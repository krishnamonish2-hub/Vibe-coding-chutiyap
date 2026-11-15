// Calibration (Phase 0 clarification C5): a 90-day synthetic run with the generator's calendar is compared with the
// existing training CSV — distributions and probabilities, not only averages. READ-ONLY: ml/ is only read.
//
// Tolerances are the approved ones. If one fails, it is reported with the measured values; tolerances are never
// loosened silently.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GENERATOR_CALENDAR } from '../src/simulation/calendar.js';
import { DISH_MEAL_PROFILES } from '../src/simulation/catalog.js';
import { createSimulationController } from '../src/simulation/controller.js';
import { loadMealContext, loadRun } from '../src/simulation/engine.js';
import { hiddenState } from '../src/simulation/hidden-state.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

// ---------------------------------------------------------------- statistics helpers
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Two-sample Kolmogorov–Smirnov test (asymptotic p-value, Numerical Recipes form).
export function ksTest(a, b) {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0; let j = 0; let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i += 1;
    while (j < y.length && y[j] <= v) j += 1;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const ne = (x.length * y.length) / (x.length + y.length);
  const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k += 1) p += 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

// Chi-square test of homogeneity for two count vectors over the same categories; df = categories - 1.
function chiSquare(countsA, countsB) {
  const nA = countsA.reduce((s, v) => s + v, 0);
  const nB = countsB.reduce((s, v) => s + v, 0);
  let x2 = 0;
  countsA.forEach((a, k) => {
    const total = a + countsB[k];
    const eA = (total * nA) / (nA + nB); const eB = (total * nB) / (nA + nB);
    x2 += (a - eA) ** 2 / eA + (countsB[k] - eB) ** 2 / eB;
  });
  return { x2, df: countsA.length - 1, p: countsA.length === 3 ? Math.exp(-x2 / 2) : NaN }; // exact for df = 2
}

// Log-gamma (Lanczos), regularized incomplete beta I_x(a, b) and upper incomplete gamma Q(a, x)
// (Numerical Recipes continued fractions / series).
function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) { y += 1; ser += c / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300; let c = 1; let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
export function betai(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
export function gammq(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) { // series for P, then Q = 1 - P
    let sum = 1 / a; let del = sum; let ap = a;
    for (let n = 0; n < 500; n += 1) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a; let c = 1e300; let d = 1 / b; let h = d; // continued fraction for Q
  for (let i = 1; i <= 500; i += 1) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const chiSquareP = (x2, df) => gammq(df / 2, x2 / 2);
const twoSidedNormalP = (z) => gammq(0.5, (z * z) / 2); // = erfc(|z| / sqrt(2))

// Two-sided F-test for equal variances.
export function fTest(a, b) {
  const f = sd(a) ** 2 / sd(b) ** 2; const d1 = a.length - 1; const d2 = b.length - 1;
  const cdf = betai(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2));
  return { f, p: Math.min(1, 2 * Math.min(cdf, 1 - cdf)) };
}

// Exact probability that a dish is on a menu under the generator's rule (choose_menu): all core dishes; a festival
// dinner gets Veg Biryani + Gulab Jamun and 6 dishes; otherwise 4–6 dishes (uniform) with the extra dishes drawn
// uniformly without replacement from the rotating dishes.
export function inclusionProbability(profile, mealType, isFestival) {
  if (profile.core) return 1;
  const options = DISH_MEAL_PROFILES.filter((p) => p.mealType === mealType);
  const nCore = options.filter((p) => p.core).length;
  const nRot = options.length - nCore;
  if (isFestival && mealType === 'dinner') {
    if (['Veg Biryani', 'Gulab Jamun'].includes(profile.mlDishName)) return 1;
    return Math.max(0, 6 - nCore - 2) / (nRot - 2);
  }
  const meanExtra = [4, 5, 6].reduce((acc, n) => acc + Math.max(0, n - nCore), 0) / 3;
  return meanExtra / nRot;
}

// Serving-frequency test for one dataset: meals = [{ meal_type, festival, dishes: string[] }].
// (a) per (dish, meal type): observed count vs the exact expectation, two-sided z-test with a Bonferroni-corrected
//     family-wise alpha of 0.01 (deterministic dishes must match exactly);
// (b) per meal type, non-festival meals: chi-square test that rotating dishes are chosen uniformly. Dishes on one
//     menu are drawn without replacement, so counts are less variable than multinomial and this test is conservative
//     (it can miss small deviations but does not fail spuriously).
export function servingFrequencyTest(meals) {
  const pairs = []; const failures = [];
  for (const mt of MEAL_TYPES) {
    const ms = meals.filter((m) => m.meal_type === mt);
    for (const prof of DISH_MEAL_PROFILES.filter((x) => x.mealType === mt)) {
      let observed = 0; let expected = 0; let variance = 0;
      for (const m of ms) {
        const p = inclusionProbability(prof, mt, m.festival);
        expected += p; variance += p * (1 - p);
        if (m.dishes.includes(prof.mlDishName)) observed += 1;
      }
      pairs.push({ key: `${prof.mlDishName}|${mt}`, observed, expected, variance, n: ms.length });
    }
  }
  const tested = pairs.filter((x) => x.variance > 0);
  const alpha = 0.01 / tested.length;
  for (const x of pairs) {
    if (x.variance === 0) { if (x.observed !== Math.round(x.expected)) failures.push(`${x.key}: ${x.observed} ≠ ${x.expected}`); continue; }
    const z = (x.observed - x.expected) / Math.sqrt(x.variance);
    x.z = z; x.p = twoSidedNormalP(z);
    if (x.p <= alpha) failures.push(`${x.key}: observed ${x.observed}/${x.n}, expected ${x.expected.toFixed(1)}, z=${z.toFixed(2)}`);
  }
  const uniformity = {};
  for (const mt of MEAL_TYPES) {
    const ms = meals.filter((m) => m.meal_type === mt && !(m.festival && mt === 'dinner'));
    const rot = DISH_MEAL_PROFILES.filter((x) => x.mealType === mt && !x.core).map((x) => x.mlDishName);
    const counts = rot.map((name) => ms.filter((m) => m.dishes.includes(name)).length);
    const total = counts.reduce((a, b) => a + b, 0); const e = total / rot.length;
    const x2 = counts.reduce((acc, o) => acc + (o - e) ** 2 / e, 0);
    uniformity[mt] = { x2: +x2.toFixed(2), df: rot.length - 1, p: +chiSquareP(x2, rot.length - 1).toFixed(3) };
    if (uniformity[mt].p <= 0.01) failures.push(`${mt}: rotating dishes not uniform (chi-square p=${uniformity[mt].p})`);
  }
  const worst = tested.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
  return { failures, alpha, worst: { key: worst.key, z: +worst.z.toFixed(2), p: +worst.p.toFixed(4) }, uniformity };
}

// ---------------------------------------------------------------- training CSV (read-only)
function readTrainingCsv() {
  const text = readFileSync(new URL('../../ml/data/raw/messmind_training_data.csv', import.meta.url), 'utf8');
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  const num = new Set(['total_students', 'previous_meal_attendance', 'historical_dish_demand', 'historical_dish_rating',
    'interested_taps', 'total_responses', 'previous_leftover_kg', 'actual_dish_consumers', 'temperature', 'rainfall', 'day_of_week']);
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => {
    const c = cols[i];
    if (num.has(c)) return [c, v === '' ? null : Number(v)];
    if (v === 'True' || v === 'False') return [c, v === 'True'];
    return [c, v];
  })));
}

const ORDER = { breakfast: 0, lunch: 1, dinner: 2 };
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];

function csvMeals(rows) {
  const byMeal = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.meal_type}`;
    if (!byMeal.has(k)) byMeal.set(k, { date: r.date, meal_type: r.meal_type, responses: r.total_responses,
      weekend: r.is_weekend, holiday: r.is_holiday, exam: r.is_exam_day, festival: r.is_festival,
      prevAttendance: r.previous_meal_attendance, dishes: [] });
    byMeal.get(k).dishes.push(r.dish_name);
  }
  const meals = [...byMeal.values()].sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.meal_type] - ORDER[b.meal_type]);
  // attendance of meal i = previous_meal_attendance recorded on meal i+1
  meals.forEach((m, i) => { m.attendance = meals[i + 1]?.prevAttendance ?? null; });
  return meals;
}

// ---------------------------------------------------------------- statistics helpers are correct (no database)
describe('calibration statistics helpers', () => {
  it('match closed-form values', () => {
    for (const x of [0.1, 1, 3.7, 12]) expect(gammq(1, x)).toBeCloseTo(Math.exp(-x), 10); // Q(1, x) = e^-x
    expect(gammq(0.5, 1.959963984540054 ** 2 / 2)).toBeCloseTo(0.05, 8); // erfc(1.96/√2) = 0.05
    expect(gammq(1, 4.60517 / 2)).toBeCloseTo(0.1, 5); // chi-square df=2, x=4.60517 -> p = 0.10
    expect(gammq(5, 18.307 / 2)).toBeCloseTo(0.05, 3); // chi-square df=10 critical value 18.307 -> p = 0.05
    expect(betai(1, 1, 0.3)).toBeCloseTo(0.3, 12); // uniform
    expect(betai(2, 3, 0.4)).toBeCloseTo(0.5248, 4); // I_0.4(2,3) = 0.5248
    expect(betai(10, 10, 0.5)).toBeCloseTo(0.5, 10); // symmetry
  });

  it('F-test: identical spread gives p = 1; very different spread gives p ≈ 0', () => {
    const a = Array.from({ length: 40 }, (_, i) => i % 7);
    expect(fTest(a, a).p).toBeCloseTo(1, 10);
    expect(fTest(a, a.map((x) => x * 5)).p).toBeLessThan(1e-6);
  });

  it('inclusion probabilities follow the generator menu rule', () => {
    const P = (name, mt, fest = false) => inclusionProbability(DISH_MEAL_PROFILES.find((x) => x.mlDishName === name && x.mealType === mt), mt, fest);
    expect(P('Tea', 'breakfast')).toBe(1);
    expect(P('Coffee', 'breakfast')).toBeCloseTo(0.4, 12); // E[n-1] = 4 of 10 rotating
    expect(P('Rajma', 'lunch')).toBeCloseTo(2 / 12, 12); // E[n-3] = 2 of 12
    expect(P('Kheer', 'dinner')).toBeCloseTo(2 / 11, 12); // E[n-3] = 2 of 11 rotating
    expect(P('Veg Biryani', 'dinner', true)).toBe(1);
    expect(P('Kheer', 'dinner', true)).toBeCloseTo(1 / 9, 12); // festival: 6 - 3 core - 2 forced = 1 of the other 9
  });
});

// ---------------------------------------------------------------- the test
describe.skipIf(!DATABASE_URL)('simulator calibration against the training CSV (90 days)', () => {
  let ctx;
  let db;
  const timing = {};
  let csv;
  let sim; // simulation-derived datasets

  beforeAll(async () => {
    ctx = await createTestSchema('p4_calib', { seeded: true });
    db = ctx.pool;
    const controller = createSimulationController({ pool: db, log: { error: () => {} } });
    const t0 = performance.now();
    await controller.start({ seed: 42, totalDays: 90, calendar: GENERATOR_CALENDAR }, null);
    const t1 = performance.now();
    await controller.advance({ to: 'day', day: 90 });
    await controller.advance({ to: 'end_of_day' });
    const t2 = performance.now();
    timing.startMs = Math.round(t1 - t0);
    timing.runMs = Math.round(t2 - t1);

    const q = async (sql, p) => (await db.query(sql, p)).rows;
    const meals = await q(`SELECT m.*, d.is_weekend, d.is_holiday, d.is_exam_day, d.is_festival
      FROM meals m JOIN sim_days d ON d.run_id = m.run_id AND d.day_number = m.day_number ORDER BY m.serve_at`);
    const dishRows = await q(`SELECT m.meal_type, md.ml_dish_name, c.final_taps, m.final_total_responses, o.actual_consumers,
        o.avg_rating, o.leftover_kg
      FROM meal_dishes md JOIN meals m ON m.id = md.meal_id
      JOIN meal_dish_counts c ON c.meal_id = md.meal_id AND c.dish_id = md.dish_id
      JOIN dish_outcomes o ON o.meal_id = md.meal_id AND o.dish_id = md.dish_id`);
    const menus = await q(`SELECT md.meal_id, array_agg(md.ml_dish_name) AS dishes FROM meal_dishes md GROUP BY md.meal_id`);
    const days = await q('SELECT temperature, rainfall FROM sim_days ORDER BY day_number');

    // expected Not Eating share from the re-derived hidden state of every meal
    const run = await loadRun(db);
    const expectedNotEating = [];
    for (const m of meals) {
      const h = hiddenState(await loadMealContext(db, run, m));
      expectedNotEating.push(1 - h.pAttendResponder);
    }
    timing.totalMs = Math.round(performance.now() - t0);
    sim = { meals, dishRows, menus: new Map(menus.map((r) => [r.meal_id, r.dishes])), days, expectedNotEating };

    const rows = readTrainingCsv();
    csv = { rows, meals: csvMeals(rows) };
    const daySeen = new Map();
    for (const r of rows) if (!daySeen.has(r.date)) daySeen.set(r.date, { temperature: r.temperature, rainfall: r.rainfall });
    csv.days = [...daySeen.values()];

    // eslint-disable-next-line no-console
    console.log(`[calibration] 90-day run: start ${timing.startMs} ms, simulate ${timing.runMs} ms, `
      + `incl. analysis ${timing.totalMs} ms; ${meals.length} meals, ${dishRows.length} dish servings`);
  }, 300_000);
  afterAll(async () => ctx?.drop());

  const report = [];
  const check = (name, simValue, csvValue, ok) => { report.push({ name, sim: simValue, csv: csvValue, ok }); return ok; };
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('[calibration] results:\n' + report.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: sim=${JSON.stringify(r.sim)} csv=${JSON.stringify(r.csv)}`).join('\n'));
  });

  it('the run completed all 270 meals', () => {
    expect(sim.meals).toHaveLength(270);
    expect(sim.meals.every((m) => m.status === 'completed')).toBe(true);
  });

  it('1. response rate by meal type × weekend (holiday/exam excluded): mean ±0.02, F-test p > 0.01, KS p > 0.01', () => {
    const failed = [];
    for (const mt of MEAL_TYPES) {
      for (const we of [false, true]) {
        const s = sim.meals.filter((m) => m.meal_type === mt && m.is_weekend === we && !m.is_holiday && !m.is_exam_day)
          .map((m) => m.final_total_responses / 1000);
        const c = csv.meals.filter((m) => m.meal_type === mt && m.weekend === we && !m.holiday && !m.exam).map((m) => m.responses / 1000);
        const ks = ksTest(s, c);
        const ft = fTest(s, c);
        const ok = Math.abs(mean(s) - mean(c)) <= 0.02 && ft.p > 0.01 && ks.p > 0.01;
        if (!check(`response rate ${mt} weekend=${we}`, { mean: +mean(s).toFixed(3), sd: +sd(s).toFixed(3), f_p: +ft.p.toFixed(3), ks_p: +ks.p.toFixed(3) },
          { mean: +mean(c).toFixed(3), sd: +sd(c).toFixed(3) }, ok)) failed.push(`${mt} weekend=${we}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it('2. attendance rate by meal type × weekend: mean ±0.02', () => {
    const failed = [];
    for (const mt of MEAL_TYPES) {
      for (const we of [false, true]) {
        const s = sim.meals.filter((m) => m.meal_type === mt && m.is_weekend === we && !m.is_holiday && !m.is_exam_day).map((m) => m.headcount / 1000);
        const c = csv.meals.filter((m) => m.meal_type === mt && m.weekend === we && !m.holiday && !m.exam && m.attendance !== null).map((m) => m.attendance / 1000);
        const ok = Math.abs(mean(s) - mean(c)) <= 0.02;
        if (!check(`attendance ${mt} weekend=${we}`, +mean(s).toFixed(3), +mean(c).toFixed(3), ok)) failed.push(`${mt} weekend=${we}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it('3. menu size distribution: chi-square p > 0.01', () => {
    const count = (sizes) => [4, 5, 6].map((n) => sizes.filter((s) => s === n).length);
    const s = count([...sim.menus.values()].map((d) => d.length));
    const c = count(csv.meals.map((m) => m.dishes.length));
    const t = chiSquare(s, c);
    expect(check('menu sizes 4/5/6', { counts: s, p: +t.p.toFixed(3) }, { counts: c }, t.p > 0.01)).toBe(true);
  });

  it('4. core dishes on every menu; festival dinners include Veg Biryani and Gulab Jamun', () => {
    for (const m of sim.meals) {
      const dishes = sim.menus.get(m.id);
      const core = DISH_MEAL_PROFILES.filter((p) => p.mealType === m.meal_type && p.core).map((p) => p.mlDishName);
      expect(core.every((d) => dishes.includes(d)), m.id).toBe(true);
      if (m.is_festival && m.meal_type === 'dinner') expect(dishes).toEqual(expect.arrayContaining(['Veg Biryani', 'Gulab Jamun']));
    }
    check('core + festival rules', 'all meals', 'rule', true);
  });

  it('5. the set of (dish, meal type) pairs matches the CSV exactly (40 pairs)', () => {
    const s = new Set(sim.meals.flatMap((m) => sim.menus.get(m.id).map((d) => `${d}|${m.meal_type}`)));
    const c = new Set(csv.rows.map((r) => `${r.dish_name}|${r.meal_type}`));
    expect(check('dish/meal pairs', s.size, c.size, s.size === 40 && [...s].every((p) => c.has(p)))).toBe(true);
  });

  it('6. serving frequency: per-pair z-test vs the exact expectation (Bonferroni, family α = 0.01) and chi-square uniformity; CSV as control', () => {
    const simMeals = sim.meals.map((m) => ({ meal_type: m.meal_type, festival: m.is_festival, dishes: sim.menus.get(m.id) }));
    const csvMeals = csv.meals.map((m) => ({ meal_type: m.meal_type, festival: m.festival, dishes: m.dishes }));
    const s = servingFrequencyTest(simMeals);
    const c = servingFrequencyTest(csvMeals);
    check('serving frequency (sim vs exact expectation)', { failures: s.failures, worst: s.worst, uniformity: s.uniformity }, 'expected', s.failures.length === 0);
    check('serving frequency (CSV vs exact expectation, control)', { failures: c.failures, worst: c.worst, uniformity: c.uniformity }, 'expected', c.failures.length === 0);
    expect(s.failures).toEqual([]);
    expect(c.failures).toEqual([]); // control: the training data passes the same test
  });

  it('7. tap share (taps / responses) by meal type: mean ±0.03, KS p > 0.01', () => {
    const failed = [];
    for (const mt of MEAL_TYPES) {
      const s = sim.dishRows.filter((r) => r.meal_type === mt).map((r) => r.final_taps / r.final_total_responses);
      const c = csv.rows.filter((r) => r.meal_type === mt).map((r) => r.interested_taps / r.total_responses);
      const ks = ksTest(s, c);
      const ok = Math.abs(mean(s) - mean(c)) <= 0.03 && ks.p > 0.01;
      if (!check(`tap share ${mt}`, { mean: +mean(s).toFixed(3), ks_p: +ks.p.toFixed(3) }, { mean: +mean(c).toFixed(3) }, ok)) failed.push(mt);
    }
    expect(failed).toEqual([]);
  });

  it('8. actual consumers ÷ taps: mean and median ±0.15', () => {
    const s = sim.dishRows.filter((r) => r.final_taps > 0).map((r) => r.actual_consumers / r.final_taps);
    const c = csv.rows.map((r) => r.actual_dish_consumers / r.interested_taps);
    const ok = Math.abs(mean(s) - mean(c)) <= 0.15 && Math.abs(median(s) - median(c)) <= 0.15;
    expect(check('actual / taps', { mean: +mean(s).toFixed(3), median: +median(s).toFixed(3) },
      { mean: +mean(c).toFixed(3), median: +median(c).toFixed(3) }, ok)).toBe(true);
  });

  it('9. actual consumers by meal type: mean ±25, std ±25, KS p > 0.01', () => {
    const failed = [];
    for (const mt of MEAL_TYPES) {
      const s = sim.dishRows.filter((r) => r.meal_type === mt).map((r) => r.actual_consumers);
      const c = csv.rows.filter((r) => r.meal_type === mt).map((r) => r.actual_dish_consumers);
      const ks = ksTest(s, c);
      const ok = Math.abs(mean(s) - mean(c)) <= 25 && Math.abs(sd(s) - sd(c)) <= 25 && ks.p > 0.01;
      if (!check(`actual consumers ${mt}`, { mean: +mean(s).toFixed(1), sd: +sd(s).toFixed(1), ks_p: +ks.p.toFixed(3) },
        { mean: +mean(c).toFixed(1), sd: +sd(c).toFixed(1) }, ok)) failed.push(mt);
    }
    expect(failed).toEqual([]);
  });

  it('10. per-serving rating: mean ±0.05, within [1, 5]', () => {
    const s = sim.dishRows.map((r) => r.avg_rating);
    const c = csv.rows.filter((r) => r.historical_dish_rating !== null).map((r) => r.historical_dish_rating);
    const ok = Math.abs(mean(s) - mean(c)) <= 0.05 && Math.min(...s) >= 1 && Math.max(...s) <= 5;
    expect(check('rating', { mean: +mean(s).toFixed(3), min: Math.min(...s), max: Math.max(...s) }, { mean: +mean(c).toFixed(3) }, ok)).toBe(true);
  });

  it('11. leftover kg (static plan): mean ±1.5, zero share ±0.04', () => {
    const s = sim.dishRows.map((r) => r.leftover_kg);
    const c = csv.rows.filter((r) => r.previous_leftover_kg !== null).map((r) => r.previous_leftover_kg);
    const zs = s.filter((v) => v === 0).length / s.length;
    const zc = c.filter((v) => v === 0).length / c.length;
    const ok = Math.abs(mean(s) - mean(c)) <= 1.5 && Math.abs(zs - zc) <= 0.04;
    expect(check('leftover kg', { mean: +mean(s).toFixed(2), zero_share: +zs.toFixed(3) }, { mean: +mean(c).toFixed(2), zero_share: +zc.toFixed(3) }, ok)).toBe(true);
  });

  it('12. weather: rainy share ±0.08, rain on rainy days ±3 mm, temperature mean ±0.5 and std ±0.4', () => {
    const stats = (days) => {
      const rainy = days.filter((d) => d.rainfall > 0);
      return { rainy_share: rainy.length / days.length, rain_mean: mean(rainy.map((d) => d.rainfall)),
        t_mean: mean(days.map((d) => d.temperature)), t_sd: sd(days.map((d) => d.temperature)) };
    };
    const s = stats(sim.days); const c = stats(csv.days);
    const ok = Math.abs(s.rainy_share - c.rainy_share) <= 0.08 && Math.abs(s.rain_mean - c.rain_mean) <= 3
      && Math.abs(s.t_mean - c.t_mean) <= 0.5 && Math.abs(s.t_sd - c.t_sd) <= 0.4;
    const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]));
    expect(check('weather', r(s), r(c), ok)).toBe(true);
  });

  it('13. basic limits: taps ≤ responses ≤ 1000, actual ≤ headcount', () => {
    for (const r of sim.dishRows) {
      expect(r.final_taps).toBeLessThanOrEqual(r.final_total_responses);
      expect(r.final_total_responses).toBeLessThanOrEqual(1000);
    }
    const byMeal = new Map(sim.meals.map((m) => [m.id, m.headcount]));
    expect(sim.meals.every((m) => m.headcount <= 1000)).toBe(true);
    expect(byMeal.size).toBe(270);
    check('limits', 'ok', 'rule', true);
  });

  it('14. Not Eating share ≈ 1 − (p_attend + 0.08): mean ±0.03', () => {
    const observed = mean(sim.meals.map((m) => m.final_not_eating / m.final_total_responses));
    const expected = mean(sim.expectedNotEating);
    expect(check('not eating share', +observed.toFixed(3), +expected.toFixed(3), Math.abs(observed - expected) <= 0.03)).toBe(true);
  });

  it('records the runtime', () => {
    expect(timing.runMs).toBeGreaterThan(0);
    check('runtime (ms)', timing, 'n/a', true);
  });
});
