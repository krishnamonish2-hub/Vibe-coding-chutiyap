// Approved meal schedule (D1, D2). All simulated times are UTC.
//   Run start: Day 0 19:30 (= Day 1 breakfast serve − 12 h).
//   Serve 07:30 / 12:30 / 19:30. Voting opens serve − 12 h; provisional step serve − 4 h; voting closes serve − 30 m;
//   meal completes serve + 45 m.
// Steps of a meal, in order, keyed by the meal status that precedes them.

import { addDays } from './calendar.js';
import { MEAL_ORDER } from './hidden-state.js';

export const SERVE_TIMES = Object.freeze({ breakfast: '07:30', lunch: '12:30', dinner: '19:30' });
const MIN = 60_000;
const HOUR = 60 * MIN;

export const STEPS = Object.freeze([
  { name: 'open_voting', from: 'scheduled', to: 'voting_open', at: 'voting_opens_at', order: 0 },
  { name: 'provisional', from: 'voting_open', to: 'provisional_taken', at: 'provisional_at', order: 1 },
  { name: 'close_voting', from: 'provisional_taken', to: 'voting_closed', at: 'voting_closes_at', order: 2 },
  { name: 'complete', from: 'voting_closed', to: 'completed', at: 'completes_at', order: 3 },
]);
export const STEP_BY_STATUS = Object.freeze(Object.fromEntries(STEPS.map((s) => [s.from, s])));

export function runStartAt(startDate) {
  return new Date(`${addDays(startDate, -1)}T19:30:00Z`);
}

export function startOfDay(startDate, dayNumber) {
  return new Date(`${addDays(startDate, dayNumber - 1)}T00:00:00Z`);
}

// Day 0 before Day 1 00:00, then 1, 2, …
export function dayNumberAt(startDate, at) {
  return Math.floor((at.getTime() - Date.parse(`${startDate}T00:00:00Z`)) / (24 * HOUR)) + 1;
}

export function mealTimes(date, mealType) {
  const serve = Date.parse(`${date}T${SERVE_TIMES[mealType]}:00Z`);
  return {
    serve_at: new Date(serve),
    voting_opens_at: new Date(serve - 12 * HOUR),
    provisional_at: new Date(serve - 4 * HOUR),
    voting_closes_at: new Date(serve - 30 * MIN),
    completes_at: new Date(serve + 45 * MIN),
  };
}

// Meal rows for the whole run (phase from the day number: learning Days 1–30, active from Day 31).
export function buildMeals(runId, days) {
  const meals = [];
  for (const day of days) {
    for (const mealType of Object.keys(MEAL_ORDER)) {
      meals.push({
        id: `r${runId}-d${String(day.day_number).padStart(3, '0')}-${mealType}`,
        run_id: runId,
        day_number: day.day_number,
        date: day.date,
        meal_type: mealType,
        phase: day.day_number >= 31 ? 'active' : 'learning',
        ...mealTimes(day.date, mealType),
      });
    }
  }
  assertScheduleInvariant(meals);
  return meals;
}

// Every meal completes before the next meal's provisional step, so both predictions of a meal see the same history.
export function assertScheduleInvariant(meals) {
  const sorted = [...meals].sort((a, b) => a.serve_at - b.serve_at);
  for (let i = 1; i < sorted.length; i += 1) {
    if (!(sorted[i - 1].completes_at < sorted[i].provisional_at)) {
      throw new Error(`schedule invariant broken: ${sorted[i - 1].id} completes after ${sorted[i].id} provisional`);
    }
  }
}
