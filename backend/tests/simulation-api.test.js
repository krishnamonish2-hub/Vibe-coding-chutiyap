// Phase 4A HTTP tests against PostgreSQL: admin simulation and meal routes, student voting API (window, cutoff,
// S0001 visibility, demo override), outcome edits and authorization. Synthetic data only.

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSimulationController } from '../src/simulation/controller.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

// Multi-day simulations take seconds (slower on CI runners), so these tests get 60 s instead of the default 5 s.
describe.skipIf(!DATABASE_URL)('simulation and voting API', { timeout: 60_000 }, () => {
  let ctx;
  let db;
  let app;
  let sim;
  let admin;
  let student;

  const json = (r) => r.set('Content-Type', 'application/json');
  const post = (agent, path, body = {}) => json(agent.post(path)).send(body);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  beforeAll(async () => {
    ctx = await createTestSchema('p4_api', { seeded: true });
    db = ctx.pool;
    sim = createSimulationController({ pool: db, tickMs: 5, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim });
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');
  });
  afterAll(async () => { await sim?.shutdown(); await ctx?.drop(); });
  beforeEach(async () => {
    await sim.shutdown();
    await db.query('DELETE FROM simulation_runs');
  });

  // -------------------------------------------------------------------------
  describe('authorization', () => {
    const ADMIN = [['GET', '/api/admin/simulation'], ['POST', '/api/admin/simulation/start'],
      ['POST', '/api/admin/simulation/advance'], ['POST', '/api/admin/simulation/play'],
      ['POST', '/api/admin/simulation/pause'], ['POST', '/api/admin/simulation/reset'],
      ['GET', '/api/admin/meals'], ['GET', '/api/admin/meals/r1-d001-lunch'], ['PUT', '/api/admin/meals/r1-d001-lunch/outcomes']];
    const STUDENT = [['GET', '/api/student/meals/upcoming'], ['PUT', '/api/student/meals/r1-d001-lunch/response']];
    const call = (agent, m, p) => (m === 'GET' ? agent.get(p) : json(agent[m.toLowerCase()](p)).send({}));

    it.each(ADMIN)('%s %s: 401 without session, 403 for the student', async (m, p) => {
      expect((await call(request(app), m, p)).status).toBe(401);
      expect((await call(student, m, p)).status).toBe(403);
    });

    it.each(STUDENT)('%s %s: 401 without session, 403 for the admin', async (m, p) => {
      expect((await call(request(app), m, p)).status).toBe(401);
      expect((await call(admin, m, p)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe('admin simulation routes', () => {
    it('GET without a run; start (201) with validation; second start 409', async () => {
      expect((await admin.get('/api/admin/simulation')).body).toMatchObject({ run: null, clock_running: false });
      expect((await post(admin, '/api/admin/simulation/start', { total_days: 30 })).status).toBe(400);
      expect((await post(admin, '/api/admin/simulation/start', { start_date: '2026-02-30' })).status).toBe(400);
      expect((await post(admin, '/api/admin/simulation/start', { seed: 1, extra: true })).status).toBe(400);
      const res = await post(admin, '/api/admin/simulation/start', { seed: 7 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ current_day: 0, phase: 'learning', run: { seed: 7, status: 'paused', total_days: 60 } });
      expect((await post(admin, '/api/admin/simulation/start', { seed: 8 })).status).toBe(409);
    });

    it('advance: validation, next_step, day N; play then advance is 409; pause', async () => {
      await post(admin, '/api/admin/simulation/start', { seed: 7 });
      expect((await post(admin, '/api/admin/simulation/advance', { to: 'tomorrow' })).status).toBe(400);
      expect((await post(admin, '/api/admin/simulation/advance', { to: 'day' })).status).toBe(400);
      const step = await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      expect(step.body).toMatchObject({ steps_executed: 1 });
      const day3 = await post(admin, '/api/admin/simulation/advance', { to: 'day', day: 3 });
      expect(day3.body).toMatchObject({ current_day: 3, phase: 'learning' });
      expect((await post(admin, '/api/admin/simulation/play', { speed_sim_minutes: 30 })).body.clock_running).toBe(true);
      const busy = await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      expect([busy.status, busy.body.error.code]).toEqual([409, 'clock_running']);
      const paused = await post(admin, '/api/admin/simulation/pause');
      expect(paused.body).toMatchObject({ clock_running: false, run: { status: 'paused', speed_sim_minutes: 30 } });
    });

    it('reset endpoint: wrong confirmation 400; RESET deletes the run and returns the audit id', async () => {
      await post(admin, '/api/admin/simulation/start', { seed: 7 });
      const wrong = await post(admin, '/api/admin/simulation/reset', { confirm: 'yes' });
      expect([wrong.status, wrong.body.error.code]).toEqual([400, 'confirmation_required']);
      expect((await post(admin, '/api/admin/simulation/reset', {})).status).toBe(400);
      const ok = await post(admin, '/api/admin/simulation/reset', { confirm: 'RESET' });
      expect(ok.status).toBe(200);
      expect(ok.body.summary.counts.meals).toBe(180);
      const audit = await one('SELECT action, entity, user_id FROM audit_log WHERE id = $1', [ok.body.audit_id]);
      expect(audit).toMatchObject({ action: 'simulation.reset', entity: `simulation_run:${ok.body.summary.run_id}` });
      expect(audit.user_id).not.toBeNull();
      expect((await admin.get('/api/admin/simulation')).body.run).toBeNull();
      expect((await post(admin, '/api/admin/simulation/reset', { confirm: 'RESET' })).status).toBe(404);
    });

    it('reset while the accelerated clock runs stops the clock first', async () => {
      await post(admin, '/api/admin/simulation/start', { seed: 7, speed_sim_minutes: 60 });
      await post(admin, '/api/admin/simulation/play');
      const ok = await post(admin, '/api/admin/simulation/reset', { confirm: 'RESET' });
      expect(ok.status).toBe(200);
      expect(sim.clockRunning).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('admin meal routes', () => {
    it('lists meals by day and shows a completed meal with counts, outcomes and no predictions', async () => {
      const start = await post(admin, '/api/admin/simulation/start', { seed: 7 });
      const runId = start.body.run.id;
      await post(admin, '/api/admin/simulation/advance', { to: 'day', day: 2 });
      const list = await admin.get('/api/admin/meals?day=1');
      expect(list.body.meals.map((m) => m.meal_type)).toEqual(['breakfast', 'lunch', 'dinner']);
      expect((await admin.get('/api/admin/meals?day=abc')).status).toBe(400);
      const detail = await admin.get(`/api/admin/meals/r${runId}-d001-lunch`);
      expect(detail.body.meal).toMatchObject({ status: 'completed', phase: 'learning' });
      expect(detail.body.predictions).toEqual([]);
      for (const d of detail.body.dishes) {
        expect(d.final_taps).toBeGreaterThanOrEqual(d.prov_taps);
        expect(d.prepared_servings).toBe(d.static_plan_servings);
        expect(d.source).toBe('simulated');
      }
      expect((await admin.get('/api/admin/meals/r999-d001-lunch')).status).toBe(404);
    });

    it('edits outcomes of a completed meal only; audited; shortfall recomputed', async () => {
      const runId = (await post(admin, '/api/admin/simulation/start', { seed: 7 })).body.run.id;
      await post(admin, '/api/admin/simulation/advance', { to: 'day', day: 2 });
      const mealId = `r${runId}-d001-lunch`;
      const dish = (await admin.get(`/api/admin/meals/${mealId}`)).body.dishes[0];
      const res = await json(admin.put(`/api/admin/meals/${mealId}/outcomes`))
        .send({ headcount: 800, dishes: [{ dish_id: dish.dish_id, actual_consumers: dish.prepared_servings + 10, avg_rating: 4.2 }] });
      expect(res.status).toBe(200);
      const edited = res.body.dishes.find((d) => d.dish_id === dish.dish_id);
      expect(edited).toMatchObject({ actual_consumers: dish.prepared_servings + 10, avg_rating: 4.2, shortfall_servings: 10, source: 'admin' });
      expect(res.body.meal.headcount).toBe(800);
      const audit = await one("SELECT before, after FROM audit_log WHERE action = 'meal.outcomes_edit' ORDER BY id DESC LIMIT 1");
      expect(audit.after.dishes[0]).toMatchObject({ dish_id: dish.dish_id, actual_consumers: dish.prepared_servings + 10 });
      expect(audit.before.dishes[0].actual_consumers).toBe(dish.actual_consumers);

      const future = await json(admin.put(`/api/admin/meals/r${runId}-d010-lunch/outcomes`)).send({ headcount: 1 });
      expect([future.status, future.body.error.code]).toEqual([409, 'meal_not_completed']);
      const bad = await json(admin.put(`/api/admin/meals/${mealId}/outcomes`)).send({ dishes: [{ dish_id: 'D999', actual_consumers: 1 }] });
      expect(bad.status).toBe(400);
      expect((await json(admin.put(`/api/admin/meals/${mealId}/outcomes`)).send({ dishes: [{ dish_id: dish.dish_id, actual_consumers: 1001 }] })).status).toBe(400);
      expect((await json(admin.put(`/api/admin/meals/${mealId}/outcomes`)).send({})).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('student voting API', () => {
    let runId;
    let lunchId;

    async function setUp() {
      runId = (await post(admin, '/api/admin/simulation/start', { seed: 11 })).body.run.id;
      lunchId = `r${runId}-d001-lunch`;
    }
    const s0001 = async (mealId) => one(
      `SELECT r.response, r.responded_at, array_remove(array_agg(p.dish_id ORDER BY p.dish_id), NULL) AS dishes
         FROM meal_responses r LEFT JOIN response_picks p ON p.response_id = r.id
        WHERE r.meal_id = $1 AND r.student_id = 1 GROUP BY r.id`, [mealId]);
    const vote = (mealId, body) => json(student.put(`/api/student/meals/${mealId}/response`)).send(body);

    it('lists only meals whose voting window is open, with the menu', async () => {
      await setUp();
      expect((await student.get('/api/student/meals/upcoming')).body.meals).toEqual([]); // nothing opened yet
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' }); // breakfast opens 19:30
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' }); // lunch opens 00:30
      const up = (await student.get('/api/student/meals/upcoming')).body;
      expect(up.meals.map((m) => m.meal_type)).toEqual(['breakfast', 'lunch']);
      expect(up.meals[1].menu.length).toBeGreaterThanOrEqual(4);
      expect(up.meals[1].menu[0]).toHaveProperty('display_name');
    });

    it('S0001\'s synthetic response is visible only once responded_at <= sim_now', async () => {
      // find a seed/meal where S0001 has a synthetic response, then check visibility before and after its time
      await setUp();
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      const synthetic = await one(`SELECT r.meal_id, r.responded_at FROM meal_responses r
        WHERE r.student_id = 1 AND r.meal_id IN ($1, $2) ORDER BY r.responded_at DESC LIMIT 1`,
      [`r${runId}-d001-breakfast`, lunchId]);
      const simNow = new Date((await admin.get('/api/admin/simulation')).body.run.sim_now);
      const mine = (await student.get('/api/student/meals/upcoming')).body.meals.find((m) => m.meal_id === synthetic?.meal_id);
      if (synthetic && synthetic.responded_at > simNow) {
        expect(mine.my_response).toBeNull();
      } else if (synthetic) {
        expect(mine.my_response).not.toBeNull();
      }
      // regardless of the seed: make S0001 have a future synthetic response and check both sides
      await db.query("UPDATE meal_responses SET responded_at = $2 WHERE meal_id = $1 AND student_id = 1", [lunchId, new Date(simNow.getTime() + 3600e3)]);
      await db.query(`INSERT INTO meal_responses (meal_id, student_id, response, responded_at)
        VALUES ($1, 1, 'not_eating', $2) ON CONFLICT (meal_id, student_id) DO NOTHING`, [lunchId, new Date(simNow.getTime() + 3600e3)]);
      let lunch = (await student.get('/api/student/meals/upcoming')).body.meals.find((m) => m.meal_id === lunchId);
      expect(lunch.my_response).toBeNull();
      await db.query("UPDATE meal_responses SET responded_at = $2 WHERE meal_id = $1 AND student_id = 1", [lunchId, simNow]);
      lunch = (await student.get('/api/student/meals/upcoming')).body.meals.find((m) => m.meal_id === lunchId);
      expect(lunch.my_response).not.toBeNull();
    });

    it('the demo vote replaces S0001\'s synthetic response (one row, responded_at = sim_now); can switch to not_eating', async () => {
      await setUp();
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      const menu = (await student.get('/api/student/meals/upcoming')).body.meals.find((m) => m.meal_id === lunchId).menu;
      const picks = [menu[0].dish_id, menu[1].dish_id].sort();
      const simNow = (await admin.get('/api/admin/simulation')).body.run.sim_now;

      const res = await vote(lunchId, { response: 'eating', dish_ids: picks });
      expect(res.status).toBe(200);
      expect(res.body.my_response).toEqual({ response: 'eating', dish_ids: picks, responded_at: simNow });
      expect(await s0001(lunchId)).toMatchObject({ response: 'eating', dishes: picks });
      expect((await one('SELECT count(*)::int n FROM meal_responses WHERE meal_id = $1 AND student_id = 1', [lunchId])).n).toBe(1);

      const ne = await vote(lunchId, { response: 'not_eating' });
      expect(ne.body.my_response).toMatchObject({ response: 'not_eating', dish_ids: [] });
      expect(await s0001(lunchId)).toMatchObject({ response: 'not_eating', dishes: [] });
    });

    it('validates the body and the menu', async () => {
      await setUp();
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      expect((await vote(lunchId, { response: 'eating', dish_ids: [] })).status).toBe(400); // ≥ 1 dish (D8 UI rule)
      expect((await vote(lunchId, { response: 'eating', dish_ids: ['D012', 'D012'] })).status).toBe(400);
      expect((await vote(lunchId, { response: 'not_eating', dish_ids: ['D012'] })).status).toBe(400);
      expect((await vote(lunchId, { response: 'maybe' })).status).toBe(400);
      const offMenu = await vote(lunchId, { response: 'eating', dish_ids: ['D040'] }); // Ice Cream is a dinner dish
      expect([offMenu.status, offMenu.body.error.code]).toEqual([400, 'dish_not_on_menu']);
      expect((await vote(`r${runId}-d099-lunch`, { response: 'not_eating' })).status).toBe(404);
    });

    it('enforces the window: before opening and at/after the T-30m cutoff are 409', async () => {
      await setUp();
      const dinnerId = `r${runId}-d001-dinner`;
      const early = await vote(dinnerId, { response: 'not_eating' }); // dinner opens at 07:30
      expect([early.status, early.body.error.code]).toEqual([409, 'voting_closed']);
      // advance to exactly the lunch cutoff (12:00): lunch's close_voting step is the 8th step
      for (let i = 0; i < 8; i += 1) await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      const status = (await admin.get('/api/admin/simulation')).body;
      expect(status.run.sim_now).toBe('2026-07-06T12:00:00.000Z');
      const late = await vote(lunchId, { response: 'not_eating' });
      expect([late.status, late.body.error.code]).toEqual([409, 'voting_closed']);
      expect((await student.get('/api/student/meals/upcoming')).body.meals.map((m) => m.meal_id)).not.toContain(lunchId);
    });

    it('a vote after T-4h counts in the final count but not in the frozen provisional count', async () => {
      await setUp();
      // steps until lunch provisional (08:30) is done: 7 steps
      for (let i = 0; i < 7; i += 1) await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
      const prov = await one('SELECT prov_total_responses FROM meals WHERE id = $1', [lunchId]);
      await db.query('DELETE FROM response_picks WHERE meal_id = $1 AND response_id IN (SELECT id FROM meal_responses WHERE meal_id = $1 AND student_id = 1)', [lunchId]);
      await db.query('DELETE FROM meal_responses WHERE meal_id = $1 AND student_id = 1', [lunchId]);
      const base = await one('SELECT count(*)::int n FROM meal_responses WHERE meal_id = $1', [lunchId]);
      expect((await vote(lunchId, { response: 'not_eating' })).status).toBe(200);
      await post(admin, '/api/admin/simulation/advance', { to: 'next_step' }); // close voting 12:00
      const m = await one('SELECT prov_total_responses, final_total_responses FROM meals WHERE id = $1', [lunchId]);
      expect(m.prov_total_responses).toBe(prov.prov_total_responses);
      expect(m.final_total_responses).toBe(base.n + 1);
    });
  });
});
