// Test helpers: an isolated, throw-away PostgreSQL schema per test file, plus builders for valid fixture rows.

import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seed } from '../../db/seed.js';

export const DATABASE_URL = process.env.DATABASE_URL;

// Creates schema `<prefix>_<pid>_<time>`; returns a pool whose search_path is that schema.
export async function createTestSchema(prefix, { migrated = true, seeded = false } = {}) {
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = createPool(DATABASE_URL, { max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(DATABASE_URL, { options: `-c search_path=${schema}` });
  if (migrated) await migrate(pool);
  if (seeded) await seed(pool);
  return {
    schema,
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}

// ---- fixture builders (values follow the approved schedule, D1/D2) ----
export const START_DATE = '2026-07-06'; // a Monday = Day 1
const SERVE = { breakfast: '07:30', lunch: '12:30', dinner: '19:30' };
const HOUR = 3600e3;

export function dayDate(day, start = START_DATE) {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + day - 1);
  return d.toISOString().slice(0, 10);
}

export function mealRow(runId, day, mealType, overrides = {}) {
  const date = dayDate(day);
  const serve = new Date(`${date}T${SERVE[mealType]}:00Z`).getTime();
  const iso = (ms) => new Date(ms).toISOString();
  return {
    id: `r${runId}-d${String(day).padStart(3, '0')}-${mealType}`,
    run_id: runId,
    day_number: day,
    date,
    meal_type: mealType,
    serve_at: iso(serve),
    voting_opens_at: iso(serve - 12 * HOUR),
    provisional_at: iso(serve - 4 * HOUR),
    voting_closes_at: iso(serve - 0.5 * HOUR),
    completes_at: iso(serve + 0.75 * HOUR),
    phase: day >= 31 ? 'active' : 'learning',
    status: 'scheduled',
    ...overrides,
  };
}

export async function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

export async function insertRun(db, overrides = {}) {
  return insertRow(db, 'simulation_runs', {
    seed: 42, start_date: START_DATE, sim_now: `${dayDate(0)}T19:30:00Z`, ...overrides,
  });
}

export async function insertDay(db, runId, day, overrides = {}) {
  const date = dayDate(day);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return insertRow(db, 'sim_days', {
    run_id: runId, day_number: day, date, is_weekend: dow === 0 || dow === 6,
    temperature: 29.5, rainfall: 0, ...overrides,
  });
}

export async function insertMealDish(db, mealId, dishId, position, overrides = {}) {
  const { rows } = await db.query('SELECT ml_dish_name, display_name, category, is_veg FROM dishes WHERE id = $1', [dishId]);
  return insertRow(db, 'meal_dishes', { meal_id: mealId, dish_id: dishId, position, ...rows[0], ...overrides });
}

// Expects `fn` to reject with a PostgreSQL error; returns the error (for code/constraint assertions).
export async function pgError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a database error, but the statement succeeded');
}
