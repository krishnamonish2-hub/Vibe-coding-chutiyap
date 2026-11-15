// Admin meal views and outcome editing (Phase 4A). Admin role only, enforced on the server.
// `predictions` lists every stored ML attempt (provisional and final, all attempts, with status and reason); learning
// meals have none. Fallback (fixed-plan) quantities are outcomes, never predictions.

import { Router } from 'express';
import { z } from 'zod';

import { withTransaction } from '../../db/transaction.js';
import { parseOrThrow } from '../../lib/validate.js';
import { ApiError } from '../../middleware/error-handler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';
import { retryPrediction } from '../../services/predictions.js';

const DayQuery = z.object({ day: z.coerce.number().int().min(1).max(366).optional() }).strict();

const OutcomesBody = z.object({
  headcount: z.number().int().min(0).max(1000).optional(),
  dishes: z.array(z.object({
    dish_id: z.string().regex(/^D[0-9]{3}$/),
    actual_consumers: z.number().int().min(0).max(1000).optional(),
    leftover_kg: z.number().finite().min(0).max(10_000).optional(),
    avg_rating: z.number().finite().min(1).max(5).optional(),
  }).strict()).max(30).default([]),
}).strict().refine((b) => b.headcount !== undefined || b.dishes.length > 0, { message: 'nothing to change' });

async function currentRunId(db) {
  const { rows } = await db.query('SELECT id FROM simulation_runs ORDER BY id LIMIT 1');
  if (!rows[0]) throw new ApiError(404, 'no_simulation_run', 'There is no simulation run');
  return rows[0].id;
}

async function mealDetail(db, mealId) {
  const runId = await currentRunId(db);
  const { rows } = await db.query('SELECT * FROM meals WHERE id = $1 AND run_id = $2', [mealId, runId]);
  if (!rows[0]) throw new ApiError(404, 'meal_not_found', `No meal ${mealId}`);
  const m = rows[0];
  const { rows: dishes } = await db.query(
    `SELECT md.dish_id, d.display_name, md.ml_dish_name, md.category, md.position,
            c.prov_taps, c.final_taps,
            o.actual_consumers, o.prepared_servings, o.static_plan_servings, o.leftover_kg,
            o.static_plan_leftover_kg, o.shortfall_servings, o.avg_rating, o.source, o.edited_at
       FROM meal_dishes md JOIN dishes d ON d.id = md.dish_id
       LEFT JOIN meal_dish_counts c ON c.meal_id = md.meal_id AND c.dish_id = md.dish_id
       LEFT JOIN dish_outcomes o ON o.meal_id = md.meal_id AND o.dish_id = md.dish_id
      WHERE md.meal_id = $1 ORDER BY md.position`, [mealId]);
  const { rows: predictions } = await db.query(
    `SELECT r.id, r.kind, r.attempt, r.status, r.is_current, r.http_status, r.error_detail->>'reason' AS reason,
            r.model_version, r.trained_on, r.sim_at, r.wall_at, r.request_payload->>'total_responses' AS total_responses,
            coalesce((SELECT json_agg(json_build_object('dish_id', i.dish_id, 'interested_taps', i.interested_taps,
                       'predicted_consumers', i.predicted_consumers, 'warnings', i.warnings) ORDER BY i.dish_id)
                        FROM prediction_items i WHERE i.request_id = r.id), '[]') AS items
       FROM prediction_requests r WHERE r.meal_id = $1 ORDER BY r.kind DESC, r.attempt`,
    [mealId]);
  for (const p of predictions) p.total_responses = p.total_responses === null ? null : Number(p.total_responses);
  return {
    meal: {
      id: m.id, day: m.day_number, date: m.date, meal_type: m.meal_type, phase: m.phase, status: m.status,
      serve_at: m.serve_at, voting_opens_at: m.voting_opens_at, provisional_at: m.provisional_at,
      voting_closes_at: m.voting_closes_at, completes_at: m.completes_at,
      prov_total_responses: m.prov_total_responses, prov_not_eating: m.prov_not_eating,
      final_total_responses: m.final_total_responses, final_not_eating: m.final_not_eating, headcount: m.headcount,
    },
    dishes,
    predictions,
  };
}

export function createAdminMealsRouter({ pool, config, ml }) {
  const router = Router();
  router.use(requireAuth({ pool, config }), requireRole('admin'));

  router.get('/', async (req, res) => {
    const { day } = parseOrThrow(DayQuery, req.query);
    const runId = await currentRunId(pool);
    const { rows } = await pool.query(
      `SELECT id, day_number AS day, date, meal_type, phase, status, serve_at,
              prov_total_responses, final_total_responses, headcount
         FROM meals WHERE run_id = $1 AND ($2::int IS NULL OR day_number = $2)
        ORDER BY serve_at`, [runId, day ?? null]);
    res.json({ meals: rows });
  });

  router.get('/:id', async (req, res) => {
    res.json(await mealDetail(pool, req.params.id));
  });

  // Administrator retry of a provisional/final prediction whose current attempt is not 'ok': re-sends the stored
  // request with the same policy (one automatic retry on 500/503/timeout). A late final retry is recorded only;
  // `applies_to_kitchen` says whether this result will be used to cook the meal.
  router.post('/:id/predictions/:kind/retry', async (req, res) => {
    const { kind } = parseOrThrow(z.object({ kind: z.enum(['provisional', 'final']) }), { kind: req.params.kind });
    await currentRunId(pool);
    const row = await retryPrediction(pool, ml, { mealId: req.params.id, kind, userId: req.user.id, withTransaction });
    // The kitchen uses a prediction only if it is a successful FINAL prediction for a meal that has not been completed
    // yet; completed meals are never recalculated.
    const appliesToKitchen = kind === 'final' && row.status === 'ok' && row.mealStatus !== 'completed';
    res.json({ attempt: row.attempt, status: row.status, applies_to_kitchen: appliesToKitchen, ...(await mealDetail(pool, req.params.id)) });
  });

  // Edit synthetic actuals of a completed meal (source becomes 'admin'); audited in the same transaction.
  router.put('/:id/outcomes', async (req, res) => {
    const body = parseOrThrow(OutcomesBody, req.body);
    await withTransaction(pool, async (client) => {
      const runId = await currentRunId(client);
      const { rows } = await client.query('SELECT * FROM meals WHERE id = $1 AND run_id = $2 FOR UPDATE', [req.params.id, runId]);
      const meal = rows[0];
      if (!meal) throw new ApiError(404, 'meal_not_found', `No meal ${req.params.id}`);
      if (meal.status !== 'completed') throw new ApiError(409, 'meal_not_completed', 'Only completed meals can be edited');

      const before = { headcount: meal.headcount, dishes: [] };
      const after = { headcount: body.headcount ?? meal.headcount, dishes: [] };
      for (const d of body.dishes) {
        const { rows: cur } = await client.query(
          'SELECT * FROM dish_outcomes WHERE meal_id = $1 AND dish_id = $2 FOR UPDATE', [meal.id, d.dish_id]);
        if (!cur[0]) throw new ApiError(400, 'dish_not_on_menu', `${d.dish_id} is not on this meal's menu`);
        const o = cur[0];
        const actual = d.actual_consumers ?? o.actual_consumers;
        const next = {
          actual_consumers: actual,
          leftover_kg: d.leftover_kg ?? o.leftover_kg,
          avg_rating: d.avg_rating ?? o.avg_rating,
          shortfall_servings: Math.max(0, actual - o.prepared_servings),
        };
        before.dishes.push({ dish_id: d.dish_id, actual_consumers: o.actual_consumers, leftover_kg: o.leftover_kg, avg_rating: o.avg_rating });
        after.dishes.push({ dish_id: d.dish_id, actual_consumers: next.actual_consumers, leftover_kg: next.leftover_kg, avg_rating: next.avg_rating });
        await client.query(
          `UPDATE dish_outcomes SET actual_consumers = $3, leftover_kg = $4, avg_rating = $5, shortfall_servings = $6,
                  source = 'admin', edited_at = now()
            WHERE meal_id = $1 AND dish_id = $2`,
          [meal.id, d.dish_id, next.actual_consumers, next.leftover_kg, next.avg_rating, next.shortfall_servings]);
      }
      if (body.headcount !== undefined) {
        await client.query('UPDATE meals SET headcount = $2 WHERE id = $1', [meal.id, body.headcount]);
      }
      await recordAudit(client, { userId: req.user.id, action: 'meal.outcomes_edit', entity: `meal:${meal.id}`, before, after });
    });
    res.json(await mealDetail(pool, req.params.id));
  });

  return router;
}
