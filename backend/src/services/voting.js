// Student voting (R-07, D8, D11, Phase 4A decision 3).
//
// * A vote is accepted only while voting_opens_at <= sim_now < voting_closes_at (the cutoff is T-30m); otherwise 409.
//   Only the MEAL row is locked (FOR UPDATE) — not the run row — so a vote never waits for another meal's simulation
//   step (or its ML call). The provisional and close-voting steps of this meal also lock this meal row, so a vote and
//   those steps are strictly serialised. sim_now is read AFTER the meal lock is held: if a step of this meal ran first,
//   the vote sees its committed status and clock.
// * A vote recorded after this meal's provisional snapshot (status provisional_taken) is stamped strictly after T-4h
//   (at least provisional_at + 1 s), so stored timestamps always agree with the frozen provisional counts.
// * "eating" needs at least one dish from that meal's menu; "not_eating" has no dishes. Both count as responses.
// * The demo student is linked to S0001. Synthetic votes are generated ahead of time with future responded_at, so a
//   student only sees their own response once responded_at <= sim_now. A student's vote replaces any existing
//   (synthetic) response for that meal, with responded_at = sim_now.

import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../middleware/error-handler.js';

const OPEN_STATUSES = ['voting_open', 'provisional_taken'];

async function currentRun(db) {
  const { rows } = await db.query('SELECT id, sim_now FROM simulation_runs ORDER BY id LIMIT 1');
  return rows[0] ?? null;
}

async function ownResponse(db, mealId, studentId, simNow) {
  const { rows } = await db.query(
    `SELECT r.response, r.responded_at,
            coalesce(array_agg(p.dish_id ORDER BY p.dish_id) FILTER (WHERE p.dish_id IS NOT NULL), '{}') AS dish_ids
       FROM meal_responses r LEFT JOIN response_picks p ON p.response_id = r.id
      WHERE r.meal_id = $1 AND r.student_id = $2 AND r.responded_at <= $3
      GROUP BY r.id`,
    [mealId, studentId, simNow],
  );
  const r = rows[0];
  return r ? { response: r.response, dish_ids: r.dish_ids, responded_at: r.responded_at.toISOString() } : null;
}

export async function listUpcomingMeals(db, studentId) {
  const run = await currentRun(db);
  if (!run) return { sim_now: null, meals: [] };
  const { rows: meals } = await db.query(
    `SELECT id, day_number, date, meal_type, serve_at, voting_closes_at
       FROM meals
      WHERE run_id = $1 AND status = ANY($2) AND voting_opens_at <= $3 AND voting_closes_at > $3
      ORDER BY serve_at`,
    [run.id, OPEN_STATUSES, run.sim_now],
  );
  const result = [];
  for (const m of meals) {
    const { rows: menu } = await db.query(
      `SELECT md.dish_id, d.display_name, md.category, md.is_veg
         FROM meal_dishes md JOIN dishes d ON d.id = md.dish_id
        WHERE md.meal_id = $1 ORDER BY md.position`, [m.id]);
    result.push({
      meal_id: m.id, day: m.day_number, date: m.date, meal_type: m.meal_type,
      serve_at: m.serve_at.toISOString(), voting_closes_at: m.voting_closes_at.toISOString(),
      menu, my_response: await ownResponse(db, m.id, studentId, run.sim_now),
    });
  }
  return { sim_now: run.sim_now.toISOString(), meals: result };
}

export async function submitResponse(pool, studentId, mealId, { response, dishIds = [] }) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM meals WHERE id = $1 AND run_id = (SELECT id FROM simulation_runs ORDER BY id LIMIT 1) FOR UPDATE',
      [mealId]);
    const meal = rows[0];
    if (!meal) {
      if (!(await currentRun(client))) throw new ApiError(404, 'no_simulation_run', 'There is no simulation run');
      throw new ApiError(404, 'meal_not_found', `No meal ${mealId}`);
    }
    const run = await currentRun(client); // read after the meal lock: any step of this meal has committed
    if (!run) throw new ApiError(404, 'no_simulation_run', 'There is no simulation run');
    const open = OPEN_STATUSES.includes(meal.status)
      && meal.voting_opens_at <= run.sim_now && run.sim_now < meal.voting_closes_at;
    if (!open) throw new ApiError(409, 'voting_closed', 'Voting is not open for this meal');
    let respondedAt = run.sim_now;
    if (meal.status === 'provisional_taken' && respondedAt <= meal.provisional_at) {
      respondedAt = new Date(meal.provisional_at.getTime() + 1000);
    }

    if (response === 'eating') {
      const { rows: menu } = await client.query('SELECT dish_id FROM meal_dishes WHERE meal_id = $1', [mealId]);
      const onMenu = new Set(menu.map((r) => r.dish_id));
      const unknown = dishIds.filter((d) => !onMenu.has(d));
      if (unknown.length) throw new ApiError(400, 'dish_not_on_menu', 'Some dishes are not on this meal\'s menu', { dish_ids: unknown });
    }

    // Replace any existing (synthetic or earlier) response: picks first, so the response type may change.
    await client.query(
      'DELETE FROM response_picks WHERE response_id = (SELECT id FROM meal_responses WHERE meal_id = $1 AND student_id = $2)',
      [mealId, studentId]);
    const { rows: [saved] } = await client.query(
      `INSERT INTO meal_responses (meal_id, student_id, response, responded_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (meal_id, student_id) DO UPDATE SET response = EXCLUDED.response, responded_at = EXCLUDED.responded_at
       RETURNING id`,
      [mealId, studentId, response, respondedAt]);
    if (response === 'eating') {
      await client.query(
        'INSERT INTO response_picks (response_id, meal_id, dish_id) SELECT $1, $2, unnest($3::text[])',
        [saved.id, mealId, dishIds]);
    }
    return ownResponse(client, mealId, studentId, respondedAt);
  });
}
