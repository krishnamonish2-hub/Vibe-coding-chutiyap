// Synthetic student responses for one meal (decisions R-07, D4, D8), generated per student from the meal's hidden
// state with their own reproducible random stream:
//   * each of the 1,000 students responds with probability pRespond; the others give no response (not counted);
//   * a responder attends with probability pAttendResponder; one who will not attend answers "not_eating";
//   * an attending responder picks each dish with probability pPick ("eating"; zero picks is allowed, D8);
//   * responded_at is uniform over [voting_opens_at, voting_closes_at) in whole simulated seconds (D4).
// Expected taps per dish equal the generator's binomial(total_responses, pAttendResponder * pTap * tapBias).

import { createRng } from './rng.js';
import { mealIndex } from './hidden-state.js';

export function generateVotes(ctx, hidden) {
  const { seed, totalStudents, meal } = ctx;
  const rng = createRng(seed, 'votes', mealIndex(meal.day_number, meal.meal_type));
  const opens = meal.voting_opens_at.getTime();
  const windowSeconds = (meal.voting_closes_at.getTime() - opens) / 1000;

  const votes = [];
  for (let studentId = 1; studentId <= totalStudents; studentId += 1) {
    if (rng.random() >= hidden.pRespond) continue;
    const respondedAt = new Date(opens + Math.floor(rng.random() * windowSeconds) * 1000);
    if (rng.random() >= hidden.pAttendResponder) {
      votes.push({ studentId, response: 'not_eating', respondedAt, dishIds: [] });
      continue;
    }
    const dishIds = hidden.dishes.filter((d) => rng.random() < d.pPick).map((d) => d.dish_id);
    votes.push({ studentId, response: 'eating', respondedAt, dishIds });
  }
  return votes;
}
