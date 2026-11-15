// Simulation engine: creates a run and executes meal steps in simulated-time order.
//
// No event table: the next step of every meal follows from its status and timestamps. Each step runs in its own
// transaction, locks the run row, re-checks the meal status (conditional update), does its work and moves sim_now to
// the step time. A step that already ran is simply not found again, so steps can never run twice, and a crash
// mid-step rolls back cleanly. Phase 4A: no ML calls; Day 31+ meals use the static kitchen plan (D5 fallback).

import { withTransaction } from '../db/transaction.js';
import { TOTAL_STUDENTS } from './catalog.js';
import { DEFAULT_CALENDAR, buildCalendar } from './calendar.js';
import { hiddenState } from './hidden-state.js';
import { chooseMenu, profileFor } from './menu.js';
import { generateOutcomes } from './outcomes.js';
import { createRng } from './rng.js';
import { STEPS, STEP_BY_STATUS, buildMeals, runStartAt } from './schedule.js';
import { generateVotes } from './votes.js';

export const DEFAULT_START_DATE = '2026-07-06'; // a Monday (D1)
export const DEFAULT_TOTAL_DAYS = 60;

export async function loadRun(db, { forUpdate = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM simulation_runs ORDER BY id LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------
export async function createRun(client, { seed, startDate = DEFAULT_START_DATE, totalDays = DEFAULT_TOTAL_DAYS,
  speedSimMinutes = 15, calendar = DEFAULT_CALENDAR }) {
  const { rows: [run] } = await client.query(
    `INSERT INTO simulation_runs (seed, start_date, total_days, speed_sim_minutes, sim_now, calendar_config)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [seed, startDate, totalDays, speedSimMinutes, runStartAt(startDate), JSON.stringify(calendar)],
  );
  const runId = Number(run.id);

  const days = buildCalendar({ seed, startDate, totalDays, calendar });
  await client.query(
    `INSERT INTO sim_days (run_id, day_number, date, is_weekend, is_holiday, is_exam_day, is_festival, temperature, rainfall)
     SELECT $1, * FROM unnest($2::int[], $3::date[], $4::bool[], $5::bool[], $6::bool[], $7::bool[], $8::float8[], $9::float8[])`,
    [runId, ...['day_number', 'date', 'is_weekend', 'is_holiday', 'is_exam_day', 'is_festival', 'temperature', 'rainfall']
      .map((k) => days.map((d) => d[k]))],
  );

  const meals = buildMeals(runId, days);
  const cols = ['id', 'day_number', 'date', 'meal_type', 'serve_at', 'voting_opens_at', 'provisional_at',
    'voting_closes_at', 'completes_at', 'phase'];
  await client.query(
    `INSERT INTO meals (run_id, ${cols.join(', ')})
     SELECT $1, * FROM unnest($2::text[], $3::int[], $4::date[], $5::text[], $6::timestamptz[], $7::timestamptz[],
                              $8::timestamptz[], $9::timestamptz[], $10::timestamptz[], $11::text[])`,
    [runId, ...cols.map((c) => meals.map((m) => m[c]))],
  );

  // Menus for the whole run, chosen in meal order from one stream (like the generator's simulation loop).
  const { rows: dishRows } = await client.query('SELECT id, ml_dish_name, display_name, category, is_veg FROM dishes');
  const dishByName = new Map(dishRows.map((d) => [d.ml_dish_name, d]));
  const festival = new Map(days.map((d) => [d.day_number, d.is_festival]));
  const menuRng = createRng(seed, 'menus');
  const md = { meal_id: [], dish_id: [], ml_dish_name: [], display_name: [], category: [], is_veg: [], position: [] };
  for (const meal of meals) {
    chooseMenu(meal.meal_type, festival.get(meal.day_number), menuRng).forEach((profile, i) => {
      const dish = dishByName.get(profile.mlDishName);
      md.meal_id.push(meal.id); md.dish_id.push(dish.id); md.ml_dish_name.push(dish.ml_dish_name);
      md.display_name.push(dish.display_name); md.category.push(dish.category); md.is_veg.push(dish.is_veg);
      md.position.push(i + 1);
    });
  }
  await client.query(
    `INSERT INTO meal_dishes (meal_id, dish_id, ml_dish_name, display_name, category, is_veg, position)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::int[])`,
    Object.values(md),
  );
  return { run, days: days.length, meals: meals.length, menuItems: md.meal_id.length };
}

// ---------------------------------------------------------------------------
// Step discovery
// ---------------------------------------------------------------------------
const NEXT_STEP_SQL = `
  SELECT m.*, CASE m.status
                WHEN 'scheduled' THEN m.voting_opens_at
                WHEN 'voting_open' THEN m.provisional_at
                WHEN 'provisional_taken' THEN m.voting_closes_at
                WHEN 'voting_closed' THEN m.completes_at END AS due_at,
              CASE m.status WHEN 'scheduled' THEN 0 WHEN 'voting_open' THEN 1
                            WHEN 'provisional_taken' THEN 2 ELSE 3 END AS step_order
    FROM meals m
   WHERE m.run_id = $1 AND m.status <> 'completed'
   ORDER BY due_at, m.serve_at, step_order
   LIMIT 1`;

export async function nextPendingStep(db, runId) {
  const { rows } = await db.query(NEXT_STEP_SQL, [runId]);
  if (rows.length === 0) return null;
  const meal = rows[0];
  return { meal, step: STEP_BY_STATUS[meal.status], dueAt: meal.due_at };
}

export async function runEndAt(db, runId) {
  const { rows } = await db.query('SELECT max(completes_at) AS end_at FROM meals WHERE run_id = $1', [runId]);
  return rows[0].end_at;
}

// ---------------------------------------------------------------------------
// Meal context (everything a step needs to re-derive the hidden state)
// ---------------------------------------------------------------------------
export async function loadMealContext(db, run, meal) {
  const { rows: [day] } = await db.query('SELECT * FROM sim_days WHERE run_id = $1 AND day_number = $2',
    [run.id, meal.day_number]);
  // days since this dish was last served at this meal type (99 if never, like the generator)
  const { rows: menuRows } = await db.query(
    `SELECT md.dish_id, md.ml_dish_name, md.position,
            (SELECT $2::int - max(pm.day_number)
               FROM meal_dishes pmd JOIN meals pm ON pm.id = pmd.meal_id
              WHERE pm.run_id = $3 AND pm.meal_type = $4 AND pmd.dish_id = md.dish_id
                AND pm.day_number < $2) AS days_since
       FROM meal_dishes md WHERE md.meal_id = $1 ORDER BY md.position`,
    [meal.id, meal.day_number, run.id, meal.meal_type],
  );
  const menu = menuRows.map((r) => ({
    dish_id: r.dish_id,
    profile: profileFor(r.ml_dish_name, meal.meal_type),
    daysSinceServed: r.days_since ?? 99,
  }));
  return { seed: Number(run.seed), totalStudents: run.total_students, meal, day, menu };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function insertVotes(client, mealId, votes) {
  if (votes.length === 0) return;
  const { rows } = await client.query(
    `INSERT INTO meal_responses (meal_id, student_id, response, responded_at)
     SELECT $1, * FROM unnest($2::int[], $3::text[], $4::timestamptz[])
     RETURNING id, student_id`,
    [mealId, votes.map((v) => v.studentId), votes.map((v) => v.response), votes.map((v) => v.respondedAt)],
  );
  const idByStudent = new Map(rows.map((r) => [r.student_id, r.id]));
  const responseIds = [];
  const dishIds = [];
  for (const v of votes) {
    for (const dishId of v.dishIds) {
      responseIds.push(idByStudent.get(v.studentId));
      dishIds.push(dishId);
    }
  }
  if (responseIds.length) {
    await client.query(
      `INSERT INTO response_picks (response_id, meal_id, dish_id)
       SELECT r, $1, d FROM unnest($2::bigint[], $3::text[]) AS t(r, d)`,
      [mealId, responseIds, dishIds],
    );
  }
}

// Counts as of `asOf` (inclusive) — provisional: T-4h; final: all valid votes (responded_at < voting_closes_at).
export async function countVotes(db, mealId, asOf) {
  const { rows: [totals] } = await db.query(
    `SELECT count(*)::int AS total, (count(*) FILTER (WHERE response = 'not_eating'))::int AS not_eating
       FROM meal_responses WHERE meal_id = $1 AND responded_at <= $2`,
    [mealId, asOf],
  );
  const { rows: taps } = await db.query(
    `SELECT md.dish_id, count(r.id)::int AS taps
       FROM meal_dishes md
       LEFT JOIN response_picks p ON p.meal_id = md.meal_id AND p.dish_id = md.dish_id
       LEFT JOIN meal_responses r ON r.id = p.response_id AND r.responded_at <= $2
      WHERE md.meal_id = $1
      GROUP BY md.dish_id, md.position ORDER BY md.position`,
    [mealId, asOf],
  );
  return { total: totals.total, notEating: totals.not_eating, taps };
}

async function stepOpenVoting(client, run, meal) {
  const ctx = await loadMealContext(client, run, meal);
  await insertVotes(client, meal.id, generateVotes(ctx, hiddenState(ctx)));
  return {};
}

async function stepProvisional(client, run, meal) {
  const counts = await countVotes(client, meal.id, meal.provisional_at);
  await client.query(
    `INSERT INTO meal_dish_counts (meal_id, dish_id, prov_taps)
     SELECT $1, * FROM unnest($2::text[], $3::int[])`,
    [meal.id, counts.taps.map((t) => t.dish_id), counts.taps.map((t) => t.taps)],
  );
  // Phase 4B adds the provisional ML prediction here (Day 31+ only).
  return { prov_total_responses: counts.total, prov_not_eating: counts.notEating };
}

async function stepCloseVoting(client, run, meal) {
  const counts = await countVotes(client, meal.id, meal.voting_closes_at);
  await client.query(
    `UPDATE meal_dish_counts c SET final_taps = t.taps
       FROM unnest($2::text[], $3::int[]) AS t(dish_id, taps)
      WHERE c.meal_id = $1 AND c.dish_id = t.dish_id`,
    [meal.id, counts.taps.map((t) => t.dish_id), counts.taps.map((t) => t.taps)],
  );
  // Phase 4B adds the final ML prediction here (Day 31+ only).
  return { final_total_responses: counts.total, final_not_eating: counts.notEating };
}

async function stepComplete(client, run, meal) {
  const ctx = await loadMealContext(client, run, meal);
  const outcome = generateOutcomes(ctx, hiddenState(ctx), null); // 4A: no predictions -> static plan (D5)
  const cols = ['dish_id', 'actual_consumers', 'prepared_servings', 'static_plan_servings', 'leftover_kg',
    'static_plan_leftover_kg', 'shortfall_servings', 'avg_rating'];
  await client.query(
    `INSERT INTO dish_outcomes (meal_id, ${cols.join(', ')})
     SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::float8[], $7::float8[], $8::int[], $9::float8[])`,
    [meal.id, ...cols.map((c) => outcome.dishes.map((d) => d[c]))],
  );
  return { headcount: outcome.headcount };
}

const STEP_HANDLERS = {
  open_voting: stepOpenVoting,
  provisional: stepProvisional,
  close_voting: stepCloseVoting,
  complete: stepComplete,
};

// Executes one step in its own transaction. Returns false if the step had already been executed (no-op).
export async function executeStep(pool, runId, pending) {
  return withTransaction(pool, async (client) => {
    const run = await loadRun(client, { forUpdate: true });
    if (!run || Number(run.id) !== Number(runId)) return false;
    const { rows } = await client.query('SELECT * FROM meals WHERE id = $1 FOR UPDATE', [pending.meal.id]);
    const meal = rows[0];
    if (!meal || meal.status !== pending.step.from) return false; // already done by someone else

    const extra = await STEP_HANDLERS[pending.step.name](client, run, meal);
    const sets = ['status = $2', ...Object.keys(extra).map((k, i) => `${k} = $${i + 3}`)];
    await client.query(`UPDATE meals SET ${sets.join(', ')} WHERE id = $1`,
      [meal.id, pending.step.to, ...Object.values(extra)]);
    await client.query('UPDATE simulation_runs SET sim_now = GREATEST(sim_now, $2) WHERE id = $1', [run.id, pending.dueAt]);

    if (pending.step.name === 'complete') {
      const { rows: [left] } = await client.query(
        "SELECT count(*)::int AS n FROM meals WHERE run_id = $1 AND status <> 'completed'", [run.id]);
      if (left.n === 0) await client.query("UPDATE simulation_runs SET status = 'completed' WHERE id = $1", [run.id]);
    }
    return true;
  });
}

// Executes every step due at or before `target`, in order, then moves the clock to `target` (capped at the run end).
export async function advanceTo(pool, runId, target) {
  let executed = 0;
  for (;;) {
    const pending = await nextPendingStep(pool, runId);
    if (!pending || pending.dueAt > target) break;
    if (await executeStep(pool, runId, pending)) executed += 1;
  }
  const end = await runEndAt(pool, runId);
  const clockTo = target > end ? end : target;
  await pool.query('UPDATE simulation_runs SET sim_now = GREATEST(sim_now, $2) WHERE id = $1', [runId, clockTo]);
  return executed;
}

export { STEPS };
