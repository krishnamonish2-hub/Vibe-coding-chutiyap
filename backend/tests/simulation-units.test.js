// Phase 4A pure-function tests (no database): random streams, generator formulas, schedule, calendar, menus,
// hidden state, synthetic votes and outcomes.

import { describe, expect, it } from 'vitest';

import { attendanceProbability, dishProbability, responseRate, tapBias } from '../src/simulation/behaviour.js';
import { DEFAULT_CALENDAR, GENERATOR_CALENDAR, addDays, buildCalendar } from '../src/simulation/calendar.js';
import { DISH_MEAL_PROFILES } from '../src/simulation/catalog.js';
import { hiddenState, mealIndex } from '../src/simulation/hidden-state.js';
import { chooseMenu, profileFor } from '../src/simulation/menu.js';
import { generateOutcomes, preparedFromPrediction } from '../src/simulation/outcomes.js';
import { createRng } from '../src/simulation/rng.js';
import {
  assertScheduleInvariant, buildMeals, dayNumberAt, mealTimes, runStartAt, startOfDay,
} from '../src/simulation/schedule.js';
import { generateVotes } from '../src/simulation/votes.js';

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const day = (over = {}) => ({ is_weekend: false, is_holiday: false, is_exam_day: false, is_festival: false,
  rainfall: 0, temperature: 29, ...over });
const P = (key) => { const [n, m] = key.split('|'); return profileFor(n, m); };

describe('rng', () => {
  it('is reproducible per key and independent across keys', () => {
    const a = createRng(42, 'votes', 7); const b = createRng(42, 'votes', 7); const c = createRng(42, 'votes', 8);
    const sa = Array.from({ length: 5 }, () => a.random());
    expect(Array.from({ length: 5 }, () => b.random())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.random())).not.toEqual(sa);
  });

  it('produces the expected distributions (n = 20,000)', () => {
    const r = createRng('dist');
    const n = 20000;
    const u = Array.from({ length: n }, () => r.random());
    expect(Math.min(...u)).toBeGreaterThanOrEqual(0); expect(Math.max(...u)).toBeLessThan(1);
    expect(mean(u)).toBeCloseTo(0.5, 1);
    const z = Array.from({ length: n }, () => r.normal(2, 3));
    expect(mean(z)).toBeCloseTo(2, 0); expect(sd(z)).toBeCloseTo(3, 0);
    const g = Array.from({ length: n }, () => r.gamma(1.5, 8));
    expect(mean(g)).toBeGreaterThan(11.5); expect(mean(g)).toBeLessThan(12.5); // shape × scale = 12
    const ln = Array.from({ length: n }, () => r.lognormal(0, 0.08));
    expect(mean(ln)).toBeCloseTo(Math.exp(0.0032), 2);
    const bin = Array.from({ length: 2000 }, () => r.binomial(1000, 0.3));
    expect(mean(bin)).toBeGreaterThan(297); expect(mean(bin)).toBeLessThan(303);
    expect(r.binomial(10, 0)).toBe(0); expect(r.binomial(10, 1)).toBe(10);
    const ints = Array.from({ length: 3000 }, () => r.integers(4, 7));
    expect(new Set(ints)).toEqual(new Set([4, 5, 6]));
    const s = r.sample([1, 2, 3, 4, 5], 3);
    expect(new Set(s).size).toBe(3);
    expect(() => r.sample([1], 2)).toThrow();
  });
});

describe('generator formulas (golden values from ml/src/generate_data.py with zero noise)', () => {
  it('attendanceProbability', () => {
    const cases = [['lunch', {}], ['breakfast', { is_weekend: true }], ['dinner', { is_festival: true, rainfall: 8 }],
      ['lunch', { is_holiday: true, temperature: 34 }], ['breakfast', { is_exam_day: true }]];
    const got = cases.map(([m, k]) => attendanceProbability(m, day(k), 0));
    [0.8, 0.4, 0.9, 0.55, 0.65].forEach((v, i) => expect(got[i]).toBeCloseTo(v, 10));
  });

  it('dishProbability', () => {
    const cases = [['Rice|lunch', 3.7, {}, 5, 99, 1.0], ['Paneer Butter Masala|lunch', 4.5, {}, 6, 2, 1.1],
      ['Ice Cream|dinner', 4.9, { is_festival: true, temperature: 33 }, 6, 10, 0.95],
      ['Tea|breakfast', 3.0, { rainfall: 9 }, 4, 1, 1.0], ['Lauki Sabzi|lunch', 1.0, {}, 4, 99, 0.5]];
    const got = cases.map(([k, r, d, n, ds, a]) => dishProbability(P(k), r, day(d), n, ds, a));
    [0.8668, 0.62398908, 0.97, 0.7392, 0.0638].forEach((v, i) => expect(got[i]).toBeCloseTo(v, 8));
  });

  it('tapBias and responseRate', () => {
    expect(['Rice|lunch', 'Gulab Jamun|dinner', 'Veg Biryani|dinner', 'Chole|lunch'].map((k) => tapBias(P(k))))
      .toEqual([0.75, 1.15, 1.15, 1.0]);
    expect(responseRate('lunch', day(), 0)).toBeCloseTo(0.45, 10);
    expect(responseRate('breakfast', day({ is_weekend: true }), 0)).toBeCloseTo(0.32, 10);
    expect(responseRate('dinner', day({ is_exam_day: true }), 0)).toBeCloseTo(0.35, 10);
    expect(responseRate('lunch', day(), 1)).toBe(0.9);
    expect(responseRate('lunch', day(), -1)).toBe(0.1);
  });
});

describe('schedule (D1, D2)', () => {
  it('starts the run at Day 0 19:30 UTC and uses the approved offsets', () => {
    expect(runStartAt('2026-07-06').toISOString()).toBe('2026-07-05T19:30:00.000Z');
    const t = mealTimes('2026-07-06', 'breakfast');
    expect(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toISOString()]))).toEqual({
      serve_at: '2026-07-06T07:30:00.000Z', voting_opens_at: '2026-07-05T19:30:00.000Z',
      provisional_at: '2026-07-06T03:30:00.000Z', voting_closes_at: '2026-07-06T07:00:00.000Z',
      completes_at: '2026-07-06T08:15:00.000Z' });
    expect(mealTimes('2026-07-06', 'lunch').serve_at.toISOString()).toBe('2026-07-06T12:30:00.000Z');
    expect(mealTimes('2026-07-06', 'dinner').serve_at.toISOString()).toBe('2026-07-06T19:30:00.000Z');
  });

  it('day numbers, Day 31 activation and the ordering invariant', () => {
    expect(dayNumberAt('2026-07-06', runStartAt('2026-07-06'))).toBe(0);
    expect(dayNumberAt('2026-07-06', startOfDay('2026-07-06', 31))).toBe(31);
    const days = Array.from({ length: 60 }, (_, i) => ({ day_number: i + 1, date: addDays('2026-07-06', i) }));
    const meals = buildMeals(1, days);
    expect(meals).toHaveLength(180);
    expect(meals[0].id).toBe('r1-d001-breakfast');
    expect(meals.filter((m) => m.phase === 'learning')).toHaveLength(90);
    expect(meals.find((m) => m.phase === 'active').id).toBe('r1-d031-breakfast');
    const bad = [{ ...meals[0] }, { ...meals[1], provisional_at: meals[0].completes_at }];
    expect(() => assertScheduleInvariant(bad)).toThrow(/invariant/);
  });
});

describe('calendar (D3, D9)', () => {
  it('default: 2 weekday holidays, 2 festivals, no exam days; weekends flagged; reproducible', () => {
    const cal = buildCalendar({ seed: 42, startDate: '2026-07-06', totalDays: 60, calendar: DEFAULT_CALENDAR });
    expect(cal).toHaveLength(60);
    expect(cal.filter((d) => d.is_holiday)).toHaveLength(2);
    expect(cal.filter((d) => d.is_holiday).every((d) => !d.is_weekend)).toBe(true);
    expect(cal.filter((d) => d.is_festival)).toHaveLength(2);
    expect(cal.some((d) => d.is_exam_day)).toBe(false);
    expect(cal.filter((d) => d.is_weekend)).toHaveLength(16); // 8 full weeks + Mon–Thu
    expect(cal.every((d) => d.temperature >= -30 && d.temperature <= 60 && d.rainfall >= 0)).toBe(true);
    expect(buildCalendar({ seed: 42, startDate: '2026-07-06', totalDays: 60 })).toEqual(cal);
  });

  it('generator calendar: an 8-day exam block in the second half; festivals avoid holidays and exams', () => {
    const cal = buildCalendar({ seed: 7, startDate: '2026-07-06', totalDays: 90, calendar: GENERATOR_CALENDAR });
    const exam = cal.filter((d) => d.is_exam_day).map((d) => d.day_number);
    expect(exam.length).toBeGreaterThanOrEqual(7); // a holiday inside the block is not an exam day
    expect(Math.min(...exam)).toBeGreaterThan(45);
    expect(cal.filter((d) => d.is_festival).every((d) => !d.is_holiday && !d.is_exam_day)).toBe(true);
  });
});

describe('menus', () => {
  it('always include the core dishes, 4–6 dishes; festival dinners include Veg Biryani and Gulab Jamun', () => {
    const rng = createRng('menus-test');
    for (const mt of ['breakfast', 'lunch', 'dinner']) {
      const core = DISH_MEAL_PROFILES.filter((p) => p.mealType === mt && p.core);
      for (let i = 0; i < 200; i += 1) {
        const menu = chooseMenu(mt, false, rng);
        expect(menu.length).toBeGreaterThanOrEqual(4); expect(menu.length).toBeLessThanOrEqual(6);
        expect(core.every((c) => menu.includes(c))).toBe(true);
        expect(new Set(menu).size).toBe(menu.length);
      }
    }
    const fest = chooseMenu('dinner', true, rng).map((p) => p.mlDishName);
    expect(fest).toHaveLength(6);
    expect(fest).toEqual(expect.arrayContaining(['Veg Biryani', 'Gulab Jamun']));
  });
});

describe('hidden state, votes and outcomes', () => {
  const meal = { day_number: 3, meal_type: 'lunch', ...mealTimes('2026-07-08', 'lunch') };
  const menu = ['Rice', 'Chapati', 'Dal Tadka', 'Chole', 'Curd'].map((n, i) => ({
    dish_id: `D${String(i + 1).padStart(3, '0')}`, profile: profileFor(n, 'lunch'), daysSinceServed: 99 }));
  const ctx = { seed: 42, totalStudents: 1000, meal, day: day(), menu };

  it('meal index and hidden state are deterministic', () => {
    expect(mealIndex(1, 'breakfast')).toBe(0); expect(mealIndex(31, 'breakfast')).toBe(90);
    expect(hiddenState(ctx)).toEqual(hiddenState(ctx));
    const h = hiddenState(ctx);
    expect(h.pAttendResponder).toBeCloseTo(Math.min(0.98, h.pAttend + 0.08), 12);
    expect(h.attendance).toBeGreaterThan(600); expect(h.attendance).toBeLessThan(950);
  });

  it('votes: valid students, window, not_eating without dishes, zero-dish eating allowed (D8), reproducible', () => {
    const h = hiddenState(ctx);
    const votes = generateVotes(ctx, h);
    expect(generateVotes(ctx, h)).toEqual(votes);
    expect(new Set(votes.map((v) => v.studentId)).size).toBe(votes.length);
    expect(votes.every((v) => v.studentId >= 1 && v.studentId <= 1000)).toBe(true);
    expect(votes.every((v) => v.respondedAt >= meal.voting_opens_at && v.respondedAt < meal.voting_closes_at)).toBe(true);
    expect(votes.every((v) => v.respondedAt.getUTCMilliseconds() === 0)).toBe(true);
    expect(votes.filter((v) => v.response === 'not_eating').every((v) => v.dishIds.length === 0)).toBe(true);
    expect(votes.length).toBeGreaterThan(300); expect(votes.length).toBeLessThan(650);
    // D8: across many meals some attending responders pick nothing
    const many = Array.from({ length: 30 }, (_, i) => generateVotes({ ...ctx, meal: { ...meal, day_number: i + 1 } },
      hiddenState({ ...ctx, meal: { ...meal, day_number: i + 1 } }))).flat();
    expect(many.some((v) => v.response === 'eating' && v.dishIds.length === 0)).toBe(true);
  });

  it('outcomes: static plan without predictions (4A), prediction × 1.05 when given, leftovers and shortfall', () => {
    const h = hiddenState(ctx);
    const o = generateOutcomes(ctx, h, null);
    expect(o.headcount).toBe(h.attendance);
    for (const d of o.dishes) {
      expect(d.prepared_servings).toBe(d.static_plan_servings);
      expect(d.actual_consumers).toBeLessThanOrEqual(h.attendance);
      expect(d.shortfall_servings).toBe(Math.max(0, d.actual_consumers - d.prepared_servings));
      expect(d.avg_rating).toBeGreaterThanOrEqual(1); expect(d.avg_rating).toBeLessThanOrEqual(5);
    }
    expect(generateOutcomes(ctx, h, null)).toEqual(o);
    expect(preparedFromPrediction(500)).toBe(525);
    const withPred = generateOutcomes(ctx, h, new Map([['D001', 400]]));
    expect(withPred.dishes[0].prepared_servings).toBe(420);
    expect(withPred.dishes[0].actual_consumers).toBe(o.dishes[0].actual_consumers); // actuals never depend on prep
    expect(withPred.dishes[0].static_plan_servings).toBe(o.dishes[0].static_plan_servings);
  });
});
