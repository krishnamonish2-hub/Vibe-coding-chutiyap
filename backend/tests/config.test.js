import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      port: 4000,
      databaseUrl: base.DATABASE_URL,
      mlApiUrl: 'http://127.0.0.1:8001',
      mlTimeoutMs: 10000,
    });
  });

  it('reads explicit values and strips a trailing slash from ML_API_URL', () => {
    const cfg = loadConfig({ ...base, PORT: '5050', ML_API_URL: 'http://ml.internal:9000/', ML_TIMEOUT_MS: '2500' });
    expect(cfg.port).toBe(5050);
    expect(cfg.mlApiUrl).toBe('http://ml.internal:9000');
    expect(cfg.mlTimeoutMs).toBe(2500);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it.each([['abc'], ['0'], ['-1'], ['1.5'], ['70000']])('rejects invalid PORT %s', (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow(ConfigError);
  });

  it.each([['not a url'], ['ftp://ml:21']])('rejects invalid ML_API_URL %s', (url) => {
    expect(() => loadConfig({ ...base, ML_API_URL: url })).toThrow(ConfigError);
  });

  it('rejects a non-positive ML_TIMEOUT_MS', () => {
    expect(() => loadConfig({ ...base, ML_TIMEOUT_MS: '0' })).toThrow(ConfigError);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(base))).toBe(true);
  });
});
