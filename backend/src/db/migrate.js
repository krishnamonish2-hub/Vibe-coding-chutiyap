// Minimal forward-only migration runner: applies backend/db/migrations/*.sql in name order.
// Each file runs in its own transaction and is recorded in schema_migrations, so re-running is safe.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const LOCK_ID = 7_310_001; // arbitrary constant: only one migration run at a time

export async function listMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  for (const name of names) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`migration file name must look like 001_name.sql, got ${name}`);
    }
  }
  return names;
}

export async function migrate(pool, { dir = DEFAULT_MIGRATIONS_DIR, log = () => {} } = {}) {
  const names = await listMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const newlyApplied = [];
    for (const name of names) {
      if (applied.has(name)) continue;
      const sql = await readFile(path.join(dir, name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${err.message}`, { cause: err });
      }
      newlyApplied.push(name);
      log(`applied ${name}`);
    }
    return { applied: newlyApplied, total: names.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// CLI: `npm run migrate`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadDatabaseUrl } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(loadDatabaseUrl());
  try {
    const result = await migrate(pool, { log: (m) => console.log(m) });
    console.log(`migrations: ${result.applied.length} applied, ${result.total} total`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
