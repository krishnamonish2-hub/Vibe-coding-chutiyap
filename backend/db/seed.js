// Seeds synthetic reference data: the 38-dish catalogue, the 1,000 synthetic students and, when configured, the two
// login accounts (admin, and the demo student linked to S0001, decision D11).
//
// Idempotent: existing rows are kept (admin renames of display_name and existing passwords are never overwritten),
// and every run verifies that stored dish identities (id, ml_dish_name, category) still match the catalogue.
//
// Accounts come only from the environment (never committed): ADMIN_EMAIL + ADMIN_PASSWORD and
// DEMO_STUDENT_EMAIL + DEMO_STUDENT_PASSWORD. If a pair is not set, that account is skipped.
//
// Usage: npm run seed   (after npm run migrate)

import { pathToFileURL } from 'node:url';

import { checkPasswordStrength, hashPassword } from '../src/auth/password.js';
import { recordAudit } from '../src/services/audit.js';
import { DISHES, TOTAL_STUDENTS, studentCode } from '../src/simulation/catalog.js';

export const DEMO_STUDENT_CODE = 'S0001';
const EMAIL = /^[^\s@]+@[^\s@]+$/;

// Reads the account settings from environment variables. Returns { accounts, skipped } or throws on invalid values.
export function accountsFromEnv(env = process.env) {
  const specs = [
    { role: 'admin', emailVar: 'ADMIN_EMAIL', passwordVar: 'ADMIN_PASSWORD' },
    { role: 'student', emailVar: 'DEMO_STUDENT_EMAIL', passwordVar: 'DEMO_STUDENT_PASSWORD', studentCode: DEMO_STUDENT_CODE },
  ];
  const accounts = [];
  const skipped = [];
  for (const spec of specs) {
    const email = env[spec.emailVar]?.trim().toLowerCase();
    const password = env[spec.passwordVar];
    if (!email && !password) {
      skipped.push(spec.role);
      continue;
    }
    if (!email || !EMAIL.test(email)) throw new Error(`${spec.emailVar} must be a valid email address`);
    const problem = checkPasswordStrength(password);
    if (problem) throw new Error(`${spec.passwordVar} ${problem}`);
    accounts.push({ role: spec.role, email, password, studentCode: spec.studentCode ?? null });
  }
  if (accounts.length === 2 && accounts[0].email === accounts[1].email) {
    throw new Error('ADMIN_EMAIL and DEMO_STUDENT_EMAIL must be different');
  }
  return { accounts, skipped };
}

async function seedAccounts(client, accounts, rounds) {
  let created = 0;
  for (const acc of accounts) {
    const existing = await client.query('SELECT id, role, student_id FROM users WHERE email = $1', [acc.email]);
    if (existing.rows.length) {
      if (existing.rows[0].role !== acc.role) {
        throw new Error(`user ${acc.email} already exists with role ${existing.rows[0].role}`);
      }
      continue; // keep the existing account and password
    }
    let studentId = null;
    if (acc.studentCode) {
      const { rows } = await client.query('SELECT id FROM students WHERE code = $1', [acc.studentCode]);
      studentId = rows[0].id;
      const linked = await client.query('SELECT email FROM users WHERE student_id = $1', [studentId]);
      if (linked.rows.length) {
        throw new Error(`${acc.studentCode} is already linked to ${linked.rows[0].email}`);
      }
    }
    const { rows } = await client.query(
      'INSERT INTO users (email, password_hash, role, student_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [acc.email, await hashPassword(acc.password, rounds), acc.role, studentId],
    );
    await recordAudit(client, {
      action: 'user.create', entity: `user:${rows[0].id}`,
      after: { email: acc.email, role: acc.role, student_code: acc.studentCode },
    });
    created += 1;
  }
  return created;
}

export async function seed(pool, { accounts = [], bcryptRounds } = {}) {
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

    const accountsCreated = await seedAccounts(client, accounts, bcryptRounds);

    await client.query('COMMIT');
    return {
      dishesInserted: insertedDishes.rowCount,
      studentsInserted: insertedStudents.rowCount,
      accountsCreated,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// CLI: `npm run seed`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadDatabaseUrl } = await import('../src/config.js');
  const { createPool } = await import('../src/db/pool.js');
  let pool;
  try {
    const { accounts, skipped } = accountsFromEnv();
    pool = createPool(loadDatabaseUrl());
    const r = await seed(pool, { accounts });
    console.log(`seed: ${r.dishesInserted} dishes, ${r.studentsInserted} students, `
      + `${r.accountsCreated} accounts created (synthetic)`);
    for (const role of skipped) {
      console.log(`seed: ${role} account skipped (set ${role === 'admin' ? 'ADMIN' : 'DEMO_STUDENT'}_EMAIL and _PASSWORD)`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
