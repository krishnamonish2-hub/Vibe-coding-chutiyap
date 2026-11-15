// Admin UI component tests: route guard, loading/empty/error states, ML unavailable states, simulation controls,
// typed-RESET confirmation, dish renaming, predictions and outcomes. The backend is mocked at the fetch level.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, renderAt, simStatus } from './helpers.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const meal = (o = {}) => ({
  id: 'r1-d031-lunch', day: 31, date: '2026-08-05', meal_type: 'lunch', phase: 'active', status: 'completed',
  serve_at: '2026-08-05T12:30:00.000Z', prov_total_responses: 300, final_total_responses: 420, headcount: 790,
  provisional: { status: 'ok', reason: null, attempts: 1 }, final: { status: 'ok', reason: null, attempts: 1 },
  outcomes: { dishes: 5, prepared_servings: 2000, static_plan_servings: 2300, actual_consumers: 1950, leftover_kg: 6.1,
    static_plan_leftover_kg: 40.2, shortfall_servings: 0, edited: false }, ...o,
});

// ---------------------------------------------------------------------------
describe('route protection (navigation only; the backend enforces access)', () => {
  it('redirects a signed-out visitor from /admin to the login page', async () => {
    mockApi({}, { user: null });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('does not render admin pages for the student account', async () => {
    const calls = mockApi({}, { user: 'student' });
    renderAt('/admin/simulation');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'You do not have access to this page.');
    expect(calls.some((c) => c.url.startsWith('/api/admin'))).toBe(false);
  });

  it('sends a signed-in admin from / to the dashboard', async () => {
    mockApi({ 'GET /api/admin/simulation': simStatus() });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('dashboard', () => {
  it('shows a loading state, then the simulated day, time and phase', async () => {
    let release;
    mockApi({ 'GET /api/admin/simulation': () => new Promise((r) => { release = () => r(simStatus()); }) });
    renderAt('/admin');
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Loading…');
    await waitFor(() => expect(typeof release).toBe('function')); // the request is in flight
    expect(screen.queryByText('Day 31 of 60')).toBeNull();
    release();
    expect(await screen.findByText('Day 31 of 60')).toBeTruthy();
    expect(screen.getByText('Predictions active')).toBeTruthy();
    expect(screen.getByText(/Wed 5 Aug, 00:00/)).toBeTruthy();
    expect(screen.getByText('90 of 180')).toBeTruthy();
  });

  it('shows an empty state when no run exists', async () => {
    mockApi({ 'GET /api/admin/simulation': { run: null, clock_running: false, ml: { health: null, model_info: null } } });
    renderAt('/admin');
    expect(await screen.findByText(/No simulation run yet/)).toBeTruthy();
  });

  it('shows ML "reachable, model not ready" and the last check reason honestly', async () => {
    mockApi({
      'GET /api/admin/simulation': simStatus({ ml: { health: { ready: false, reason: 'model_not_loaded' }, model_info: null } }),
      'GET /api/health': { status: 'degraded', backend: 'ok', database: 'ok', ml: { reachable: true, ready: false, model_loaded: false, model_version: null } },
    });
    renderAt('/admin');
    expect(await screen.findByText('Reachable, model not ready')).toBeTruthy();
    expect(screen.getByText('Model not loaded')).toBeTruthy();
  });

  it('shows ML "not reachable"', async () => {
    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'GET /api/health': { status: 'degraded', backend: 'ok', database: 'ok', ml: { reachable: false, ready: false, model_loaded: false, model_version: null } },
    });
    renderAt('/admin');
    expect(await screen.findByText('Not reachable')).toBeTruthy();
  });

  it('shows an error state with a retry when the backend fails', async () => {
    mockApi({ 'GET /api/admin/simulation': [500, { error: { code: 'internal_error', message: 'Internal server error' } }] });
    renderAt('/admin');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Something went wrong.*Internal server error/);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows a sign-in link when the session has ended (401)', async () => {
    mockApi({ 'GET /api/admin/simulation': [401, { error: { code: 'unauthenticated', message: 'Sign in required' } }] });
    renderAt('/admin');
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('simulation controls and reset', () => {
  it('starts a run with the form values', async () => {
    let started = false;
    const calls = mockApi({
      'GET /api/admin/simulation': () => (started ? simStatus({ current_day: 0, phase: 'learning' }) : { run: null, clock_running: false, ml: {} }),
      'POST /api/admin/simulation/start': () => { started = true; return [201, simStatus()]; },
    });
    const user = userEvent.setup();
    renderAt('/admin/simulation');
    await user.type(await screen.findByLabelText(/Seed/), '7');
    await user.click(screen.getByRole('button', { name: 'Start simulation' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ start_date: '2026-07-06', total_days: 60, speed_sim_minutes: 15, seed: 7 });
  });

  it('disables manual advance while the accelerated clock runs, and offers Pause', async () => {
    mockApi({ 'GET /api/admin/simulation': simStatus({ run: { status: 'running' }, clock_running: true }) });
    renderAt('/admin/simulation');
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next step' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'End of day' }).disabled).toBe(true);
    expect(screen.getByText('Pause the accelerated clock to advance manually.')).toBeTruthy();
  });

  it('advances and reports the number of steps; shows a 409 error from the backend', async () => {
    let n = 0;
    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'POST /api/admin/simulation/advance': () => (n++ === 0 ? { steps_executed: 1, ...simStatus() }
        : [409, { error: { code: 'simulation_busy', message: 'Another simulation operation is in progress' } }]),
    });
    const user = userEvent.setup();
    renderAt('/admin/simulation');
    await user.click(await screen.findByRole('button', { name: 'Next step' }));
    expect(await screen.findByText('1 step executed.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(await screen.findByText('Another simulation operation is in progress')).toBeTruthy();
  });

  it('reset needs RESET typed exactly; cancel sends nothing; confirm sends { confirm: "RESET" }', async () => {
    const calls = mockApi({
      'GET /api/admin/simulation': simStatus(),
      'POST /api/admin/simulation/reset': { reset: true, summary: { run_id: 1, counts: { meals: 180 } }, audit_id: 9 },
    });
    const user = userEvent.setup();
    renderAt('/admin/simulation');
    await user.click(await screen.findByRole('button', { name: 'Reset simulation…' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reset simulation' });
    const input = within(dialog).getByLabelText(/Type RESET to confirm/);
    expect(confirm.disabled).toBe(true);
    await user.type(input, 'reset');
    expect(confirm.disabled).toBe(true);
    await user.clear(input); await user.type(input, 'RESET ');
    expect(confirm.disabled).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url === '/api/admin/simulation/reset')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Reset simulation…' }));
    await user.type(screen.getByLabelText(/Type RESET to confirm/), 'RESET');
    await user.click(screen.getByRole('button', { name: 'Reset simulation' }));
    expect(await screen.findByText(/Run 1 was reset \(180 meals deleted\)/)).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/admin/simulation/reset').map((c) => c.body)).toEqual([{ confirm: 'RESET' }]);
  });

  it('keeps the dialog open and shows the error if the reset fails', async () => {
    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'POST /api/admin/simulation/reset': [500, { error: { code: 'internal_error', message: 'Internal server error' } }],
    });
    const user = userEvent.setup();
    renderAt('/admin/simulation');
    await user.click(await screen.findByRole('button', { name: 'Reset simulation…' }));
    await user.type(screen.getByLabelText(/Type RESET to confirm/), 'RESET');
    await user.click(screen.getByRole('button', { name: 'Reset simulation' }));
    expect(await within(screen.getByRole('dialog')).findByText('Internal server error')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('dishes', () => {
  const dishes = [
    { id: 'D001', display_name: 'Tea', ml_dish_name: 'Tea', category: 'beverage', is_veg: true },
    { id: 'D002', display_name: 'Coffee', ml_dish_name: 'Coffee', category: 'beverage', is_veg: true },
  ];

  it('renames a display name only (the ML name is never editable)', async () => {
    let list = dishes;
    const calls = mockApi({
      'GET /api/admin/dishes': () => ({ dishes: list }),
      'PATCH /api/admin/dishes/D001': (body) => {
        list = [{ ...dishes[0], display_name: body.display_name }, dishes[1]];
        return { dish: list[0] };
      },
    });
    const user = userEvent.setup();
    renderAt('/admin/dishes');
    await user.click(await screen.findByRole('button', { name: 'Rename Tea' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(1); // only the display-name field
    const input = screen.getByLabelText('Display name for D001');
    await user.clear(input); await user.type(input, '  Masala Chai ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Renamed D001 to “Masala Chai”.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH').body).toEqual({ display_name: 'Masala Chai' });
  });

  it('shows the backend 409 for a name already in use', async () => {
    mockApi({
      'GET /api/admin/dishes': { dishes },
      'PATCH /api/admin/dishes/D002': [409, { error: { code: 'display_name_taken', message: 'Another dish is already called "Tea"' } }],
    });
    const user = userEvent.setup();
    renderAt('/admin/dishes');
    await user.click(await screen.findByRole('button', { name: 'Rename Coffee' }));
    const input = screen.getByLabelText('Display name for D002');
    await user.clear(input); await user.type(input, 'tea');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Another dish is already called "Tea"')).toBeTruthy();
  });

  it('blocks an empty name without calling the backend', async () => {
    const calls = mockApi({ 'GET /api/admin/dishes': { dishes } });
    const user = userEvent.setup();
    renderAt('/admin/dishes');
    await user.click(await screen.findByRole('button', { name: 'Rename Tea' }));
    await user.clear(screen.getByLabelText('Display name for D001'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('meals, predictions and outcomes', () => {
  const detail = (over = {}) => ({
    meal: { id: 'r1-d031-lunch', day: 31, date: '2026-08-05', meal_type: 'lunch', phase: 'active', status: 'voting_closed',
      serve_at: '2026-08-05T12:30:00.000Z', voting_opens_at: '2026-08-05T00:30:00.000Z', provisional_at: '2026-08-05T08:30:00.000Z',
      voting_closes_at: '2026-08-05T12:00:00.000Z', completes_at: '2026-08-05T13:15:00.000Z', prov_total_responses: 300,
      prov_not_eating: 30, final_total_responses: 420, final_not_eating: 40, headcount: null, ...over.meal },
    dishes: [{ dish_id: 'D012', display_name: 'Steamed Rice', ml_dish_name: 'Rice', category: 'staple_rice', position: 1,
      prov_taps: 100, final_taps: 150, actual_consumers: null, prepared_servings: null, static_plan_servings: null,
      leftover_kg: null, static_plan_leftover_kg: null, shortfall_servings: null, avg_rating: null, source: null }],
    predictions: [
      { id: 1, kind: 'provisional', attempt: 1, status: 'ok', is_current: true, http_status: 200, reason: null, model_version: 'rf-v1-synthetic',
        trained_on: 'synthetic', sim_at: '2026-08-05T08:30:00.000Z', wall_at: '2026-11-15T10:00:00.000Z', total_responses: 300,
        items: [{ dish_id: 'D012', interested_taps: 100, predicted_consumers: 250, warnings: [] }] },
      { id: 2, kind: 'final', attempt: 1, status: 'unavailable', is_current: false, http_status: 503, reason: 'http_503', model_version: null,
        trained_on: null, sim_at: '2026-08-05T12:00:00.000Z', wall_at: '2026-11-15T10:00:01.000Z', total_responses: 420, items: [] },
      { id: 3, kind: 'final', attempt: 2, status: 'unavailable', is_current: true, http_status: 503, reason: 'http_503', model_version: null,
        trained_on: null, sim_at: '2026-08-05T12:00:00.000Z', wall_at: '2026-11-15T10:00:02.000Z', total_responses: 420, items: [] },
    ],
    ...over.rest,
  });

  it('meal detail: provisional under-estimate notice, ML name shown, final failure reason and retry', async () => {
    const calls = mockApi({
      'GET /api/admin/meals/r1-d031-lunch': detail(),
      'POST /api/admin/meals/r1-d031-lunch/predictions/final/retry': { attempt: 3, status: 'ok', applies_to_kitchen: true, ...detail() },
    });
    const user = userEvent.setup();
    renderAt('/admin/meals/r1-d031-lunch');
    expect(await screen.findByRole('heading', { name: 'Day 31 · Lunch' })).toBeTruthy();
    expect(screen.getByText(/likely an under-estimate/)).toBeTruthy();
    expect(screen.getAllByText('ML service unavailable (503)').length).toBeGreaterThan(0);
    expect(screen.getByText('Rice')).toBeTruthy(); // the ML name the model receives
    expect(screen.queryByRole('button', { name: 'Retry provisional prediction' })).toBeNull(); // provisional is ok
    await user.click(screen.getByRole('button', { name: 'Retry final prediction' }));
    expect(await screen.findByText(/The kitchen will use this prediction/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/admin/meals/r1-d031-lunch/predictions/final/retry']);
  });

  it('meal detail: learning meals say they are never sent to ML; completed meals show the fixed-plan fallback', async () => {
    mockApi({
      'GET /api/admin/meals/r1-d005-lunch': detail({
        meal: { id: 'r1-d005-lunch', day: 5, phase: 'learning', status: 'completed', headcount: 780 },
        rest: { predictions: [], dishes: [{ dish_id: 'D012', display_name: 'Rice', ml_dish_name: 'Rice', category: 'staple_rice',
          prov_taps: 100, final_taps: 150, actual_consumers: 600, prepared_servings: 700, static_plan_servings: 700, leftover_kg: 15,
          static_plan_leftover_kg: 15, shortfall_servings: 0, avg_rating: 3.71, source: 'simulated' }] },
      }),
    });
    renderAt('/admin/meals/r1-d005-lunch');
    expect(await screen.findByText(/never sent to the ML service/)).toBeTruthy();
    expect(screen.getByText(/Prepared with the fixed plan \(learning period\)/)).toBeTruthy();
  });

  it('meal detail: shows a late-retry result as recorded only', async () => {
    mockApi({
      'GET /api/admin/meals/r1-d031-lunch': detail({ meal: { status: 'completed', headcount: 790 } }),
      'POST /api/admin/meals/r1-d031-lunch/predictions/final/retry': { attempt: 3, status: 'ok', applies_to_kitchen: false },
    });
    const user = userEvent.setup();
    renderAt('/admin/meals/r1-d031-lunch');
    await user.click(await screen.findByRole('button', { name: 'Retry final prediction' }));
    expect(await screen.findByText(/Recorded only: the meal was already cooked with the fixed plan/)).toBeTruthy();
  });

  it('meal list: filters upcoming/completed and links to the meal', async () => {
    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'GET /api/admin/meals': { meals: [meal({ id: 'r1-d031-breakfast', meal_type: 'breakfast' }), meal({ status: 'voting_open', final: null, outcomes: null })] },
    });
    const user = userEvent.setup();
    renderAt('/admin/meals?day=31');
    expect(await screen.findByRole('link', { name: 'Breakfast' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    expect(screen.queryByRole('link', { name: 'Breakfast' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Lunch' }).getAttribute('href')).toBe('/admin/meals/r1-d031-lunch');
  });

  it('predictions: empty state before Day 31; counts and failures-only filter afterwards', async () => {
    mockApi({ 'GET /api/admin/simulation': simStatus({ current_day: 10, phase: 'learning' }), 'GET /api/admin/meals': { meals: [meal({ phase: 'learning', provisional: null, final: null })] } });
    const first = renderAt('/admin/predictions');
    expect(await screen.findByText(/No predictions yet/)).toBeTruthy();
    first.unmount(); cleanup(); vi.restoreAllMocks();

    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'GET /api/admin/meals': { meals: [
        meal({ id: 'a', meal_type: 'breakfast' }),
        meal({ id: 'b', final: { status: 'unavailable', reason: 'timeout', attempts: 2 } }),
      ] },
    });
    const user = userEvent.setup();
    renderAt('/admin/predictions');
    expect(await screen.findByText('1 unavailable')).toBeTruthy();
    expect(screen.getByText('Timed out')).toBeTruthy();
    expect(screen.getByText('Fixed plan (fallback)')).toBeTruthy();
    await user.click(screen.getByLabelText(/Show only meals with a failed or unavailable prediction/));
    expect(screen.queryByRole('link', { name: 'Day 31 · Breakfast' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Day 31 · Lunch' })).toBeTruthy();
  });

  it('outcomes: separate learning and prediction-period totals with the fixed-plan counterfactual', async () => {
    mockApi({
      'GET /api/admin/simulation': simStatus(),
      'GET /api/admin/meals': { meals: [
        meal({ id: 'l', day: 5, phase: 'learning', outcomes: { ...meal().outcomes, leftover_kg: 30, static_plan_leftover_kg: 30 } }),
        meal({ id: 'a', outcomes: { ...meal().outcomes, shortfall_servings: 12 } }),
      ] },
    });
    renderAt('/admin/outcomes');
    const learning = await screen.findByRole('region', { name: 'Learning period (Days 1–30)' });
    const active = screen.getByRole('region', { name: 'Prediction period (Day 31+)' });
    expect(within(learning).getAllByText('30.0 kg')).toHaveLength(2); // leftover = fixed-plan leftover (learning)
    expect(within(active).getByText('6.1 kg')).toBeTruthy();
    expect(within(active).getByText('40.2 kg')).toBeTruthy();
    expect(within(active).getByText('12')).toBeTruthy();
  });
});
