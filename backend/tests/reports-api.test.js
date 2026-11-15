// Phase 7: accuracy and waste reports, and the contract §3 training-data CSV export. PostgreSQL + a MOCK ML service
// (the real ML service is not exercised here). Every expected value is recomputed directly from the stored rows.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMlClient } from '../src/ml/client.js';
import { EXPORT_COLUMNS } from '../src/services/reports.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';
import { startMockMl } from './helpers/mock-ml.js';

const CONTRACT_HEADER = 'meal_id,date,meal_type,total_students,is_holiday,is_exam_day,is_festival,temperature,rainfall,'
  + 'total_responses,meal_attendance,dish_id,dish_name,dish_category,is_veg,is_special,interested_taps,'
  + 'actual_dish_consumers,leftover_kg,post_meal_rating';

function parseCsv(text) {
  const [head, ...lines] = text.trimEnd().split('\n');
  return { head, rows: lines.map((l) => l.split(',')) }; // no field contains a comma or quote in the seed data
}

describe.skipIf(!DATABASE_URL)('reports and training export (Phase 7)', { timeout: 180_000 }, () => {
  let ctx; let db; let mock; let sim; let app; let admin; let student; let runId;

  beforeAll(async () => {
    ctx = await createTestSchema('p7_reports', { seeded: true });
    db = ctx.pool;
    mock = await startMockMl();
    const ml = createMlClient({ baseUrl: mock.url, timeoutMs: 300 });
    sim = createSimulationController({ pool: db, ml, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim, ml });
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');
  });
  afterAll(async () => { await sim?.shutdown(); await mock?.close(); await ctx?.drop(); });

  it('answer 404 before a run exists', async () => {
    for (const p of ['/api/admin/reports/accuracy', '/api/admin/reports/waste', '/api/admin/export/training.csv']) {
      const res = await admin.get(p);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('no_simulation_run');
    }
  });

  describe('after Day 32 with predictions (one ML outage on Day 32 breakfast)', () => {
    beforeAll(async () => {
      runId = Number((await sim.start({ seed: 7 }, null)).run.id);
      await sim.advance({ to: 'day', day: 32 });
      mock.state.queue = [503, 503, 503, 503]; // Day 32 breakfast: provisional and final both unavailable
      await sim.advance({ to: 'day', day: 33 });
    });

    it('accuracy: MAE / bias / baseline equal a direct recomputation; outages are counted, not hidden', async () => {
      const res = await admin.get('/api/admin/reports/accuracy');
      expect(res.status).toBe(200);
      expect(res.body.synthetic).toBe(true);
      for (const kind of ['provisional', 'final']) {
        const { rows: [e] } = await db.query(
          `SELECT count(*)::int n, avg(abs(i.predicted_consumers - o.actual_consumers))::float8 mae,
                  avg(i.predicted_consumers - o.actual_consumers)::float8 bias,
                  avg(abs(i.hist_demand - o.actual_consumers))::float8 base
             FROM prediction_requests r JOIN meals m ON m.id = r.meal_id AND m.status = 'completed'
             JOIN prediction_items i ON i.request_id = r.id
             JOIN dish_outcomes o ON o.meal_id = i.meal_id AND o.dish_id = i.dish_id
            WHERE r.is_current AND r.status = 'ok' AND r.kind = $1`, [kind]);
        const k = res.body[kind];
        expect(e.n).toBeGreaterThan(0);
        expect(k.overall.n).toBe(e.n);
        expect(k.overall.mae).toBeCloseTo(e.mae, 2);
        expect(k.overall.bias).toBeCloseTo(e.bias, 2);
        expect(k.overall.baseline_mae).toBeCloseTo(e.base, 2);
        expect(Object.values(k.by_meal_type).reduce((a, m) => a + m.n, 0)).toBe(e.n);
        expect(k.by_day.map((d) => d.day)).toEqual([31, 32]);
        expect(k.current_status.unavailable).toBeGreaterThanOrEqual(1);
      }
      // Day 32 breakfast had no ok prediction, so it is excluded from the accuracy pairs
      const { rows } = await db.query(`SELECT kind, status FROM prediction_requests WHERE meal_id = $1 AND is_current ORDER BY kind`, [`r${runId}-d032-breakfast`]);
      expect(rows).toEqual([{ kind: 'final', status: 'unavailable' }, { kind: 'provisional', status: 'unavailable' }]);
      expect(res.body.models).toEqual([{ model_version: expect.any(String), trained_on: expect.any(String) }]);
    });

    it('waste: per-period totals equal the stored outcome rows; savings = fixed plan − actual leftovers', async () => {
      const res = await admin.get('/api/admin/reports/waste');
      expect(res.status).toBe(200);
      const { rows } = await db.query(
        `SELECT m.phase, count(DISTINCT m.id)::int meals, count(DISTINCT m.day_number)::int days,
                sum(o.prepared_servings)::int prepared, sum(o.static_plan_servings)::int static_plan,
                sum(o.actual_consumers)::int actual, sum(o.shortfall_servings)::int shortfall,
                sum(o.leftover_kg)::float8 lk, sum(o.static_plan_leftover_kg)::float8 sk
           FROM meals m JOIN dish_outcomes o ON o.meal_id = m.id WHERE m.status = 'completed' GROUP BY m.phase`);
      for (const r of rows) {
        const t = res.body[r.phase];
        expect([t.days, t.meals, t.prepared, t.static_plan, t.actual, t.shortfall])
          .toEqual([r.days, r.meals, r.prepared, r.static_plan, r.actual, r.shortfall]);
        expect(t.leftover_kg).toBeCloseTo(r.lk, 0);
        expect(t.static_plan_leftover_kg).toBeCloseTo(r.sk, 0);
        expect(t.leftover_saved_kg).toBeCloseTo(t.static_plan_leftover_kg - t.leftover_kg, 1);
      }
      expect(res.body.learning).toMatchObject({ days: 30, meals: 90 });
      expect(res.body.active).toMatchObject({ days: 2, meals: 6 });
      // learning period: the kitchen cooks the fixed plan, so the two leftover figures are the same
      expect(res.body.learning.leftover_kg).toBe(res.body.learning.static_plan_leftover_kg);
      expect(res.body.by_day).toHaveLength(32);
    });

    it('export: exact contract §3 header, one row per dish of each completed meal, values from the stored rows', async () => {
      const res = await admin.get('/api/admin/export/training.csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="messmind-training-export-run${runId}.csv"`);
      const { head, rows } = parseCsv(res.text);
      expect(head).toBe(CONTRACT_HEADER);
      expect(EXPORT_COLUMNS.join(',')).toBe(CONTRACT_HEADER);
      const { rows: [{ n }] } = await db.query(`SELECT count(*)::int n FROM meal_dishes md JOIN meals m ON m.id = md.meal_id WHERE m.status = 'completed'`);
      expect(rows).toHaveLength(n);
      expect(rows.every((r) => r.length === EXPORT_COLUMNS.length)).toBe(true);
      expect(new Set(rows.map((r) => r[0]))).not.toContain(`r${runId}-d033-lunch`); // not completed

      const col = (name) => EXPORT_COLUMNS.indexOf(name);
      const sample = rows.find((r) => r[0] === `r${runId}-d031-lunch`);
      const { rows: [want] } = await db.query(
        `SELECT m.final_total_responses, m.headcount, md.ml_dish_name, c.final_taps, o.actual_consumers, o.avg_rating, d.is_holiday
           FROM meals m JOIN meal_dishes md ON md.meal_id = m.id AND md.position = 1
           JOIN meal_dish_counts c ON c.meal_id = md.meal_id AND c.dish_id = md.dish_id
           JOIN dish_outcomes o ON o.meal_id = md.meal_id AND o.dish_id = md.dish_id
           JOIN sim_days d ON d.run_id = m.run_id AND d.day_number = m.day_number WHERE m.id = $1`, [`r${runId}-d031-lunch`]);
      expect(sample[col('date')]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(sample[col('total_students')]).toBe('1000');
      expect(sample[col('total_responses')]).toBe(String(want.final_total_responses));
      expect(sample[col('meal_attendance')]).toBe(String(want.headcount));
      expect(sample[col('dish_name')]).toBe(want.ml_dish_name);
      expect(sample[col('interested_taps')]).toBe(String(want.final_taps));
      expect(sample[col('actual_dish_consumers')]).toBe(String(want.actual_consumers));
      expect(sample[col('post_meal_rating')]).toBe(want.avg_rating === null ? '' : String(want.avg_rating));
      expect(sample[col('is_holiday')]).toBe(want.is_holiday ? 'True' : 'False');
      expect(['True', 'False']).toContain(sample[col('is_veg')]);
    });

    it('the export uses the immutable ML dish name even after a display rename', async () => {
      const { rows: [d] } = await db.query(`SELECT md.dish_id, md.ml_dish_name FROM meal_dishes md WHERE md.meal_id = $1 AND md.position = 1`, [`r${runId}-d031-lunch`]);
      const before = (await admin.get('/api/admin/export/training.csv')).text;
      const { rows: [orig] } = await db.query('SELECT display_name FROM dishes WHERE id = $1', [d.dish_id]);
      await db.query('UPDATE dishes SET display_name = $2 WHERE id = $1', [d.dish_id, 'Renamed For Test']);
      try {
        const after = (await admin.get('/api/admin/export/training.csv')).text;
        expect(after).toBe(before);
        expect(after).not.toContain('Renamed For Test');
      } finally {
        await db.query('UPDATE dishes SET display_name = $2 WHERE id = $1', [d.dish_id, orig.display_name]);
      }
    });

    it('reading reports never changes data (row counts unchanged)', async () => {
      const count = async () => (await db.query(`SELECT (SELECT count(*) FROM prediction_requests)::int p,
        (SELECT count(*) FROM dish_outcomes)::int o, (SELECT sim_now FROM simulation_runs) s`)).rows[0];
      const before = await count();
      await admin.get('/api/admin/reports/accuracy');
      await admin.get('/api/admin/reports/waste');
      await admin.get('/api/admin/export/training.csv');
      expect(await count()).toEqual(before);
    });

    it('is admin-only', async () => {
      for (const p of ['/api/admin/reports/accuracy', '/api/admin/reports/waste', '/api/admin/export/training.csv']) {
        expect((await request(app).get(p)).status).toBe(401);
        expect((await student.get(p)).status).toBe(403);
      }
    });
  });
});
