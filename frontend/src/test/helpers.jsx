// Test helpers: mock the backend at the fetch level and render the real routes at a given URL.
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { AppRoutes } from '../App.jsx';

const ADMIN = { id: 1, email: 'admin@example.test', role: 'admin', student_code: null };
const STUDENT = { id: 2, email: 'demo@example.test', role: 'student', student_code: 'S0001' };
export const USERS = { admin: ADMIN, student: STUDENT };

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

// routes: { 'GET /api/admin/simulation': body | [status, body] | (body, url) => body | [status, body] | Promise }
// Unknown routes answer 404. Returns the list of calls ({ method, url, body }).
export function mockApi(routes, { user = 'admin' } = {}) {
  const calls = [];
  const all = {
    'GET /api/auth/me': user ? { user: USERS[user] } : [401, { error: { code: 'unauthenticated', message: 'Sign in required' } }],
    'GET /api/health': { status: 'ok', backend: 'ok', database: 'ok', ml: { reachable: true, ready: true, model_loaded: true, model_version: 'rf-v1-synthetic' } },
    ...routes,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, url, body });
    const path = String(url).split('?')[0];
    let handler = all[`${method} ${url}`] ?? all[`${method} ${path}`];
    if (handler === undefined) return json(404, { error: { code: 'not_found', message: `No route for ${method} ${url}` } });
    if (typeof handler === 'function') handler = await handler(body, url);
    if (Array.isArray(handler)) return json(handler[0], handler[1]);
    return json(200, handler);
  });
  return calls;
}

export function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
}

export function simStatus(overrides = {}) {
  const { run: runOverrides, ...rest } = overrides;
  return {
    run: {
      id: 1, status: 'paused', seed: 42, start_date: '2026-07-06', total_days: 60, learning_days: 30, activation_day: 31,
      total_students: 1000, speed_sim_minutes: 15, sim_now: '2026-08-05T00:00:00.000Z',
      calendar: { holidays: 2, festivals: 2, exam_days: 0 }, ...runOverrides,
    },
    current_day: 31, phase: 'active',
    next_step: { meal_id: 'r1-d031-lunch', step: 'open_voting', due_at: '2026-08-05T00:30:00.000Z' },
    meals: { total: 180, completed: 90 }, clock_running: false, last_clock_error: null,
    ml: { health: { ready: true, reason: null }, model_info: { model_version: 'rf-v1-synthetic', trained_on: 'synthetic', contract_version: '0.3' } },
    ...rest,
  };
}
