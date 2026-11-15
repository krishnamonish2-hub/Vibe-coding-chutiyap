// Runs against a real PostgreSQL database when DATABASE_URL is set (always in CI); skipped otherwise.
// Every test works inside a throw-away schema, so it never touches application tables.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { testConfig } from './helpers/app.js';
import { createPool } from '../src/db/pool.js';
import { listMigrations, migrate } from '../src/db/migrate.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgreSQL integration', () => {
  const schema = `p1_test_${process.pid}_${Date.now()}`;
  let admin;
  let pool;
  let dir;

  beforeAll(async () => {
    admin = createPool(DATABASE_URL, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(DATABASE_URL, { options: `-c search_path=${schema}` });
    dir = await mkdtemp(path.join(os.tmpdir(), 'messmind-migrations-'));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('applies migrations in order, once', async () => {
    await writeFile(path.join(dir, '001_create_widget.sql'), 'CREATE TABLE widget (id int PRIMARY KEY, made_on date NOT NULL);');
    await writeFile(path.join(dir, '002_seed_widget.sql'), "INSERT INTO widget VALUES (1, '2026-07-06');");

    expect(await migrate(pool, { dir })).toEqual({ applied: ['001_create_widget.sql', '002_seed_widget.sql'], total: 2 });
    expect(await migrate(pool, { dir })).toEqual({ applied: [], total: 2 });

    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual(['001_create_widget.sql', '002_seed_widget.sql']);
  });

  it('returns DATE columns as YYYY-MM-DD strings (no time-zone shift)', async () => {
    const { rows } = await pool.query("SELECT made_on, DATE '2026-12-31' AS year_end FROM widget");
    expect(rows[0]).toEqual({ made_on: '2026-07-06', year_end: '2026-12-31' });
  });

  it('rolls back a failing migration and does not record it', async () => {
    await writeFile(path.join(dir, '003_broken.sql'), 'CREATE TABLE half_done (id int); SELECT no_such_column FROM widget;');
    await expect(migrate(pool, { dir })).rejects.toThrow(/003_broken\.sql failed/);
    const { rows } = await pool.query("SELECT to_regclass('half_done') AS t, (SELECT count(*)::int FROM schema_migrations) AS n");
    expect(rows[0]).toEqual({ t: null, n: 2 });
    await rm(path.join(dir, '003_broken.sql'));
  });

  it('rejects badly named migration files', async () => {
    await writeFile(path.join(dir, 'oops.sql'), 'SELECT 1;');
    await expect(listMigrations(dir)).rejects.toThrow(/001_name\.sql/);
    await rm(path.join(dir, 'oops.sql'));
  });

  it('GET /api/health reports database ok against the real database', async () => {
    const mlDown = async () => ({ reachable: false, model_loaded: false, model_version: null });
    const res = await request(createApp({ pool, config: testConfig(), getMlHealth: mlDown })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });
});
