// Reports page (Phase 7): accuracy per prediction kind, waste vs fixed plan, CSV download link, empty state.
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, renderAt } from './helpers.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const m = (n, mae, bias, base) => ({ n, mae, bias, baseline_n: n, baseline_mae: base });
const kind = (ok, unavailable) => ({
  overall: m(40, 12.34, -1.5, 30.2),
  by_meal_type: { breakfast: m(10, 8, 0, 20), lunch: m(15, 14, -2, 35), dinner: m(15, 13, -2, 33) },
  by_day: [{ day: 31, ...m(40, 12.34, -1.5, 30.2) }],
  current_status: { ok, unavailable, error: 0 },
});
const accuracy = { run_id: 1, synthetic: true, models: [{ model_version: 'rf-v1-synthetic', trained_on: 'synthetic' }],
  provisional: kind(5, 1), final: kind(6, 0) };
const total = (o) => ({ days: 30, meals: 90, prepared: 9000, static_plan: 9000, actual: 7000, leftover_kg: 500, static_plan_leftover_kg: 500,
  shortfall: 0, leftover_saved_kg: 0, leftover_saved_pct: 0, ...o });
const waste = { run_id: 1, synthetic: true, learning: total(),
  active: total({ days: 2, meals: 6, leftover_kg: 20.5, static_plan_leftover_kg: 40, leftover_saved_kg: 19.5, leftover_saved_pct: 48.8, shortfall: 3 }),
  by_day: [] };

describe('reports page', () => {
  it('shows MAE, baseline and statuses per kind, waste savings, and the CSV link', async () => {
    mockApi({ 'GET /api/admin/reports/accuracy': accuracy, 'GET /api/admin/reports/waste': waste });
    renderAt('/admin/reports');
    const prov = await screen.findByRole('region', { name: 'Provisional (T−4 h) accuracy' });
    expect(within(prov).getByText(/5 OK · 1 unavailable · 0 failed/)).toBeTruthy();
    expect(within(prov).getAllByRole('row')[1].textContent).toMatch(/All meals.*40.*12\.3.*-1\.5.*30\.2/);
    const active = screen.getByRole('region', { name: 'Prediction period (Day 31+)' });
    expect(within(active).getByText('19.5 kg (48.8%)')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Download training CSV' });
    expect(link.getAttribute('href')).toBe('/api/admin/export/training.csv');
    expect(screen.getByText(/Nothing is retrained automatically/)).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Admin' }).textContent).toContain('Reports');
  });

  it('shows an empty state (and no download link) before a run exists', async () => {
    const none = [404, { error: { code: 'no_simulation_run', message: 'There is no simulation run' } }];
    mockApi({ 'GET /api/admin/reports/accuracy': none, 'GET /api/admin/reports/waste': none });
    renderAt('/admin/reports');
    expect(await screen.findByText(/No simulation run yet/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Download training CSV' })).toBeNull();
  });

  it('a student cannot open the reports page', async () => {
    const calls = mockApi({}, { user: 'student' });
    renderAt('/admin/reports');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/admin'))).toBe(false);
  });
});
