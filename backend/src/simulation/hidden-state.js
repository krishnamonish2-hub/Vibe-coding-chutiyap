// A meal's hidden "true" state (attendance, response rate, per-dish appeal and today's rating), derived
// deterministically from (run seed, meal index). Every step can call this again and get the same values, so nothing
// hidden is stored and results never depend on how time was advanced. Synthetic only.

import { attendanceProbability, dishProbability, responseRate, tapBias } from './behaviour.js';
import { createRng, clip } from './rng.js';

export const MEAL_ORDER = Object.freeze({ breakfast: 0, lunch: 1, dinner: 2 });

export function mealIndex(dayNumber, mealType) {
  return (dayNumber - 1) * 3 + MEAL_ORDER[mealType];
}

// ctx: { seed, totalStudents, meal: {day_number, meal_type}, day: sim_days row,
//        menu: [{ dish_id, profile, daysSinceServed }] in menu order }
export function hiddenState(ctx) {
  const { seed, totalStudents, meal, day, menu } = ctx;
  const rng = createRng(seed, 'state', mealIndex(meal.day_number, meal.meal_type));

  const pAttend = attendanceProbability(meal.meal_type, day, rng.normal(0, 0.03));
  const attendance = rng.binomial(totalStudents, pAttend);
  const pRespond = responseRate(meal.meal_type, day, rng.normal(0, 0.04));
  const pAttendResponder = Math.min(0.98, pAttend + 0.08); // responders are more engaged

  const dishes = menu.map((item) => {
    const appealNoise = rng.lognormal(0, 0.08); // shared by taps and actual eating
    const todaysRating = clip(item.profile.baseRating + rng.normal(0, 0.3), 1, 5);
    // Students tap based on the menu (typical rating) but eat based on how good the food is today.
    const pTapDish = dishProbability(item.profile, item.profile.baseRating, day, menu.length, item.daysSinceServed, appealNoise);
    const pEatDish = dishProbability(item.profile, todaysRating, day, menu.length, item.daysSinceServed, appealNoise);
    return {
      dish_id: item.dish_id,
      profile: item.profile,
      appealNoise,
      todaysRating,
      pTapDish,
      pEatDish,
      pPick: Math.min(0.98, pTapDish * tapBias(item.profile)), // P(an attending responder picks it)
    };
  });

  return { pAttend, attendance, pRespond, pAttendResponder, dishes };
}
