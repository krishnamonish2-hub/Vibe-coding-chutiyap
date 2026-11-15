// Authentication: login, session cookie, /me, logout, token validation, login limiter, JSON-only writes.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE, signSession, verifySession } from '../src/auth/jwt.js';
import { createLoginLimiter } from '../src/auth/login-limiter.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../src/auth/password.js';
import { PASSWORD, TEST_SECRET, buildApp, createUser, signedIn, testConfig } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

describe('password helpers', () => {
  it('enforces 12 characters and the 72-byte bcrypt limit', () => {
    expect(checkPasswordStrength('short')).toMatch(/12/);
    expect(checkPasswordStrength('x'.repeat(73))).toMatch(/72/);
    expect(checkPasswordStrength('long enough pass')).toBeNull();
  });

  it('hashes and verifies; rejects wrong, missing and oversized input', async () => {
    const hash = await hashPassword(PASSWORD, 4);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong password!', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, undefined)).toBe(false);
    expect(await verifyPassword('x'.repeat(100), hash)).toBe(false);
    await expect(hashPassword('short', 4)).rejects.toThrow(/12/);
  });
});

describe('session tokens', () => {
  const cfg = { secret: TEST_SECRET, ttlHours: 1 };

  it('round-trips the user id and session version', () => {
    expect(verifySession(signSession(42, 3, cfg), cfg)).toEqual({ userId: '42', sessionVersion: 3 });
  });

  it.each([[0], [-1], [1.5], ['1'], [undefined]])('refuses to sign an invalid session version (%j)', (sv) => {
    expect(() => signSession(42, sv, cfg)).toThrow(TypeError);
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'not.a.token'],
    ['wrong secret', jwt.sign({ sub: '1', sv: 1 }, 'another-secret-another-secret-123', { algorithm: 'HS256', issuer: 'messmind' })],
    ['wrong issuer', jwt.sign({ sub: '1', sv: 1 }, TEST_SECRET, { algorithm: 'HS256', issuer: 'someone-else' })],
    ['expired', jwt.sign({ sub: '1', sv: 1, exp: Math.floor(Date.now() / 1000) - 10 }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
    ['alg none', `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"1","sv":1,"iss":"messmind"}').toString('base64url')}.`],
    ['non-numeric subject', jwt.sign({ sub: 'admin', sv: 1 }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
    ['pre-versioning token (no sv)', jwt.sign({ sub: '1' }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
    ['sv = 0', jwt.sign({ sub: '1', sv: 0 }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
    ['sv as a string', jwt.sign({ sub: '1', sv: '1' }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
    ['fractional sv', jwt.sign({ sub: '1', sv: 1.5 }, TEST_SECRET, { algorithm: 'HS256', issuer: 'messmind' })],
  ])('rejects a %s token', (_, token) => {
    expect(verifySession(token, cfg)).toBeNull();
  });
});

describe('login limiter', () => {
  it('blocks after N failures within the window and recovers afterwards', () => {
    let t = 0;
    const limiter = createLoginLimiter({ maxFailures: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    expect(limiter.isBlocked('5.6.7.8')).toBe(false);
    t = 1001;
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('a successful login clears the counter', () => {
    const limiter = createLoginLimiter({ maxFailures: 2 });
    limiter.recordFailure('ip');
    limiter.recordSuccess('ip');
    limiter.recordFailure('ip');
    expect(limiter.isBlocked('ip')).toBe(false);
  });
});

describe.skipIf(!DATABASE_URL)('auth routes', () => {
  let ctx;
  let app;

  beforeAll(async () => {
    ctx = await createTestSchema('p3_auth', { seeded: true });
    app = buildApp(ctx.pool);
    await createUser(ctx.pool, { email: 'admin@example.test', role: 'admin' });
    await createUser(ctx.pool, { email: 'demo@example.test', role: 'student', studentCode: 'S0001' });
  });
  afterAll(async () => ctx?.drop());

  it('logs in and sets an httpOnly, SameSite=Strict session cookie scoped to /api', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@example.test', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@example.test', role: 'admin', student_code: null });
    expect(res.body.user).not.toHaveProperty('password_hash');
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api/);
    expect(cookie).not.toMatch(/Secure/); // local http prototype (COOKIE_SECURE=false)
  });

  it('marks the cookie Secure when configured', async () => {
    const secureApp = buildApp(ctx.pool, { config: testConfig({ cookieSecure: true }) });
    const res = await request(secureApp).post('/api/auth/login').send({ email: 'admin@example.test', password: PASSWORD });
    expect(res.headers['set-cookie'][0]).toMatch(/Secure/);
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: '  Admin@Example.TEST ', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: 'admin@example.test', password: 'not the password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.test', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['missing password', { email: 'admin@example.test' }],
    ['extra field', { email: 'admin@example.test', password: PASSWORD, role: 'admin' }],
    ['non-string email', { email: 5, password: PASSWORD }],
  ])('rejects a login body with %s (400)', async (_, body) => {
    const res = await request(app).post('/api/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('GET /me returns the signed-in user; the demo student is linked to S0001', async () => {
    const agent = await signedIn(app, 'demo@example.test');
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'demo@example.test', role: 'student', student_code: 'S0001' });
  });

  it('GET /me needs a valid session', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    const forged = jwt.sign({ sub: '1', sv: 1 }, 'not-the-server-secret-not-the-secret', { algorithm: 'HS256', issuer: 'messmind' });
    const res = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('logout clears the cookie', async () => {
    const agent = await signedIn(app, 'admin@example.test');
    const res = await agent.post('/api/auth/logout').set('Content-Type', 'application/json').send({});
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'][0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('a session stops working as soon as the account is deleted', async () => {
    const temp = await createUser(ctx.pool, { email: 'temp@example.test', role: 'admin' });
    const agent = await signedIn(app, 'temp@example.test');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await ctx.pool.query('DELETE FROM users WHERE id = $1', [temp.id]);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('returns 429 after too many failed logins from one client', async () => {
    const limited = buildApp(ctx.pool, { config: testConfig({ loginMaxFailures: 3 }) });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(limited).post('/api/auth/login').send({ email: 'admin@example.test', password: 'wrong password!' })).status).toBe(401);
    }
    const blocked = await request(limited).post('/api/auth/login').send({ email: 'admin@example.test', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');
  });

  it('rejects state-changing requests that are not JSON (415)', async () => {
    const res = await request(app).post('/api/auth/login').type('form').send('email=admin@example.test&password=x');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });
});
