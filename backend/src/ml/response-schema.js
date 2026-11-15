// Incoming POST /predict 200 response — mirror of MealResponse/DishPrediction in ml/api/schemas.py (contract v0.3 §2.3),
// plus checks against the request that was sent. A response is used only if every check passes:
//   * exactly the contract fields (unknown fields rejected), correct types;
//   * meal_id equals the request's; one prediction per dish, in the same order, with the same dish_id;
//   * interested_taps echoes the request; predicted_consumers is an integer in [0, total_students];
//   * warnings is a list of strings; model_version and trained_on are non-empty strings.

import { z } from 'zod';

const DishPrediction = z.object({
  dish_id: z.string().min(1),
  interested_taps: z.number().int().min(0),
  predicted_consumers: z.number().int(),
  warnings: z.array(z.string()),
}).strict();

const MealResponse = z.object({
  meal_id: z.string().min(1),
  model_version: z.string().min(1),
  trained_on: z.string().min(1),
  predictions: z.array(DishPrediction),
}).strict();

export function validateResponse(body, request) {
  const parsed = MealResponse.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const issues = [];
  const r = parsed.data;
  if (r.meal_id !== request.meal_id) issues.push({ path: 'meal_id', message: `expected ${request.meal_id}, got ${r.meal_id}` });
  if (r.predictions.length !== request.dishes.length) {
    issues.push({ path: 'predictions', message: `expected ${request.dishes.length} predictions, got ${r.predictions.length}` });
  } else {
    r.predictions.forEach((p, i) => {
      const d = request.dishes[i];
      if (p.dish_id !== d.dish_id) issues.push({ path: `predictions.${i}.dish_id`, message: `expected ${d.dish_id}, got ${p.dish_id}` });
      if (p.interested_taps !== d.interested_taps) issues.push({ path: `predictions.${i}.interested_taps`, message: 'does not echo the request' });
      if (p.predicted_consumers < 0 || p.predicted_consumers > request.total_students) {
        issues.push({ path: `predictions.${i}.predicted_consumers`, message: `must be in [0, ${request.total_students}]` });
      }
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: r };
}
