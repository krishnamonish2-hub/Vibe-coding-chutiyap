// Seeds synthetic reference data: the 38-dish catalogue and the 1,000 synthetic students.
// Idempotent: existing rows are kept (admin renames of display_name are never overwritten), and every run verifies
// that the stored dish identities (id, ml_dish_name, category) still match the catalogue.
//
// User accounts (admin, demo student S0001) are created in Phase 3, which adds password hashing.
//
// Usage: npm run seed   (after npm run migrate)

import { pathToFileURL } from 'node:url';

import { DISHES, TOTAL_STUDENTS, studentCode } from '../src/simulation/catalog.js';

export async function seed(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dishRows = DISHES.map((d) => [d.id, d.displayName, d.mlDishName, d.category, d.isVeg, d.portionKg]);
    const insertedDishes = await client.query(
      `INSERT INTO dishes (id, display_name, ml_dish_name, category, is_veg, portion_kg)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::double precision[])
       ON CONFLICT (id) DO NOTHING`,
      [0, 1, 2, 3, 4, 5].map((i) => dishRows.map((r) => r[i])),
    );

    const { rows: stored } = await client.query('SELECT id, ml_dish_name, category FROM dishes');
    const byId = new Map(stored.map((r) => [r.id, r]));
    const mismatches = DISHES.filter((d) => {
      const s = byId.get(d.id);
      return !s || s.ml_dish_name !== d.mlDishName || s.category !== d.category;
    }).map((d) => d.id);
    if (mismatches.length) {
      throw new Error(`dishes table does not match the catalogue for: ${mismatches.join(', ')}`);
    }

    const ids = Array.from({ length: TOTAL_STUDENTS }, (_, i) => i + 1);
    const insertedStudents = await client.query(
      `INSERT INTO students (id, code)
       SELECT * FROM unnest($1::integer[], $2::text[])
       ON CONFLICT (id) DO NOTHING`,
      [ids, ids.map(studentCode)],
    );

    await client.query('COMMIT');
    return { dishesInserted: insertedDishes.rowCount, studentsInserted: insertedStudents.rowCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// CLI: `npm run seed`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/db/pool.js');
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const r = await seed(pool);
    console.log(`seed: ${r.dishesInserted} dishes and ${r.studentsInserted} students inserted (synthetic)`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
