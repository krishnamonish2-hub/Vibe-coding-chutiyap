// Outgoing POST /predict request — a field-by-field mirror of MealRequest/DishIn in ml/api/schemas.py and
// shared/api_contract.md v0.3 (§2.3). It is never looser than the ML service:
//   * unknown fields are rejected (ML: extra="forbid");
//   * integers must be JS integers, booleans real booleans, numbers finite (ML: strict types, allow_inf_nan=False);
//   * strings must already be trimmed and 1–100 characters (ML trims, then checks length; we never rely on trimming);
//   * meal_type is one of the three literals; date is a real YYYY-MM-DD date;
//   * cross-field rules are identical.
// Backend-only, stricter rules: total_students must be 1,000 (R-02); every boolean is always sent; optional numbers
// are omitted when missing (never null). Nothing is coerced: invalid input fails validation.

import { z } from 'zod';

const str100 = z.string().min(1).max(100).refine((s) => s === s.trim(), { message: 'must not have leading or trailing whitespace' });
const int = z.number().int().safe();
const finite = z.number().finite();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const DishRequest = z.object({
  dish_id: str100,
  dish_name: str100,
  dish_category: str100,
  is_veg: z.boolean(),
  is_special: z.boolean(),
  interested_taps: int.min(0),
  historical_dish_demand: finite.min(0).optional(),
  historical_dish_rating: finite.min(1).max(5).optional(),
  previous_leftover_kg: finite.min(0).optional(),
}).strict();

// Object shape without the cross-field rules (exported so tests can compare its fields with ml/api/schemas.py).
export const MealRequestBase = z.object({
  meal_id: str100,
  date: z.string().refine(isRealDate, { message: 'must be a real YYYY-MM-DD date' }),
  meal_type: z.enum(['breakfast', 'lunch', 'dinner']),
  total_students: int.refine((v) => v === 1000, { message: 'must be 1000 (synthetic population)' }),
  total_responses: int.min(0),
  is_holiday: z.boolean(),
  is_exam_day: z.boolean(),
  is_festival: z.boolean(),
  temperature: finite.min(-30).max(60).optional(),
  rainfall: finite.min(0).optional(),
  previous_meal_attendance: int.min(0).optional(),
  dishes: z.array(DishRequest).min(1).max(30),
}).strict();

export const MealRequest = MealRequestBase.superRefine((m, ctx) => {
  const add = (message, path = []) => ctx.addIssue({ code: 'custom', message, path });
  if (m.total_responses > m.total_students) add('total_responses must be <= total_students', ['total_responses']);
  if (m.previous_meal_attendance !== undefined && m.previous_meal_attendance > m.total_students) {
    add('previous_meal_attendance must be <= total_students', ['previous_meal_attendance']);
  }
  m.dishes.forEach((d, i) => {
    if (d.interested_taps > m.total_responses) add('interested_taps must be <= total_responses', ['dishes', i, 'interested_taps']);
  });
  if (new Set(m.dishes.map((d) => d.dish_id)).size !== m.dishes.length) add('dish_id values must be unique within a meal', ['dishes']);
  if (new Set(m.dishes.map((d) => d.dish_name)).size !== m.dishes.length) add('dish_name values must be unique within a meal', ['dishes']);
});

// Returns { ok: true, value } or { ok: false, issues: [{ path, message }] }. Never transforms the value.
export function validateRequest(payload) {
  const result = MealRequest.safeParse(payload);
  if (result.success) return { ok: true, value: payload };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
}
