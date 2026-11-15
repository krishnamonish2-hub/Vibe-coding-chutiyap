// Student pages (Phase 6): voting with at least one dish or Not Eating, cutoff errors, my responses, role guard.
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, renderAt } from './helpers.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const upcoming = (my = null) => ({
  sim_now: '2026-08-05T09:00:00.000Z',
  meals: [{
    meal_id: 'r1-d031-lunch', day: 31, date: '2026-08-05', meal_type: 'lunch',
    serve_at: '2026-08-05T12:30:00.000Z', voting_closes_at: '2026-08-05T12:00:00.000Z',
    menu: [
      { dish_id: 'D012', display_name: 'Steamed Rice', category: 'staple_rice', is_veg: true },
      { dish_id: 'D013', display_name: 'Chapati', category: 'bread', is_veg: true },
      { dish_id: 'D022', display_name: 'Chicken Curry', category: 'main_nonveg', is_veg: false },
    ],
    my_response: my,
  }],
});

describe('student pages', () => {
  it('a signed-in student lands on the voting page; admin pages stay hidden', async () => {
    const calls = mockApi({ 'GET /api/student/meals/upcoming': upcoming() }, { user: 'student' });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Meals open for voting' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Student' })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/admin'))).toBe(false);
  });

  it('the admin cannot open student pages', async () => {
    mockApi({}, { user: 'admin' });
    renderAt('/student');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });

  it('requires at least one dish for "eating" (no request is sent)', async () => {
    const calls = mockApi({ 'GET /api/student/meals/upcoming': upcoming() }, { user: 'student' });
    const user = userEvent.setup();
    renderAt('/student');
    await user.click(await screen.findByRole('button', { name: 'Submit answer' }));
    expect(await screen.findByText('Choose at least one dish, or select “Not eating”.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('sends the chosen dishes in menu order; display names only, dish IDs in the request', async () => {
    const calls = mockApi({
      'GET /api/student/meals/upcoming': upcoming(),
      'PUT /api/student/meals/r1-d031-lunch/response': (body) => ({ meal_id: 'r1-d031-lunch', my_response: { response: 'eating', dish_ids: body.dish_ids, responded_at: '2026-08-05T09:00:00.000Z' } }),
    }, { user: 'student' });
    const user = userEvent.setup();
    renderAt('/student');
    await user.click(await screen.findByLabelText(/Chicken Curry \(non-veg\)/));
    await user.click(screen.getByLabelText('Steamed Rice'));
    await user.click(screen.getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ response: 'eating', dish_ids: ['D012', 'D022'] });
  });

  it('"Not eating" sends no dishes and disables the dish list', async () => {
    const calls = mockApi({
      'GET /api/student/meals/upcoming': upcoming({ response: 'eating', dish_ids: ['D012'], responded_at: '2026-08-05T08:00:00.000Z' }),
      'PUT /api/student/meals/r1-d031-lunch/response': { meal_id: 'r1-d031-lunch', my_response: { response: 'not_eating', dish_ids: [], responded_at: '2026-08-05T09:00:00.000Z' } },
    }, { user: 'student' });
    const user = userEvent.setup();
    renderAt('/student');
    expect(await screen.findByText('Eating')).toBeTruthy(); // current answer shown
    await user.click(screen.getByLabelText('Not eating'));
    expect(screen.getByLabelText('Steamed Rice').disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Update answer' }));
    expect(await screen.findByText('Saved. You can change it until voting closes.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ response: 'not_eating' });
  });

  it('shows a clear message when voting has closed (backend 409)', async () => {
    mockApi({
      'GET /api/student/meals/upcoming': upcoming(),
      'PUT /api/student/meals/r1-d031-lunch/response': [409, { error: { code: 'voting_closed', message: 'Voting is not open for this meal' } }],
    }, { user: 'student' });
    const user = userEvent.setup();
    renderAt('/student');
    await user.click(await screen.findByLabelText('Not eating'));
    await user.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(await screen.findByText('Voting for this meal has closed.')).toBeTruthy();
  });

  it('empty states: no open meal / demonstration not started', async () => {
    mockApi({ 'GET /api/student/meals/upcoming': { sim_now: '2026-08-05T09:00:00.000Z', meals: [] } }, { user: 'student' });
    const first = renderAt('/student');
    expect(await screen.findByText('No meal is open for voting right now.')).toBeTruthy();
    first.unmount(); cleanup(); vi.restoreAllMocks();
    mockApi({ 'GET /api/student/meals/upcoming': { sim_now: null, meals: [] } }, { user: 'student' });
    renderAt('/student');
    expect(await screen.findByText('The demonstration has not started yet.')).toBeTruthy();
  });

  it('my responses lists answers with dishes, newest first', async () => {
    mockApi({
      'GET /api/student/meals/responses': { sim_now: '2026-08-05T09:00:00.000Z', responses: [
        { meal_id: 'r1-d031-lunch', day: 31, meal_type: 'lunch', serve_at: '2026-08-05T12:30:00.000Z', response: 'eating',
          responded_at: '2026-08-05T09:00:00.000Z', dishes: [{ dish_id: 'D012', display_name: 'Steamed Rice' }], can_change: true },
        { meal_id: 'r1-d031-breakfast', day: 31, meal_type: 'breakfast', serve_at: '2026-08-05T07:30:00.000Z', response: 'not_eating',
          responded_at: '2026-08-04T22:00:00.000Z', dishes: [], can_change: false },
      ] },
    }, { user: 'student' });
    renderAt('/student/responses');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toMatch(/Day 31 · Lunch.*Eating.*can still change.*Steamed Rice/);
    expect(rows[2].textContent).toMatch(/Day 31 · Breakfast.*Not eating/);
  });
});
