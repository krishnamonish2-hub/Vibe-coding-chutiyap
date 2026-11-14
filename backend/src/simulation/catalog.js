// Synthetic dish catalogue for the MessMind simulation.
//
// Ported (read-only reference) from ml/src/generate_data.py, section "1. Fixed dish catalogue".
// The ML model was trained on exactly these dish names, categories and meal types, so they must not change:
// `mlDishName` is the exact training spelling sent to the ML service as `dish_name`.
// Simulator parameters (popularity, rating, core, portion) are used from Phase 4 onwards.
//
// Dish IDs are stable: D001… in order of first appearance in the generator's list. Display names start equal to
// the ML names and may be renamed by the admin later; IDs and ML names never change.

export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner']);

export const DISH_CATEGORIES = Object.freeze([
  'staple_rice', 'bread', 'dal', 'main_veg', 'main_nonveg', 'side', 'dessert', 'beverage', 'breakfast_item', 'fruit',
]);

// [mlDishName, category, mealType, basePopularity, baseRating, core, portionKg]
// Same order and values as DISHES in ml/src/generate_data.py (default portion 0.12 kg).
const SERVINGS = [
  // --- breakfast ---
  ['Tea', 'beverage', 'breakfast', 0.75, 3.8, true, 0.15],
  ['Coffee', 'beverage', 'breakfast', 0.35, 3.9, false, 0.15],
  ['Poha', 'breakfast_item', 'breakfast', 0.55, 3.6, false, 0.12],
  ['Upma', 'breakfast_item', 'breakfast', 0.40, 3.0, false, 0.12],
  ['Idli Sambar', 'breakfast_item', 'breakfast', 0.60, 3.9, false, 0.12],
  ['Aloo Paratha', 'breakfast_item', 'breakfast', 0.70, 4.3, false, 0.15],
  ['Masala Dosa', 'breakfast_item', 'breakfast', 0.72, 4.4, false, 0.12],
  ['Bread Omelette', 'breakfast_item', 'breakfast', 0.55, 4.0, false, 0.12],
  ['Boiled Eggs', 'side', 'breakfast', 0.35, 3.5, false, 0.10],
  ['Cornflakes and Milk', 'breakfast_item', 'breakfast', 0.30, 3.4, false, 0.20],
  ['Banana', 'fruit', 'breakfast', 0.40, 3.5, false, 0.10],
  // --- lunch ---
  ['Rice', 'staple_rice', 'lunch', 0.88, 3.7, true, 0.15],
  ['Chapati', 'bread', 'lunch', 0.80, 3.8, true, 0.09],
  ['Dal Tadka', 'dal', 'lunch', 0.70, 3.6, true, 0.12],
  ['Paneer Butter Masala', 'main_veg', 'lunch', 0.62, 4.5, false, 0.12],
  ['Rajma', 'main_veg', 'lunch', 0.58, 4.1, false, 0.12],
  ['Chole', 'main_veg', 'lunch', 0.55, 4.0, false, 0.12],
  ['Aloo Gobi', 'main_veg', 'lunch', 0.45, 3.3, false, 0.12],
  ['Mixed Veg', 'main_veg', 'lunch', 0.38, 3.0, false, 0.12],
  ['Bhindi Fry', 'main_veg', 'lunch', 0.40, 3.4, false, 0.12],
  ['Lauki Sabzi', 'main_veg', 'lunch', 0.22, 2.6, false, 0.12],
  ['Chicken Curry', 'main_nonveg', 'lunch', 0.48, 4.4, false, 0.12],
  ['Egg Curry', 'main_nonveg', 'lunch', 0.38, 3.8, false, 0.12],
  ['Curd', 'side', 'lunch', 0.50, 3.9, false, 0.10],
  ['Buttermilk', 'beverage', 'lunch', 0.45, 3.8, false, 0.20],
  ['Salad', 'side', 'lunch', 0.30, 3.2, false, 0.08],
  // --- dinner ---
  ['Rice', 'staple_rice', 'dinner', 0.80, 3.7, true, 0.15],
  ['Chapati', 'bread', 'dinner', 0.82, 3.8, true, 0.09],
  ['Dal Fry', 'dal', 'dinner', 0.65, 3.5, true, 0.12],
  ['Kadai Paneer', 'main_veg', 'dinner', 0.60, 4.4, false, 0.12],
  ['Palak Paneer', 'main_veg', 'dinner', 0.50, 3.9, false, 0.12],
  ['Aloo Matar', 'main_veg', 'dinner', 0.42, 3.3, false, 0.12],
  ['Soya Chunks', 'main_veg', 'dinner', 0.30, 3.0, false, 0.12],
  ['Kadhi', 'main_veg', 'dinner', 0.35, 3.2, false, 0.12],
  ['Veg Biryani', 'main_veg', 'dinner', 0.66, 4.3, false, 0.20],
  ['Chicken Biryani', 'main_nonveg', 'dinner', 0.58, 4.7, false, 0.22],
  ['Vegetable Soup', 'beverage', 'dinner', 0.30, 3.4, false, 0.20],
  ['Gulab Jamun', 'dessert', 'dinner', 0.70, 4.6, false, 0.08],
  ['Kheer', 'dessert', 'dinner', 0.60, 4.3, false, 0.10],
  ['Ice Cream', 'dessert', 'dinner', 0.75, 4.7, false, 0.08],
];

// Dishes containing meat or eggs. `is_veg` is required by the ML contract but not used by the model.
const NON_VEG = new Set(['Chicken Curry', 'Egg Curry', 'Chicken Biryani', 'Bread Omelette', 'Boiled Eggs']);

// One entry per (dish, meal type): simulator parameters.
export const DISH_MEAL_PROFILES = Object.freeze(SERVINGS.map(
  ([mlDishName, category, mealType, basePopularity, baseRating, core, portionKg]) =>
    Object.freeze({ mlDishName, category, mealType, basePopularity, baseRating, core, portionKg }),
));

// One entry per dish (stable identity), in order of first appearance.
export const DISHES = Object.freeze((() => {
  const byName = new Map();
  for (const p of DISH_MEAL_PROFILES) {
    const existing = byName.get(p.mlDishName);
    if (existing) {
      if (existing.category !== p.category || existing.portionKg !== p.portionKg) {
        throw new Error(`catalogue: ${p.mlDishName} differs between meal types`);
      }
      continue;
    }
    byName.set(p.mlDishName, {
      id: `D${String(byName.size + 1).padStart(3, '0')}`,
      mlDishName: p.mlDishName,
      displayName: p.mlDishName,
      category: p.category,
      isVeg: !NON_VEG.has(p.mlDishName),
      portionKg: p.portionKg,
    });
  }
  return [...byName.values()].map((d) => Object.freeze(d));
})());

// Generator constants used by the simulator in Phase 4 (same values as ml/src/generate_data.py).
export const BASE_ATTENDANCE = Object.freeze({ breakfast: 0.55, lunch: 0.80, dinner: 0.75 });
export const HOT_WEATHER_DISHES = Object.freeze(new Set(['Curd', 'Buttermilk', 'Ice Cream', 'Salad']));
export const RAINY_WEATHER_DISHES = Object.freeze(
  new Set(['Tea', 'Coffee', 'Vegetable Soup', 'Masala Dosa', 'Aloo Paratha']),
);

export const TOTAL_STUDENTS = 1000;

export function studentCode(n) {
  return `S${String(n).padStart(4, '0')}`;
}
