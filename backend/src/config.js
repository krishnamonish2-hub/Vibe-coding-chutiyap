// Reads and validates configuration from environment variables.
// Only settings needed by the current phase are read; later phases add their own (e.g. JWT_SECRET in Phase 3).

export class ConfigError extends Error {}

function positiveInt(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
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

export function loadConfig(env = process.env) {
  const port = positiveInt('PORT', env.PORT, 4000);
  if (port > 65535) throw new ConfigError(`PORT must be <= 65535, got ${port}`);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required (see .env.example)');

  return Object.freeze({
    port,
    databaseUrl,
    mlApiUrl: httpUrl('ML_API_URL', env.ML_API_URL, 'http://127.0.0.1:8001'),
    mlTimeoutMs: positiveInt('ML_TIMEOUT_MS', env.ML_TIMEOUT_MS, 10000),
  });
}
