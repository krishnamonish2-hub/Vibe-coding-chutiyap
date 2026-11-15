import { Router } from 'express';

import { isMlHealthReady } from '../ml/client.js';

const ML_HEALTH_TIMEOUT_CAP_MS = 2000; // a health check should answer quickly even if ML_TIMEOUT_MS is long

// Reads the ML service's GET /health (contract v0.3 §2.1). It always answers HTTP 200 when the
// service is up; `ready` uses the same strict rule as the ML client (status 'ok' AND model_loaded). Never throws.
export async function fetchMlHealth(mlApiUrl, timeoutMs) {
  const unreachable = { reachable: false, ready: false, model_loaded: false, model_version: null };
  try {
    const res = await fetch(`${mlApiUrl}/health`, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, ML_HEALTH_TIMEOUT_CAP_MS)),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return unreachable;
    const body = await res.json();
    return {
      reachable: true,
      ready: isMlHealthReady(body),
      model_loaded: body?.model_loaded === true,
      model_version: typeof body?.model_version === 'string' ? body.model_version : null,
    };
  } catch {
    return unreachable;
  }
}

async function checkDatabase(pool) {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch {
    return 'error';
  }
}

export function createHealthRouter({ pool, getMlHealth }) {
  const router = Router();
  router.get('/health', async (req, res) => {
    const [database, ml] = await Promise.all([checkDatabase(pool), getMlHealth()]);
    const status = database === 'ok' && ml.ready === true ? 'ok' : 'degraded';
    res.status(database === 'ok' ? 200 : 503).json({ status, backend: 'ok', database, ml });
  });
  return router;
}
