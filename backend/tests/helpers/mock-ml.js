// Mock of the existing ML service (contract v0.3) for automated tests. The real service is never needed in CI.
// Behaviour is scriptable: health/model-info bodies, and a queue of /predict behaviours
// ('ok' | 422 | 500 | 503 | 404 | 'timeout' | 'malformed' | 'out_of_range' | 'wrong_order' | 'not_json' | function).
// When the queue is empty, `defaultPredict` is used. Every request is recorded in `requests`.

import http from 'node:http';

export const MODEL_INFO = {
  model_version: 'rf-v1-synthetic', model_type: 'random_forest', trained_on: 'synthetic', frozen_on: '2026-11-14',
  feature_schema_version: '0.1', contract_version: '0.3', target: 'actual_dish_consumers', n_features: 69,
  feature_names: [], meal_types: ['breakfast', 'lunch', 'dinner'], known_dish_categories: [], known_dish_names: [],
  metrics: { validation_mae: 31.08, test_mae: 31.44, test_baseline_mae: 56.22 }, limitations: [],
};

// Deterministic, contract-shaped answer (NOT a real model): 2.5 × taps, clipped to [0, total_students].
export function fakeAnswer(req) {
  return {
    meal_id: req.meal_id, model_version: 'rf-v1-synthetic', trained_on: 'synthetic',
    predictions: req.dishes.map((d) => ({
      dish_id: d.dish_id, interested_taps: d.interested_taps,
      predicted_consumers: Math.min(req.total_students, Math.round(d.interested_taps * 2.5)),
      warnings: d.historical_dish_demand === undefined ? ['new_dish_no_history'] : [],
    })),
  };
}

export async function startMockMl() {
  const state = {
    health: { status: 'ok', model_loaded: true, model_version: 'rf-v1-synthetic' },
    healthStatus: 200,
    modelInfo: MODEL_INFO,
    modelInfoStatus: 200,
    healthDelayMs: 0,
    queue: [],
    defaultPredict: 'ok',
    requests: [],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, path: req.url, body, at: Date.now() });
      const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (req.method === 'GET' && req.url === '/health') {
        if (state.healthDelayMs) return setTimeout(() => send(state.healthStatus, state.health), state.healthDelayMs);
        return send(state.healthStatus, state.health);
      }
      if (req.method === 'GET' && req.url === '/model-info') return send(state.modelInfoStatus, state.modelInfo);
      if (req.method === 'POST' && req.url === '/predict') {
        const behaviour = state.queue.length ? state.queue.shift() : state.defaultPredict;
        if (typeof behaviour === 'function') return behaviour(body, send, res);
        switch (behaviour) {
          case 'ok': return send(200, fakeAnswer(body));
          case 422: return send(422, { detail: [{ loc: ['dishes', 0, 'dish_name'], msg: 'Value error', type: 'value_error' }] });
          case 500: return send(500, { detail: 'internal error' });
          case 503: return send(503, { detail: 'model not loaded' });
          case 404: return send(404, { detail: 'Not Found' });
          case 'timeout': return undefined; // never answer
          case 'malformed': return send(200, { ...fakeAnswer(body), extra_field: true });
          case 'out_of_range': { const a = fakeAnswer(body); a.predictions[0].predicted_consumers = body.total_students + 1; return send(200, a); }
          case 'wrong_order': { const a = fakeAnswer(body); a.predictions.reverse(); return send(200, a); }
          case 'not_json': return res.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
          default: throw new Error(`unknown mock behaviour ${behaviour}`);
        }
      }
      return send(404, { detail: 'Not Found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    predictRequests: () => state.requests.filter((r) => r.path === '/predict'),
    count: (path) => state.requests.filter((r) => r.path === path).length,
    reset() {
      state.queue = []; state.defaultPredict = 'ok'; state.requests = [];
      state.health = { status: 'ok', model_loaded: true, model_version: 'rf-v1-synthetic' }; state.healthStatus = 200;
      state.modelInfoStatus = 200; state.healthDelayMs = 0; state.modelInfo = MODEL_INFO;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
