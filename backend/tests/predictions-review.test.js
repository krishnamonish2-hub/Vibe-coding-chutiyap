// Regression tests for the Phase 4B code-review fixes (H1, H2, M1, M2, M3, L3), against PostgreSQL and a MOCK ML
// service. The controller uses its own pool with a unique application_name so open transactions can be observed in
// pg_stat_activity without interference from other test files.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool } from '../src/db/pool.js';
import { createMlClient } from '../src/ml/client.js';
import { retryPrediction } from '../src/services/predictions.js';
import { submitResponse } from '../src/services/voting.js';
import { withTransaction } from '../src/db/transaction.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';
import { MODEL_INFO, startMockMl } from './helpers/mock-ml.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DATABASE_URL)('Phase 4B review fixes', { timeout: 120_000 }, () => {
  let ctx;
  let db; // observer/test pool
  let simPool; // pool used by the simulation (named, observable)
  let appName;
  let mock;
  let clock;
  let ml;
  let sim;

  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const all = async (sql, p) => (await db.query(sql, p)).rows;
  const step = async (n = 1) => { for (let i = 0; i < n; i += 1) await sim.advance({ to: 'next_step' }); };
  const id = (runId, day, mt) => `r${runId}-d${String(day).padStart(3, '0')}-${mt}`;
  const openTx = async () => (await one(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%'", [appName])).n;

  beforeAll(async () => {
    ctx = await createTestSchema('p4b_review', { seeded: true });
    db = ctx.pool;
    appName = `p4b_review_${process.pid}`;
    simPool = createPool(DATABASE_URL, { options: `-c search_path=${ctx.schema}`, application_name: appName });
    mock = await startMockMl();
  });
  afterAll(async () => { await sim?.shutdown(); await simPool?.end(); await mock?.close(); await ctx?.drop(); });

  beforeEach(async () => {
    await sim?.shutdown();
    await db.query('DELETE FROM simulation_runs');
    mock.reset();
    clock = 5_000_000;
    ml = createMlClient({ baseUrl: mock.url, timeoutMs: 1500, now: () => clock });
    sim = createSimulationController({ pool: simPool, ml, log: { error: () => {} } });
  });

  async function toDay31() {
    const { run } = await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'day', day: 31 });
    await step(1); // Day 31 lunch voting opens (00:30); breakfast provisional (03:30) is next
    return Number(run.id);
  }
  const firstDish = async (mealId) => (await one('SELECT dish_id FROM meal_dishes WHERE meal_id = $1 ORDER BY position LIMIT 1', [mealId])).dish_id;

  // -------------------------------------------------------------------------- H1
  it('H1: health/model-info checks run with NO transaction open; only /predict runs inside the step transaction', async () => {
    await toDay31();
    clock += 61_000; // health cache expired -> the next prediction re-checks health
    mock.state.healthDelayMs = 1200;
    const pending = step(1); // breakfast provisional
    await sleep(400); // the slow health check is in progress
    expect(mock.state.requests.filter((r) => r.path === '/health').length).toBeGreaterThan(0);
    expect(await openTx()).toBe(0);
    await pending;

    mock.state.queue = ['timeout', 'timeout'];
    const pending2 = step(1); // breakfast final: /predict hangs (cached health, no new check)
    await sleep(400);
    expect(await openTx()).toBe(1); // the step's own transaction, held during the predict attempt
    await pending2;
    expect(await openTx()).toBe(0);
  });

  it('H1: a vote on another meal does not wait for a hanging ML call', async () => {
    const runId = await toDay31();
    await step(1); // breakfast provisional (ok)
    const lunch = id(runId, 31, 'lunch');
    const dish = await firstDish(lunch);
    mock.state.queue = ['timeout', 'timeout']; // ~3 s of hanging inside the breakfast final step
    const pending = step(1);
    await sleep(300);
    const t0 = Date.now();
    await submitResponse(db, 1, lunch, { response: 'eating', dishIds: [dish] });
    const waited = Date.now() - t0;
    await pending;
    expect(waited).toBeLessThan(500);
    expect((await one("SELECT status, error_detail->>'reason' r FROM prediction_requests WHERE meal_id = $1 AND kind = 'final' AND is_current", [id(runId, 31, 'breakfast')])))
      .toEqual({ status: 'unavailable', r: 'timeout' });
  });

  it('H1: a vote on the SAME meal during its close-voting step waits for the step and is then rejected (cutoff kept)', async () => {
    const runId = await toDay31();
    await step(1); // breakfast provisional
    const breakfast = id(runId, 31, 'breakfast');
    const dish = await firstDish(breakfast);
    mock.state.queue = ['timeout', 'timeout'];
    const pending = step(1); // breakfast close + final (holds the meal row lock)
    await sleep(300);
    const t0 = Date.now();
    const err = await submitResponse(db, 1, breakfast, { response: 'eating', dishIds: [dish] }).catch((e) => e);
    const waited = Date.now() - t0;
    await pending;
    expect([err.status, err.code]).toEqual([409, 'voting_closed']);
    expect(waited).toBeGreaterThan(1500); // it was serialised behind the step
    const m = await one('SELECT final_total_responses FROM meals WHERE id = $1', [breakfast]);
    expect((await one('SELECT count(*)::int n FROM meal_responses WHERE meal_id = $1', [breakfast])).n).toBe(m.final_total_responses);
  });

  it('H1: a vote after the provisional snapshot is stamped after T-4h, so timestamps agree with the frozen count', async () => {
    const runId = await toDay31();
    await step(1); // breakfast provisional at 03:30 -> clock parked exactly at T-4h
    const breakfast = id(runId, 31, 'breakfast');
    const m = await one('SELECT provisional_at, prov_total_responses FROM meals WHERE id = $1', [breakfast]);
    expect((await sim.status()).run.sim_now).toBe(m.provisional_at.toISOString());
    await db.query('DELETE FROM response_picks WHERE response_id IN (SELECT id FROM meal_responses WHERE meal_id = $1 AND student_id = 1)', [breakfast]);
    await db.query('DELETE FROM meal_responses WHERE meal_id = $1 AND student_id = 1', [breakfast]);
    const before = (await one('SELECT count(*)::int n FROM meal_responses WHERE meal_id = $1 AND responded_at <= $2', [breakfast, m.provisional_at])).n;
    const saved = await submitResponse(db, 1, breakfast, { response: 'not_eating' });
    expect(saved.responded_at).toBe(new Date(m.provisional_at.getTime() + 1000).toISOString());
    const after = (await one('SELECT count(*)::int n FROM meal_responses WHERE meal_id = $1 AND responded_at <= $2', [breakfast, m.provisional_at])).n;
    expect(after).toBe(before);
  });

  // -------------------------------------------------------------------------- H2
  it('H2: each attempt stores its own wall-clock time (attempts within one step differ)', async () => {
    const runId = await toDay31();
    mock.state.queue = [500, 'ok'];
    await step(1);
    const rows = await all("SELECT attempt, wall_at FROM prediction_requests WHERE meal_id = $1 AND kind = 'provisional' ORDER BY attempt", [id(runId, 31, 'breakfast')]);
    expect(rows).toHaveLength(2);
    expect(rows[1].wall_at.getTime()).toBeGreaterThan(rows[0].wall_at.getTime());
    mock.state.queue = ['timeout', 'ok'];
    await step(1);
    const fin = await all("SELECT wall_at FROM prediction_requests WHERE meal_id = $1 AND kind = 'final' ORDER BY attempt", [id(runId, 31, 'breakfast')]);
    expect(fin[1].wall_at.getTime() - fin[0].wall_at.getTime()).toBeGreaterThanOrEqual(0); // ordered
    expect(fin[0].wall_at.getTime() - rows[1].wall_at.getTime()).toBeGreaterThan(1000); // the 1.5 s timeout separates them
  });

  // -------------------------------------------------------------------------- L3: rollback after a successful ML call
  it('L3: a step that fails after a successful ML call rolls back completely; re-running it creates exactly one attempt', async () => {
    const runId = await toDay31();
    const breakfast = id(runId, 31, 'breakfast');
    await db.query(`CREATE FUNCTION fail_items() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure after ML'; END $$`);
    await db.query('CREATE TRIGGER fail_items BEFORE INSERT ON prediction_items FOR EACH STATEMENT EXECUTE FUNCTION fail_items()');
    try {
      await expect(step(1)).rejects.toThrow(/simulated failure after ML/);
    } finally {
      await db.query('DROP TRIGGER fail_items ON prediction_items');
      await db.query('DROP FUNCTION fail_items()');
    }
    expect(mock.predictRequests()).toHaveLength(1); // the ML service WAS called
    expect(await one('SELECT status, prov_total_responses FROM meals WHERE id = $1', [breakfast])).toEqual({ status: 'voting_open', prov_total_responses: null });
    expect((await one('SELECT count(*)::int n FROM prediction_requests')).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM meal_dish_counts WHERE meal_id = $1', [breakfast])).n).toBe(0);
    await step(1); // re-run
    expect(await all("SELECT attempt, status, is_current FROM prediction_requests WHERE meal_id = $1", [breakfast]))
      .toEqual([{ attempt: 1, status: 'ok', is_current: true }]);
    expect(mock.predictRequests()).toHaveLength(2);
    expect(mock.predictRequests()[1].body).toEqual(mock.predictRequests()[0].body); // same frozen inputs
  });

  // -------------------------------------------------------------------------- M1
  it('M1: an admin retry re-checks health when the cached result says "not ready"', async () => {
    const runId = await toDay31();
    mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    clock += 61_000;
    await step(1); // provisional -> unavailable (model_not_loaded); cached for 60 s
    const breakfast = id(runId, 31, 'breakfast');
    expect((await one("SELECT error_detail->>'reason' r FROM prediction_requests WHERE meal_id = $1", [breakfast])).r).toBe('model_not_loaded');
    mock.state.health = { status: 'ok', model_loaded: true, model_version: 'rf-v1-synthetic' }; // recovered, cache still "not ready"
    const healthBefore = mock.count('/health');
    const row = await retryPrediction(simPool, ml, { mealId: breakfast, kind: 'provisional', withTransaction });
    expect(row.status).toBe('ok');
    expect(mock.count('/health')).toBe(healthBefore + 1);
  });

  // -------------------------------------------------------------------------- M2
  it('M2: a missing dish count is recorded as request_invalid (no ML call), never silently dropped', async () => {
    const runId = await toDay31();
    await step(1); // provisional ok
    const breakfast = id(runId, 31, 'breakfast');
    const dish = await firstDish(breakfast);
    await db.query('DELETE FROM meal_dish_counts WHERE meal_id = $1 AND dish_id = $2', [breakfast, dish]);
    const calls = mock.predictRequests().length;
    await step(1); // close + final
    const r = await one("SELECT status, error_detail FROM prediction_requests WHERE meal_id = $1 AND kind = 'final'", [breakfast]);
    expect([r.status, r.error_detail.reason]).toEqual(['error', 'request_invalid']);
    expect(r.error_detail.issues.map((i) => i.message)).toContain(`missing final vote count for dish ${dish}`);
    expect(mock.predictRequests()).toHaveLength(calls);
  });

  // -------------------------------------------------------------------------- M3
  it.each([
    ['a different contract version', () => { mock.state.modelInfo = { ...MODEL_INFO, contract_version: '0.4' }; }, 'contract_mismatch'],
    ['an unreadable /model-info', () => { mock.state.modelInfoStatus = 503; }, 'model_info_unavailable'],
  ])('M3: %s makes the prediction unavailable without calling /predict', async (_, setUp, reason) => {
    const runId = await toDay31();
    setUp();
    await step(1);
    const r = await one("SELECT status, error_detail->>'reason' r FROM prediction_requests WHERE meal_id = $1", [id(runId, 31, 'breakfast')]);
    expect(r).toEqual({ status: 'unavailable', r: reason });
    expect(mock.predictRequests()).toHaveLength(0);
  });
});
