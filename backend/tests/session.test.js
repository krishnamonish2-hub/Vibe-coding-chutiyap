// Per-user session versioning (migration 003): tokens carry the user's session_version, every authenticated request
// compares it with the database, and logout increments it so previously issued tokens stop working immediately.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE, signSession } from '../src/auth/jwt.js';
import { listMigrations, migrate } from '../src/db/migrate.js';
import { PASSWORD, TEST_SECRET, buildApp, createUser } from './helpers/app.js';
import { DATABASE_URL, createTestSchema, pgError } from './helpers/db.js';

const TOKEN_CFG = { secret: TEST_SECRET, ttlHours: 1 };

// Logs in with a plain request and returns the raw session cookie ("messmind_session=<jwt>") and the token.
async function loginCookie(app, email, password = PASSWORD) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(';')[0];
  return { cookie, token: cookie.slice(SESSION_COOKIE.length + 1), user: res.body.user };
}

const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const me = (app, cookie) => request(app).get('/api/auth/me').set('Cookie', cookie);
const adminDishes = (app, cookie) => request(app).get('/api/admin/dishes').set('Cookie', cookie);
const logout = (app, cookie) => {
  const r = request(app).post('/api/auth/logout').set('Content-Type', 'application/json');
  return (cookie ? r.set('Cookie', cookie) : r).send({});
};

describe.skipIf(!DATABASE_URL)('migration 003: users.session_version', () => {
  it('adds session_version (default 1) to existing users and rejects values below 1', async () => {
    const ctx = await createTestSchema('p3_mig003', { migrated: false });
    try {
      const dir = (await listMigrations());
      expect(dir).toContain('003_user_session_version.sql');
      // Apply 001-002 only (copy of the real files), create a user, then apply 003 on top of existing data.
      const { mkdtemp, copyFile, rm } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const { DEFAULT_MIGRATIONS_DIR } = await import('../src/db/migrate.js');
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'messmind-m003-'));
      try {
        for (const f of ['001_schema.sql', '002_dish_display_name_unique.sql']) {
          await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmp, f));
        }
        await migrate(ctx.pool, { dir: tmp });
        await ctx.pool.query("INSERT INTO users (email, password_hash, role) VALUES ('old@example.test', 'x', 'admin')");
        expect((await migrate(ctx.pool)).applied).toEqual(['003_user_session_version.sql']);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      const { rows } = await ctx.pool.query("SELECT session_version FROM users WHERE email = 'old@example.test'");
      expect(rows[0].session_version).toBe(1);
      const err = await pgError(() => ctx.pool.query('UPDATE users SET session_version = 0'));
      expect(err.code).toBe('23514');
      expect((await pgError(() => ctx.pool.query('UPDATE users SET session_version = NULL'))).code).toBe('23502');
    } finally {
      await ctx.drop();
    }
  });
});

describe.skipIf(!DATABASE_URL)('session invalidation', () => {
  let ctx;
  let db;
  let app;
  let admin;
  let student;

  const version = async (id) => (await db.query('SELECT session_version FROM users WHERE id = $1', [id])).rows[0].session_version;

  beforeAll(async () => {
    ctx = await createTestSchema('p3_session', { seeded: true });
    db = ctx.pool;
    app = buildApp(db);
    admin = await createUser(db, { email: 'admin@example.test', role: 'admin' });
    student = await createUser(db, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
  });
  afterAll(async () => ctx?.drop());

  // Every test starts from version 1 for both users.
  beforeEach(async () => {
    await db.query('UPDATE users SET session_version = 1');
  });

  it('new users start at version 1 and login embeds the current version in the token', async () => {
    expect(await version(admin.id)).toBe(1);
    const { token } = await loginCookie(app, 'admin@example.test');
    expect(claims(token)).toMatchObject({ sub: String(admin.id), sv: 1, iss: 'messmind' });
  });

  it('login does not change the version (other open sessions stay valid)', async () => {
    const first = await loginCookie(app, 'admin@example.test');
    await loginCookie(app, 'admin@example.test');
    expect(await version(admin.id)).toBe(1);
    expect((await me(app, first.cookie)).status).toBe(200);
  });

  it('a copied token stops working immediately after logout', async () => {
    const { cookie } = await loginCookie(app, 'admin@example.test');
    const copied = cookie; // e.g. taken from the browser before logout
    expect((await me(app, copied)).status).toBe(200);
    expect((await adminDishes(app, copied)).status).toBe(200);

    const out = await logout(app, cookie);
    expect(out.status).toBe(204);
    expect(out.headers['set-cookie'][0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
    expect(await version(admin.id)).toBe(2);

    const afterMe = await me(app, copied);
    expect(afterMe.status).toBe(401);
    expect(afterMe.body.error.code).toBe('unauthenticated');
    expect((await adminDishes(app, copied)).status).toBe(401);
    const rename = await request(app).patch('/api/admin/dishes/D001').set('Cookie', copied)
      .set('Content-Type', 'application/json').send({ display_name: 'Chai' });
    expect(rename.status).toBe(401);
    expect((await db.query("SELECT display_name FROM dishes WHERE id = 'D001'")).rows[0].display_name).toBe('Tea');
  });

  it('a later login works normally and receives the new version; the old token stays invalid', async () => {
    const old = await loginCookie(app, 'admin@example.test');
    await logout(app, old.cookie);
    const fresh = await loginCookie(app, 'admin@example.test');
    expect(claims(fresh.token).sv).toBe(2);
    expect((await me(app, fresh.cookie)).body.user).toMatchObject({ email: 'admin@example.test', role: 'admin' });
    expect((await adminDishes(app, fresh.cookie)).status).toBe(200);
    expect((await me(app, old.cookie)).status).toBe(401);
  });

  it('logout ends all of that user\'s sessions (per-user version), but not other users\' sessions', async () => {
    const laptop = await loginCookie(app, 'admin@example.test');
    const phone = await loginCookie(app, 'admin@example.test');
    const stu = await loginCookie(app, 'demo@example.test');
    await logout(app, laptop.cookie);
    expect((await me(app, laptop.cookie)).status).toBe(401);
    expect((await me(app, phone.cookie)).status).toBe(401);
    expect((await me(app, stu.cookie)).status).toBe(200);
    expect(await version(student.id)).toBe(1);
  });

  it('demo student logout works the same way', async () => {
    const { cookie } = await loginCookie(app, 'demo@example.test');
    expect((await me(app, cookie)).body.user.student_code).toBe('S0001');
    await logout(app, cookie);
    expect(await version(student.id)).toBe(2);
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('logout with an old (already invalid) token clears the cookie but does not bump the version again', async () => {
    const old = await loginCookie(app, 'admin@example.test');
    await logout(app, old.cookie);
    const current = await loginCookie(app, 'admin@example.test');
    const replay = await logout(app, old.cookie);
    expect(replay.status).toBe(204);
    expect(replay.headers['set-cookie'][0]).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await version(admin.id)).toBe(2);
    expect((await me(app, current.cookie)).status).toBe(200); // the replayed old token did not end the new session
  });

  it('logout without a session, or with a garbage cookie, is a harmless 204', async () => {
    expect((await logout(app)).status).toBe(204);
    expect((await logout(app, `${SESSION_COOKIE}=not-a-token`)).status).toBe(204);
    expect(await version(admin.id)).toBe(1);
    expect(await version(student.id)).toBe(1);
  });

  it('two simultaneous logouts with the same token increment the version only once', async () => {
    const { cookie } = await loginCookie(app, 'admin@example.test');
    const results = await Promise.all([logout(app, cookie), logout(app, cookie), logout(app, cookie)]);
    expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(await version(admin.id)).toBe(2);
  });

  it.each([
    ['older than the current version', 1, 2],
    ['newer than the current version', 3, 2],
  ])('rejects a correctly signed token whose version is %s', async (_, tokenVersion, dbVersion) => {
    await db.query('UPDATE users SET session_version = $2 WHERE id = $1', [admin.id, dbVersion]);
    const cookie = `${SESSION_COOKIE}=${signSession(admin.id, tokenVersion, TOKEN_CFG)}`;
    expect((await me(app, cookie)).status).toBe(401);
    const ok = `${SESSION_COOKIE}=${signSession(admin.id, dbVersion, TOKEN_CFG)}`;
    expect((await me(app, ok)).status).toBe(200); // control: the matching version works
  });

  it('rejects a correctly signed token without a version (issued before migration 003)', async () => {
    const legacy = jwt.sign({ sub: String(admin.id) }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind', expiresIn: '1h' });
    expect((await me(app, `${SESSION_COOKIE}=${legacy}`)).status).toBe(401);
  });

  it('bumping the version in the database ends existing sessions (forced sign-out)', async () => {
    const { cookie } = await loginCookie(app, 'demo@example.test');
    await db.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [student.id]);
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('keeps role checks: a valid student session is still 403 on admin routes', async () => {
    const { cookie } = await loginCookie(app, 'demo@example.test');
    expect((await adminDishes(app, cookie)).status).toBe(403);
  });

  it('logout and login do not write audit entries (audit behaviour unchanged)', async () => {
    const before = Number((await db.query('SELECT count(*) FROM audit_log')).rows[0].count);
    const { cookie } = await loginCookie(app, 'admin@example.test');
    await logout(app, cookie);
    expect(Number((await db.query('SELECT count(*) FROM audit_log')).rows[0].count)).toBe(before);
  });
});
