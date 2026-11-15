// Hidden "true" behaviour of the synthetic mess. Same formulas and constants as ml/src/generate_data.py
// (section 4), which generated the data the frozen ML model was trained on. Read-only port: ml/ is never modified.

import { BASE_ATTENDANCE, HOT_WEATHER_DISHES, RAINY_WEATHER_DISHES } from './catalog.js';
import { clip } from './rng.js';

const WEEKEND_DROP = { breakfast: 0.15, lunch: 0.08, dinner: 0.05 };

// P(a student attends this meal). `noise` is the N(0, 0.03) day-to-day variation drawn by the caller.
export function attendanceProbability(mealType, day, noise) {
  let p = BASE_ATTENDANCE[mealType];
  if (day.is_weekend) p -= WEEKEND_DROP[mealType];
  if (day.is_holiday) p -= 0.22;
  if (day.is_exam_day) p += mealType !== 'breakfast' ? 0.06 : 0.10;
  if (day.is_festival && mealType === 'dinner') p += 0.10;
  if (day.rainfall > 5) p += 0.05; // students avoid going out in the rain
  if (day.temperature > 33 && mealType === 'lunch') p -= 0.03;
  p += noise;
  return clip(p, 0.05, 0.97);
}

// P(a student responds in the app for this meal). `noise` is N(0, 0.04).
export function responseRate(mealType, day, noise) {
  let r = 0.45 - 0.10 * (day.is_exam_day ? 1 : 0) - 0.08 * (day.is_weekend ? 1 : 0);
  r -= 0.05 * (mealType === 'breakfast' ? 1 : 0);
  return clip(r + noise, 0.10, 0.90);
}

// P(an attending student takes this dish).
export function dishProbability(profile, rating, day, menuSize, daysSinceServed, appealNoise) {
  let p = profile.basePopularity * (1 + 0.15 * (rating - 3.8));
  if (!profile.core) p *= 1 - 0.04 * (menuSize - 4); // more choice -> each extra dish loses a bit
  if (daysSinceServed <= 2 && !profile.core) p *= 0.90; // menu fatigue
  if (day.temperature > 32 && HOT_WEATHER_DISHES.has(profile.mlDishName)) p *= 1.15;
  if (day.rainfall > 5 && RAINY_WEATHER_DISHES.has(profile.mlDishName)) p *= 1.12;
  if (day.is_festival && profile.category === 'dessert') p *= 1.15;
  p *= appealNoise;
  return clip(p, 0.02, 0.97);
}

// Students do not bother tapping staples; they over-tap treats.
export function tapBias(profile) {
  if (profile.core) return 0.75;
  if (profile.category === 'dessert' || profile.mlDishName.endsWith('Biryani')) return 1.15;
  return 1.0;
}

// Kitchen's static plan before the overcooking factor (servings).
export function plannedServings(totalStudents, mealType, profile) {
  return totalStudents * BASE_ATTENDANCE[mealType] * profile.basePopularity;
}
