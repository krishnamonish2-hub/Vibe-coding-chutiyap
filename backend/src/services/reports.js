// Reports and the training-data export (owner's Phase 7 = plan P8). Read-only. Everything is computed from the
// current synthetic run; nothing here retrains or changes the model.

import { ApiError } from '../middleware/error-handler.js';

async function currentRun(db) {
  const { rows } = await db.query('SELECT * FROM simulation_runs ORDER BY id LIMIT 1');
  if (!rows[0]) throw new ApiError(404, 'no_simulation_run', 'There is no simulation run');
  return rows[0];
}

const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

// Prediction accuracy against the synthetic actuals of completed Day 31+ meals, using the CURRENT 'ok' attempt of
// each kind. Baseline: the historical demand that was sent with the request (mean of the last 5 servings) — the same
// baseline as the ML evaluation. Also counts current statuses so unavailable/failed predictions stay visible.
export async function accuracyReport(db) {
  const run = await currentRun(db);
  const { rows: pairs } = await db.query(
    `SELECT r.kind, m.meal_type, m.day_number AS day, i.predicted_consumers AS predicted, i.hist_demand AS baseline,
            o.actual_consumers AS actual
       FROM prediction_requests r
       JOIN meals m ON m.id = r.meal_id AND m.run_id = $1 AND m.status = 'completed'
       JOIN prediction_items i ON i.request_id = r.id
       JOIN dish_outcomes o ON o.meal_id = i.meal_id AND o.dish_id = i.dish_id
      WHERE r.is_current AND r.status = 'ok'`, [run.id]);
  const { rows: statusRows } = await db.query(
    `SELECT r.kind, r.status, count(*)::int AS n
       FROM prediction_requests r JOIN meals m ON m.id = r.meal_id AND m.run_id = $1
      WHERE r.is_current GROUP BY r.kind, r.status`, [run.id]);
  const { rows: versions } = await db.query(
    `SELECT DISTINCT r.model_version, r.trained_on FROM prediction_requests r JOIN meals m ON m.id = r.meal_id
      WHERE m.run_id = $1 AND r.status = 'ok' ORDER BY 1`, [run.id]);

  const metrics = (list) => {
    if (list.length === 0) return { n: 0, mae: null, bias: null, baseline_n: 0, baseline_mae: null };
    const err = list.map((p) => p.predicted - p.actual);
    const withBase = list.filter((p) => p.baseline !== null);
    return {
      n: list.length,
      mae: round(err.reduce((a, e) => a + Math.abs(e), 0) / list.length),
      bias: round(err.reduce((a, e) => a + e, 0) / list.length),
      baseline_n: withBase.length,
      baseline_mae: withBase.length ? round(withBase.reduce((a, p) => a + Math.abs(p.baseline - p.actual), 0) / withBase.length) : null,
    };
  };
  const kinds = {};
  for (const kind of ['provisional', 'final']) {
    const list = pairs.filter((p) => p.kind === kind);
    const statuses = { ok: 0, unavailable: 0, error: 0 };
    for (const s of statusRows.filter((r) => r.kind === kind)) statuses[s.status] = s.n;
    const days = [...new Set(list.map((p) => p.day))].sort((a, b) => a - b);
    kinds[kind] = {
      overall: metrics(list),
      by_meal_type: Object.fromEntries(['breakfast', 'lunch', 'dinner'].map((mt) => [mt, metrics(list.filter((p) => p.meal_type === mt))])),
      by_day: days.map((d) => ({ day: d, ...metrics(list.filter((p) => p.day === d)) })),
      current_status: statuses,
    };
  }
  return { run_id: Number(run.id), synthetic: true, models: versions, ...kinds };
}

// Waste: actual leftovers vs the fixed-plan counterfactual, learning period vs prediction period, and per day.
export async function wasteReport(db) {
  const run = await currentRun(db);
  const { rows } = await db.query(
    `SELECT m.day_number AS day, m.phase, count(DISTINCT m.id)::int AS meals,
            sum(o.prepared_servings)::int AS prepared, sum(o.static_plan_servings)::int AS static_plan,
            sum(o.actual_consumers)::int AS actual, sum(o.leftover_kg)::float8 AS leftover_kg,
            sum(o.static_plan_leftover_kg)::float8 AS static_plan_leftover_kg, sum(o.shortfall_servings)::int AS shortfall
       FROM meals m JOIN dish_outcomes o ON o.meal_id = m.id
      WHERE m.run_id = $1 AND m.status = 'completed'
      GROUP BY m.day_number, m.phase ORDER BY m.day_number`, [run.id]);
  const total = (list) => {
    const t = { days: list.length, meals: 0, prepared: 0, static_plan: 0, actual: 0, leftover_kg: 0, static_plan_leftover_kg: 0, shortfall: 0 };
    for (const r of list) for (const k of Object.keys(t)) if (k !== 'days') t[k] += Number(r[k]);
    t.leftover_kg = round(t.leftover_kg, 1);
    t.static_plan_leftover_kg = round(t.static_plan_leftover_kg, 1);
    t.leftover_saved_kg = round(t.static_plan_leftover_kg - t.leftover_kg, 1);
    t.leftover_saved_pct = t.static_plan_leftover_kg > 0 ? round((100 * t.leftover_saved_kg) / t.static_plan_leftover_kg, 1) : null;
    return t;
  };
  return {
    run_id: Number(run.id),
    synthetic: true,
    learning: total(rows.filter((r) => r.phase === 'learning')),
    active: total(rows.filter((r) => r.phase === 'active')),
    by_day: rows.map((r) => ({ ...r, leftover_kg: round(r.leftover_kg, 1), static_plan_leftover_kg: round(r.static_plan_leftover_kg, 1) })),
  };
}

// Contract v0.3 §3 training-data export: one row per dish per COMPLETED meal, columns in the contract's order.
// dish_name is the immutable ml_dish_name; total_responses / interested_taps are the counts frozen at the voting
// cutoff; meal_attendance is the headcount; post_meal_rating is the serving's average rating. Booleans are written as
// True/False, like the existing training CSV.
export const EXPORT_COLUMNS = ['meal_id', 'date', 'meal_type', 'total_students', 'is_holiday', 'is_exam_day', 'is_festival',
  'temperature', 'rainfall', 'total_responses', 'meal_attendance', 'dish_id', 'dish_name', 'dish_category', 'is_veg',
  'is_special', 'interested_taps', 'actual_dish_consumers', 'leftover_kg', 'post_meal_rating'];

function csvValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function trainingExport(db) {
  const run = await currentRun(db);
  const { rows } = await db.query(
    `SELECT m.id AS meal_id, m.date, m.meal_type, r.total_students, d.is_holiday, d.is_exam_day, d.is_festival,
            d.temperature, d.rainfall, m.final_total_responses AS total_responses, m.headcount AS meal_attendance,
            md.dish_id, md.ml_dish_name AS dish_name, md.category AS dish_category, md.is_veg, md.is_special,
            c.final_taps AS interested_taps, o.actual_consumers AS actual_dish_consumers, o.leftover_kg,
            o.avg_rating AS post_meal_rating
       FROM meals m
       JOIN simulation_runs r ON r.id = m.run_id
       JOIN sim_days d ON d.run_id = m.run_id AND d.day_number = m.day_number
       JOIN meal_dishes md ON md.meal_id = m.id
       JOIN dish_outcomes o ON o.meal_id = md.meal_id AND o.dish_id = md.dish_id
       LEFT JOIN meal_dish_counts c ON c.meal_id = md.meal_id AND c.dish_id = md.dish_id
      WHERE m.run_id = $1 AND m.status = 'completed'
      ORDER BY m.serve_at, md.position`, [run.id]);
  const lines = [EXPORT_COLUMNS.join(','), ...rows.map((row) => EXPORT_COLUMNS.map((c) => csvValue(row[c])).join(','))];
  return { runId: Number(run.id), rows: rows.length, csv: `${lines.join('\n')}\n` };
}
