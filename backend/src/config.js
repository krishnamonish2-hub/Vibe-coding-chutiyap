// Reads and validates configuration from environment variables.
// loadConfig() is for the HTTP server; loadDatabaseUrl() is for command-line tools (migrate, seed) that only need
// the database.

export class ConfigError extends Error {}

export const MIN_JWT_SECRET_LENGTH = 32;

function positiveInt(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function bool(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

function httpUrl(name, raw, fallback) {
  const value = raw === undefined || raw === '' ? fallback : raw;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http or https, got ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, ''); // no trailing slash, so paths can be appended safely
}

export function loadDatabaseUrl(env = process.env) {
  if (!env.DATABASE_URL) throw new ConfigError('DATABASE_URL is required (see .env.example)');
  return env.DATABASE_URL;
}

export function loadConfig(env = process.env) {
  const port = positiveInt('PORT', env.PORT, 4000);
  if (port > 65535) throw new ConfigError(`PORT must be <= 65535, got ${port}`);

  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(`JWT_SECRET is required and must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }

  const sessionTtlHours = positiveInt('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 8);
  if (sessionTtlHours > 24 * 7) throw new ConfigError('SESSION_TTL_HOURS must be <= 168');

  return Object.freeze({
    port,
    databaseUrl: loadDatabaseUrl(env),
    mlApiUrl: httpUrl('ML_API_URL', env.ML_API_URL, 'http://127.0.0.1:8001'),
    mlTimeoutMs: positiveInt('ML_TIMEOUT_MS', env.ML_TIMEOUT_MS, 10000),
    jwtSecret,
    sessionTtlHours,
    // Secure cookies need HTTPS; default on in production, off for local http development.
    cookieSecure: bool('COOKIE_SECURE', env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    loginMaxFailures: positiveInt('LOGIN_MAX_FAILURES', env.LOGIN_MAX_FAILURES, 10),
  });
}
