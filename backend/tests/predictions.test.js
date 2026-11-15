// Phase 4B integration: the simulation engine + PostgreSQL + a MOCK ML service (the real service is not needed).
// Covers timing (learning period, Day 31 activation, T-4h / T-30m), request contents (partial vs frozen counts,
// ml_dish_name mapping, history, weather), failure policy (422 / 500 / 503 / timeout / not loaded / invalid output),
// fixed-plan fallback, separate provisional and final records, and administrator retry.

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMlClient } from '../src/ml/client.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';
import { fakeAnswer, startMockMl } from './helpers/mock-ml.js';

describe.skipIf(!DATABASE_URL)('ML predictions in the simulation', { timeout: 120_000 }, () => {
  let ctx;
  let db;
  let mock;
  let clock; // fake wall clock for the 60 s health cache
  let ml;
  let sim;
  let app;
  let admin;
  let student;

  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const all = async (sql, p) => (await db.query(sql, p)).rows;
  const preds = (mealId, kind) => all(`SELECT attempt, status, is_current, http_status, error_detail->>'reason' AS reason,
      request_payload, response_payload, model_version, trained_on, sim_at
    FROM prediction_requests WHERE meal_id = $1 AND kind = $2 ORDER BY attempt`, [mealId, kind]);
  const step = (n = 1) => (async () => { for (let i = 0; i < n; i += 1) await sim.advance({ to: 'next_step' }); })();
  const status = () => sim.status();

  beforeAll(async () => {
    ctx = await createTestSchema('p4b_pred', { seeded: true });
    db = ctx.pool;
    mock = await startMockMl();
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
  });
  afterAll(async () => { await sim?.shutdown(); await mock?.close(); await ctx?.drop(); });

  beforeEach(async () => {
    await sim?.shutdown();
    await db.query('DELETE FROM simulation_runs');
    await db.query('UPDATE dishes SET display_name = ml_dish_name');
    mock.reset();
    clock = 1_000_000;
    ml = createMlClient({ baseUrl: mock.url, timeoutMs: 300, now: () => clock });
    sim = createSimulationController({ pool: db, ml, tickMs: 5, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim, ml });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');
  });

  async function toDay31(seed = 42) {
    const { run } = await sim.start({ seed }, null);
    await sim.advance({ to: 'day', day: 31 });
    return Number(run.id);
  }
  const mealId = (runId, day, mt) => `r${runId}-d${String(day).padStart(3, '0')}-${mt}`;

  // -------------------------------------------------------------------------
  it('Days 1–30 never call the ML service; the first call is Day 31 breakfast provisional at T-4h', async () => {
    const runId = await toDay31();
    expect(mock.predictRequests()).toHaveLength(0);
    expect(mock.count('/health')).toBe(0);
    expect((await one('SELECT count(*)::int n FROM prediction_requests')).n).toBe(0);
    // Day 31 breakfast provisional (03:30) is the 2nd pending step after Day 31 00:00 (lunch opens 00:30 first)
    await step(2);
    expect(mock.predictRequests()).toHaveLength(1);
    expect(mock.predictRequests()[0].body.meal_id).toBe(mealId(runId, 31, 'breakfast'));
    const [p] = await preds(mealId(runId, 31, 'breakfast'), 'provisional');
    expect(p.sim_at.toISOString()).toBe('2026-08-05T03:30:00.000Z');
    expect(p).toMatchObject({ attempt: 1, status: 'ok', is_current: true, model_version: 'rf-v1-synthetic', trained_on: 'synthetic' });
  });

  it('provisional uses partial counts at T-4h, final uses the frozen counts at T-30m; separate records', async () => {
    const runId = await toDay31();
    const b = mealId(runId, 31, 'breakfast');
    await step(3); // lunch open, breakfast provisional 03:30, breakfast close + final 07:00
    const meal = await one('SELECT * FROM meals WHERE id = $1', [b]);
    const [prov] = await preds(b, 'provisional');
    const [fin] = await preds(b, 'final');
    expect(fin.sim_at.toISOString()).toBe('2026-08-05T07:00:00.000Z');
    expect(prov.request_payload.total_responses).toBe(meal.prov_total_responses);
    expect(fin.request_payload.total_responses).toBe(meal.final_total_responses);
    expect(prov.request_payload.total_responses).toBeLessThan(fin.request_payload.total_responses);
    const counts = await all('SELECT dish_id, prov_taps, final_taps FROM meal_dish_counts WHERE meal_id = $1', [b]);
    for (const c of counts) {
      expect(prov.request_payload.dishes.find((d) => d.dish_id === c.dish_id).interested_taps).toBe(c.prov_taps);
      expect(fin.request_payload.dishes.find((d) => d.dish_id === c.dish_id).interested_taps).toBe(c.final_taps);
    }
    // provisional record untouched by the final one; both current for their own kind
    expect([prov.is_current, fin.is_current]).toEqual([true, true]);
    const items = await all(`SELECT r.kind, count(i.*)::int n FROM prediction_requests r JOIN prediction_items i ON i.request_id = r.id
      WHERE r.meal_id = $1 GROUP BY r.kind ORDER BY r.kind`, [b]);
    expect(items).toEqual([{ kind: 'final', n: counts.length }, { kind: 'provisional', n: counts.length }]);
  });

  it('request contents: immutable ml_dish_name (not the renamed display name), stable dish IDs, history, weather, previous attendance', async () => {
    await db.query("UPDATE dishes SET display_name = 'Steamed Rice' WHERE id = 'D012'");
    await db.query("UPDATE dishes SET display_name = 'Masala Chai' WHERE id = 'D001'");
    const runId = await toDay31();
    await step(2);
    const body = mock.predictRequests()[0].body;
    const meal = await one('SELECT * FROM meals WHERE id = $1', [mealId(runId, 31, 'breakfast')]);
    const day = await one('SELECT * FROM sim_days WHERE run_id = $1 AND day_number = 31', [runId]);
    const prevDinner = await one('SELECT headcount FROM meals WHERE id = $1', [mealId(runId, 30, 'dinner')]);
    expect(body).toMatchObject({ meal_type: 'breakfast', date: meal.date, total_students: 1000,
      is_holiday: day.is_holiday, is_exam_day: day.is_exam_day, is_festival: day.is_festival,
      temperature: day.temperature, rainfall: day.rainfall, previous_meal_attendance: prevDinner.headcount });
    const tea = body.dishes.find((d) => d.dish_id === 'D001');
    expect(tea.dish_name).toBe('Tea');
    expect(JSON.stringify(body)).not.toMatch(/Masala Chai|Steamed Rice/);
    expect(tea.historical_dish_demand).toBeGreaterThan(0); // Tea is served every breakfast
    expect(Object.keys(body).sort()).toEqual(['date', 'dishes', 'is_exam_day', 'is_festival', 'is_holiday', 'meal_id', 'meal_type',
      'previous_meal_attendance', 'rainfall', 'temperature', 'total_responses', 'total_students']);
    // the stored payload is exactly what was sent
    expect((await preds(meal.id, 'provisional'))[0].request_payload).toEqual(body);
  });

  it('history in the request comes only from completed earlier meals of this run', async () => {
    const runId = await toDay31();
    await step(2);
    const body = mock.predictRequests()[0].body;
    for (const d of body.dishes) {
      const last5 = await all(`SELECT o.actual_consumers FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
        WHERE m.run_id = $1 AND m.meal_type = 'breakfast' AND o.dish_id = $2 AND m.status = 'completed' AND m.day_number < 31
        ORDER BY m.serve_at DESC LIMIT 5`, [runId, d.dish_id]);
      if (last5.length === 0) { expect(d.historical_dish_demand).toBeUndefined(); continue; }
      const mean = last5.reduce((a, r) => a + r.actual_consumers, 0) / last5.length;
      expect(Math.abs(d.historical_dish_demand - mean)).toBeLessThanOrEqual(0.05);
    }
    // no outcome of the predicted meal existed when it was predicted
    expect((await one('SELECT count(*)::int n FROM dish_outcomes WHERE meal_id = $1', [mealId(runId, 31, 'breakfast')])).n).toBe(0);
  });

  it('kitchen: final × 1.05 when the final prediction is ok; the fixed plan is still stored as the counterfactual', async () => {
    const runId = await toDay31();
    await step(5); // ... breakfast completes at 08:15 (5th step after Day 31 00:00)
    const b = mealId(runId, 31, 'breakfast');
    expect((await one('SELECT status FROM meals WHERE id = $1', [b])).status).toBe('completed');
    const rows = await all(`SELECT o.prepared_servings, o.static_plan_servings, i.predicted_consumers
      FROM dish_outcomes o JOIN prediction_requests r ON r.meal_id = o.meal_id AND r.kind = 'final' AND r.is_current
      JOIN prediction_items i ON i.request_id = r.id AND i.dish_id = o.dish_id WHERE o.meal_id = $1`, [b]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.prepared_servings).toBe(Math.round(r.predicted_consumers * 1.05));
      expect(r.static_plan_servings).toBeGreaterThan(0);
    }
  });

  it('actual consumption does not depend on whether predictions were available', async () => {
    const runId = await toDay31(7);
    await step(5);
    const withMl = await all('SELECT dish_id, actual_consumers, static_plan_servings, avg_rating FROM dish_outcomes WHERE meal_id = $1 ORDER BY dish_id', [mealId(runId, 31, 'breakfast')]);
    await sim.reset({ confirm: 'RESET' });
    mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    clock += 61_000;
    const run2 = await toDay31(7);
    await step(5);
    const without = await all('SELECT dish_id, actual_consumers, static_plan_servings, avg_rating FROM dish_outcomes WHERE meal_id = $1 ORDER BY dish_id', [mealId(run2, 31, 'breakfast')]);
    expect(without).toEqual(withMl);
  });

  it('failure policy: 422 no retry; 500 then ok = 2 attempts; 503 ×2 and timeout ×2 = unavailable; fixed-plan fallback', async () => {
    const runId = await toDay31();
    const B = mealId(runId, 31, 'breakfast');
    const L = mealId(runId, 31, 'lunch');
    await step(1); // lunch opens
    mock.state.queue = [422]; await step(1); // breakfast provisional
    mock.state.queue = [500, 'ok']; await step(1); // breakfast final
    await step(2); // dinner opens, breakfast completes
    mock.state.queue = [503, 503]; await step(1); // lunch provisional
    mock.state.queue = ['timeout', 'timeout']; await step(1); // lunch final
    await step(1); // lunch completes

    expect((await preds(B, 'provisional')).map((p) => [p.attempt, p.status, p.http_status, p.reason, p.is_current]))
      .toEqual([[1, 'error', 422, 'ml_rejected_request', true]]);
    expect((await preds(B, 'final')).map((p) => [p.attempt, p.status, p.http_status, p.reason, p.is_current]))
      .toEqual([[1, 'unavailable', 500, 'http_500', false], [2, 'ok', 200, null, true]]);
    expect((await preds(L, 'provisional')).map((p) => [p.attempt, p.status, p.http_status, p.reason, p.is_current]))
      .toEqual([[1, 'unavailable', 503, 'http_503', false], [2, 'unavailable', 503, 'http_503', true]]);
    expect((await preds(L, 'final')).map((p) => [p.attempt, p.status, p.reason, p.is_current]))
      .toEqual([[1, 'unavailable', 'timeout', false], [2, 'unavailable', 'timeout', true]]);
    // exactly: 1 (422) + 2 (500, ok) + 2 (503, 503) + 2 (timeouts) predict calls
    expect(mock.predictRequests()).toHaveLength(7);
    expect((await one('SELECT count(*)::int n FROM prediction_items i JOIN prediction_requests r ON r.id = i.request_id WHERE r.status <> $1', ['ok'])).n).toBe(0);
    // breakfast cooked from the successful final prediction; lunch fell back to the fixed plan
    expect((await one('SELECT count(*)::int n FROM dish_outcomes WHERE meal_id = $1 AND prepared_servings <> static_plan_servings', [L])).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM dish_outcomes WHERE meal_id = $1', [L])).n).toBeGreaterThan(0);
  });

  it('health HTTP 200 with model_loaded=false: no /predict call, recorded unavailable (model_not_loaded); health cached 60 s; model-info read once', async () => {
    const runId = await toDay31();
    await step(2); // first prediction: health + model-info read
    expect([mock.count('/health'), mock.count('/model-info')]).toEqual([1, 1]);
    await step(1); // final within 60 s: cached health, no new reads
    expect([mock.count('/health'), mock.count('/model-info')]).toEqual([1, 1]);
    mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    await step(3); // dinner opens, breakfast completes, lunch provisional — still cached as ready
    expect(mock.predictRequests()).toHaveLength(3);
    clock += 60_001; // cache expires
    const before = mock.predictRequests().length;
    await step(1); // lunch final
    expect(mock.count('/health')).toBe(2);
    expect(mock.predictRequests()).toHaveLength(before);
    expect((await preds(mealId(runId, 31, 'lunch'), 'final')).map((p) => [p.status, p.reason])).toEqual([['unavailable', 'model_not_loaded']]);
    expect(mock.count('/model-info')).toBe(1);
  });

  it.each([
    ['an out-of-range prediction', 'out_of_range'],
    ['an unknown extra field', 'malformed'],
    ['reordered predictions', 'wrong_order'],
    ['a non-JSON body', 'not_json'],
  ])('a 200 response with %s is rejected as invalid_response (no retry, nothing stored as a prediction)', async (_, behaviour) => {
    const runId = await toDay31();
    await step(1);
    mock.state.queue = [behaviour];
    await step(1);
    const [p] = await preds(mealId(runId, 31, 'breakfast'), 'provisional');
    expect([p.status, p.reason, p.response_payload]).toEqual(['error', 'invalid_response', null]);
    expect(mock.predictRequests()).toHaveLength(1);
    expect((await one('SELECT count(*)::int n FROM prediction_items')).n).toBe(0);
  });

  it('an unreachable ML service never blocks the simulation: everything is unavailable and the fixed plan is used', async () => {
    sim = createSimulationController({ pool: db, ml: createMlClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }), log: { error: () => {} } });
    const { run } = await sim.start({ seed: 42 }, null);
    await sim.advance({ to: 'day', day: 33 });
    const s = await sim.status();
    expect([s.current_day, s.phase]).toEqual([33, 'active']);
    const rows = await all("SELECT DISTINCT status, error_detail->>'reason' AS reason FROM prediction_requests");
    expect(rows).toEqual([{ status: 'unavailable', reason: 'health_unreachable' }]);
    expect((await one(`SELECT count(*)::int n FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
      WHERE m.run_id = $1 AND m.phase = 'active' AND o.prepared_servings <> o.static_plan_servings`, [run.id])).n).toBe(0);
  });

  // -------------------------------------------------------------------------
  describe('administrator retry', () => {
    const retry = (agent, id, kind) => agent.post(`/api/admin/meals/${id}/predictions/${kind}/retry`).set('Content-Type', 'application/json').send({});

    it('re-sends the stored request; success becomes current; the kitchen then uses it if the meal is not completed yet', async () => {
      const runId = await toDay31();
      const L = mealId(runId, 31, 'lunch');
      await step(5);
      mock.state.queue = [503, 503]; await step(1); // lunch provisional unavailable
      mock.state.queue = [503, 503]; await step(1); // lunch final unavailable (12:00), lunch completes at 13:15
      const stored = (await preds(L, 'final'))[1].request_payload;
      const before = mock.predictRequests().length;

      expect((await retry(student, L, 'final')).status).toBe(403);
      expect((await retry(request(app), L, 'final')).status).toBe(401);
      expect((await retry(admin, L, 'tomorrow')).status).toBe(400);

      const res = await retry(admin, L, 'final');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ attempt: 3, status: 'ok', applies_to_kitchen: true }); // lunch not yet completed
      expect(mock.predictRequests().slice(before).map((r) => r.body)).toEqual([stored]); // exactly the stored request
      const final = await preds(L, 'final');
      expect(final.map((p) => [p.attempt, p.status, p.is_current])).toEqual([[1, 'unavailable', false], [2, 'unavailable', false], [3, 'ok', true]]);
      const audit = await one("SELECT entity, before, after FROM audit_log WHERE action = 'prediction.retry' ORDER BY id DESC LIMIT 1");
      expect(audit).toEqual({ entity: `meal:${L}:final`, before: { attempt: 2, status: 'unavailable' }, after: { attempt: 3, status: 'ok' } });

      expect((await retry(admin, L, 'final')).status).toBe(409); // already ok
      await step(1); // lunch completes: uses the retried final prediction
      const o = await all(`SELECT o.prepared_servings, i.predicted_consumers FROM dish_outcomes o
        JOIN prediction_items i ON i.meal_id = o.meal_id AND i.dish_id = o.dish_id
        JOIN prediction_requests r ON r.id = i.request_id AND r.is_current AND r.kind = 'final' WHERE o.meal_id = $1`, [L]);
      expect(o.length).toBeGreaterThan(0);
      expect(o.every((r) => r.prepared_servings === Math.round(r.predicted_consumers * 1.05))).toBe(true);
    });

    it('a late final retry after completion is recorded only; outcomes are not recalculated', async () => {
      const runId = await toDay31();
      const B = mealId(runId, 31, 'breakfast');
      await step(1);
      await step(1); // provisional ok
      mock.state.queue = [503, 503]; await step(1); // final unavailable
      await step(2); // breakfast completes with the fixed plan
      const before = await all('SELECT * FROM dish_outcomes WHERE meal_id = $1 ORDER BY dish_id', [B]);
      const res = await retry(admin, B, 'final');
      expect(res.body).toMatchObject({ status: 'ok', applies_to_kitchen: false }); // breakfast already completed
      expect(await all('SELECT * FROM dish_outcomes WHERE meal_id = $1 ORDER BY dish_id', [B])).toEqual(before);
      expect(before.every((r) => r.prepared_servings === r.static_plan_servings)).toBe(true);
    });

    it('rejects retries for learning meals, unscheduled predictions and unknown meals; a failed retry is recorded too', async () => {
      const runId = await toDay31();
      expect((await retry(admin, mealId(runId, 10, 'lunch'), 'final')).body.error.code).toBe('learning_meal');
      expect((await retry(admin, mealId(runId, 31, 'dinner'), 'final')).body.error.code).toBe('no_prediction_yet');
      expect((await retry(admin, 'r999-d031-lunch', 'final')).status).toBe(404);
      await step(1);
      mock.state.queue = [422]; await step(1);
      mock.state.queue = [503, 503];
      const res = await retry(admin, mealId(runId, 31, 'breakfast'), 'provisional');
      expect(res.body).toMatchObject({ attempt: 3, status: 'unavailable' });
    });

    it('the meal detail shows every attempt with status and reason, and the ok items', async () => {
      const runId = await toDay31();
      await step(1);
      mock.state.queue = [500, 'ok']; await step(1);
      const detail = (await admin.get(`/api/admin/meals/${mealId(runId, 31, 'breakfast')}`)).body;
      expect(detail.predictions.map((p) => [p.kind, p.attempt, p.status, p.reason, p.is_current])).toEqual([
        ['provisional', 1, 'unavailable', 'http_500', false], ['provisional', 2, 'ok', null, true]]);
      expect(detail.predictions[1].items.length).toBe(detail.dishes.length);
      expect(detail.predictions[0].items).toEqual([]);
      const st = (await admin.get('/api/admin/simulation')).body;
      expect(st.ml.health).toMatchObject({ ready: true });
      expect(st.ml.model_info).toMatchObject({ model_version: 'rf-v1-synthetic', contract_version: '0.3' });
    });
  });

  it('the mock answers are contract-shaped (sanity check of the test double)', () => {
    const a = fakeAnswer({ meal_id: 'm', total_students: 1000, dishes: [{ dish_id: 'D1', interested_taps: 500 }] });
    expect(a.predictions[0].predicted_consumers).toBe(1000);
  });
});
