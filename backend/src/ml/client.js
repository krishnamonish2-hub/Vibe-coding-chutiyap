// HTTP client for the independent ML service (backend-only; the browser never calls it). Contract v0.3.
//
// * GET /health always answers HTTP 200 when the service is up, so readiness is status === 'ok' AND model_loaded === true
//   (isMlHealthReady, also used by GET /api/health). The result (ready or not, or unreachable) is cached for 60 s of
//   wall-clock time; getHealth({ fresh: true }) bypasses the cache.
// * GET /model-info is read once (after the first successful read it is never requested again; a failed read is
//   retried on a later call). Its contract_version must be 0.3.
// * checkReady() combines both and is called OUTSIDE any database transaction, before a prediction is attempted.
// * POST /predict (never /predict/batch) with a timeout (default 10 s). Results are classified, never thrown:
//   { kind: 'ok' | 'http_error' | 'timeout' | 'network_error', status?, body? }.

export const HEALTH_TTL_MS = 60_000;
export const EXPECTED_CONTRACT_VERSION = '0.3';

// The single, strict readiness rule for the ML service's GET /health body (contract v0.3 §2.1).
export function isMlHealthReady(body) {
  return body?.status === 'ok' && body?.model_loaded === true;
}

export function createMlClient({ baseUrl, timeoutMs = 10_000, healthTtlMs = HEALTH_TTL_MS, now = () => Date.now(),
  fetchImpl = globalThis.fetch } = {}) {
  let healthCache = null; // { at, value }
  let modelInfo = null;
  const url = (path) => `${baseUrl.replace(/\/+$/, '')}${path}`;

  async function request(method, path, body, ms) {
    try {
      const res = await fetchImpl(url(path), {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ms),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
      if (json === undefined) return { kind: res.ok ? 'invalid_json' : 'http_error', status: res.status, body: text.slice(0, 2000) };
      return res.ok ? { kind: 'ok', status: res.status, body: json } : { kind: 'http_error', status: res.status, body: json };
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'network_error', message: String(err?.cause?.code ?? err?.message ?? err) };
    }
  }

  async function getHealth({ fresh = false } = {}) {
    if (!fresh && healthCache && now() - healthCache.at < healthTtlMs) return healthCache.value;
    const r = await request('GET', '/health', undefined, Math.min(timeoutMs, 5000));
    let value;
    if (r.kind !== 'ok') {
      value = { ready: false, reason: 'health_unreachable', detail: r.kind === 'http_error' ? `HTTP ${r.status}` : r.kind };
    } else {
      const b = r.body ?? {};
      const ready = isMlHealthReady(b);
      value = { ready, reason: ready ? null : 'model_not_loaded', status: b.status ?? null,
        model_loaded: b.model_loaded === true, model_version: typeof b.model_version === 'string' ? b.model_version : null };
    }
    healthCache = { at: now(), value };
    return value;
  }

  async function getModelInfo() {
    if (modelInfo) return modelInfo;
    const r = await request('GET', '/model-info', undefined, Math.min(timeoutMs, 5000));
    if (r.kind === 'ok' && r.body && typeof r.body.model_version === 'string') {
      const b = r.body;
      modelInfo = { model_version: b.model_version, model_type: b.model_type ?? null, trained_on: b.trained_on ?? null,
        frozen_on: b.frozen_on ?? null, contract_version: b.contract_version ?? null, n_features: b.n_features ?? null };
    }
    return modelInfo;
  }

  async function predict(payload) {
    return request('POST', '/predict', payload, timeoutMs);
  }

  // Readiness for a prediction: health ready, model-info readable, contract 0.3. Never throws.
  // refreshIfNotReady: an administrator retry re-checks health instead of trusting a cached "not ready".
  async function checkReady({ refreshIfNotReady = false } = {}) {
    let health = await getHealth();
    if (!health.ready && refreshIfNotReady) health = await getHealth({ fresh: true });
    if (!health.ready) return { ready: false, reason: health.reason, detail: health.detail ?? null };
    const info = await getModelInfo();
    if (!info) return { ready: false, reason: 'model_info_unavailable', detail: null };
    if (info.contract_version !== EXPECTED_CONTRACT_VERSION) {
      return { ready: false, reason: 'contract_mismatch', detail: `expected ${EXPECTED_CONTRACT_VERSION}, got ${info.contract_version}` };
    }
    return { ready: true, reason: null, detail: null, model_version: info.model_version };
  }

  return {
    getHealth,
    getModelInfo,
    checkReady,
    predict,
    status: () => ({ health: healthCache?.value ?? null, health_checked_at: healthCache ? new Date(healthCache.at).toISOString() : null, model_info: modelInfo }),
    configured: true,
  };
}

// Used when no ML URL is configured (and by tests of the engine without ML): never ready, never calls anything.
export function createDisabledMlClient() {
  const value = { ready: false, reason: 'ml_not_configured' };
  return {
    getHealth: async () => value,
    getModelInfo: async () => null,
    checkReady: async () => ({ ready: false, reason: 'ml_not_configured', detail: null }),
    predict: async () => { throw new Error('ML client is disabled'); },
    status: () => ({ health: value, health_checked_at: null, model_info: null }),
    configured: false,
  };
}
