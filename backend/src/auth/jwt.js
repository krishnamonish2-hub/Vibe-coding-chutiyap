import jwt from 'jsonwebtoken';

const ALGORITHM = 'HS256';
const ISSUER = 'messmind';
export const SESSION_COOKIE = 'messmind_session';

const POSITIVE_INT_STRING = /^[1-9][0-9]*$/;

// The token carries the user id (`sub`) and the user's session version at login (`sv`). Role and student link are
// re-read from the database on every request, and `sv` must equal the user's current session_version, so logout
// (which increments it), a deleted account or a role change take effect immediately.
export function signSession(userId, sessionVersion, { secret, ttlHours }) {
  if (!Number.isInteger(sessionVersion) || sessionVersion < 1) {
    throw new TypeError('sessionVersion must be a positive integer');
  }
  return jwt.sign({ sub: String(userId), sv: sessionVersion }, secret, {
    algorithm: ALGORITHM, issuer: ISSUER, expiresIn: `${ttlHours}h`,
  });
}

// Returns { userId, sessionVersion } or null for a missing, malformed, expired, tampered or pre-versioning token.
export function verifySession(token, { secret }) {
  if (typeof token !== 'string' || token.length === 0) return null;
  let payload;
  try {
    payload = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER });
  } catch {
    return null;
  }
  if (!POSITIVE_INT_STRING.test(payload.sub ?? '')) return null;
  if (!Number.isInteger(payload.sv) || payload.sv < 1) return null;
  return { userId: payload.sub, sessionVersion: payload.sv };
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/api',
    maxAge: config.sessionTtlHours * 3600 * 1000,
  };
}
