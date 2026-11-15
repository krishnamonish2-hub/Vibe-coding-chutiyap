// Audit log service, the D6 reset service, and seeded login accounts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { accountsFromEnv, seed } from '../db/seed.js';
import { verifyPassword } from '../src/auth/password.js';
import { ApiError } from '../src/middleware/error-handler.js';
import { listAudit, recordAudit } from '../src/services/audit.js';
import { RESET_CONFIRMATION, resetSimulation } from '../src/services/simulation-reset.js';
import { createUser } from './helpers/app.js';
import {
  DATABASE_URL, createTestSchema, insertDay, insertMealDish, insertRow, insertRun, mealRow,
} from './helpers/db.js';

const RUN_TABLES = ['simulation_runs', 'sim_days', 'meals', 'meal_dishes', 'meal_responses', 'response_picks',
  'meal_dish_counts', 'prediction_requests', 'prediction_items', 'dish_outcomes'];

describe('accountsFromEnv', () => {
  const full = {
    ADMIN_EMAIL: 'Admin@Example.test', ADMIN_PASSWORD: 'admin password 1',
    DEMO_STUDENT_EMAIL: 'demo@example.test', DEMO_STUDENT_PASSWORD: 'student password 1',
  };

  it('reads both accounts; the demo student is linked to S0001', () => {
    const { accounts, skipped } = accountsFromEnv(full);
    expect(skipped).toEqual([]);
    expect(accounts).toEqual([
      { role: 'admin', email: 'admin@example.test', password: 'admin password 1', studentCode: null },
      { role: 'student', email: 'demo@example.test', password: 'student password 1', studentCode: 'S0001' },
    ]);
  });

  it('skips accounts that are not configured', () => {
    expect(accountsFromEnv({})).toEqual({ accounts: [], skipped: ['admin', 'student'] });
  });

  it.each([
    ['a short password', { ...full, ADMIN_PASSWORD: 'short' }, /ADMIN_PASSWORD/],
    ['a missing password', { ...full, DEMO_STUDENT_PASSWORD: '' }, /DEMO_STUDENT_PASSWORD/],
    ['an invalid email', { ...full, ADMIN_EMAIL: 'not-an-email' }, /ADMIN_EMAIL/],
    ['the same email twice', { ...full, DEMO_STUDENT_EMAIL: 'admin@example.test' }, /different/],
  ])('rejects %s', (_, env, message) => {
    expect(() => accountsFromEnv(env)).toThrow(message);
  });
});

describe.skipIf(!DATABASE_URL)('database services', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await createTestSchema('p3_audit', { seeded: true });
    db = ctx.pool;
  });
  afterAll(async () => ctx?.drop());

  const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const runScopedCounts = async () => Object.fromEntries(await Promise.all(RUN_TABLES.map(async (t) => [t, await count(t)])));

  // ---------------------------------------------------------------------------
  describe('recordAudit', () => {
    it('stores an entry with user, action, entity and JSON before/after', async () => {
      const user = await createUser(db, { email: 'auditor@example.test', role: 'admin' });
      const entry = await recordAudit(db, {
        userId: user.id, action: 'test.event', entity: 'thing:1', before: { a: 1 }, after: { a: 2, list: [1, 'x'] },
      });
      expect(entry).toMatchObject({ user_id: String(user.id), action: 'test.event', entity: 'thing:1',
        before: { a: 1 }, after: { a: 2, list: [1, 'x'] } });
      expect((await listAudit(db, { limit: 1 }))[0].id).toBe(entry.id);
    });

    it.each([
      ['an empty action', { action: '', entity: 'x' }],
      ['an empty entity', { action: 'x', entity: '' }],
      ['a too-long action', { action: 'x'.repeat(101), entity: 'x' }],
    ])('rejects %s', async (_, args) => {
      await expect(recordAudit(db, args)).rejects.toThrow(TypeError);
    });

    it('entries cannot be edited or deleted through the database', async () => {
      const entry = await recordAudit(db, { action: 'test.locked', entity: 'x' });
      await expect(db.query("UPDATE audit_log SET action = 'changed' WHERE id = $1", [entry.id])).rejects.toThrow(/append-only/);
      await expect(db.query('DELETE FROM audit_log WHERE id = $1', [entry.id])).rejects.toThrow(/append-only/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('resetSimulation (D6)', () => {
    let admin;

    beforeAll(async () => {
      admin = await createUser(db, { email: 'reset-admin@example.test', role: 'admin' });
    });
    beforeEach(async () => {
      await db.query('DELETE FROM simulation_runs');
    });

    // One run that touches every run-scoped table (synthetic values).
    async function fullRun() {
      const run = await insertRun(db);
      await insertDay(db, run.id, 31);
      const meal = await insertRow(db, 'meals', mealRow(run.id, 31, 'lunch', {
        status: 'completed', prov_total_responses: 300, prov_not_eating: 30,
        final_total_responses: 420, final_not_eating: 40, headcount: 790 }));
      await insertMealDish(db, meal.id, 'D012', 1);
      const resp = await insertRow(db, 'meal_responses', { meal_id: meal.id, student_id: 1, response: 'eating', responded_at: meal.voting_opens_at });
      await insertRow(db, 'response_picks', { response_id: resp.id, meal_id: meal.id, dish_id: 'D012' });
      await insertRow(db, 'meal_dish_counts', { meal_id: meal.id, dish_id: 'D012', prov_taps: 1, final_taps: 1 });
      const req = await insertRow(db, 'prediction_requests', { meal_id: meal.id, kind: 'final', attempt: 1, status: 'unavailable',
        request_payload: { meal_id: meal.id }, sim_at: meal.voting_closes_at });
      await insertRow(db, 'prediction_items', { request_id: req.id, meal_id: meal.id, dish_id: 'D012', interested_taps: 1, predicted_consumers: 2 });
      await insertRow(db, 'dish_outcomes', { meal_id: meal.id, dish_id: 'D012', actual_consumers: 640, prepared_servings: 700,
        static_plan_servings: 700, leftover_kg: 9, static_plan_leftover_kg: 9 });
      return run;
    }

    it.each([[undefined], [''], ['reset'], ['RESET ']])('requires the exact confirmation "RESET" (got %j)', async (confirm) => {
      const run = await fullRun();
      const err = await resetSimulation(db, { userId: admin.id, confirm }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect([err.status, err.code]).toEqual([400, 'confirmation_required']);
      expect((await db.query('SELECT id FROM simulation_runs')).rows[0].id).toBe(run.id);
    });

    it('returns 404 when there is no run', async () => {
      const err = await resetSimulation(db, { userId: admin.id, confirm: RESET_CONFIRMATION }).catch((e) => e);
      expect([err.status, err.code]).toEqual([404, 'no_simulation_run']);
    });

    it('writes a durable audit entry with the run ID and summary, then deletes every run-scoped row', async () => {
      const run = await fullRun();
      const { summary, auditId } = await resetSimulation(db, { userId: admin.id, confirm: RESET_CONFIRMATION });

      expect(summary).toMatchObject({
        run_id: Number(run.id), seed: 42, status: 'paused', start_date: '2026-07-06', total_days: 60,
        sim_now: '2026-07-05T19:30:00.000Z',
        counts: { days: 1, meals: 1, meals_completed: 1, responses: 1, outcomes: 1, prediction_attempts: { unavailable: 1 } },
      });
      expect(Object.values(await runScopedCounts()).every((n) => n === 0)).toBe(true);
      expect(await count('dishes')).toBe(38);
      expect(await count('students')).toBe(1000);

      const { rows } = await db.query('SELECT user_id, action, entity, before FROM audit_log WHERE id = $1', [auditId]);
      expect(rows[0]).toEqual({ user_id: String(admin.id), action: 'simulation.reset', entity: `simulation_run:${run.id}`, before: summary });
    });

    it('if the delete fails, nothing is deleted, no reset entry remains, and reset_failed is recorded', async () => {
      const run = await fullRun();
      const resetsBefore = Number((await db.query("SELECT count(*) FROM audit_log WHERE action = 'simulation.reset'")).rows[0].count);
      await db.query(`CREATE FUNCTION block_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated failure during delete'; END $$`);
      await db.query('CREATE TRIGGER block_delete BEFORE DELETE ON simulation_runs FOR EACH ROW EXECUTE FUNCTION block_delete()');
      try {
        await expect(resetSimulation(db, { userId: admin.id, confirm: RESET_CONFIRMATION })).rejects.toThrow(/simulated failure/);
      } finally {
        await db.query('DROP TRIGGER block_delete ON simulation_runs');
        await db.query('DROP FUNCTION block_delete()');
      }
      expect(Object.values(await runScopedCounts()).every((n) => n === 1)).toBe(true);
      const resetsAfter = Number((await db.query("SELECT count(*) FROM audit_log WHERE action = 'simulation.reset'")).rows[0].count);
      expect(resetsAfter).toBe(resetsBefore);
      const { rows } = await db.query("SELECT user_id, entity, after FROM audit_log WHERE action = 'simulation.reset_failed' ORDER BY id DESC LIMIT 1");
      expect(rows[0]).toMatchObject({ user_id: String(admin.id), entity: `simulation_run:${run.id}` });
      expect(rows[0].after.message).toMatch(/simulated failure/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('seeded accounts', () => {
    const accounts = [
      { role: 'admin', email: 'seed-admin@example.test', password: 'admin password 1', studentCode: null },
      { role: 'student', email: 'seed-demo@example.test', password: 'student password 1', studentCode: 'S0001' },
    ];

    it('creates the admin and the demo student linked to S0001, with hashed passwords and audit entries', async () => {
      expect((await seed(db, { accounts, bcryptRounds: 4 })).accountsCreated).toBe(2);
      const { rows } = await db.query(`SELECT u.email, u.role, u.password_hash, s.code
        FROM users u LEFT JOIN students s ON s.id = u.student_id WHERE u.email LIKE 'seed-%' ORDER BY u.email`);
      expect(rows.map((r) => [r.email, r.role, r.code])).toEqual([
        ['seed-admin@example.test', 'admin', null], ['seed-demo@example.test', 'student', 'S0001']]);
      expect(await verifyPassword('student password 1', rows[1].password_hash)).toBe(true);
      expect(rows.every((r) => !r.password_hash.includes('password'))).toBe(true);

      const audit = await db.query("SELECT after FROM audit_log WHERE action = 'user.create' ORDER BY id DESC LIMIT 2");
      expect(audit.rows.map((r) => r.after.email).sort()).toEqual(['seed-admin@example.test', 'seed-demo@example.test']);
      expect(JSON.stringify(audit.rows)).not.toMatch(/password/);
    });

    it('is idempotent and never overwrites an existing password', async () => {
      const changed = accounts.map((a) => ({ ...a, password: 'a different password' }));
      expect((await seed(db, { accounts: changed, bcryptRounds: 4 })).accountsCreated).toBe(0);
      const { rows } = await db.query("SELECT password_hash FROM users WHERE email = 'seed-admin@example.test'");
      expect(await verifyPassword('admin password 1', rows[0].password_hash)).toBe(true);
    });

    it('refuses to link a second account to S0001', async () => {
      const other = [{ role: 'student', email: 'other-demo@example.test', password: 'student password 2', studentCode: 'S0001' }];
      await expect(seed(db, { accounts: other, bcryptRounds: 4 })).rejects.toThrow(/S0001 is already linked/);
    });
  });
});
