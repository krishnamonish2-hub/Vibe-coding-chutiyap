import { describe, expect, it } from 'vitest';

import { formatSimTime, formatTime, predictionCounts, reasonLabel, sumOutcomes } from '../lib/format.js';

describe('format helpers', () => {
  it('formats simulated UTC times', () => {
    expect(formatSimTime('2026-08-05T03:30:00.000Z')).toBe('Wed 5 Aug, 03:30');
    expect(formatTime('2026-08-05T19:30:00.000Z')).toBe('19:30');
    expect(formatSimTime(null)).toBe('—');
    expect(formatSimTime('not a date')).toBe('—');
  });

  it('labels every backend failure reason, and unknown HTTP codes generically', () => {
    for (const r of ['ml_not_configured', 'health_unreachable', 'model_not_loaded', 'model_info_unavailable', 'contract_mismatch',
      'http_500', 'http_503', 'timeout', 'unreachable', 'ml_rejected_request', 'invalid_response', 'request_invalid']) {
      expect(reasonLabel(r)).not.toBe(r);
    }
    expect(reasonLabel('http_404')).toBe('ML service answered HTTP 404');
    expect(reasonLabel(null)).toBe('');
  });

  it('sums outcome summaries and skips meals without outcomes', () => {
    const t = sumOutcomes([
      { outcomes: { prepared_servings: 10, static_plan_servings: 12, actual_consumers: 9, leftover_kg: 0.15, static_plan_leftover_kg: 0.3, shortfall_servings: 0 } },
      { outcomes: null },
      { outcomes: { prepared_servings: 5, static_plan_servings: 5, actual_consumers: 7, leftover_kg: 0.05, static_plan_leftover_kg: 0, shortfall_servings: 2 } },
    ]);
    expect(t).toEqual({ meals: 2, prepared_servings: 15, static_plan_servings: 17, actual_consumers: 16, leftover_kg: 0.2,
      static_plan_leftover_kg: 0.3, shortfall_servings: 2 });
  });

  it('counts current prediction statuses per kind', () => {
    const c = predictionCounts([
      { provisional: { status: 'ok' }, final: { status: 'unavailable' } },
      { provisional: { status: 'error' }, final: null },
    ]);
    expect(c).toEqual({ provisional: { ok: 1, unavailable: 0, error: 1, none: 0 }, final: { ok: 0, unavailable: 1, error: 0, none: 1 } });
  });
});
