// Post-meal synthetic outcomes (decision D5): headcount, actual consumers per dish, kitchen quantities, leftovers and
// the serving's average rating. Mirrors ml/src/generate_data.py:
//   actual  = binomial(attendance, pEatDish)                      — never capped by what was prepared (D5)
//   static  = total_students × BASE_ATTENDANCE × popularity × U(1.00, 1.35)   (the generator's kitchen plan)
//   rating  = clip(today's rating + N(0, 0.15), 1, 5), 2 decimals
// Phase 4A has no predictions, so every meal is prepared with the static plan (D5 fallback). Phase 4B will pass the
// final prediction for Day 31+ meals; preparedFromPrediction() is the approved rule (final × 1.05).

import { plannedServings } from './behaviour.js';
import { mealIndex } from './hidden-state.js';
import { clip, createRng, round } from './rng.js';

export const PREDICTION_BUFFER = 1.05;

export function preparedFromPrediction(predictedConsumers) {
  return Math.round(predictedConsumers * PREDICTION_BUFFER);
}

// finalPredictions: Map(dish_id -> predicted_consumers) or null when no final prediction exists.
export function generateOutcomes(ctx, hidden, finalPredictions = null) {
  const { seed, totalStudents, meal } = ctx;
  const rng = createRng(seed, 'outcomes', mealIndex(meal.day_number, meal.meal_type));

  const dishes = hidden.dishes.map((d) => {
    const actual = rng.binomial(hidden.attendance, d.pEatDish);
    const staticPlan = Math.round(plannedServings(totalStudents, meal.meal_type, d.profile) * rng.uniform(1.0, 1.35));
    const avgRating = round(clip(d.todaysRating + rng.normal(0, 0.15), 1, 5), 2);

    const predicted = finalPredictions?.get(d.dish_id);
    const prepared = predicted === undefined ? staticPlan : preparedFromPrediction(predicted);
    const portion = d.profile.portionKg;
    return {
      dish_id: d.dish_id,
      actual_consumers: actual,
      prepared_servings: prepared,
      static_plan_servings: staticPlan,
      leftover_kg: round(Math.max(0, prepared - actual) * portion, 1),
      static_plan_leftover_kg: round(Math.max(0, staticPlan - actual) * portion, 1),
      shortfall_servings: Math.max(0, actual - prepared),
      avg_rating: avgRating,
    };
  });
  return { headcount: hidden.attendance, dishes };
}
