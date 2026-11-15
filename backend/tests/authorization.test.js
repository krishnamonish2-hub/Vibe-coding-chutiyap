// Role-based access control is enforced by the backend for every protected route.

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorHandler } from '../src/middleware/error-handler.js';
import { requireRole } from '../src/middleware/auth.js';
import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

describe('requireRole', () => {
  function appFor(user, ...roles) {
    const app = express();
    app.use((req, res, next) => { req.user = user; next(); });
    app.get('/x', requireRole(...roles), (req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  }

  it('lets a matching role through', async () => {
    expect((await request(appFor({ role: 'student' }, 'student')).get('/x')).status).toBe(200);
    expect((await request(appFor({ role: 'admin' }, 'admin', 'student')).get('/x')).status).toBe(200);
  });

  it('returns 403 for another role and 401 without a user', async () => {
    expect((await request(appFor({ role: 'student' }, 'admin')).get('/x')).status).toBe(403);
    expect((await request(appFor({ role: 'admin' }, 'student')).get('/x')).status).toBe(403);
    expect((await request(appFor(undefined, 'admin')).get('/x')).status).toBe(401);
  });
});

describe.skipIf(!DATABASE_URL)('admin routes', () => {
  let ctx;
  let app;
  let admin;
  let student;

  // Every admin route available in Phase 3, with a request that would succeed for an admin.
  const ADMIN_ROUTES = [
    ['GET', '/api/admin/dishes', undefined],
    ['PATCH', '/api/admin/dishes/D001', { display_name: 'Tea' }],
  ];

  beforeAll(async () => {
    ctx = await createTestSchema('p3_rbac', { seeded: true });
    app = buildApp(ctx.pool);
    await createUser(ctx.pool, { email: 'admin@example.test', role: 'admin' });
    await createUser(ctx.pool, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
    admin = await signedIn(app, 'admin@example.test');
    student = await signedIn(app, 'demo@example.test');
  });
  afterAll(async () => ctx?.drop());

  const send = (agent, method, path, body) => {
    const r = agent[method.toLowerCase()](path);
    return body === undefined ? r : r.set('Content-Type', 'application/json').send(body);
  };

  it.each(ADMIN_ROUTES)('%s %s: 401 without a session', async (method, path, body) => {
    const res = await send(request(app), method, path, body);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it.each(ADMIN_ROUTES)('%s %s: 403 for the demo student', async (method, path, body) => {
    const res = await send(student, method, path, body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it.each(ADMIN_ROUTES)('%s %s: allowed for the admin', async (method, path, body) => {
    expect((await send(admin, method, path, body)).status).toBe(200);
  });

  it('a student cannot rename a dish even with a hand-crafted request, and nothing changes', async () => {
    const res = await send(student, 'PATCH', '/api/admin/dishes/D012', { display_name: 'Hacked Rice' });
    expect(res.status).toBe(403);
    const { rows } = await ctx.pool.query("SELECT display_name FROM dishes WHERE id = 'D012'");
    expect(rows[0].display_name).toBe('Rice');
  });

  it('a role change takes effect on the next request (role is read from the database)', async () => {
    const temp = await createUser(ctx.pool, { email: 'temp-admin@example.test', role: 'admin' });
    const agent = await signedIn(app, 'temp-admin@example.test');
    expect((await agent.get('/api/admin/dishes')).status).toBe(200);
    await ctx.pool.query("UPDATE users SET role = 'student', student_id = 2 WHERE id = $1", [temp.id]);
    expect((await agent.get('/api/admin/dishes')).status).toBe(403);
  });
});
