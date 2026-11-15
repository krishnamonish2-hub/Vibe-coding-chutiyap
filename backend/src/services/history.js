// Historical features for a prediction (contract v0.3 §2.5, docs/integration_handoff.md §6, mirrors
// ml/src/generate_data.py add_historical_features). Built ONLY from completed meals of the SAME simulation run that
// were served strictly before the meal being predicted — never from the current meal or anything later.
//
//   historical_dish_demand   mean actual consumers over the last 5 servings of the dish at the same meal type   (1 dp)
//   historical_dish_rating   mean per-serving average rating over the last 5 rated servings of the dish,
//                            any meal type (an earlier meal on the same day counts)                              (2 dp)
//   previous_leftover_kg     leftover kg of the single most recent serving of the dish at the same meal type   (1 dp)
//   previous_meal_attendance headcount of the meal slot immediately before (breakfast -> previous day's dinner)
// Missing values are omitted (never 0 or a default). Rounding is round-half-to-even, like pandas .round().

const WINDOW = 5;

export function roundHalfEven(value, decimals) {
  const f = 10 ** decimals;
  const x = value * f;
  const r = Math.round(x);
  const isHalf = Math.abs(Math.abs(x - Math.trunc(x)) - 0.5) < 1e-9;
  const even = isHalf ? 2 * Math.round(x / 2) : r;
  return even / f;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export async function buildHistory(db, { runId, meal, dishIds }) {
  const base = [runId, meal.serve_at, dishIds];

  const { rows: demandRows } = await db.query(
    `SELECT dish_id, actual_consumers FROM (
       SELECT o.dish_id, o.actual_consumers,
              row_number() OVER (PARTITION BY o.dish_id ORDER BY m.serve_at DESC) AS rn
         FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
        WHERE m.run_id = $1 AND m.status = 'completed' AND m.serve_at < $2 AND o.dish_id = ANY($3)
          AND m.meal_type = $4) t
      WHERE rn <= ${WINDOW}`,
    [...base, meal.meal_type],
  );
  const { rows: ratingRows } = await db.query(
    `SELECT dish_id, avg_rating FROM (
       SELECT o.dish_id, o.avg_rating,
              row_number() OVER (PARTITION BY o.dish_id ORDER BY m.serve_at DESC) AS rn
         FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
        WHERE m.run_id = $1 AND m.status = 'completed' AND m.serve_at < $2 AND o.dish_id = ANY($3)
          AND o.avg_rating IS NOT NULL) t
      WHERE rn <= ${WINDOW}`,
    base,
  );
  const { rows: leftoverRows } = await db.query(
    `SELECT DISTINCT ON (o.dish_id) o.dish_id, o.leftover_kg
       FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
      WHERE m.run_id = $1 AND m.status = 'completed' AND m.serve_at < $2 AND o.dish_id = ANY($3) AND m.meal_type = $4
      ORDER BY o.dish_id, m.serve_at DESC`,
    [...base, meal.meal_type],
  );
  const { rows: prevRows } = await db.query(
    `SELECT status, headcount FROM meals WHERE run_id = $1 AND serve_at < $2 ORDER BY serve_at DESC LIMIT 1`,
    [runId, meal.serve_at],
  );

  const group = (rows, col) => {
    const m = new Map();
    for (const r of rows) {
      if (r[col] === null) continue;
      if (!m.has(r.dish_id)) m.set(r.dish_id, []);
      m.get(r.dish_id).push(Number(r[col]));
    }
    return m;
  };
  const demand = group(demandRows, 'actual_consumers');
  const rating = group(ratingRows, 'avg_rating');
  const leftover = new Map(leftoverRows.filter((r) => r.leftover_kg !== null).map((r) => [r.dish_id, Number(r.leftover_kg)]));

  const dishes = new Map();
  for (const id of dishIds) {
    const h = {};
    if (demand.has(id)) h.historical_dish_demand = roundHalfEven(mean(demand.get(id)), 1);
    if (rating.has(id)) h.historical_dish_rating = roundHalfEven(mean(rating.get(id)), 2);
    if (leftover.has(id)) h.previous_leftover_kg = roundHalfEven(leftover.get(id), 1);
    dishes.set(id, h);
  }
  const prev = prevRows[0];
  const previousMealAttendance = prev && prev.status === 'completed' && prev.headcount !== null ? prev.headcount : undefined;
  return { dishes, previousMealAttendance };
}
