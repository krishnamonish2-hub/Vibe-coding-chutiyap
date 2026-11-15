// ML contract conformance (no database): request/response validators vs the existing ML service, and the ML client
// (health readiness + 60 s cache, one-time model-info, timeouts) against a mock service.
// READ-ONLY use of ml/api/schemas.py and shared/api_contract.md.

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDisabledMlClient, createMlClient, isMlHealthReady } from '../src/ml/client.js';
import { DishRequest, MealRequestBase, validateRequest } from '../src/ml/request-schema.js';
import { validateResponse } from '../src/ml/response-schema.js';
import { fakeAnswer, startMockMl } from './helpers/mock-ml.js';

const ROOT = new URL('../../', import.meta.url);
const contract = readFileSync(new URL('shared/api_contract.md', ROOT), 'utf8');
const pySchemas = readFileSync(new URL('ml/api/schemas.py', ROOT), 'utf8');

function contractExamples() {
  const section = contract.split('### 2.3 `POST /predict`')[1].split('\n### ')[0];
  const [request, response] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  return { request, response };
}
function pyFields(className) {
  const block = pySchemas.split(`class ${className}(`)[1].split('\n\n')[0];
  return [...block.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]);
}

const valid = () => {
  const { request } = contractExamples();
  return { ...request, dishes: request.dishes.map((d) => ({ is_special: false, ...d })) }; // we always send is_special
};

describe('request schema mirrors ml/api/schemas.py', () => {
  it('has exactly the same fields as MealRequest and DishIn', () => {
    expect(pyFields('MealRequest')).toHaveLength(12);
    expect(pyFields('DishIn')).toHaveLength(9);
    expect(new Set(Object.keys(MealRequestBase.shape))).toEqual(new Set(pyFields('MealRequest')));
    expect(new Set(Object.keys(DishRequest.shape))).toEqual(new Set(pyFields('DishIn')));
  });

  it('accepts the contract §2.3 example (with is_special sent, as the backend always does)', () => {
    expect(validateRequest(valid())).toMatchObject({ ok: true });
  });

  it('is stricter than the contract where approved: is_special and the flags must always be sent', () => {
    const { request } = contractExamples(); // second dish omits is_special in the contract example
    expect(validateRequest(request).ok).toBe(false);
    const noFlag = valid(); delete noFlag.is_holiday;
    expect(validateRequest(noFlag).ok).toBe(false);
  });

  const mutate = (fn) => { const r = valid(); fn(r); return r; };
  it.each([
    ['an unknown top-level field', (r) => { r.day_of_week = 1; }],
    ['an unknown dish field', (r) => { r.dishes[0].display_name = 'Steamed Rice'; }],
    ['an untrimmed dish_name', (r) => { r.dishes[0].dish_name = ' Rice'; }],
    ['a 101-character meal_id', (r) => { r.meal_id = 'x'.repeat(101); }],
    ['an empty dish_category', (r) => { r.dishes[0].dish_category = ''; }],
    ['a non-integer total_responses', (r) => { r.total_responses = 410.5; }],
    ['a string total_students', (r) => { r.total_students = '1000'; }],
    ['total_students other than 1000', (r) => { r.total_students = 999; }],
    ['a null boolean', (r) => { r.is_holiday = null; }],
    ['a number as boolean', (r) => { r.dishes[0].is_veg = 1; }],
    ['an impossible date', (r) => { r.date = '2026-02-30'; }],
    ['a non-ISO date', (r) => { r.date = '16/11/2026'; }],
    ['an unknown meal_type', (r) => { r.meal_type = 'snacks'; }],
    ['a padded meal_type', (r) => { r.meal_type = ' lunch'; }],
    ['NaN rainfall', (r) => { r.rainfall = Number.NaN; }],
    ['Infinity temperature', (r) => { r.temperature = Number.POSITIVE_INFINITY; }],
    ['temperature above 60', (r) => { r.temperature = 61; }],
    ['negative rainfall', (r) => { r.rainfall = -1; }],
    ['a rating above 5', (r) => { r.dishes[0].historical_dish_rating = 5.1; }],
    ['negative history', (r) => { r.dishes[0].historical_dish_demand = -1; }],
    ['null optional history (we omit instead)', (r) => { r.dishes[0].previous_leftover_kg = null; }],
    ['a non-integer previous_meal_attendance', (r) => { r.previous_meal_attendance = 720.5; }],
    ['previous_meal_attendance above total_students', (r) => { r.previous_meal_attendance = 1001; }],
    ['taps above total_responses', (r) => { r.dishes[0].interested_taps = 411; }],
    ['total_responses above total_students', (r) => { r.total_responses = 1001; }],
    ['duplicate dish_id', (r) => { r.dishes[1].dish_id = r.dishes[0].dish_id; }],
    ['duplicate dish_name', (r) => { r.dishes[1].dish_name = r.dishes[0].dish_name; }],
    ['no dishes', (r) => { r.dishes = []; }],
    ['31 dishes', (r) => { r.dishes = Array.from({ length: 31 }, (_, i) => ({ ...r.dishes[0], dish_id: `D${i}`, dish_name: `N${i}` })); }],
    ['missing interested_taps', (r) => { delete r.dishes[0].interested_taps; }],
  ])('rejects %s', (_, fn) => {
    const result = validateRequest(mutate(fn));
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('never coerces: the validated value is the same object, unchanged', () => {
    const r = valid();
    const copy = JSON.parse(JSON.stringify(r));
    expect(validateRequest(r).value).toBe(r);
    expect(r).toEqual(copy);
  });
});

describe('response validation', () => {
  it('accepts the contract §2.3 example response for its request', () => {
    const { response } = contractExamples();
    expect(validateResponse(response, valid())).toMatchObject({ ok: true });
  });

  const req = valid();
  const ok = () => fakeAnswer(req);
  it.each([
    ['an extra top-level field', (a) => { a.extra = 1; }],
    ['an extra prediction field', (a) => { a.predictions[0].raw_prediction = 1.2; }],
    ['a different meal_id', (a) => { a.meal_id = 'other'; }],
    ['a missing model_version', (a) => { delete a.model_version; }],
    ['an empty trained_on', (a) => { a.trained_on = ''; }],
    ['too few predictions', (a) => { a.predictions.pop(); }],
    ['reordered predictions', (a) => { a.predictions.reverse(); }],
    ['an unknown dish_id', (a) => { a.predictions[0].dish_id = 'D999'; }],
    ['interested_taps not echoed', (a) => { a.predictions[0].interested_taps += 1; }],
    ['a fractional prediction', (a) => { a.predictions[0].predicted_consumers = 12.5; }],
    ['a negative prediction', (a) => { a.predictions[0].predicted_consumers = -1; }],
    ['a prediction above total_students', (a) => { a.predictions[0].predicted_consumers = 1001; }],
    ['a string prediction', (a) => { a.predictions[0].predicted_consumers = '500'; }],
    ['non-string warnings', (a) => { a.predictions[0].warnings = [1]; }],
    ['a null body', () => null],
  ])('rejects %s', (_, fn) => {
    const a = ok();
    const out = fn(a);
    const result = validateResponse(out === undefined ? a : out, req);
    expect(result.ok).toBe(false);
  });
});

describe('ML client against a mock service', () => {
  let mock;
  let t;
  const client = (opts = {}) => createMlClient({ baseUrl: mock.url, timeoutMs: 300, now: () => t, ...opts });

  beforeAll(async () => { mock = await startMockMl(); });
  afterAll(async () => mock.close());
  beforeEach(() => { mock.reset(); t = 1_000_000; });

  it('ready only when status is ok AND model_loaded is true (HTTP 200 alone is not enough)', async () => {
    mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    expect(await client().getHealth()).toMatchObject({ ready: false, reason: 'model_not_loaded', model_loaded: false });
    mock.state.health = { status: 'ok', model_loaded: false, model_version: null };
    expect((await client().getHealth()).ready).toBe(false);
    mock.state.health = { status: 'degraded', model_loaded: true, model_version: 'x' };
    expect((await client().getHealth()).ready).toBe(false);
    mock.reset();
    expect(await client().getHealth()).toMatchObject({ ready: true, model_version: 'rf-v1-synthetic' });
  });

  it('caches health for 60 s, then checks again', async () => {
    const c = client();
    await c.getHealth(); await c.getHealth();
    t += 59_999; await c.getHealth();
    expect(mock.count('/health')).toBe(1);
    t += 2; mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    expect((await c.getHealth()).ready).toBe(false);
    expect(mock.count('/health')).toBe(2);
  });

  it('reports an unreachable service and a non-200 health answer as not ready', async () => {
    expect(await createMlClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).getHealth())
      .toMatchObject({ ready: false, reason: 'health_unreachable' });
    mock.state.healthStatus = 500;
    expect(await client().getHealth()).toMatchObject({ ready: false, reason: 'health_unreachable', detail: 'HTTP 500' });
  });

  it('reads /model-info once (a failed read is retried later)', async () => {
    const c = client();
    mock.state.modelInfoStatus = 503;
    expect(await c.getModelInfo()).toBeNull();
    mock.state.modelInfoStatus = 200;
    for (let i = 0; i < 5; i += 1) expect((await c.getModelInfo()).contract_version).toBe('0.3');
    expect(mock.count('/model-info')).toBe(2);
  });

  it('classifies predict results without throwing', async () => {
    const c = client();
    mock.state.queue = ['ok', 422, 500, 'timeout'];
    expect((await c.predict(valid())).kind).toBe('ok');
    expect(await c.predict(valid())).toMatchObject({ kind: 'http_error', status: 422 });
    expect(await c.predict(valid())).toMatchObject({ kind: 'http_error', status: 500 });
    expect(await c.predict(valid())).toMatchObject({ kind: 'timeout' });
    expect((await createMlClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).predict(valid())).kind).toBe('network_error');
    expect(mock.predictRequests().every((r) => r.path === '/predict')).toBe(true);
    expect(mock.count('/predict/batch')).toBe(0);
  });

  it('checkReady: ready only with healthy model, readable model-info and contract 0.3', async () => {
    expect(await client().checkReady()).toMatchObject({ ready: true, model_version: 'rf-v1-synthetic' });
    mock.reset(); mock.state.modelInfo = { ...mock.state.modelInfo, contract_version: '0.4' };
    expect(await client().checkReady()).toMatchObject({ ready: false, reason: 'contract_mismatch' });
    mock.reset(); mock.state.modelInfoStatus = 500;
    expect(await client().checkReady()).toMatchObject({ ready: false, reason: 'model_info_unavailable' });
    mock.reset(); mock.state.health = { status: 'ok', model_loaded: false, model_version: null };
    expect(await client().checkReady()).toMatchObject({ ready: false, reason: 'model_not_loaded' });
    expect(mock.count('/model-info')).toBe(0); // not read when health is not ready
  });

  it('checkReady({ refreshIfNotReady }) bypasses a cached "not ready"; the default uses the cache', async () => {
    const c = client();
    mock.state.health = { status: 'degraded', model_loaded: false, model_version: null };
    expect((await c.checkReady()).ready).toBe(false);
    mock.state.health = { status: 'ok', model_loaded: true, model_version: 'rf-v1-synthetic' };
    expect((await c.checkReady()).ready).toBe(false); // cached
    expect(mock.count('/health')).toBe(1);
    expect((await c.checkReady({ refreshIfNotReady: true })).ready).toBe(true);
    expect(mock.count('/health')).toBe(2);
    expect((await c.checkReady({ refreshIfNotReady: true })).ready).toBe(true); // cached "ready" is trusted
    expect(mock.count('/health')).toBe(2);
  });

  it('isMlHealthReady is the single strict rule', () => {
    expect([isMlHealthReady({ status: 'ok', model_loaded: true }), isMlHealthReady({ status: 'degraded', model_loaded: true }),
      isMlHealthReady({ status: 'ok', model_loaded: false }), isMlHealthReady(null)]).toEqual([true, false, false, false]);
  });

  it('the disabled client is never ready and never calls anything', async () => {
    const c = createDisabledMlClient();
    expect(await c.getHealth()).toEqual({ ready: false, reason: 'ml_not_configured' });
    expect(await c.checkReady()).toMatchObject({ ready: false, reason: 'ml_not_configured' });
    await expect(c.predict({})).rejects.toThrow();
  });
});
