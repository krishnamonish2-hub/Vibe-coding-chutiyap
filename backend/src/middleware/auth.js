// Backend authorization: every protected route checks the session and the role on the server.
// The frontend only hides what the user cannot use; it is never trusted.

import { SESSION_COOKIE, verifySession } from '../auth/jwt.js';
import { ApiError } from './error-handler.js';

export async function loadUser(db, userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, u.student_id, u.session_version, s.code AS student_code
       FROM users u LEFT JOIN students s ON s.id = u.student_id
      WHERE u.id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  const u = rows[0];
  return {
    id: Number(u.id), email: u.email, role: u.role, studentId: u.student_id, studentCode: u.student_code,
    sessionVersion: u.session_version,
  };
}

// Resolves the session cookie to the current user, or null when the token is invalid, the account no longer exists,
// or the token's session version is not the user's current one (e.g. issued before a logout).
export async function sessionUser(db, req, config) {
  const session = verifySession(req.cookies?.[SESSION_COOKIE], { secret: config.jwtSecret });
  if (!session) return null;
  const user = await loadUser(db, session.userId);
  if (!user || user.sessionVersion !== session.sessionVersion) return null;
  return user;
}

export function requireAuth({ pool, config }) {
  return async function requireAuthMiddleware(req, res, next) {
    const user = await sessionUser(pool, req, config);
    if (!user) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
    req.user = user;
    return next();
  };
}

export function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'forbidden', 'You do not have access to this resource'));
    }
    return next();
  };
}

// Cross-site request protection for cookie sessions, on top of SameSite=Strict: state-changing requests must be
// JSON, which a plain HTML form on another site cannot send.
export function requireJsonForWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.is('application/json')) {
    return next(new ApiError(415, 'unsupported_media_type', 'Requests that change data must use application/json'));
  }
  return next();
}
