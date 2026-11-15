// ML predictions for active meals (Day 31+): provisional at T-4h (partial counts), final at T-30m (frozen counts).
//
// Every HTTP attempt is stored as its own prediction_requests row (attempt 1, 2, …); exactly one row per (meal, kind)
// is current. Provisional and final are separate kinds and never overwrite each other. Statuses:
//   ok           validated model output (prediction_items rows hold the per-dish values)
//   error        will not succeed by resending: our request failed validation, the ML service answered 422 or
//                another 4xx, or its 200 response failed validation — no automatic retry
//   unavailable  ML not ready (health), unreachable, timed out, or HTTP 500/503 — after exactly one automatic retry
// error_detail.reason records why. Nothing is ever estimated or substituted: without an 'ok' final prediction the
// kitchen uses the fixed plan (D5), and fallback quantities are never stored as predictions.
// The POST /predict attempts run inside the caller's transaction (approved: the ML call is part of the simulation
// step). Readiness (health + model-info + contract 0.3) is checked BEFORE that transaction by the caller and passed in,
// so no health/model-info request ever holds database locks. Each attempt row records its own wall-clock time
// (clock_timestamp(), not the transaction start).

import { validateRequest } from '../ml/request-schema.js';
import { validateResponse } from '../ml/response-schema.js';
import { ApiError } from '../middleware/error-handler.js';
import { recordAudit } from './audit.js';
import { buildHistory } from './history.js';

const RETRYABLE_STATUS = new Set([500, 503]);
const SIM_AT_FIELD = { provisional: 'provisional_at', final: 'voting_closes_at' };

// Builds the contract request for a meal from stored data only (counts frozen by the step).
export async function buildPredictionRequest(db, run, meal, kind) {
  const total = kind === 'provisional' ? meal.prov_total_responses : meal.final_total_responses;
  if (total === null || total === undefined) throw new Error(`${kind} counts are not frozen for ${meal.id}`);
  const tapsCol = kind === 'provisional' ? 'prov_taps' : 'final_taps';
  const { rows: dishes } = await db.query(
    `SELECT md.dish_id, md.ml_dish_name, md.category, md.is_veg, md.is_special, c.${tapsCol} AS taps
       FROM meal_dishes md LEFT JOIN meal_dish_counts c ON c.meal_id = md.meal_id AND c.dish_id = md.dish_id
      WHERE md.meal_id = $1 ORDER BY md.position`, [meal.id]);
  // Every menu dish must have a frozen count; a missing one is reported, never silently dropped (M2).
  const missingCounts = dishes.filter((d) => d.taps === null).map((d) => d.dish_id);
  const { rows: [day] } = await db.query('SELECT * FROM sim_days WHERE run_id = $1 AND day_number = $2', [run.id, meal.day_number]);
  const history = await buildHistory(db, { runId: run.id, meal, dishIds: dishes.map((d) => d.dish_id) });

  const payload = {
    meal_id: meal.id,
    date: meal.date,
    meal_type: meal.meal_type,
    total_students: run.total_students,
    total_responses: total,
    is_holiday: day.is_holiday,
    is_exam_day: day.is_exam_day,
    is_festival: day.is_festival,
    temperature: day.temperature,
    rainfall: day.rainfall,
    ...(history.previousMealAttendance !== undefined ? { previous_meal_attendance: history.previousMealAttendance } : {}),
    dishes: dishes.map((d) => ({
      dish_id: d.dish_id,
      dish_name: d.ml_dish_name, // the immutable training name — never the editable display name
      dish_category: d.category,
      is_veg: d.is_veg,
      is_special: d.is_special,
      interested_taps: d.taps,
      ...history.dishes.get(d.dish_id),
    })),
  };
  return { payload, missingCounts };
}

async function nextAttempt(db, mealId, kind) {
  const { rows: [r] } = await db.query(
    'SELECT coalesce(max(attempt), 0)::int AS n FROM prediction_requests WHERE meal_id = $1 AND kind = $2', [mealId, kind]);
  return r.n + 1;
}

async function storeAttempt(db, { meal, kind, payload, simAt, outcome }) {
  await db.query('UPDATE prediction_requests SET is_current = false WHERE meal_id = $1 AND kind = $2 AND is_current', [meal.id, kind]);
  const attempt = await nextAttempt(db, meal.id, kind);
  const { rows: [row] } = await db.query(
    `INSERT INTO prediction_requests (meal_id, kind, attempt, status, is_current, request_payload, response_payload,
       http_status, error_detail, model_version, trained_on, sim_at, wall_at)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, clock_timestamp()) RETURNING id, attempt, status, wall_at`,
    [meal.id, kind, attempt, outcome.status, JSON.stringify(payload),
      outcome.response ? JSON.stringify(outcome.response) : null, outcome.httpStatus ?? null,
      outcome.error ? JSON.stringify(outcome.error) : null, outcome.response?.model_version ?? null,
      outcome.response?.trained_on ?? null, simAt],
  );
  if (outcome.status === 'ok') {
    const byId = new Map(payload.dishes.map((d) => [d.dish_id, d]));
    for (const p of outcome.response.predictions) { // at most 30 dishes (6 in the simulation)
      const sent = byId.get(p.dish_id);
      await db.query(
        `INSERT INTO prediction_items (request_id, meal_id, dish_id, interested_taps, predicted_consumers, warnings,
           hist_demand, hist_rating, prev_leftover_kg)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)`,
        [row.id, meal.id, p.dish_id, p.interested_taps, p.predicted_consumers, p.warnings,
          sent.historical_dish_demand ?? null, sent.historical_dish_rating ?? null, sent.previous_leftover_kg ?? null],
      );
    }
  }
  return row;
}

// One HTTP attempt -> outcome { status, reason?, retryable, httpStatus?, response?, error? }
async function attemptOnce(ml, payload) {
  const r = await ml.predict(payload);
  if (r.kind === 'ok') {
    const v = validateResponse(r.body, payload);
    if (v.ok) return { status: 'ok', retryable: false, httpStatus: r.status, response: v.value };
    return { status: 'error', retryable: false, httpStatus: r.status,
      error: { reason: 'invalid_response', issues: v.issues, raw: JSON.stringify(r.body).slice(0, 2000) } };
  }
  if (r.kind === 'invalid_json') {
    return { status: 'error', retryable: false, httpStatus: r.status, error: { reason: 'invalid_response', raw: r.body } };
  }
  if (r.kind === 'timeout') return { status: 'unavailable', retryable: true, error: { reason: 'timeout' } };
  if (r.kind === 'network_error') return { status: 'unavailable', retryable: true, error: { reason: 'unreachable', message: r.message } };
  // http_error
  if (RETRYABLE_STATUS.has(r.status)) {
    return { status: 'unavailable', retryable: true, httpStatus: r.status, error: { reason: `http_${r.status}`, detail: r.body } };
  }
  return { status: 'error', retryable: false, httpStatus: r.status,
    error: { reason: r.status === 422 ? 'ml_rejected_request' : `http_${r.status}`, detail: r.body } };
}

// Sends `payload` (already validated) with the approved policy and stores every attempt. Returns the final row.
// `readiness` comes from ml.checkReady(), evaluated by the caller OUTSIDE the database transaction.
async function sendWithPolicy(db, ml, { meal, kind, payload, simAt, readiness }) {
  if (!readiness?.ready) {
    return storeAttempt(db, { meal, kind, payload, simAt,
      outcome: { status: 'unavailable', error: { reason: readiness?.reason ?? 'not_checked', detail: readiness?.detail ?? null } } });
  }
  let outcome = await attemptOnce(ml, payload);
  if (outcome.retryable) {
    await storeAttempt(db, { meal, kind, payload, simAt, outcome });
    outcome = await attemptOnce(ml, payload); // exactly one automatic retry
  }
  return storeAttempt(db, { meal, kind, payload, simAt, outcome });
}

// Scheduled prediction for a simulation step (inside the step's transaction). Learning meals are never sent.
// `readiness` must be computed by the caller before the transaction (ml.checkReady()).
export async function predictForStep(db, ml, run, meal, kind, { readiness } = {}) {
  if (meal.phase !== 'active') return null;
  const { payload, missingCounts } = await buildPredictionRequest(db, run, meal, kind);
  const simAt = meal[SIM_AT_FIELD[kind]];
  const v = validateRequest(payload);
  const issues = [
    ...missingCounts.map((id) => ({ path: 'dishes', message: `missing ${kind} vote count for dish ${id}` })),
    ...(v.ok ? [] : v.issues),
  ];
  if (issues.length) {
    return storeAttempt(db, { meal, kind, payload, simAt,
      outcome: { status: 'error', error: { reason: 'request_invalid', issues } } });
  }
  return sendWithPolicy(db, ml, { meal, kind, payload, simAt, readiness });
}

// Final predictions usable by the kitchen: Map(dish_id -> predicted_consumers) or null (-> fixed plan).
export async function currentFinalPredictions(db, mealId) {
  const { rows } = await db.query(
    `SELECT i.dish_id, i.predicted_consumers
       FROM prediction_requests r JOIN prediction_items i ON i.request_id = r.id
      WHERE r.meal_id = $1 AND r.kind = 'final' AND r.is_current AND r.status = 'ok'`, [mealId]);
  return rows.length ? new Map(rows.map((r) => [r.dish_id, r.predicted_consumers])) : null;
}

// Administrator retry: re-sends the STORED request of the current attempt (never rebuilt), same policy.
// Allowed only when the current attempt is not 'ok'. A late final retry after completion is recorded only:
// the meal's prepared quantities are not recalculated (approved).
export async function retryPrediction(pool, ml, { mealId, kind, userId = null, withTransaction }) {
  // Outside the transaction (H1); a cached "not ready" is re-checked for an explicit admin retry (M1).
  const readiness = await ml.checkReady({ refreshIfNotReady: true });
  return withTransaction(pool, async (client) => {
    const { rows: [meal] } = await client.query(
      'SELECT m.* FROM meals m JOIN simulation_runs r ON r.id = m.run_id WHERE m.id = $1 FOR UPDATE OF m', [mealId]);
    if (!meal) throw new ApiError(404, 'meal_not_found', `No meal ${mealId}`);
    if (meal.phase !== 'active') throw new ApiError(409, 'learning_meal', 'Learning-period meals are never sent to the ML service');
    const { rows: [current] } = await client.query(
      'SELECT * FROM prediction_requests WHERE meal_id = $1 AND kind = $2 AND is_current', [mealId, kind]);
    if (!current) throw new ApiError(409, 'no_prediction_yet', `The ${kind} prediction has not been scheduled yet`);
    if (current.status === 'ok') throw new ApiError(409, 'prediction_ok', `The current ${kind} prediction already succeeded`);
    const payload = current.request_payload;
    const v = validateRequest(payload);
    const { rows: [run] } = await client.query('SELECT sim_now FROM simulation_runs WHERE id = $1', [meal.run_id]);
    const simAt = run.sim_now;
    const row = v.ok
      ? await sendWithPolicy(client, ml, { meal, kind, payload, simAt, readiness })
      : await storeAttempt(client, { meal, kind, payload, simAt, outcome: { status: 'error', error: { reason: 'request_invalid', issues: v.issues } } });
    await recordAudit(client, { userId, action: 'prediction.retry', entity: `meal:${mealId}:${kind}`,
      before: { attempt: current.attempt, status: current.status }, after: { attempt: row.attempt, status: row.status } });
    return { ...row, mealStatus: meal.status };
  });
}
