// Phase 2 schema tests against real PostgreSQL (skipped without DATABASE_URL; always run in CI).
// Each test file works in its own throw-away schema. All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listMigrations, migrate } from '../src/db/migrate.js';
import { seed } from '../db/seed.js';
import { DISHES, TOTAL_STUDENTS } from '../src/simulation/catalog.js';
import {
  DATABASE_URL, createTestSchema, dayDate, insertDay, insertMealDish, insertRow, insertRun, mealRow, pgError,
} from './helpers/db.js';

const FK = '23503';
const UNIQUE = '23505';
const CHECK = '23514';
const APPEND_ONLY = '42501';

const RUN_TABLES = ['simulation_runs', 'sim_days', 'meals', 'meal_dishes', 'meal_responses', 'response_picks',
  'meal_dish_counts', 'prediction_requests', 'prediction_items', 'dish_outcomes'];

describe.skipIf(!DATABASE_URL)('schema (001_schema.sql)', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await createTestSchema('p2_schema', { seeded: true });
    db = ctx.pool;
  });
  afterAll(async () => ctx?.drop());

  // Every test starts without a simulation run; reference data (dishes, students) stays seeded.
  beforeEach(async () => {
    await db.query('DELETE FROM simulation_runs');
    await db.query('DELETE FROM users');
  });

  async function runWithMeal(day = 1, mealType = 'lunch', mealOverrides = {}) {
    const run = await insertRun(db);
    await insertDay(db, run.id, day);
    const meal = await insertRow(db, 'meals', mealRow(run.id, day, mealType, mealOverrides));
    return { run, meal };
  }

  async function count(table) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }

  // -------------------------------------------------------------------------
  describe('migration and seed', () => {
    it('records the migrations and is idempotent', async () => {
      expect(await listMigrations()).toEqual(['001_schema.sql', '002_dish_display_name_unique.sql', '003_user_session_version.sql']);
      expect((await migrate(db)).applied).toEqual([]);
    });

    it('seeds 38 synthetic dishes and 1,000 synthetic students', async () => {
      expect(await count('dishes')).toBe(DISHES.length);
      expect(await count('students')).toBe(TOTAL_STUDENTS);
      const { rows } = await db.query("SELECT min(code) AS lo, max(code) AS hi FROM students");
      expect(rows[0]).toEqual({ lo: 'S0001', hi: 'S1000' });
      const { rows: rice } = await db.query("SELECT * FROM dishes WHERE ml_dish_name = 'Rice'");
      expect(rice[0]).toMatchObject({ id: 'D012', category: 'staple_rice', is_veg: true, portion_kg: 0.15, active: true });
    });

    it('re-seeding inserts nothing and keeps an admin rename', async () => {
      await db.query("UPDATE dishes SET display_name = 'Steamed Rice' WHERE id = 'D012'");
      expect(await seed(db)).toEqual({ dishesInserted: 0, studentsInserted: 0, accountsCreated: 0 });
      const { rows } = await db.query("SELECT display_name, ml_dish_name FROM dishes WHERE id = 'D012'");
      expect(rows[0]).toEqual({ display_name: 'Steamed Rice', ml_dish_name: 'Rice' });
      await db.query("UPDATE dishes SET display_name = 'Rice' WHERE id = 'D012'");
    });

    it('creates no users (accounts are added in Phase 3)', async () => {
      expect(await count('users')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('stable dish identity (R-08)', () => {
    it('allows renaming the display name and updates updated_at', async () => {
      const before = (await db.query("SELECT updated_at FROM dishes WHERE id = 'D001'")).rows[0].updated_at;
      await db.query("UPDATE dishes SET display_name = 'Masala Chai' WHERE id = 'D001'");
      const after = (await db.query("SELECT display_name, updated_at FROM dishes WHERE id = 'D001'")).rows[0];
      expect(after.display_name).toBe('Masala Chai');
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      await db.query("UPDATE dishes SET display_name = 'Tea' WHERE id = 'D001'");
    });

    it('rejects changing ml_dish_name or id', async () => {
      expect((await pgError(() => db.query("UPDATE dishes SET ml_dish_name = 'Chai' WHERE id = 'D001'"))).code).toBe(CHECK);
      expect((await pgError(() => db.query("UPDATE dishes SET id = 'D999' WHERE id = 'D001'"))).code).toBe(CHECK);
    });

    it('rejects untrimmed or unknown-category dishes', async () => {
      const base = { id: 'D900', display_name: 'X', ml_dish_name: 'X', category: 'side', is_veg: true, portion_kg: 0.1 };
      expect((await pgError(() => insertRow(db, 'dishes', { ...base, ml_dish_name: ' X' }))).code).toBe(CHECK);
      expect((await pgError(() => insertRow(db, 'dishes', { ...base, category: 'snack' }))).code).toBe(CHECK);
      expect((await pgError(() => insertRow(db, 'dishes', { ...base, id: 'X1' }))).code).toBe(CHECK);
    });

    it('menu copies must carry the dish\'s real ML name', async () => {
      const { meal } = await runWithMeal();
      expect((await pgError(() => insertMealDish(db, meal.id, 'D012', 1, { ml_dish_name: 'Chapati' }))).code).toBe(FK);
      await insertMealDish(db, meal.id, 'D012', 1, { display_name: 'Old display name' }); // display copy may differ
    });
  });

  // -------------------------------------------------------------------------
  describe('users', () => {
    it('student accounts need a student; admins must not have one', async () => {
      const base = { email: 'a@example.test', password_hash: 'x' };
      expect((await pgError(() => insertRow(db, 'users', { ...base, role: 'student' }))).code).toBe(CHECK);
      expect((await pgError(() => insertRow(db, 'users', { ...base, role: 'admin', student_id: 1 }))).code).toBe(CHECK);
      expect((await pgError(() => insertRow(db, 'users', { ...base, email: 'A@example.test', role: 'admin' }))).code).toBe(CHECK);
      await insertRow(db, 'users', { ...base, role: 'student', student_id: 1 });
      expect((await pgError(() => insertRow(db, 'users', { ...base, email: 'b@example.test', role: 'student', student_id: 1 }))).code).toBe(UNIQUE);
    });
  });

  // -------------------------------------------------------------------------
  describe('simulation runs and calendar', () => {
    it('allows only one run at a time', async () => {
      await insertRun(db);
      expect((await pgError(() => insertRun(db))).code).toBe(UNIQUE);
    });

    it.each([
      ['total_students', { total_students: 999 }],
      ['learning_days', { learning_days: 29 }],
      ['activation_day', { activation_day: 30 }],
      ['total_days', { total_days: 30 }],
      ['sim_now before Day 0 19:30', { sim_now: `${dayDate(0)}T19:29:59Z` }],
    ])('rejects a run with invalid %s', async (_, overrides) => {
      expect((await pgError(() => insertRun(db, overrides))).code).toBe(CHECK);
    });

    it('defaults to 60 days, paused, and the approved run start', async () => {
      const run = await insertRun(db);
      expect(run).toMatchObject({ total_days: 60, learning_days: 30, activation_day: 31, total_students: 1000, status: 'paused' });
      expect(run.sim_now.toISOString()).toBe('2026-07-05T19:30:00.000Z');
    });

    it('checks the weekend flag against the date', async () => {
      const run = await insertRun(db);
      expect((await pgError(() => insertDay(db, run.id, 6, { is_weekend: false }))).code).toBe(CHECK); // Day 6 = Saturday
      await insertDay(db, run.id, 6);
    });
  });

  // -------------------------------------------------------------------------
  describe('meals', () => {
    it('accepts the approved schedule for every meal type, Day 1 and Day 31', async () => {
      const run = await insertRun(db);
      for (const day of [1, 30, 31]) {
        await insertDay(db, run.id, day);
        for (const mt of ['breakfast', 'lunch', 'dinner']) await insertRow(db, 'meals', mealRow(run.id, day, mt));
      }
      const { rows } = await db.query('SELECT day_number, phase FROM meals ORDER BY serve_at');
      expect(rows.map((r) => `${r.day_number}:${r.phase}`)).toEqual([
        '1:learning', '1:learning', '1:learning', '30:learning', '30:learning', '30:learning',
        '31:active', '31:active', '31:active']);
      // Day 1 breakfast voting opens exactly at the run start (Day 0 19:30)
      const first = (await db.query("SELECT voting_opens_at FROM meals WHERE id = $1", [`r${run.id}-d001-breakfast`])).rows[0];
      expect(first.voting_opens_at.toISOString()).toBe(run.sim_now.toISOString());
    });

    it('keeps every meal completed before the next meal\'s provisional step', async () => {
      const run = await insertRun(db);
      for (const day of [1, 2]) {
        await insertDay(db, run.id, day);
        for (const mt of ['breakfast', 'lunch', 'dinner']) await insertRow(db, 'meals', mealRow(run.id, day, mt));
      }
      const { rows } = await db.query('SELECT completes_at, provisional_at FROM meals ORDER BY serve_at');
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].completes_at.getTime()).toBeLessThan(rows[i].provisional_at.getTime());
      }
    });

    it.each([
      ['wrong id format', { id: 'meal-1' }],
      ['wrong serve time', { serve_at: '2026-07-06T13:00:00Z' }],
      ['wrong voting open offset', { voting_opens_at: '2026-07-06T00:00:00Z' }],
      ['wrong provisional offset', { provisional_at: '2026-07-06T09:00:00Z' }],
      ['wrong cutoff offset', { voting_closes_at: '2026-07-06T12:15:00Z' }],
      ['wrong completion offset', { completes_at: '2026-07-06T13:30:00Z' }],
      ['active phase on a learning day', { phase: 'active' }],
      ['provisional status without counts', { status: 'provisional_taken' }],
      ['completed without headcount', {
        status: 'completed', prov_total_responses: 300, prov_not_eating: 30,
        final_total_responses: 420, final_not_eating: 40 }],
      ['not-eating above responses', { status: 'provisional_taken', prov_total_responses: 10, prov_not_eating: 11 }],
    ])('rejects a meal with %s', async (_, overrides) => {
      const run = await insertRun(db);
      await insertDay(db, run.id, 1);
      const row = mealRow(run.id, 1, 'lunch', overrides);
      expect((await pgError(() => insertRow(db, 'meals', row))).code).toBe(CHECK);
    });

    it('requires the meal date to match its simulated day', async () => {
      const run = await insertRun(db);
      await insertDay(db, run.id, 1);
      await insertDay(db, run.id, 2);
      const row = { ...mealRow(run.id, 2, 'lunch'), day_number: 1, id: `r${run.id}-d001-lunch` };
      expect((await pgError(() => insertRow(db, 'meals', row))).code).toBe(FK);
    });

    it('accepts a fully completed meal with consistent counts', async () => {
      await runWithMeal(1, 'lunch', {
        status: 'completed', prov_total_responses: 300, prov_not_eating: 30,
        final_total_responses: 420, final_not_eating: 40, headcount: 790 });
    });
  });

  // -------------------------------------------------------------------------
  describe('response_picks composite foreign keys (approved correction)', () => {
    let lunch;
    let dinner;
    let eating;
    let notEating;

    beforeEach(async () => {
      const run = await insertRun(db);
      await insertDay(db, run.id, 1);
      lunch = await insertRow(db, 'meals', mealRow(run.id, 1, 'lunch'));
      dinner = await insertRow(db, 'meals', mealRow(run.id, 1, 'dinner'));
      await insertMealDish(db, lunch.id, 'D012', 1);   // Rice on lunch
      await insertMealDish(db, lunch.id, 'D015', 2);   // Paneer Butter Masala on lunch
      await insertMealDish(db, dinner.id, 'D030', 1);  // Aloo Matar: on dinner only
      const at = lunch.voting_opens_at;
      eating = await insertRow(db, 'meal_responses', { meal_id: lunch.id, student_id: 1, response: 'eating', responded_at: at });
      notEating = await insertRow(db, 'meal_responses', { meal_id: lunch.id, student_id: 2, response: 'not_eating', responded_at: at });
    });

    it('accepts a pick of a dish on the response\'s own meal', async () => {
      await insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D012' });
      await insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D015' });
      expect(await count('response_picks')).toBe(2);
    });

    it('case 1: rejects a dish that is not on the meal', async () => {
      const err = await pgError(() => insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D030' }));
      expect([err.code, err.constraint]).toEqual([FK, 'response_picks_meal_id_dish_id_fkey']);
    });

    it('case 2: rejects a pick whose meal differs from its response\'s meal', async () => {
      const err = await pgError(() => insertRow(db, 'response_picks', { response_id: eating.id, meal_id: dinner.id, dish_id: 'D030' }));
      expect([err.code, err.constraint]).toEqual([FK, 'response_picks_response_id_meal_id_response_fkey']);
    });

    it('case 3: rejects picks on a not_eating response', async () => {
      const err = await pgError(() => insertRow(db, 'response_picks', { response_id: notEating.id, meal_id: lunch.id, dish_id: 'D012' }));
      expect([err.code, err.constraint]).toEqual([FK, 'response_picks_response_id_meal_id_response_fkey']);
      const forced = await pgError(() => insertRow(db, 'response_picks', {
        response_id: notEating.id, meal_id: lunch.id, dish_id: 'D012', response: 'not_eating' }));
      expect(forced.code).toBe(CHECK);
    });

    it('case 4: rejects switching to not_eating while picks exist; allowed after deleting picks', async () => {
      await insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D012' });
      const err = await pgError(() => db.query("UPDATE meal_responses SET response = 'not_eating' WHERE id = $1", [eating.id]));
      expect([err.code, err.constraint]).toEqual([CHECK, 'response_picks_response_check']);
      await db.query('DELETE FROM response_picks WHERE response_id = $1', [eating.id]);
      await db.query("UPDATE meal_responses SET response = 'not_eating' WHERE id = $1", [eating.id]);
    });

    it('case 5: deleting a response, a menu dish or a meal removes its picks', async () => {
      await insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D012' });
      await insertRow(db, 'response_picks', { response_id: eating.id, meal_id: lunch.id, dish_id: 'D015' });
      await db.query("DELETE FROM meal_dishes WHERE meal_id = $1 AND dish_id = 'D015'", [lunch.id]);
      expect(await count('response_picks')).toBe(1);
      await db.query('DELETE FROM meal_responses WHERE id = $1', [eating.id]);
      expect(await count('response_picks')).toBe(0);
      await db.query('DELETE FROM meals WHERE id = $1', [lunch.id]);
      expect(await count('meal_responses')).toBe(0);
    });

    it('allows one response per student per meal; eating with zero dishes is valid (D8)', async () => {
      const dup = await pgError(() => insertRow(db, 'meal_responses', {
        meal_id: lunch.id, student_id: 1, response: 'not_eating', responded_at: lunch.voting_opens_at }));
      expect(dup.code).toBe(UNIQUE);
      await insertRow(db, 'meal_responses', { meal_id: lunch.id, student_id: 3, response: 'eating', responded_at: lunch.voting_opens_at });
    });

    it('rejects unknown students', async () => {
      const err = await pgError(() => insertRow(db, 'meal_responses', {
        meal_id: lunch.id, student_id: 1001, response: 'eating', responded_at: lunch.voting_opens_at }));
      expect(err.code).toBe(FK);
    });
  });

  // -------------------------------------------------------------------------
  describe('predictions and outcomes', () => {
    const payload = { meal_id: 'x' };
    const okResponse = { predictions: [] };

    it('keeps one current attempt per meal and kind, and provisional/final separate', async () => {
      const { meal } = await runWithMeal(31);
      const base = { meal_id: meal.id, request_payload: payload, sim_at: meal.provisional_at };
      await insertRow(db, 'prediction_requests', { ...base, kind: 'provisional', attempt: 1, status: 'unavailable' });
      await insertRow(db, 'prediction_requests', { ...base, kind: 'provisional', attempt: 2, status: 'ok', is_current: true,
        response_payload: okResponse, model_version: 'rf-v1-synthetic', trained_on: 'synthetic' });
      await insertRow(db, 'prediction_requests', { ...base, kind: 'final', attempt: 1, status: 'ok', is_current: true,
        response_payload: okResponse, model_version: 'rf-v1-synthetic', trained_on: 'synthetic' });
      const dupCurrent = await pgError(() => insertRow(db, 'prediction_requests', { ...base, kind: 'final', attempt: 2,
        status: 'error', is_current: true }));
      expect(dupCurrent.code).toBe(UNIQUE);
      const dupAttempt = await pgError(() => insertRow(db, 'prediction_requests', { ...base, kind: 'final', attempt: 1, status: 'error' }));
      expect(dupAttempt.code).toBe(UNIQUE);
    });

    it('requires response, model version and trained_on for ok attempts', async () => {
      const { meal } = await runWithMeal(31);
      const err = await pgError(() => insertRow(db, 'prediction_requests', { meal_id: meal.id, kind: 'final', attempt: 1,
        status: 'ok', request_payload: payload, sim_at: meal.voting_closes_at }));
      expect(err.code).toBe(CHECK);
    });

    it('prediction items must belong to the request\'s meal and menu', async () => {
      const run = await insertRun(db);
      await insertDay(db, run.id, 31);
      const lunch = await insertRow(db, 'meals', mealRow(run.id, 31, 'lunch'));
      const dinner = await insertRow(db, 'meals', mealRow(run.id, 31, 'dinner'));
      await insertMealDish(db, lunch.id, 'D012', 1);
      await insertMealDish(db, dinner.id, 'D027', 1); // Dal Fry
      const req = await insertRow(db, 'prediction_requests', { meal_id: lunch.id, kind: 'final', attempt: 1, status: 'ok',
        is_current: true, request_payload: payload, response_payload: okResponse, model_version: 'rf-v1-synthetic',
        trained_on: 'synthetic', sim_at: lunch.voting_closes_at });
      const item = { request_id: req.id, interested_taps: 170, predicted_consumers: 535, warnings: [] };
      await insertRow(db, 'prediction_items', { ...item, meal_id: lunch.id, dish_id: 'D012', hist_demand: 680 });
      expect((await pgError(() => insertRow(db, 'prediction_items', { ...item, meal_id: dinner.id, dish_id: 'D027' }))).code).toBe(FK);
      expect((await pgError(() => insertRow(db, 'prediction_items', { ...item, meal_id: lunch.id, dish_id: 'D013' }))).code).toBe(FK);
      expect((await pgError(() => db.query('UPDATE prediction_items SET predicted_consumers = 1001'))).code).toBe(CHECK);
    });

    it('stores outcomes separately; admin edits need edited_at', async () => {
      const { meal } = await runWithMeal(1);
      await insertMealDish(db, meal.id, 'D012', 1);
      const row = { meal_id: meal.id, dish_id: 'D012', actual_consumers: 640, prepared_servings: 700,
        static_plan_servings: 700, leftover_kg: 9, static_plan_leftover_kg: 9, avg_rating: 3.7 };
      await insertRow(db, 'dish_outcomes', row);
      expect((await pgError(() => db.query("UPDATE dish_outcomes SET source = 'admin'"))).code).toBe(CHECK);
      await db.query("UPDATE dish_outcomes SET source = 'admin', edited_at = now(), actual_consumers = 650");
      expect((await pgError(() => db.query('UPDATE dish_outcomes SET avg_rating = 5.5'))).code).toBe(CHECK);
    });
  });

  // -------------------------------------------------------------------------
  describe('reset (D6): cascade delete and durable audit log', () => {
    // Builds one run touching every run-scoped table.
    async function fullRun() {
      const run = await insertRun(db);
      await insertDay(db, run.id, 31);
      const meal = await insertRow(db, 'meals', mealRow(run.id, 31, 'lunch'));
      await insertMealDish(db, meal.id, 'D012', 1);
      const resp = await insertRow(db, 'meal_responses', { meal_id: meal.id, student_id: 1, response: 'eating', responded_at: meal.voting_opens_at });
      await insertRow(db, 'response_picks', { response_id: resp.id, meal_id: meal.id, dish_id: 'D012' });
      await insertRow(db, 'meal_dish_counts', { meal_id: meal.id, dish_id: 'D012', prov_taps: 1, final_taps: 1 });
      const req = await insertRow(db, 'prediction_requests', { meal_id: meal.id, kind: 'final', attempt: 1, status: 'unavailable',
        request_payload: { meal_id: meal.id }, sim_at: meal.voting_closes_at });
      await insertRow(db, 'prediction_items', { request_id: req.id, meal_id: meal.id, dish_id: 'D012', interested_taps: 1, predicted_consumers: 2 });
      await insertRow(db, 'dish_outcomes', { meal_id: meal.id, dish_id: 'D012', actual_consumers: 1, prepared_servings: 2,
        static_plan_servings: 2, leftover_kg: 0.1, static_plan_leftover_kg: 0.1 });
      return run;
    }

    async function runScopedCounts() {
      return Object.fromEntries(await Promise.all(RUN_TABLES.map(async (t) => [t, await count(t)])));
    }

    it('deleting the run removes every run-scoped row and keeps reference data and the audit log', async () => {
      const run = await fullRun();
      expect(Object.values(await runScopedCounts()).every((n) => n === 1)).toBe(true);

      // Approved order (architecture §4.3): audit entry first, then the cascading delete, one transaction.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await insertRow(client, 'audit_log', { action: 'simulation.reset', entity: `simulation_run:${run.id}`,
          before: { run_id: run.id, meals: 1 } });
        await client.query('DELETE FROM simulation_runs WHERE id = $1', [run.id]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      expect(Object.values(await runScopedCounts()).every((n) => n === 0)).toBe(true);
      expect(await count('dishes')).toBe(38);
      expect(await count('students')).toBe(1000);
      const { rows } = await db.query("SELECT entity, before FROM audit_log WHERE action = 'simulation.reset' ORDER BY id DESC LIMIT 1");
      expect(rows[0]).toEqual({ entity: `simulation_run:${run.id}`, before: { run_id: run.id, meals: 1 } });
    });

    it('a failed reset transaction leaves neither the audit entry nor the deletion', async () => {
      const run = await fullRun();
      const auditBefore = await count('audit_log');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO audit_log (action, entity) VALUES ('simulation.reset', $1)", [`simulation_run:${run.id}`]);
        await client.query('DELETE FROM simulation_runs WHERE id = $1', [run.id]);
        await expect(client.query('SELECT 1/0')).rejects.toThrow(); // simulated failure before COMMIT
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await count('audit_log')).toBe(auditBefore);
      expect(Object.values(await runScopedCounts()).every((n) => n === 1)).toBe(true);
    });

    it('audit_log is append-only (update, delete and truncate are rejected)', async () => {
      const entry = await insertRow(db, 'audit_log', { action: 'test.append_only', entity: 'none' });
      expect((await pgError(() => db.query("UPDATE audit_log SET action = 'x' WHERE id = $1", [entry.id]))).code).toBe(APPEND_ONLY);
      expect((await pgError(() => db.query('DELETE FROM audit_log WHERE id = $1', [entry.id]))).code).toBe(APPEND_ONLY);
      expect((await pgError(() => db.query('TRUNCATE audit_log'))).code).toBe(APPEND_ONLY);
    });

    it('deleting a user keeps their audit entries (user_id set to NULL)', async () => {
      const user = await insertRow(db, 'users', { email: 'admin@example.test', password_hash: 'x', role: 'admin' });
      const entry = await insertRow(db, 'audit_log', { user_id: user.id, action: 'test.user', entity: 'none' });
      await db.query('DELETE FROM users WHERE id = $1', [user.id]);
      const { rows } = await db.query('SELECT user_id, action FROM audit_log WHERE id = $1', [entry.id]);
      expect(rows[0]).toEqual({ user_id: null, action: 'test.user' });
    });

    it('dishes used on a menu cannot be deleted', async () => {
      const { meal } = await runWithMeal(1);
      await insertMealDish(db, meal.id, 'D012', 1);
      expect((await pgError(() => db.query("DELETE FROM dishes WHERE id = 'D012'"))).code).toBe(FK);
    });
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!DATABASE_URL)('migration rollback', () => {
  it('a failing 001_schema.sql leaves no partial schema and is not recorded', async () => {
    const ctx = await createTestSchema('p2_rollback', { migrated: false });
    try {
      // A pre-existing table with a conflicting name makes the migration fail part-way through.
      await ctx.pool.query('CREATE TABLE simulation_runs (id int)');
      await expect(migrate(ctx.pool)).rejects.toThrow(/001_schema\.sql failed/);
      const { rows } = await ctx.pool.query(`SELECT
        to_regclass('students') AS students, to_regclass('dishes') AS dishes,
        (SELECT count(*)::int FROM schema_migrations) AS recorded`);
      expect(rows[0]).toEqual({ students: null, dishes: null, recorded: 0 });

      // After removing the conflict the same migration applies cleanly.
      await ctx.pool.query('DROP TABLE simulation_runs');
      expect((await migrate(ctx.pool)).applied).toEqual(['001_schema.sql', '002_dish_display_name_unique.sql', '003_user_session_version.sql']);
    } finally {
      await ctx.drop();
    }
  });
});
