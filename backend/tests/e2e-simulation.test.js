// Phase 8: end-to-end check of a full 60-day run driven through the HTTP API, as in the demo: admin starts a run,
// the demo student votes, the run is advanced to the end, then reports and the training export are checked against
// the stored rows. PostgreSQL + a MOCK ML service (the real ML service is not exercised here). A second run with the
// same seed after a typed reset must produce a byte-identical training export (determinism).

import { createHash } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMlClient } from '../src/ml/client.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { preparedFromPrediction } from '../src/simulation/outcomes.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';
import { startMockMl } from './helpers/mock-ml.js';

const SEED = 2026;
const sha = (s) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!DATABASE_URL)('end-to-end 60-day run (Phase 8)', { timeout: 600_000 }, () => {
  let ctx; let db; let mock; let sim; let app; let admin; let student; let runId; let firstExport;
  const post = (agent, path, body = {}) => agent.post(path).set('Content-Type', 'application/json').send(body);

  async function runToEnd() {
    let status = (await admin.get('/api/admin/simulation')).body;
    for (let guard = 0; status.run.status !== 'completed' && guard < 70; guard += 1) {
      const res = await post(admin, '/api/admin/simulation/advance', { to: 'end_of_day' });
      expect(res.status).toBe(200);
      status = (await admin.get('/api/admin/simulation')).body;
    }
    return status;
  }

  beforeAll(async () => {
    ctx = await createTestSchema('p8_e2e', { seeded: true });
    db = ctx.pool;
    mock = await startMockMl();
    const ml = createMlClient({ baseUrl: mock.url, timeoutMs: 300 });
    sim = createSimulationController({ pool: db, ml, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim, ml });
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');

    expect((await post(admin, '/api/admin/simulation/start', { seed: SEED })).status).toBe(201);
    runId = Number((await admin.get('/api/admin/simulation')).body.run.id);

    // Demo flow: jump to Day 31, the student votes Not Eating for the first open meal and picks dishes for the next.
    expect((await post(admin, '/api/admin/simulation/advance', { to: 'day', day: 31 })).status).toBe(200);
    await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
    await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
    const open = (await student.get('/api/student/meals/upcoming')).body.meals;
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect((await student.put(`/api/student/meals/${open[0].meal_id}/response`).send({ response: 'not_eating' })).status).toBe(200);
    if (open[1]) {
      const dishIds = open[1].menu.slice(0, 2).map((d) => d.dish_id);
      expect((await student.put(`/api/student/meals/${open[1].meal_id}/response`).send({ response: 'eating', dish_ids: dishIds })).status).toBe(200);
    }
    // One ML outage on the next prediction: the kitchen must fall back to the fixed plan where the final is not ok.
    mock.state.queue = [503, 503];
  });
  afterAll(async () => { await sim?.shutdown(); await mock?.close(); await ctx?.drop(); });

  it('runs all 60 days to completion: 180 completed meals, every step once, no meal left behind', async () => {
    const status = await runToEnd();
    expect(status.run.status).toBe('completed');
    expect(status.meals).toEqual({ total: 180, completed: 180 });
    const { rows: [c] } = await db.query(`SELECT
        (SELECT count(*) FROM meals WHERE status = 'completed' AND headcount IS NOT NULL)::int meals,
        (SELECT count(*) FROM meal_dishes md WHERE NOT EXISTS (SELECT 1 FROM dish_outcomes o WHERE o.meal_id = md.meal_id AND o.dish_id = md.dish_id))::int missing_outcomes,
        (SELECT count(*) FROM prediction_requests r JOIN meals m ON m.id = r.meal_id WHERE m.phase = 'learning')::int learning_predictions,
        (SELECT count(*) FROM (SELECT meal_id, kind FROM prediction_requests WHERE is_current GROUP BY 1, 2) x)::int current_kinds`);
    expect(c).toEqual({ meals: 180, missing_outcomes: 0, learning_predictions: 0, current_kinds: 90 * 2 });
    // further advancing is refused once the run has finished
    expect((await post(admin, '/api/admin/simulation/advance', { to: 'next_step' })).status).toBe(409);
  });

  it('the demo student’s answers are stored and listed', async () => {
    const mine = (await student.get('/api/student/meals/responses')).body.responses;
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((r) => r.can_change === false)).toBe(true);
    expect(mine.some((r) => r.meal_id.startsWith(`r${runId}-d031-`))).toBe(true);
  });

  it('kitchen rule: final × 1.05 when the current final is ok, else the fixed plan (no fabricated predictions)', async () => {
    const { rows } = await db.query(
      `SELECT m.phase, o.prepared_servings, o.static_plan_servings, i.predicted_consumers
         FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
         LEFT JOIN prediction_requests r ON r.meal_id = o.meal_id AND r.kind = 'final' AND r.is_current AND r.status = 'ok'
         LEFT JOIN prediction_items i ON i.request_id = r.id AND i.dish_id = o.dish_id`);
    let predicted = 0; let fallback = 0;
    for (const r of rows) {
      if (r.phase === 'active' && r.predicted_consumers !== null) {
        predicted += 1;
        expect(r.prepared_servings).toBe(preparedFromPrediction(r.predicted_consumers));
      } else {
        fallback += 1;
        expect(r.prepared_servings).toBe(r.static_plan_servings);
      }
    }
    expect(predicted).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(0);
    const { rows: [u] } = await db.query("SELECT count(*)::int n FROM prediction_requests WHERE is_current AND status <> 'ok'");
    expect(u.n).toBeGreaterThanOrEqual(1);
  });

  it('reports are consistent with each other and with the stored rows', async () => {
    const acc = (await admin.get('/api/admin/reports/accuracy')).body;
    const waste = (await admin.get('/api/admin/reports/waste')).body;
    expect(waste.learning).toMatchObject({ days: 30, meals: 90 });
    expect(waste.active).toMatchObject({ days: 30, meals: 90 });
    expect(waste.by_day).toHaveLength(60);
    expect(waste.by_day.reduce((a, d) => a + d.meals, 0)).toBe(180);
    for (const kind of ['provisional', 'final']) {
      const s = acc[kind].current_status;
      expect(s.ok + s.unavailable + s.error).toBe(90);
      expect(acc[kind].by_day.map((d) => d.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 31));
      expect(acc[kind].by_day.reduce((a, d) => a + d.n, 0)).toBe(acc[kind].overall.n);
    }
    const { rows: [{ ok_final_items }] } = await db.query(
      "SELECT count(*)::int ok_final_items FROM prediction_items i JOIN prediction_requests r ON r.id = i.request_id WHERE r.kind = 'final' AND r.is_current AND r.status = 'ok'");
    expect(acc.final.overall.n).toBe(ok_final_items);
  });

  it('training export: one contract row per dish serving of the 180 completed meals', async () => {
    const res = await admin.get('/api/admin/export/training.csv');
    expect(res.status).toBe(200);
    const lines = res.text.trimEnd().split('\n');
    const { rows: [{ n }] } = await db.query('SELECT count(*)::int n FROM meal_dishes');
    expect(lines.length - 1).toBe(n);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(180);
    firstExport = res.text;
  });

  it('is deterministic: reset and the same seed give a byte-identical export', async () => {
    expect((await post(admin, '/api/admin/simulation/reset', { confirm: 'RESET' })).status).toBe(200);
    expect((await request(app).get('/api/admin/export/training.csv')).status).toBe(401);
    mock.state.queue = [];
    expect((await post(admin, '/api/admin/simulation/start', { seed: SEED })).status).toBe(201);
    const newRun = Number((await admin.get('/api/admin/simulation')).body.run.id);
    // Same simulated choices as the first run: the student's votes and the same ML outage at the same step.
    expect((await post(admin, '/api/admin/simulation/advance', { to: 'day', day: 31 })).status).toBe(200);
    await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
    await post(admin, '/api/admin/simulation/advance', { to: 'next_step' });
    const open = (await student.get('/api/student/meals/upcoming')).body.meals;
    await student.put(`/api/student/meals/${open[0].meal_id}/response`).send({ response: 'not_eating' });
    if (open[1]) await student.put(`/api/student/meals/${open[1].meal_id}/response`).send({ response: 'eating', dish_ids: open[1].menu.slice(0, 2).map((d) => d.dish_id) });
    mock.state.queue = [503, 503];
    await runToEnd();
    const second = (await admin.get('/api/admin/export/training.csv')).text;
    // meal IDs carry the run id; everything else must match exactly
    const norm = (csv, id) => csv.replaceAll(`r${id}-d`, 'rX-d');
    expect(sha(norm(second, newRun))).toBe(sha(norm(firstExport, runId)));
  });
});
