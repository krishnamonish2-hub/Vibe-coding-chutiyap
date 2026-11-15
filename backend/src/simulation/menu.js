// Menu choice — mirrors choose_menu() in ml/src/generate_data.py: all core dishes of the meal type plus random
// rotating dishes, 4–6 dishes in total; a festival dinner always gets Veg Biryani and Gulab Jamun and 6 dishes.

import { DISH_MEAL_PROFILES } from './catalog.js';

export function chooseMenu(mealType, isFestival, rng) {
  const options = DISH_MEAL_PROFILES.filter((p) => p.mealType === mealType);
  const core = options.filter((p) => p.core);
  const rotating = options.filter((p) => !p.core);

  let nDishes = rng.integers(4, 7); // 4, 5 or 6
  const menu = [...core];
  if (isFestival && mealType === 'dinner') {
    for (const name of ['Veg Biryani', 'Gulab Jamun']) menu.push(rotating.find((p) => p.mlDishName === name));
    nDishes = 6;
  }
  const remaining = rotating.filter((p) => !menu.includes(p));
  const nExtra = Math.max(0, nDishes - menu.length);
  menu.push(...rng.sample(remaining, nExtra));
  return menu;
}

export function profileFor(mlDishName, mealType) {
  const profile = DISH_MEAL_PROFILES.find((p) => p.mlDishName === mlDishName && p.mealType === mealType);
  if (!profile) throw new Error(`no simulator profile for ${mlDishName} at ${mealType}`);
  return profile;
}
