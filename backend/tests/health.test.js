import http from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { fetchMlHealth } from '../src/routes/health.js';

const okPool = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
const brokenPool = { query: async () => { throw new Error('connection refused'); } };
const mlOk = async () => ({ reachable: true, model_loaded: true, model_version: 'rf-v1-synthetic' });
const mlDown = async () => ({ reachable: false, model_loaded: false, model_version: null });

describe('GET /api/health', () => {
  it('reports ok when the database and the ML model are available', async () => {
    const res = await request(createApp({ pool: okPool, getMlHealth: mlOk })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok', backend: 'ok', database: 'ok',
      ml: { reachable: true, model_loaded: true, model_version: 'rf-v1-synthetic' },
    });
  });

  it('reports degraded (still 200) when the ML service is down', async () => {
    const res = await request(createApp({ pool: okPool, getMlHealth: mlDown })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ml.reachable).toBe(false);
  });

  it('reports degraded when the ML service is up but its model is not loaded', async () => {
    const mlDegraded = async () => ({ reachable: true, model_loaded: false, model_version: null });
    const res = await request(createApp({ pool: okPool, getMlHealth: mlDegraded })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('returns 503 when the database is unavailable', async () => {
    const res = await request(createApp({ pool: brokenPool, getMlHealth: mlOk })).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'error' });
  });
});

describe('error format', () => {
  const app = createApp({ pool: okPool, getMlHealth: mlOk });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 400 invalid_json for a malformed JSON body', async () => {
    const res = await request(app).post('/api/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('does not expose the x-powered-by header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('fetchMlHealth (against a local stub, not the real ML service)', () => {
  let server;
  let baseUrl;
  const replies = {
    '/ok/health': [200, { status: 'ok', model_loaded: true, model_version: 'rf-v1-synthetic' }],
    '/degraded/health': [200, { status: 'degraded', model_loaded: false, model_version: null }],
    '/error/health': [500, { detail: 'internal error' }],
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow/health') return; // never answers -> timeout
      const [status, body] = replies[req.url] ?? [404, { detail: 'Not Found' }];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads model_loaded and model_version', async () => {
    expect(await fetchMlHealth(`${baseUrl}/ok`, 1000))
      .toEqual({ reachable: true, model_loaded: true, model_version: 'rf-v1-synthetic' });
  });

  it('reports a degraded ML service as reachable without a model', async () => {
    expect(await fetchMlHealth(`${baseUrl}/degraded`, 1000))
      .toEqual({ reachable: true, model_loaded: false, model_version: null });
  });

  it('treats a non-200 answer as unreachable', async () => {
    expect((await fetchMlHealth(`${baseUrl}/error`, 1000)).reachable).toBe(false);
  });

  it('treats a timeout as unreachable', async () => {
    expect((await fetchMlHealth(`${baseUrl}/slow`, 200)).reachable).toBe(false);
  });

  it('treats a refused connection as unreachable', async () => {
    expect((await fetchMlHealth('http://127.0.0.1:1', 500)).reachable).toBe(false);
  });
});
