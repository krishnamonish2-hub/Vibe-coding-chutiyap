// Phase 5: read-only summary fields on GET /api/admin/meals (prediction status per kind, outcome totals), against
// PostgreSQL and a MOCK ML service. Existing fields stay unchanged; access stays admin-only.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMlClient } from '../src/ml/client.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';
import { startMockMl } from './helpers/mock-ml.js';

describe.skipIf(!DATABASE_URL)('GET /api/admin/meals summary (Phase 5)', { timeout: 120_000 }, () => {
  let ctx;
  let db;
  let mock;
  let sim;
  let app;
  let admin;
  let student;
  let runId;

  beforeAll(async () => {
    ctx = await createTestSchema('p5_ui', { seeded: true });
    db = ctx.pool;
    mock = await startMockMl();
    const ml = createMlClient({ baseUrl: mock.url, timeoutMs: 300 });
    sim = createSimulationController({ pool: db, ml, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim, ml });
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');

    runId = Number((await sim.start({ seed: 42 }, null)).run.id);
    await sim.advance({ to: 'day', day: 31 });
    // Day 31: lunch opens; breakfast provisional ok; breakfast final 500 -> ok (2 attempts); dinner opens;
    // breakfast completes; lunch provisional 503 x2; lunch final ok; lunch completes.
    await sim.advance({ to: 'next_step' });
    await sim.advance({ to: 'next_step' });
    mock.state.queue = [500, 'ok']; await sim.advance({ to: 'next_step' });
    await sim.advance({ to: 'next_step' });
    await sim.advance({ to: 'next_step' });
    mock.state.queue = [503, 503]; await sim.advance({ to: 'next_step' });
    await sim.advance({ to: 'next_step' });
    await sim.advance({ to: 'next_step' });
  });
  afterAll(async () => { await sim?.shutdown(); await mock?.close(); await ctx?.drop(); });

  const id = (day, mt) => `r${runId}-d${String(day).padStart(3, '0')}-${mt}`;
  const list = async (q = '') => (await admin.get(`/api/admin/meals${q}`)).body.meals;

  it('keeps every existing field and adds provisional, final and outcomes', async () => {
    const [m] = await list('?day=31');
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['id', 'day', 'date', 'meal_type', 'phase', 'status', 'serve_at',
      'prov_total_responses', 'final_total_responses', 'headcount', 'provisional', 'final', 'outcomes']));
  });

  it('reports the current prediction per kind with reason and number of attempts', async () => {
    const meals = await list('?day=31');
    const b = meals.find((m) => m.id === id(31, 'breakfast'));
    const l = meals.find((m) => m.id === id(31, 'lunch'));
    const d = meals.find((m) => m.id === id(31, 'dinner'));
    expect([b.provisional, b.final]).toEqual([{ status: 'ok', reason: null, attempts: 1 }, { status: 'ok', reason: null, attempts: 2 }]);
    expect([l.provisional, l.final]).toEqual([{ status: 'unavailable', reason: 'http_503', attempts: 2 }, { status: 'ok', reason: null, attempts: 1 }]);
    expect([d.provisional, d.final]).toEqual([null, null]); // not scheduled yet
  });

  it('learning meals have no predictions; completed meals have outcome totals equal to their dish rows', async () => {
    const meals = await list('?day=30');
    expect(meals.every((m) => m.provisional === null && m.final === null)).toBe(true);
    for (const m of [...meals, ...(await list('?day=31')).filter((x) => x.status === 'completed')]) {
      const { rows: [t] } = await db.query(`SELECT count(*)::int dishes, sum(prepared_servings)::int prepared, sum(static_plan_servings)::int static,
          sum(actual_consumers)::int actual, round(sum(leftover_kg)::numeric, 1)::float8 leftover,
          round(sum(static_plan_leftover_kg)::numeric, 1)::float8 static_leftover, sum(shortfall_servings)::int shortfall
        FROM dish_outcomes WHERE meal_id = $1`, [m.id]);
      expect(m.outcomes).toEqual({ dishes: t.dishes, prepared_servings: t.prepared, static_plan_servings: t.static,
        actual_consumers: t.actual, leftover_kg: t.leftover, static_plan_leftover_kg: t.static_leftover,
        shortfall_servings: t.shortfall, edited: false });
    }
  });

  it('meals that are not completed have no outcomes; the list without ?day covers the whole run', async () => {
    const all = await list();
    expect(all).toHaveLength(180);
    expect(all.filter((m) => m.status !== 'completed').every((m) => m.outcomes === null)).toBe(true);
    expect(all.filter((m) => m.status === 'completed')).toHaveLength(92);
  });

  it('marks outcomes edited by the admin', async () => {
    const mealId = id(30, 'dinner');
    const dish = (await admin.get(`/api/admin/meals/${mealId}`)).body.dishes[0];
    await admin.put(`/api/admin/meals/${mealId}/outcomes`).set('Content-Type', 'application/json')
      .send({ dishes: [{ dish_id: dish.dish_id, actual_consumers: dish.actual_consumers }] });
    expect((await list('?day=30')).find((m) => m.id === mealId).outcomes.edited).toBe(true);
  });

  it('stays admin-only', async () => {
    expect((await request(app).get('/api/admin/meals')).status).toBe(401);
    expect((await student.get('/api/admin/meals')).status).toBe(403);
  });
});
