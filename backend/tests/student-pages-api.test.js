// Phase 6: GET /api/student/meals/responses — the student's own responses (read-only), visibility rule, access control.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSimulationController } from '../src/simulation/controller.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

describe.skipIf(!DATABASE_URL)('GET /api/student/meals/responses', { timeout: 60_000 }, () => {
  let ctx; let db; let sim; let app; let student; let admin; let runId;
  const put = (id, body) => student.put(`/api/student/meals/${id}/response`).set('Content-Type', 'application/json').send(body);

  beforeAll(async () => {
    ctx = await createTestSchema('p6_student', { seeded: true });
    db = ctx.pool;
    sim = createSimulationController({ pool: db, log: { error: () => {} } });
    app = buildApp(db, { simulation: sim });
    await createUser(db, { email: 'admin@example.test', role: 'admin' });
    await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    student = await signedIn(app, 'demo@example.test');
    admin = await signedIn(app, 'admin@example.test');
  });
  afterAll(async () => { await sim?.shutdown(); await ctx?.drop(); });

  it('is empty before a run exists', async () => {
    expect((await student.get('/api/student/meals/responses')).body).toEqual({ sim_now: null, responses: [] });
  });

  it('lists my answers newest first, with picked dishes and whether they can still change', async () => {
    runId = Number((await sim.start({ seed: 3 }, null)).run.id);
    await sim.advance({ to: 'next_step' }); // breakfast opens
    await sim.advance({ to: 'next_step' }); // lunch opens (00:30)
    const b = `r${runId}-d001-breakfast`; const l = `r${runId}-d001-lunch`;
    const lunchMenu = (await db.query('SELECT dish_id FROM meal_dishes WHERE meal_id = $1 ORDER BY position', [l])).rows.map((r) => r.dish_id);
    expect((await put(b, { response: 'not_eating' })).status).toBe(200);
    expect((await put(l, { response: 'eating', dish_ids: [lunchMenu[1], lunchMenu[0]] })).status).toBe(200);
    const res = await student.get('/api/student/meals/responses');
    expect(res.status).toBe(200);
    const mine = res.body.responses.filter((r) => [b, l].includes(r.meal_id));
    expect(mine.map((r) => [r.meal_id, r.response, r.dishes.map((d) => d.dish_id), r.can_change])).toEqual([
      [l, 'eating', [lunchMenu[0], lunchMenu[1]], true], [b, 'not_eating', [], true]]);
    expect(mine[0].dishes[0]).toHaveProperty('display_name');
  });

  it('never shows a response stamped after the simulated time (synthetic votes are generated ahead)', async () => {
    const l = `r${runId}-d001-lunch`;
    const { rows: [orig] } = await db.query('SELECT responded_at FROM meal_responses WHERE meal_id = $1 AND student_id = 1', [l]);
    await db.query("UPDATE meal_responses SET responded_at = (SELECT sim_now FROM simulation_runs) + interval '1 hour' WHERE meal_id = $1 AND student_id = 1", [l]);
    try {
      const listed = (await student.get('/api/student/meals/responses')).body.responses.map((r) => r.meal_id);
      expect(listed).not.toContain(l);
      expect(listed).toContain(`r${runId}-d001-breakfast`);
    } finally {
      await db.query('UPDATE meal_responses SET responded_at = $2 WHERE meal_id = $1 AND student_id = 1', [l, orig.responded_at]);
    }
  });

  it('marks answers of closed meals as not changeable', async () => {
    await sim.advance({ to: 'day', day: 2 });
    const listed = (await student.get('/api/student/meals/responses')).body.responses;
    expect(listed.filter((r) => r.meal_id.includes('-d001-')).every((r) => r.can_change === false)).toBe(true);
  });

  it('is student-only', async () => {
    expect((await request(app).get('/api/student/meals/responses')).status).toBe(401);
    expect((await admin.get('/api/student/meals/responses')).status).toBe(403);
  });
});
