// Formatting and labels for the admin UI (pure functions, unit-tested). All simulated times are UTC.

export const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

export const MEAL_STATUS_LABEL = {
  scheduled: 'Scheduled',
  voting_open: 'Voting open',
  provisional_taken: 'Voting open · provisional taken',
  voting_closed: 'Voting closed',
  completed: 'Completed',
};

export const STEP_LABEL = {
  open_voting: 'Voting opens',
  provisional: 'Provisional count + prediction (T-4h)',
  close_voting: 'Voting closes + final prediction (T-30m)',
  complete: 'Meal completes (actuals recorded)',
};

export const PREDICTION_STATUS_LABEL = { ok: 'OK', unavailable: 'Unavailable', error: 'Failed' };

// error_detail.reason values written by the backend (docs/architecture.md §6).
export const REASON_LABEL = {
  ml_not_configured: 'ML service not configured',
  health_unreachable: 'ML service unreachable',
  model_not_loaded: 'Model not loaded',
  model_info_unavailable: 'Model info unavailable',
  contract_mismatch: 'Contract version mismatch',
  http_500: 'ML server error (500)',
  http_503: 'ML service unavailable (503)',
  timeout: 'Timed out',
  unreachable: 'Connection failed',
  ml_rejected_request: 'Rejected by the ML service (422)',
  invalid_response: 'Invalid ML response',
  request_invalid: 'Invalid request (not sent)',
  not_checked: 'Readiness not checked',
};

export function reasonLabel(reason) {
  if (!reason) return '';
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  const http = /^http_(\d{3})$/.exec(reason);
  return http ? `ML service answered HTTP ${http[1]}` : reason;
}

// "2026-08-05T03:30:00.000Z" -> "Wed 5 Aug, 03:30"
export function formatSimTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${day}, ${time}`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

export function mealTitle(meal) {
  return `Day ${meal.day} · ${MEAL_LABEL[meal.meal_type] ?? meal.meal_type}`;
}

export function formatNumber(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Sum outcome summaries of a list of meals (meals without outcomes are skipped).
export function sumOutcomes(meals) {
  const keys = ['prepared_servings', 'static_plan_servings', 'actual_consumers', 'leftover_kg', 'static_plan_leftover_kg', 'shortfall_servings'];
  const total = Object.fromEntries(keys.map((k) => [k, 0]));
  let count = 0;
  for (const m of meals) {
    if (!m.outcomes) continue;
    count += 1;
    for (const k of keys) total[k] += Number(m.outcomes[k]) || 0;
  }
  total.leftover_kg = Math.round(total.leftover_kg * 10) / 10;
  total.static_plan_leftover_kg = Math.round(total.static_plan_leftover_kg * 10) / 10;
  return { meals: count, ...total };
}

// Count current prediction statuses per kind across meals: { provisional: { ok, unavailable, error, none }, final: {...} }
export function predictionCounts(meals) {
  const blank = () => ({ ok: 0, unavailable: 0, error: 0, none: 0 });
  const out = { provisional: blank(), final: blank() };
  for (const m of meals) {
    for (const kind of ['provisional', 'final']) {
      const p = m[kind];
      out[kind][p ? p.status : 'none'] += 1;
    }
  }
  return out;
}
