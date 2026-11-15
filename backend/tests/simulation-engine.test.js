// Phase 4A engine tests against PostgreSQL: run creation, step ordering, duplicate prevention, restart recovery,
// Day 30 -> 31 transition, 409 rules, accelerated clock, full 60-day lifecycle, reset. Synthetic data only.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { executeStep, nextPendingStep } from '../src/simulation/engine.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

const quiet = { error: () => {} };

// Multi-day simulations take seconds (slower on CI runners), so these tests get 60 s instead of the default 5 s.
describe.skipIf(!DATABASE_URL)('simulation engine', { timeout: 60_000 }, () => {
  let ctx;
  let db;
  let sim;

  beforeAll(async () => {
    ctx = await createTestSchema('p4_engine', { seeded: true });
    db = ctx.pool;
  });
  afterAll(async () => { await sim?.shutdown(); await ctx?.drop(); });

  beforeEach(async () => {
    await sim?.shutdown();
    await db.query('DELETE FROM simulation_runs');
    sim = createSimulationController({ pool: db, tickMs: 5, log: quiet });
  });

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const errOf = (p) => p.then(() => { throw new Error('expected rejection'); }, (e) => e);

  it('start creates the calendar, 180 meals with menus, and a paused run at Day 0 19:30', async () => {
    await sim.start({ seed: 42 }, null);
    const s = await sim.status();
    expect(s.run).toMatchObject({ status: 'paused', seed: 42, start_date: '2026-07-06', total_days: 60,
      sim_now: '2026-07-05T19:30:00.000Z', calendar: { holidays: 2, festivals: 2, exam_days: 0 } });
    expect(s).toMatchObject({ current_day: 0, phase: 'learning', meals: { total: 180, completed: 0 } });
    expect(s.next_step).toEqual({ meal_id: `r${s.run.id}-d001-breakfast`, step: 'open_voting', due_at: '2026-07-05T19:30:00.000Z' });
    expect((await one('SELECT count(*)::int n FROM sim_days')).n).toBe(60);
    const sizes = await all('SELECT count(*)::int n FROM meal_dishes GROUP BY meal_id');
    expect(sizes).toHaveLength(180);
    expect(sizes.every((r) => r.n >= 4 && r.n <= 6)).toBe(true);
    const cal = await one(`SELECT count(*) FILTER (WHERE is_holiday)::int h, count(*) FILTER (WHERE is_festival)::int f,
      count(*) FILTER (WHERE is_exam_day)::int e FROM sim_days`);
    expect(cal).toEqual({ h: 2, f: 2, e: 0 });
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE action = 'simulation.start'")).n).toBeGreaterThan(0);
  });

  it('only one run can exist (409)', async () => {
    await sim.start({ seed: 1 }, null);
    const e = await errOf(sim.start({ seed: 2 }, null));
    expect([e.status, e.code]).toEqual([409, 'simulation_exists']);
  });

  it('next_step executes exactly one step, in the approved order', async () => {
    await sim.start({ seed: 42 }, null);
    const seen = [];
    for (let i = 0; i < 9; i += 1) {
      const before = (await sim.status()).next_step;
      seen.push(`${before.meal_id.split('-').slice(1).join('-')}:${before.step}@${before.due_at.slice(11, 16)}`);
      expect((await sim.advance({ to: 'next_step' })).steps_executed).toBe(1);
      expect((await sim.status()).run.sim_now).toBe(before.due_at);
    }
    expect(seen).toEqual([
      'd001-breakfast:open_voting@19:30', 'd001-lunch:open_voting@00:30', 'd001-breakfast:provisional@03:30',
      'd001-breakfast:close_voting@07:00', 'd001-dinner:open_voting@07:30', 'd001-breakfast:complete@08:15',
      'd001-lunch:provisional@08:30', 'd001-lunch:close_voting@12:00', 'd001-lunch:complete@13:15',
    ]);
  });

  it('a step can never run twice (re-executing a done step is a no-op)', async () => {
    await sim.start({ seed: 42 }, null);
    const run = await one('SELECT id FROM simulation_runs');
    const pending = await nextPendingStep(db, run.id);
    expect(await executeStep(db, run.id, pending)).toBe(true);
    const responses = (await one('SELECT count(*)::int n FROM meal_responses')).n;
    expect(await executeStep(db, run.id, pending)).toBe(false);
    expect((await one('SELECT count(*)::int n FROM meal_responses')).n).toBe(responses);
    // concurrent attempts at the same step: exactly one succeeds
    const next = await nextPendingStep(db, run.id);
    const results = await Promise.all([executeStep(db, run.id, next), executeStep(db, run.id, next), executeStep(db, run.id, next)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('end_of_day and day N move the clock; Day 30 -> 31 switches the phase to active', async () => {
    await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'end_of_day' });
    let s = await sim.status();
    expect([s.current_day, s.run.sim_now]).toEqual([1, '2026-07-06T00:00:00.000Z']);
    await sim.advance({ to: 'day', day: 30 });
    s = await sim.status();
    expect([s.current_day, s.phase]).toEqual([30, 'learning']);
    await sim.advance({ to: 'day', day: 31 });
    s = await sim.status();
    expect([s.current_day, s.phase, s.run.sim_now]).toEqual([31, 'active', '2026-08-05T00:00:00.000Z']);
    // every Day 1–30 meal is completed; Day 31 meals are not yet
    expect(await one(`SELECT count(*) FILTER (WHERE day_number <= 30 AND status = 'completed')::int done,
      count(*) FILTER (WHERE day_number >= 31 AND status = 'completed')::int later FROM meals`)).toEqual({ done: 90, later: 0 });
    expect(await all("SELECT DISTINCT phase FROM meals WHERE day_number <= 30")).toEqual([{ phase: 'learning' }]);
    const e = await errOf(sim.advance({ to: 'day', day: 31 }));
    expect([e.status, e.code]).toEqual([400, 'invalid_day']);
  });

  it('frozen counts: provisional ≤ final, matching the response rows; Not Eating counts as a response', async () => {
    await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'day', day: 3 });
    const meals = await all("SELECT * FROM meals WHERE status = 'completed'");
    expect(meals).toHaveLength(6);
    for (const m of meals) {
      const c = await one(`SELECT count(*) FILTER (WHERE responded_at <= $2)::int prov,
          count(*) FILTER (WHERE responded_at <= $2 AND response = 'not_eating')::int prov_ne,
          count(*)::int fin, count(*) FILTER (WHERE response = 'not_eating')::int fin_ne
        FROM meal_responses WHERE meal_id = $1`, [m.id, m.provisional_at]);
      expect([m.prov_total_responses, m.prov_not_eating, m.final_total_responses, m.final_not_eating])
        .toEqual([c.prov, c.prov_ne, c.fin, c.fin_ne]);
      expect(m.prov_total_responses).toBeLessThanOrEqual(m.final_total_responses);
      expect(m.final_not_eating).toBeGreaterThan(0);
      const taps = await all(`SELECT c.prov_taps, c.final_taps,
          (SELECT count(*)::int FROM response_picks p JOIN meal_responses r ON r.id = p.response_id
            WHERE p.meal_id = c.meal_id AND p.dish_id = c.dish_id) AS picks
        FROM meal_dish_counts c WHERE c.meal_id = $1`, [m.id]);
      for (const t of taps) {
        expect(t.final_taps).toBe(t.picks);
        expect(t.prov_taps).toBeLessThanOrEqual(t.final_taps);
        expect(t.final_taps).toBeLessThanOrEqual(m.final_total_responses);
      }
    }
  });

  it('is deterministic: the same seed gives identical votes and outcomes after a reset', async () => {
    const snapshot = async () => all(`SELECT m.day_number, m.meal_type, m.final_total_responses, m.headcount,
        o.dish_id, o.actual_consumers, o.static_plan_servings, o.avg_rating
      FROM meals m JOIN dish_outcomes o ON o.meal_id = m.id ORDER BY m.serve_at, o.dish_id`);
    await sim.start({ seed: 99 }, null);
    await sim.advance({ to: 'day', day: 3 });
    const first = await snapshot();
    await sim.reset({ confirm: 'RESET', userId: null });
    await sim.start({ seed: 99 }, null);
    for (let i = 0; i < 4; i += 1) await sim.advance({ to: 'next_step' }); // advance in different increments
    await sim.advance({ to: 'day', day: 2 });
    await sim.advance({ to: 'day', day: 3 });
    expect(await snapshot()).toEqual(first);
  }, 30_000);

  it('a step that fails mid-way rolls back completely and can be retried', async () => {
    await sim.start({ seed: 42 }, null);
    await db.query(`CREATE FUNCTION fail_votes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated crash'; END $$`);
    await db.query('CREATE TRIGGER fail_votes BEFORE INSERT ON response_picks FOR EACH STATEMENT EXECUTE FUNCTION fail_votes()');
    try {
      await expect(sim.advance({ to: 'next_step' })).rejects.toThrow(/simulated crash/);
    } finally {
      await db.query('DROP TRIGGER fail_votes ON response_picks');
      await db.query('DROP FUNCTION fail_votes()');
    }
    const s = await sim.status();
    expect(s.run.sim_now).toBe('2026-07-05T19:30:00.000Z');
    expect(s.next_step.step).toBe('open_voting');
    expect((await one('SELECT count(*)::int n FROM meal_responses')).n).toBe(0);
    expect((await sim.advance({ to: 'next_step' })).steps_executed).toBe(1);
  });

  it('restart recovery: a running run becomes paused and continues from sim_now', async () => {
    await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'day', day: 2 });
    await db.query("UPDATE simulation_runs SET status = 'running'"); // as if the process died while running
    const fresh = createSimulationController({ pool: db, tickMs: 5, log: quiet });
    expect(await fresh.recoverOnStartup()).toBe(1);
    const s = await fresh.status();
    expect([s.run.status, s.clock_running, s.current_day]).toEqual(['paused', false, 2]);
    await fresh.advance({ to: 'day', day: 3 });
    expect((await fresh.status()).current_day).toBe(3);
  });

  it('accelerated clock advances time; manual advance while it runs is 409; pause stops it', async () => {
    await sim.start({ seed: 42, speedSimMinutes: 120 }, null);
    await sim.play();
    const e = await errOf(sim.advance({ to: 'next_step' }));
    expect([e.status, e.code]).toEqual([409, 'clock_running']);
    await new Promise((r) => setTimeout(r, 300));
    await sim.pause();
    const s = await sim.status();
    expect([s.run.status, s.clock_running]).toEqual(['paused', false]);
    expect(Date.parse(s.run.sim_now)).toBeGreaterThan(Date.parse('2026-07-06T00:00:00Z'));
    const frozen = s.run.sim_now;
    await new Promise((r) => setTimeout(r, 50));
    expect((await sim.status()).run.sim_now).toBe(frozen);
    // play with a new speed is stored
    await sim.play({ speedSimMinutes: 30 });
    await sim.pause();
    expect((await sim.status()).run.speed_sim_minutes).toBe(30);
  });

  it('a second manual advance while one is in progress is 409 (simulation_busy)', async () => {
    await sim.start({ seed: 42 }, null);
    const first = sim.advance({ to: 'day', day: 4 });
    const e = await errOf(sim.advance({ to: 'next_step' }));
    expect([e.status, e.code]).toEqual([409, 'simulation_busy']);
    await first;
  });

  it('runs the full 60 days without ML: all 180 meals completed, predictions recorded as unavailable, none fabricated, fixed kitchen plan', async () => {
    await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'day', day: 60 });
    await sim.advance({ to: 'end_of_day' });
    const s = await sim.status();
    expect([s.run.status, s.meals.completed, s.next_step]).toEqual(['completed', 180, null]);
    expect(s.run.sim_now).toBe('2026-09-03T20:15:00.000Z'); // Day 60 dinner completes
    // No ML client configured: every Day 31+ provisional and final prediction is recorded as unavailable (with the
    // reason), nothing is predicted, and the kitchen falls back to the fixed plan (D5). Learning meals have no rows.
    expect(await all(`SELECT kind, status, error_detail->>'reason' AS reason, count(*)::int AS n
      FROM prediction_requests GROUP BY 1, 2, 3 ORDER BY 1`)).toEqual([
      { kind: 'final', status: 'unavailable', reason: 'ml_not_configured', n: 90 },
      { kind: 'provisional', status: 'unavailable', reason: 'ml_not_configured', n: 90 }]);
    expect((await one(`SELECT count(*)::int n FROM prediction_requests r JOIN meals m ON m.id = r.meal_id
      WHERE m.phase = 'learning'`)).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM prediction_items')).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM dish_outcomes WHERE prepared_servings <> static_plan_servings')).n).toBe(0);
    expect((await one("SELECT count(*)::int n FROM meals WHERE phase = 'active' AND status = 'completed'")).n).toBe(90);
    const e = await errOf(sim.advance({ to: 'next_step' }));
    expect([e.status, e.code]).toEqual([409, 'simulation_completed']);
    const p = await errOf(sim.play());
    expect(p.code).toBe('simulation_completed');
  }, 60_000);

  it('reset stops the clock, writes the audit entry and deletes the run', async () => {
    await sim.start({ seed: 42, speedSimMinutes: 60 }, null);
    await sim.play();
    const result = await sim.reset({ confirm: 'RESET', userId: null });
    expect(sim.clockRunning).toBe(false);
    expect(result.summary.counts.meals).toBe(180);
    expect((await sim.status()).run).toBeNull();
    const wrong = await errOf(sim.reset({ confirm: 'reset', userId: null }));
    expect([wrong.status, wrong.code]).toEqual([400, 'confirmation_required']);
    const none = await errOf(sim.reset({ confirm: 'RESET', userId: null }));
    expect([none.status, none.code]).toEqual([404, 'no_simulation_run']);
  });
});
