// Checks the synthetic dish catalogue against the existing ML files. READ-ONLY: files under ml/ are only read.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DISH_CATEGORIES, DISH_MEAL_PROFILES, DISHES, MEAL_TYPES, TOTAL_STUDENTS, studentCode,
} from '../src/simulation/catalog.js';

const ML = new URL('../../ml/', import.meta.url);
const read = (p) => readFileSync(new URL(p, ML), 'utf8');

// Training CSV: one row per dish per meal. Columns used here contain no commas or quotes.
function trainingRows() {
  const [header, ...lines] = read('data/raw/messmind_training_data.csv').trim().split(/\r?\n/);
  const cols = header.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

// Dish(...) entries of the generator source, parsed literally.
function generatorDishes() {
  const src = read('src/generate_data.py');
  const re = /Dish\("([^"]+)", "([a-z_]+)", "([a-z]+)", ([0-9.]+), ([0-9.]+)(?:, core=(True|False))?(?:, portion_kg=([0-9.]+))?\)/g;
  return [...src.matchAll(re)].map((m) => ({
    mlDishName: m[1], category: m[2], mealType: m[3], basePopularity: Number(m[4]), baseRating: Number(m[5]),
    core: m[6] === 'True', portionKg: m[7] ? Number(m[7]) : 0.12,
  }));
}

describe('dish catalogue', () => {
  it('has 38 dishes with stable sequential IDs and unique ML names', () => {
    expect(DISHES).toHaveLength(38);
    expect(DISHES.map((d) => d.id)).toEqual(Array.from({ length: 38 }, (_, i) => `D${String(i + 1).padStart(3, '0')}`));
    expect(new Set(DISHES.map((d) => d.mlDishName)).size).toBe(38);
    expect(DISHES.every((d) => d.displayName === d.mlDishName)).toBe(true);
    expect(DISHES.every((d) => DISH_CATEGORIES.includes(d.category))).toBe(true);
  });

  it('has 40 dish/meal-type profiles; every meal type has core dishes', () => {
    expect(DISH_MEAL_PROFILES).toHaveLength(40);
    for (const mt of MEAL_TYPES) {
      expect(DISH_MEAL_PROFILES.some((p) => p.mealType === mt && p.core)).toBe(true);
    }
  });

  it('matches ml/src/generate_data.py exactly (names, categories, meal types, parameters, order)', () => {
    expect(DISH_MEAL_PROFILES.map((p) => ({ ...p }))).toEqual(generatorDishes());
  });

  it('matches the (dish, meal type) pairs and categories in the training CSV', () => {
    const rows = trainingRows();
    const csvPairs = new Set(rows.map((r) => `${r.dish_name}|${r.meal_type}|${r.dish_category}`));
    const ourPairs = new Set(DISH_MEAL_PROFILES.map((p) => `${p.mlDishName}|${p.mealType}|${p.category}`));
    expect(ourPairs).toEqual(csvPairs);
    expect(rows.every((r) => r.total_students === String(TOTAL_STUDENTS))).toBe(true);
  });

  it('uses only dish names and categories the frozen model knows (feature_schema.json)', () => {
    const features = new Set(JSON.parse(read('models/feature_schema.json')).feature_names);
    for (const d of DISHES) {
      expect(features.has(`dish_name_${d.mlDishName}`), d.mlDishName).toBe(true);
      expect(features.has(`dish_category_${d.category}`), d.category).toBe(true);
    }
    for (const mt of MEAL_TYPES) expect(features.has(`meal_type_${mt}`)).toBe(true);
  });

  it('formats student codes', () => {
    expect([studentCode(1), studentCode(42), studentCode(1000)]).toEqual(['S0001', 'S0042', 'S1000']);
  });
});
