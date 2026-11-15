import { Router } from 'express';
import { z } from 'zod';

import { SESSION_COOKIE, sessionCookieOptions, signSession } from '../auth/jwt.js';
import { createLoginLimiter } from '../auth/login-limiter.js';
import { verifyPassword } from '../auth/password.js';
import { parseOrThrow } from '../lib/validate.js';
import { ApiError } from '../middleware/error-handler.js';
import { requireAuth, sessionUser } from '../middleware/auth.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(200),
}).strict();

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, student_code: user.studentCode ?? null };
}

export function createAuthRouter({ pool, config, limiter = createLoginLimiter({ maxFailures: config.loginMaxFailures }) }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (limiter.isBlocked(ip)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again later.');
    }
    const { email, password } = parseOrThrow(LoginBody, req.body);

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.password_hash, u.session_version, s.code AS student_code
         FROM users u LEFT JOIN students s ON s.id = u.student_id WHERE u.email = $1`,
      [email],
    );
    const row = rows[0];
    const ok = await verifyPassword(password, row?.password_hash);
    if (!row || !ok) {
      limiter.recordFailure(ip);
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    limiter.recordSuccess(ip);

    const user = { id: Number(row.id), email: row.email, role: row.role, studentCode: row.student_code };
    const token = signSession(user.id, row.session_version,
      { secret: config.jwtSecret, ttlHours: config.sessionTtlHours });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(config));
    res.json({ user: publicUser(user) });
  });

  // Logout invalidates every token issued to this user so far (session versioning): the version is incremented only
  // if the presented token is still current, so a stale or copied old token cannot bump it again. The cookie is
  // always cleared, and logout always answers 204, with or without a valid session.
  router.post('/logout', async (req, res) => {
    const user = await sessionUser(pool, req, config);
    if (user) {
      await pool.query(
        'UPDATE users SET session_version = session_version + 1 WHERE id = $1 AND session_version = $2',
        [user.id, user.sessionVersion],
      );
    }
    const { maxAge, ...options } = sessionCookieOptions(config); // eslint-disable-line no-unused-vars
    res.clearCookie(SESSION_COOKIE, options);
    res.status(204).end();
  });

  router.get('/me', requireAuth({ pool, config }), (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
}
