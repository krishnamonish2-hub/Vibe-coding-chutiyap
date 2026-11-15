// Historical features (contract §2.5) against PostgreSQL: definitions, rounding, missing history, same-run and
// completed-earlier-meal filtering, breakfast previous-attendance rule, no current-meal leakage, and reproduction of
// historical_dish_demand from the training CSV (read-only).

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildHistory, roundHalfEven } from '../src/services/history.js';
import { addDays } from '../src/simulation/calendar.js';
import { mealTimes } from '../src/simulation/schedule.js';
import { DATABASE_URL, createTestSchema, insertRow } from './helpers/db.js';

const START = '2026-07-06';

describe('roundHalfEven (pandas .round)', () => {
  it('rounds halves to even and everything else normally', () => {
    expect([roundHalfEven(100.25, 1), roundHalfEven(100.35, 1), roundHalfEven(2.5, 0), roundHalfEven(3.5, 0)]).toEqual([100.2, 100.4, 2, 4]);
    expect([roundHalfEven(3.744, 2), roundHalfEven(3.746, 2), roundHalfEven(12.34, 1)]).toEqual([3.74, 3.75, 12.3]);
  });
});

describe.skipIf(!DATABASE_URL)('buildHistory', () => {
  let ctx;
  let db;
  let runId;

  beforeAll(async () => {
    ctx = await createTestSchema('p4b_hist', { seeded: true });
    db = ctx.pool;
  });
  afterAll(async () => ctx?.drop());
  beforeEach(async () => {
    await db.query('DELETE FROM simulation_runs');
    runId = await newRun();
  });

  async function newRun(start = START) {
    const { rows: [r] } = await db.query(
      "INSERT INTO simulation_runs (seed, start_date, total_days, sim_now) VALUES (1, $1, 60, $2) RETURNING id",
      [start, `${addDays(start, -1)}T19:30:00Z`]);
    for (let d = 1; d <= 12; d += 1) {
      const date = addDays(start, d - 1);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      await insertRow(db, 'sim_days', { run_id: r.id, day_number: d, date, is_weekend: dow === 0 || dow === 6, temperature: 29, rainfall: 0 });
    }
    return r.id;
  }

  // A meal with the given status; completed meals get counts and a headcount (required by the schema).
  async function meal(run, day, mealType, { status = 'completed', headcount = 700 } = {}) {
    const date = addDays(START, day - 1);
    const done = status === 'completed';
    return insertRow(db, 'meals', {
      id: `r${run}-d${String(day).padStart(3, '0')}-${mealType}`, run_id: run, day_number: day, date, meal_type: mealType,
      ...mealTimes(date, mealType), phase: day >= 31 ? 'active' : 'learning', status,
      ...(status !== 'scheduled' && status !== 'voting_open' ? { prov_total_responses: 300, prov_not_eating: 0 } : {}),
      ...(['voting_closed', 'completed'].includes(status) ? { final_total_responses: 400, final_not_eating: 0 } : {}),
      ...(done ? { headcount } : {}),
    });
  }
  async function serve(m, dishId, { actual = 100, leftover = 5, rating = 3.5 } = {}) {
    const { rows: [d] } = await db.query('SELECT ml_dish_name, display_name, category, is_veg FROM dishes WHERE id = $1', [dishId]);
    const { rows: [pos] } = await db.query('SELECT count(*)::int + 1 AS n FROM meal_dishes WHERE meal_id = $1', [m.id]);
    await insertRow(db, 'meal_dishes', { meal_id: m.id, dish_id: dishId, position: pos.n, ...d });
    await insertRow(db, 'dish_outcomes', { meal_id: m.id, dish_id: dishId, actual_consumers: actual, prepared_servings: 0,
      static_plan_servings: 0, leftover_kg: leftover, static_plan_leftover_kg: leftover, avg_rating: rating });
  }
  const RICE = 'D012';

  it('demand: mean of the last 5 servings at the same meal type; fewer than 5 uses those; none -> omitted', async () => {
    for (let d = 1; d <= 7; d += 1) await serve(await meal(runId, d, 'lunch'), RICE, { actual: d * 100 });
    await serve(await meal(runId, 3, 'dinner'), RICE, { actual: 999 }); // other meal type: ignored for demand
    const target = await meal(runId, 8, 'lunch', { status: 'scheduled' });
    const h = await buildHistory(db, { runId, meal: target, dishIds: [RICE, 'D013'] });
    expect(h.dishes.get(RICE).historical_dish_demand).toBe(500); // days 3..7
    expect(h.dishes.get('D013')).toEqual({}); // Chapati never served: everything omitted
    const early = await meal(runId, 3, 'breakfast', { status: 'scheduled' });
    // no earlier breakfast servings -> no demand/leftover; but rating spans meal types (lunch days 1–2, rated 3.5)
    expect((await buildHistory(db, { runId, meal: early, dishIds: [RICE] })).dishes.get(RICE)).toEqual({ historical_dish_rating: 3.5 });
    const day3dinner = await db.query(`SELECT * FROM meals WHERE id = 'r${runId}-d003-dinner'`);
    const lunch4 = { ...(await db.query(`SELECT * FROM meals WHERE id = 'r${runId}-d004-lunch'`)).rows[0] };
    expect((await buildHistory(db, { runId, meal: lunch4, dishIds: [RICE] })).dishes.get(RICE).historical_dish_demand).toBe(200); // days 1..3
    expect(day3dinner.rows).toHaveLength(1);
  });

  it('demand rounding is half-to-even like pandas (4 servings, mean 100.25 -> 100.2)', async () => {
    for (const [d, a] of [[1, 100], [2, 101], [3, 100], [4, 100]]) await serve(await meal(runId, d, 'lunch'), RICE, { actual: a });
    const target = await meal(runId, 5, 'lunch', { status: 'scheduled' });
    expect((await buildHistory(db, { runId, meal: target, dishIds: [RICE] })).dishes.get(RICE).historical_dish_demand).toBe(100.2);
  });

  it('rating: last 5 rated servings across meal types, strictly earlier (same-day earlier meal counts); unrated ignored', async () => {
    const ratings = { 'd5-lunch': 4.0, 'd5-dinner': 3.0, 'd6-lunch': 5.0, 'd6-dinner': null, 'd7-lunch': 2.0, 'd7-dinner': 3.5, 'd8-lunch': 4.5, 'd4-lunch': 1.0 };
    for (const [k, r] of Object.entries(ratings)) {
      const [d, mt] = k.slice(1).split('-');
      await serve(await meal(runId, Number(d), mt), RICE, { rating: r });
    }
    const target = await meal(runId, 8, 'dinner', { status: 'scheduled' });
    // last 5 rated before day 8 dinner: d8-lunch 4.5, d7-dinner 3.5, d7-lunch 2.0, d6-lunch 5.0, d5-dinner 3.0 -> 3.6
    expect((await buildHistory(db, { runId, meal: target, dishIds: [RICE] })).dishes.get(RICE).historical_dish_rating).toBe(3.6);
  });

  it('leftover: the single most recent serving at the same meal type', async () => {
    await serve(await meal(runId, 1, 'lunch'), RICE, { leftover: 11.0 });
    await serve(await meal(runId, 2, 'lunch'), RICE, { leftover: 7.25 });
    await serve(await meal(runId, 2, 'dinner'), RICE, { leftover: 99 }); // other meal type: ignored
    const target = await meal(runId, 3, 'lunch', { status: 'scheduled' });
    expect((await buildHistory(db, { runId, meal: target, dishIds: [RICE] })).dishes.get(RICE).previous_leftover_kg).toBe(7.2);
  });

  it('previous attendance: lunch <- same-day breakfast, breakfast <- previous day\'s dinner, Day 1 breakfast none', async () => {
    await meal(runId, 1, 'breakfast', { headcount: 510 });
    await meal(runId, 1, 'lunch', { headcount: 790 });
    await meal(runId, 1, 'dinner', { headcount: 744 });
    const lunch = { ...(await db.query(`SELECT * FROM meals WHERE id = 'r${runId}-d001-lunch'`)).rows[0] };
    const b1 = { ...(await db.query(`SELECT * FROM meals WHERE id = 'r${runId}-d001-breakfast'`)).rows[0] };
    const b2 = await meal(runId, 2, 'breakfast', { status: 'scheduled' });
    expect((await buildHistory(db, { runId, meal: lunch, dishIds: [] })).previousMealAttendance).toBe(510);
    expect((await buildHistory(db, { runId, meal: b2, dishIds: [] })).previousMealAttendance).toBe(744);
    expect((await buildHistory(db, { runId, meal: b1, dishIds: [] })).previousMealAttendance).toBeUndefined();
  });

  it('uses only COMPLETED earlier meals: a not-yet-completed previous meal gives no history and no attendance', async () => {
    await serve(await meal(runId, 1, 'lunch'), RICE, { actual: 300 });
    const pending = await meal(runId, 2, 'lunch', { status: 'voting_closed' });
    await serve(pending, RICE, { actual: 900 }); // outcome row on a meal that is not completed
    const target = await meal(runId, 3, 'lunch', { status: 'scheduled' });
    expect((await buildHistory(db, { runId, meal: target, dishIds: [RICE] })).dishes.get(RICE).historical_dish_demand).toBe(300);
    const breakfast3 = await meal(runId, 3, 'breakfast', { status: 'scheduled' });
    const dinner2 = await meal(runId, 2, 'dinner', { status: 'voting_closed' });
    expect(dinner2.status).toBe('voting_closed');
    expect((await buildHistory(db, { runId, meal: breakfast3, dishIds: [] })).previousMealAttendance).toBeUndefined();
  });

  it('never uses the current meal or later meals, even after they are completed (re-request)', async () => {
    await serve(await meal(runId, 1, 'lunch'), RICE, { actual: 100, leftover: 1, rating: 1 });
    const current = await meal(runId, 2, 'lunch');
    await serve(current, RICE, { actual: 999, leftover: 99, rating: 5 });
    await serve(await meal(runId, 3, 'lunch'), RICE, { actual: 888, leftover: 88, rating: 5 });
    const h = await buildHistory(db, { runId, meal: current, dishIds: [RICE] });
    expect(h.dishes.get(RICE)).toEqual({ historical_dish_demand: 100, historical_dish_rating: 1, previous_leftover_kg: 1 });
  });

  it('is filtered by run: another run\'s meals never contribute', async () => {
    await db.query('DROP INDEX simulation_runs_single'); // test schema only: allow two runs side by side
    try {
      const other = await newRun('2026-07-06');
      await db.query('UPDATE simulation_runs SET seed = 2 WHERE id = $1', [other]);
      await serve(await meal(other, 1, 'lunch'), RICE, { actual: 999, leftover: 50, rating: 5 });
      await meal(other, 1, 'breakfast', { headcount: 999 });
      await serve(await meal(runId, 1, 'lunch'), RICE, { actual: 200, leftover: 2, rating: 2 });
      const target = await meal(runId, 2, 'lunch', { status: 'scheduled' });
      const h = await buildHistory(db, { runId, meal: target, dishIds: [RICE] });
      expect(h.dishes.get(RICE)).toEqual({ historical_dish_demand: 200, historical_dish_rating: 2, previous_leftover_kg: 2 });
      expect(h.previousMealAttendance).toBe(700); // own run's lunch 1 (default headcount), not the other run
    } finally {
      await db.query('DELETE FROM simulation_runs');
      await db.query('CREATE UNIQUE INDEX simulation_runs_single ON simulation_runs ((true))');
    }
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!DATABASE_URL)('buildHistory reproduces the training CSV (read-only)', () => {
  it('historical_dish_demand matches the CSV for every row with at least 5 earlier servings in the CSV', async () => {
    const ctx = await createTestSchema('p4b_csvhist', { seeded: true });
    const db = ctx.pool;
    try {
      const text = readFileSync(new URL('../../ml/data/raw/messmind_training_data.csv', import.meta.url), 'utf8');
      const [header, ...lines] = text.trim().split(/\r?\n/);
      const cols = header.split(',');
      const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
      const { rows: dishRows } = await db.query('SELECT id, ml_dish_name, display_name, category, is_veg FROM dishes');
      const dish = new Map(dishRows.map((d) => [d.ml_dish_name, d]));
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      const start = dates[0];
      const { rows: [run] } = await db.query(
        'INSERT INTO simulation_runs (seed, start_date, total_days, sim_now) VALUES (0, $1, $2, $3) RETURNING id',
        [start, dates.length, `${addDays(start, -1)}T19:30:00Z`]);
      const dayOf = new Map(dates.map((d, i) => [d, i + 1]));
      for (const d of dates) {
        const r = rows.find((x) => x.date === d);
        await insertRow(db, 'sim_days', { run_id: run.id, day_number: dayOf.get(d), date: d, is_weekend: r.is_weekend === 'True',
          is_holiday: r.is_holiday === 'True', is_exam_day: r.is_exam_day === 'True', is_festival: r.is_festival === 'True',
          temperature: Number(r.temperature), rainfall: Number(r.rainfall) });
      }
      const meals = new Map();
      for (const r of rows) {
        const key = `${r.date}|${r.meal_type}`;
        if (!meals.has(key)) {
          const day = dayOf.get(r.date);
          meals.set(key, await insertRow(db, 'meals', {
            id: `r${run.id}-d${String(day).padStart(3, '0')}-${r.meal_type}`, run_id: run.id, day_number: day, date: r.date,
            meal_type: r.meal_type, ...mealTimes(r.date, r.meal_type), phase: day >= 31 ? 'active' : 'learning', status: 'completed',
            prov_total_responses: Number(r.total_responses), prov_not_eating: 0,
            final_total_responses: Number(r.total_responses), final_not_eating: 0, headcount: 0 }));
          meals.get(key).position = 0;
        }
        const m = meals.get(key);
        m.position += 1;
        const d = dish.get(r.dish_name);
        await insertRow(db, 'meal_dishes', { meal_id: m.id, dish_id: d.id, position: m.position, ml_dish_name: d.ml_dish_name,
          display_name: d.display_name, category: d.category, is_veg: d.is_veg });
        await insertRow(db, 'dish_outcomes', { meal_id: m.id, dish_id: d.id, actual_consumers: Number(r.actual_dish_consumers),
          prepared_servings: 0, static_plan_servings: 0, leftover_kg: 0, static_plan_leftover_kg: 0 });
      }

      // count earlier servings of (dish, meal type) inside the CSV window
      const seen = new Map();
      const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
      let checked = 0;
      const mismatches = [];
      for (const r of ordered) {
        const k = `${r.dish_name}|${r.meal_type}`;
        const prior = seen.get(k) ?? 0;
        seen.set(k, prior + 1);
        if (prior < 5) continue;
        const m = meals.get(`${r.date}|${r.meal_type}`);
        const id = dish.get(r.dish_name).id;
        const h = await buildHistory(db, { runId: run.id, meal: m, dishIds: [id] });
        checked += 1;
        if (Math.abs(h.dishes.get(id).historical_dish_demand - Number(r.historical_dish_demand)) > 0.051) {
          mismatches.push(`${r.date} ${k}: ours ${h.dishes.get(id).historical_dish_demand} csv ${r.historical_dish_demand}`);
        }
      }
      expect(checked).toBeGreaterThan(900);
      expect(mismatches).toEqual([]);
    } finally {
      await ctx.drop();
    }
  }, 120_000);
});
