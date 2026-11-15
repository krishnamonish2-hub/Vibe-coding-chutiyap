import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, loadDatabaseUrl } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      port: 4000,
      databaseUrl: base.DATABASE_URL,
      mlApiUrl: 'http://127.0.0.1:8001',
      mlTimeoutMs: 10000,
      jwtSecret: base.JWT_SECRET,
      sessionTtlHours: 8,
      cookieSecure: false,
      loginMaxFailures: 10,
    });
  });

  it('reads explicit values and strips a trailing slash from ML_API_URL', () => {
    const cfg = loadConfig({
      ...base, PORT: '5050', ML_API_URL: 'http://ml.internal:9000/', ML_TIMEOUT_MS: '2500',
      SESSION_TTL_HOURS: '2', COOKIE_SECURE: 'true', LOGIN_MAX_FAILURES: '5',
    });
    expect(cfg).toMatchObject({
      port: 5050, mlApiUrl: 'http://ml.internal:9000', mlTimeoutMs: 2500,
      sessionTtlHours: 2, cookieSecure: true, loginMaxFailures: 5,
    });
  });

  it('turns secure cookies on by default in production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ JWT_SECRET: base.JWT_SECRET })).toThrow(ConfigError);
  });

  it.each([[undefined], [''], ['too-short']])('requires a JWT_SECRET of at least 32 characters (%s)', (secret) => {
    expect(() => loadConfig({ ...base, JWT_SECRET: secret })).toThrow(/JWT_SECRET/);
  });

  it.each([['abc'], ['0'], ['-1'], ['1.5'], ['70000']])('rejects invalid PORT %s', (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow(ConfigError);
  });

  it.each([['not a url'], ['ftp://ml:21']])('rejects invalid ML_API_URL %s', (url) => {
    expect(() => loadConfig({ ...base, ML_API_URL: url })).toThrow(ConfigError);
  });

  it.each([
    ['ML_TIMEOUT_MS', '0'], ['SESSION_TTL_HOURS', '0'], ['SESSION_TTL_HOURS', '200'],
    ['COOKIE_SECURE', 'yes'], ['LOGIN_MAX_FAILURES', '-3'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(base))).toBe(true);
  });
});

describe('loadDatabaseUrl (migrate/seed tools)', () => {
  it('needs only DATABASE_URL', () => {
    expect(loadDatabaseUrl({ DATABASE_URL: base.DATABASE_URL })).toBe(base.DATABASE_URL);
    expect(() => loadDatabaseUrl({})).toThrow(ConfigError);
  });
});
