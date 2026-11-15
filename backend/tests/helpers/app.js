// Test helpers for the HTTP app: a fixed test configuration, synthetic test accounts and signed-in agents.

import request from 'supertest';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';

export const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long';

export function testConfig(overrides = {}) {
  return {
    port: 0,
    databaseUrl: 'postgres://unused',
    mlApiUrl: 'http://127.0.0.1:1',
    mlTimeoutMs: 500,
    jwtSecret: TEST_SECRET,
    sessionTtlHours: 8,
    cookieSecure: false,
    loginMaxFailures: 1000, // effectively off; the limiter has its own tests
    ...overrides,
  };
}

export const mlDown = async () => ({ reachable: false, model_loaded: false, model_version: null });

export function buildApp(pool, { config = testConfig(), ...rest } = {}) {
  return createApp({ pool, config, getMlHealth: mlDown, ...rest });
}

export const PASSWORD = 'correct horse battery';

// Creates a user with a low bcrypt cost (fast tests). Student accounts are linked by student code.
export async function createUser(db, { email, role, studentCode = null, password = PASSWORD }) {
  let studentId = null;
  if (studentCode) studentId = (await db.query('SELECT id FROM students WHERE code = $1', [studentCode])).rows[0].id;
  const { rows } = await db.query(
    'INSERT INTO users (email, password_hash, role, student_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, await hashPassword(password, 4), role, studentId],
  );
  return { id: Number(rows[0].id), email, role };
}

// Returns a supertest agent that keeps cookies, signed in as `email`.
export async function signedIn(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
