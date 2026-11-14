"""MessMind synthetic dataset generator (Phase 2).

Creates a SYNTHETIC dataset where each row is one dish served at one meal on one
date. Every row is marked data_source = "synthetic". Nothing here is real data.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe src\\generate_data.py
    .\\venv\\Scripts\\python.exe src\\generate_data.py --days 90 --students 1000 --seed 42

How the simulation works (big picture)
--------------------------------------
For every meal we first simulate HIDDEN "true" quantities:
    * how many students actually come to the mess (meal attendance)
    * how appealing each dish is today (popularity x rating x weather x noise)
From those hidden quantities we draw BOTH:
    * interested_taps       -> what students said in the app BEFORE the meal (feature)
    * actual_dish_consumers -> what really happened (TARGET)
Because both come from the same hidden state, taps are informative but imperfect
(not everyone responds, some tappers skip the meal, some non-tappers eat).

Post-meal facts (today's attendance, today's rating, today's leftovers) are used
only to build history for FUTURE rows and are never written as current-row
features.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ML_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ML_ROOT / "data" / "raw" / "messmind_training_data.csv"
DICTIONARY_PATH = ML_ROOT / "docs" / "data_dictionary.md"

MEAL_TYPES = ["breakfast", "lunch", "dinner"]
MEAL_ORDER = {m: i for i, m in enumerate(MEAL_TYPES)}
HISTORY_WINDOW = 5  # number of past servings averaged for historical features


# ---------------------------------------------------------------------------
# 1. Fixed dish catalogue
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Dish:
    name: str
    category: str
    meal_type: str
    base_popularity: float  # P(an attending student takes this dish) on a normal day
    base_rating: float      # typical rating out of 5
    core: bool = False      # served at every meal of this type (rice, chapati, tea...)
    portion_kg: float = 0.12


DISHES = [
    # --- breakfast ---
    Dish("Tea", "beverage", "breakfast", 0.75, 3.8, core=True, portion_kg=0.15),
    Dish("Coffee", "beverage", "breakfast", 0.35, 3.9, portion_kg=0.15),
    Dish("Poha", "breakfast_item", "breakfast", 0.55, 3.6),
    Dish("Upma", "breakfast_item", "breakfast", 0.40, 3.0),
    Dish("Idli Sambar", "breakfast_item", "breakfast", 0.60, 3.9),
    Dish("Aloo Paratha", "breakfast_item", "breakfast", 0.70, 4.3, portion_kg=0.15),
    Dish("Masala Dosa", "breakfast_item", "breakfast", 0.72, 4.4),
    Dish("Bread Omelette", "breakfast_item", "breakfast", 0.55, 4.0),
    Dish("Boiled Eggs", "side", "breakfast", 0.35, 3.5, portion_kg=0.10),
    Dish("Cornflakes and Milk", "breakfast_item", "breakfast", 0.30, 3.4, portion_kg=0.20),
    Dish("Banana", "fruit", "breakfast", 0.40, 3.5, portion_kg=0.10),
    # --- lunch ---
    Dish("Rice", "staple_rice", "lunch", 0.88, 3.7, core=True, portion_kg=0.15),
    Dish("Chapati", "bread", "lunch", 0.80, 3.8, core=True, portion_kg=0.09),
    Dish("Dal Tadka", "dal", "lunch", 0.70, 3.6, core=True),
    Dish("Paneer Butter Masala", "main_veg", "lunch", 0.62, 4.5),
    Dish("Rajma", "main_veg", "lunch", 0.58, 4.1),
    Dish("Chole", "main_veg", "lunch", 0.55, 4.0),
    Dish("Aloo Gobi", "main_veg", "lunch", 0.45, 3.3),
    Dish("Mixed Veg", "main_veg", "lunch", 0.38, 3.0),
    Dish("Bhindi Fry", "main_veg", "lunch", 0.40, 3.4),
    Dish("Lauki Sabzi", "main_veg", "lunch", 0.22, 2.6),
    Dish("Chicken Curry", "main_nonveg", "lunch", 0.48, 4.4),
    Dish("Egg Curry", "main_nonveg", "lunch", 0.38, 3.8),
    Dish("Curd", "side", "lunch", 0.50, 3.9, portion_kg=0.10),
    Dish("Buttermilk", "beverage", "lunch", 0.45, 3.8, portion_kg=0.20),
    Dish("Salad", "side", "lunch", 0.30, 3.2, portion_kg=0.08),
    # --- dinner ---
    Dish("Rice", "staple_rice", "dinner", 0.80, 3.7, core=True, portion_kg=0.15),
    Dish("Chapati", "bread", "dinner", 0.82, 3.8, core=True, portion_kg=0.09),
    Dish("Dal Fry", "dal", "dinner", 0.65, 3.5, core=True),
    Dish("Kadai Paneer", "main_veg", "dinner", 0.60, 4.4),
    Dish("Palak Paneer", "main_veg", "dinner", 0.50, 3.9),
    Dish("Aloo Matar", "main_veg", "dinner", 0.42, 3.3),
    Dish("Soya Chunks", "main_veg", "dinner", 0.30, 3.0),
    Dish("Kadhi", "main_veg", "dinner", 0.35, 3.2),
    Dish("Veg Biryani", "main_veg", "dinner", 0.66, 4.3, portion_kg=0.20),
    Dish("Chicken Biryani", "main_nonveg", "dinner", 0.58, 4.7, portion_kg=0.22),
    Dish("Vegetable Soup", "beverage", "dinner", 0.30, 3.4, portion_kg=0.20),
    Dish("Gulab Jamun", "dessert", "dinner", 0.70, 4.6, portion_kg=0.08),
    Dish("Kheer", "dessert", "dinner", 0.60, 4.3, portion_kg=0.10),
    Dish("Ice Cream", "dessert", "dinner", 0.75, 4.7, portion_kg=0.08),
]

# Baseline share of students who attend each meal on a normal weekday.
BASE_ATTENDANCE = {"breakfast": 0.55, "lunch": 0.80, "dinner": 0.75}
HOT_WEATHER_DISHES = {"Curd", "Buttermilk", "Ice Cream", "Salad"}
RAINY_WEATHER_DISHES = {"Tea", "Coffee", "Vegetable Soup", "Masala Dosa", "Aloo Paratha"}


# ---------------------------------------------------------------------------
# 2. Calendar and weather (one row per day)
# ---------------------------------------------------------------------------
def build_calendar(start: pd.Timestamp, n_days: int, burn_in_days: int,
                   rng: np.random.Generator) -> pd.DataFrame:
    """Daily calendar with holidays, exam days, festivals and weather.

    The first `burn_in_days` days are a warm-up period: they exist only so that
    historical features of the real window have past data. They are dropped later.
    """
    first_day = start - pd.Timedelta(days=burn_in_days)
    dates = pd.date_range(first_day, periods=burn_in_days + n_days, freq="D")
    cal = pd.DataFrame({"date": dates})
    cal["day_of_week"] = cal["date"].dt.day_of_week         # 0 = Monday
    cal["is_weekend"] = cal["day_of_week"] >= 5

    n_total = len(cal)
    window = np.arange(burn_in_days, n_total)              # indices of the real window

    # Holidays: ~4 random weekdays (students leave campus -> lower attendance)
    weekday_idx = cal.index[(~cal["is_weekend"]) & (cal.index >= burn_in_days)]
    holiday_idx = rng.choice(weekday_idx, size=min(4, len(weekday_idx)), replace=False)
    cal["is_holiday"] = cal.index.isin(holiday_idx)

    # Exam days: one block of 8 consecutive days in the second half of the window
    exam_start = int(rng.integers(burn_in_days + n_days // 2,
                                  max(burn_in_days + n_days // 2 + 1, n_total - 8)))
    exam_idx = np.arange(exam_start, min(exam_start + 8, n_total))
    cal["is_exam_day"] = cal.index.isin(exam_idx) & ~cal["is_holiday"]

    # Festivals: 3 days (special dinner, more students stay to celebrate)
    non_exam = [i for i in window if i not in set(exam_idx) and i not in set(holiday_idx)]
    festival_idx = rng.choice(non_exam, size=min(3, len(non_exam)), replace=False)
    cal["is_festival"] = cal.index.isin(festival_idx)

    # Weather: monsoon-like. Rainy days are a bit cooler.
    rainy = rng.random(n_total) < 0.40
    rainfall = np.where(rainy, rng.gamma(shape=1.5, scale=8.0, size=n_total), 0.0)
    seasonal = 31.0 - 2.0 * np.sin(np.linspace(0, np.pi, n_total))  # slow drift
    temperature = seasonal - 0.08 * rainfall + rng.normal(0, 1.2, n_total)
    cal["rainfall"] = np.round(rainfall, 1)
    cal["temperature"] = np.round(temperature, 1)
    return cal


# ---------------------------------------------------------------------------
# 3. Menus
# ---------------------------------------------------------------------------
def choose_menu(meal_type: str, is_festival: bool, rng: np.random.Generator) -> list[Dish]:
    """Pick 4-6 dishes: all core dishes + random rotating dishes."""
    options = [d for d in DISHES if d.meal_type == meal_type]
    core = [d for d in options if d.core]
    rotating = [d for d in options if not d.core]

    n_dishes = int(rng.integers(4, 7))  # 4, 5 or 6
    menu = list(core)

    if is_festival and meal_type == "dinner":
        # Festival dinner always gets a biryani and a dessert.
        for name in ("Veg Biryani", "Gulab Jamun"):
            menu.append(next(d for d in rotating if d.name == name))
        n_dishes = 6

    remaining = [d for d in rotating if d not in menu]
    n_extra = max(0, n_dishes - len(menu))
    picks = rng.choice(len(remaining), size=n_extra, replace=False)
    menu.extend(remaining[i] for i in picks)
    return menu


# ---------------------------------------------------------------------------
# 4. Hidden "true" behaviour for one meal
# ---------------------------------------------------------------------------
def attendance_probability(meal_type: str, day: pd.Series, rng: np.random.Generator) -> float:
    p = BASE_ATTENDANCE[meal_type]
    if day["is_weekend"]:
        p -= {"breakfast": 0.15, "lunch": 0.08, "dinner": 0.05}[meal_type]
    if day["is_holiday"]:
        p -= 0.22
    if day["is_exam_day"]:
        p += 0.06 if meal_type != "breakfast" else 0.10
    if day["is_festival"] and meal_type == "dinner":
        p += 0.10
    if day["rainfall"] > 5:
        p += 0.05          # students avoid going out in the rain
    if day["temperature"] > 33 and meal_type == "lunch":
        p -= 0.03
    p += rng.normal(0, 0.03)  # unexplained day-to-day variation
    return float(np.clip(p, 0.05, 0.97))


def dish_probability(dish: Dish, rating: float, day: pd.Series, menu_size: int,
                     days_since_served: float, appeal_noise: float) -> float:
    """P(an attending student takes this dish)."""
    p = dish.base_popularity * (1 + 0.15 * (rating - 3.8))
    if not dish.core:
        p *= 1 - 0.04 * (menu_size - 4)   # more choice -> each extra dish loses a bit
    if days_since_served <= 2 and not dish.core:
        p *= 0.90                          # menu fatigue
    if day["temperature"] > 32 and dish.name in HOT_WEATHER_DISHES:
        p *= 1.15
    if day["rainfall"] > 5 and dish.name in RAINY_WEATHER_DISHES:
        p *= 1.12
    if day["is_festival"] and dish.category == "dessert":
        p *= 1.15
    p *= appeal_noise
    return float(np.clip(p, 0.02, 0.97))


def tap_bias(dish: Dish) -> float:
    """Students don't bother tapping staples; they over-tap treats."""
    if dish.core:
        return 0.75
    if dish.category in {"dessert"} or dish.name.endswith("Biryani"):
        return 1.15
    return 1.0


# ---------------------------------------------------------------------------
# 5. Simulation loop
# ---------------------------------------------------------------------------
def simulate(cal: pd.DataFrame, n_students: int, rng: np.random.Generator) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (dish_rows, meal_rows) including hidden post-meal columns."""
    dish_rows, meal_rows = [], []
    last_served: dict[tuple[str, str], int] = {}

    for day_idx, day in cal.iterrows():
        for meal_type in MEAL_TYPES:
            menu = choose_menu(meal_type, bool(day["is_festival"]), rng)

            # --- hidden meal attendance ---
            p_att = attendance_probability(meal_type, day, rng)
            attendance = int(rng.binomial(n_students, p_att))

            # --- app responses (BEFORE the meal) ---
            r = 0.45 - 0.10 * day["is_exam_day"] - 0.08 * day["is_weekend"]
            r -= 0.05 * (meal_type == "breakfast")
            r = float(np.clip(r + rng.normal(0, 0.04), 0.10, 0.90))
            total_responses = int(rng.binomial(n_students, r))
            p_att_responder = min(0.98, p_att + 0.08)  # responders are more engaged

            meal_rows.append({"date": day["date"], "meal_type": meal_type,
                              "meal_attendance": attendance})

            for dish in menu:
                key = (dish.name, meal_type)
                days_since = day_idx - last_served[key] if key in last_served else 99
                last_served[key] = day_idx

                appeal_noise = float(rng.lognormal(0, 0.08))  # shared by taps and actuals
                # Students tap based on the menu (typical rating) ...
                p_tap_dish = dish_probability(dish, dish.base_rating, day, len(menu),
                                              days_since, appeal_noise)
                # ... but actually eat based on how good the food is today.
                todays_rating = float(np.clip(dish.base_rating + rng.normal(0, 0.3), 1, 5))
                p_eat_dish = dish_probability(dish, todays_rating, day, len(menu),
                                              days_since, appeal_noise)

                p_tap = min(0.98, p_att_responder * p_tap_dish * tap_bias(dish))
                interested_taps = int(rng.binomial(total_responses, p_tap))
                actual = int(rng.binomial(attendance, p_eat_dish))

                # Kitchen plans with a simple static rule (+ random over-cooking)
                planned = n_students * BASE_ATTENDANCE[meal_type] * dish.base_popularity
                prepared = planned * rng.uniform(1.00, 1.35)
                leftover_kg = max(0.0, prepared - actual) * dish.portion_kg

                dish_rows.append({
                    "date": day["date"],
                    "meal_type": meal_type,
                    "dish_name": dish.name,
                    "dish_category": dish.category,
                    "day_of_week": int(day["day_of_week"]),
                    "is_weekend": bool(day["is_weekend"]),
                    "is_holiday": bool(day["is_holiday"]),
                    "is_exam_day": bool(day["is_exam_day"]),
                    "is_festival": bool(day["is_festival"]),
                    "temperature": float(day["temperature"]),
                    "rainfall": float(day["rainfall"]),
                    "total_students": n_students,
                    "interested_taps": interested_taps,
                    "total_responses": total_responses,
                    "actual_dish_consumers": actual,
                    # hidden post-meal values (used only for FUTURE history)
                    "_post_meal_rating": round(float(np.clip(todays_rating + rng.normal(0, 0.15), 1, 5)), 2),
                    "_leftover_kg": round(leftover_kg, 1),
                })

    return pd.DataFrame(dish_rows), pd.DataFrame(meal_rows)


# ---------------------------------------------------------------------------
# 6. Leakage-safe historical features
# ---------------------------------------------------------------------------
def add_historical_features(df: pd.DataFrame, meals: pd.DataFrame) -> pd.DataFrame:
    """Add history features using ONLY records from earlier meals.

    Key idea: sort by time, group by dish, then .shift(1) BEFORE averaging.
    shift(1) moves every value down one row inside its group, so the row for
    meal t only ever sees values from meals t-1, t-2, ... never meal t itself.
    """
    df = df.copy()
    df["_meal_order"] = df["meal_type"].map(MEAL_ORDER)
    df = df.sort_values(["date", "_meal_order", "dish_name"]).reset_index(drop=True)

    # previous_meal_attendance: attendance of the meal immediately before this one
    meals = meals.copy()
    meals["_meal_order"] = meals["meal_type"].map(MEAL_ORDER)
    meals = meals.sort_values(["date", "_meal_order"]).reset_index(drop=True)
    meals["previous_meal_attendance"] = meals["meal_attendance"].shift(1)
    df = df.merge(meals[["date", "meal_type", "previous_meal_attendance"]],
                  on=["date", "meal_type"], how="left")

    def past_mean(series: pd.Series) -> pd.Series:
        return series.shift(1).rolling(HISTORY_WINDOW, min_periods=1).mean()

    # Demand / leftovers are specific to dish AND meal (rice at lunch != rice at dinner).
    by_dish_meal = df.groupby(["dish_name", "meal_type"], sort=False)
    df["historical_dish_demand"] = by_dish_meal["actual_dish_consumers"].transform(past_mean).round(1)
    df["previous_leftover_kg"] = by_dish_meal["_leftover_kg"].transform(lambda s: s.shift(1))

    # Rating is a property of the dish, wherever it is served.
    df["historical_dish_rating"] = (
        df.groupby("dish_name", sort=False)["_post_meal_rating"].transform(past_mean).round(2)
    )
    return df


# ---------------------------------------------------------------------------
# 7. Data dictionary
# ---------------------------------------------------------------------------
COLUMNS = [
    # (name, dtype, known_before_meal, role, description)
    ("date", "date", "yes", "id / split key", "Calendar date of the meal (YYYY-MM-DD). Used for chronological splitting."),
    ("meal_type", "category", "yes", "feature", "breakfast, lunch or dinner."),
    ("dish_name", "category", "yes", "feature / id", "Dish served. Comes from a fixed catalogue so dishes repeat."),
    ("dish_category", "category", "yes", "feature", "Dish group (staple_rice, bread, dal, main_veg, main_nonveg, side, dessert, beverage, breakfast_item, fruit). Helps generalise to new dishes."),
    ("day_of_week", "int 0-6", "yes", "feature", "0 = Monday ... 6 = Sunday."),
    ("is_weekend", "bool", "yes", "feature", "Saturday or Sunday."),
    ("is_holiday", "bool", "yes", "feature", "Institute holiday (many students leave campus)."),
    ("is_exam_day", "bool", "yes", "feature", "Day inside the exam block."),
    ("is_festival", "bool", "yes", "feature", "Festival day (special dinner)."),
    ("temperature", "float (deg C)", "yes (forecast)", "feature", "Daily temperature."),
    ("rainfall", "float (mm)", "yes (forecast)", "feature", "Daily rainfall; 0 on dry days."),
    ("total_students", "int", "yes", "feature", "Students registered with the mess."),
    ("previous_meal_attendance", "float", "yes", "history feature", "Headcount of the meal immediately before this one. NaN only for the very first meal."),
    ("historical_dish_demand", "float", "yes", "history feature", f"Mean actual_dish_consumers over the last {HISTORY_WINDOW} PREVIOUS servings of this dish at this meal type. NaN if never served before."),
    ("historical_dish_rating", "float 1-5", "yes", "history feature", f"Mean post-meal rating over the last {HISTORY_WINDOW} PREVIOUS servings of this dish. NaN if never served before."),
    ("interested_taps", "int", "yes", "feature", "Students who tapped 'interested' for this dish in the app before the meal. NOT the target."),
    ("total_responses", "int", "yes", "feature", "Students who responded in the app for this meal (same value for every dish in the meal). interested_taps <= total_responses."),
    ("previous_leftover_kg", "float (kg)", "yes", "history feature", "Leftover of this dish at its PREVIOUS serving at this meal type. NaN if never served before."),
    ("actual_dish_consumers", "int", "NO (after meal)", "TARGET", "Students who actually took this dish. 0 <= value <= total_students. Dishes overlap: one student can eat many dishes."),
    ("data_source", "string", "-", "metadata", "Always 'synthetic' for generated data."),
]
OUTPUT_COLUMNS = [c[0] for c in COLUMNS]


def write_data_dictionary(path: Path, args: argparse.Namespace) -> None:
    lines = [
        "# MessMind Training Data — Data Dictionary",
        "",
        "> Auto-generated by `src/generate_data.py`. **All rows are SYNTHETIC** "
        "(`data_source = \"synthetic\"`). Metrics computed on this data say nothing "
        "about real-world accuracy.",
        "",
        f"Generated with: `--days {args.days} --students {args.students} --seed {args.seed} "
        f"--start-date {args.start_date} --burn-in-days {args.burn_in_days}`",
        "",
        "**One row = one dish served at one meal on one date.**",
        "",
        "| Column | Type | Known before meal? | Role | Description |",
        "|---|---|---|---|---|",
    ]
    lines += [f"| `{n}` | {t} | {k} | {r} | {d} |" for n, t, k, r, d in COLUMNS]
    lines += [
        "",
        "## Never use as features",
        "",
        "- `actual_dish_consumers` of the current row (it is the target).",
        "- Current-meal leftovers, rating or attendance (not stored; they happen after the meal).",
        "",
        "## How history columns avoid leakage",
        "",
        "Rows are sorted by (date, meal order) and grouped by dish. Values are shifted by one "
        "serving (`shift(1)`) **before** the rolling mean, so each row only sees earlier meals. "
        f"A {args.burn_in_days}-day warm-up period is simulated before the window and then dropped, "
        "so early rows have real past history instead of being empty.",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# 8. Validation
# ---------------------------------------------------------------------------
def validate(df: pd.DataFrame) -> list[str]:
    """Return a list of rule violations (empty list = all good)."""
    problems = []
    if list(df.columns) != OUTPUT_COLUMNS:
        problems.append("columns do not match the data dictionary")
    if df.duplicated(["date", "meal_type", "dish_name"]).any():
        problems.append("duplicate (date, meal_type, dish_name) rows")
    if not df["actual_dish_consumers"].between(0, df["total_students"]).all():
        problems.append("actual_dish_consumers outside [0, total_students]")
    if (df["interested_taps"] > df["total_responses"]).any():
        problems.append("interested_taps > total_responses")
    if (df["total_responses"] > df["total_students"]).any():
        problems.append("total_responses > total_students")
    if (df["interested_taps"] < 0).any():
        problems.append("negative interested_taps")
    if not df["previous_meal_attendance"].dropna().between(0, df["total_students"].max()).all():
        problems.append("previous_meal_attendance out of range")
    if not df["historical_dish_rating"].dropna().between(1, 5).all():
        problems.append("historical_dish_rating outside [1, 5]")
    if (df["previous_leftover_kg"].dropna() < 0).any():
        problems.append("negative previous_leftover_kg")
    if (df["rainfall"] < 0).any():
        problems.append("negative rainfall")
    per_meal = df.groupby(["date", "meal_type"]).size()
    if not per_meal.between(4, 6).all():
        problems.append("a meal has fewer than 4 or more than 6 dishes")
    if (df["data_source"] != "synthetic").any():
        problems.append("data_source must be 'synthetic'")
    # Same total_responses for every dish in a meal
    if (df.groupby(["date", "meal_type"])["total_responses"].nunique() > 1).any():
        problems.append("total_responses differs within a meal")
    return problems


# ---------------------------------------------------------------------------
# 9. Main
# ---------------------------------------------------------------------------
def generate(args: argparse.Namespace) -> pd.DataFrame:
    rng = np.random.default_rng(args.seed)
    start = pd.Timestamp(args.start_date)
    cal = build_calendar(start, args.days, args.burn_in_days, rng)
    dish_df, meal_df = simulate(cal, args.students, rng)
    df = add_historical_features(dish_df, meal_df)

    # Drop the warm-up period AFTER computing history (so history is available).
    df = df[df["date"] >= start].copy()
    df["data_source"] = "synthetic"
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    df = df[OUTPUT_COLUMNS].reset_index(drop=True)  # hidden columns are dropped here
    return df


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate SYNTHETIC MessMind dish-wise data.")
    parser.add_argument("--days", type=int, default=90, help="days in the dataset (default 90)")
    parser.add_argument("--students", type=int, default=1000, help="students in the mess (default 1000)")
    parser.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    parser.add_argument("--start-date", default="2026-07-01", help="first date YYYY-MM-DD")
    parser.add_argument("--burn-in-days", type=int, default=21,
                        help="warm-up days simulated for history then dropped (default 21)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="output CSV path")
    args = parser.parse_args()
    if args.days < 1 or args.students < 1 or args.burn_in_days < 0:
        parser.error("--days and --students must be >= 1, --burn-in-days >= 0")
    return args


def main() -> None:
    args = parse_args()
    df = generate(args)

    problems = validate(df)
    if problems:
        raise SystemExit("VALIDATION FAILED:\n  - " + "\n  - ".join(problems))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.output, index=False)
    write_data_dictionary(DICTIONARY_PATH, args)

    print(f"SYNTHETIC dataset written: {args.output}")
    print(f"Data dictionary written:   {DICTIONARY_PATH}")
    print(f"Rows: {len(df)}  Columns: {df.shape[1]}  Validation: passed")


if __name__ == "__main__":
    main()
