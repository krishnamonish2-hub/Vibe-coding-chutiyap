// OPT-IN smoke test against the REAL, unmodified ML service (skipped unless ML_LIVE_TESTS=1). Never runs in CI.
//
//   1. Start the ML service exactly as documented in ml/README.md (its own venv, port 8001).
//   2. ML_LIVE_TESTS=1 ML_API_URL=http://127.0.0.1:8001 DATABASE_URL=... npm test -- tests/ml-live.test.js
//
// Only reads from the ML service (GET /health, GET /model-info, POST /predict). Nothing under ml/ is touched.

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMlClient } from '../src/ml/client.js';
import { validateRequest } from '../src/ml/request-schema.js';
import { validateResponse } from '../src/ml/response-schema.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

const LIVE = process.env.ML_LIVE_TESTS === '1';
const URL_ = process.env.ML_API_URL ?? 'http://127.0.0.1:8001';

describe.skipIf(!LIVE)('real ML service (opt-in)', { timeout: 120_000 }, () => {
  const ml = createMlClient({ baseUrl: URL_, timeoutMs: 10_000 });

  it('is healthy with the model loaded, and reports contract 0.3', async () => {
    expect(await ml.getHealth()).toMatchObject({ ready: true });
    expect(await ml.getModelInfo()).toMatchObject({ contract_version: '0.3', trained_on: 'synthetic' });
  });

  it('answers the contract §2.3 example with a response that passes our validation', async () => {
    const contract = readFileSync(new URL('../../shared/api_contract.md', import.meta.url), 'utf8');
    const section = contract.split('### 2.3 `POST /predict`')[1].split('\n### ')[0];
    const [example] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
    const req = { ...example, dishes: example.dishes.map((d) => ({ is_special: false, ...d })) };
    expect(validateRequest(req).ok).toBe(true);
    const r = await ml.predict(req);
    expect(r.kind).toBe('ok');
    expect(validateResponse(r.body, req)).toMatchObject({ ok: true });
  });

  describe.skipIf(!DATABASE_URL)('with the simulation engine', () => {
    let ctx;
    beforeAll(async () => { ctx = await createTestSchema('live_ml', { seeded: true }); });
    afterAll(async () => ctx?.drop());

    it('Day 31 provisional and final predictions are ok and validated', async () => {
      const sim = createSimulationController({ pool: ctx.pool, ml, log: { error: () => {} } });
      await sim.start({ seed: 42 }, null);
      await sim.advance({ to: 'day', day: 31 });
      for (let i = 0; i < 3; i += 1) await sim.advance({ to: 'next_step' }); // breakfast provisional + final
      const { rows } = await ctx.pool.query(
        "SELECT kind, status, error_detail FROM prediction_requests WHERE meal_id LIKE '%-d031-breakfast' ORDER BY kind");
      expect(rows.map((r) => [r.kind, r.status])).toEqual([['final', 'ok'], ['provisional', 'ok']]);
      await sim.shutdown();
    });
  });
});
