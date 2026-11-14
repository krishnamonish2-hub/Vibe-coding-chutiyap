import { Router } from 'express';

const ML_HEALTH_TIMEOUT_CAP_MS = 2000; // a health check should answer quickly even if ML_TIMEOUT_MS is long

// Reads the ML service's GET /health (contract v0.3 §2.1). It always answers HTTP 200 when the
// service is up; `model_loaded` tells whether predictions are possible. Never throws.
export async function fetchMlHealth(mlApiUrl, timeoutMs) {
  const unreachable = { reachable: false, model_loaded: false, model_version: null };
  try {
    const res = await fetch(`${mlApiUrl}/health`, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, ML_HEALTH_TIMEOUT_CAP_MS)),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return unreachable;
    const body = await res.json();
    return {
      reachable: true,
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
    const status = database === 'ok' && ml.reachable && ml.model_loaded ? 'ok' : 'degraded';
    res.status(database === 'ok' ? 200 : 503).json({ status, backend: 'ok', database, ml });
  });
  return router;
}
