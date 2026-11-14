# MessMind — Preprocessing & Feature Engineering Report (Phase 4)

> **All data is SYNTHETIC.** Source: `data/raw/messmind_training_data.csv` (1,337 rows, MD5
> `0a8d9df2a9491ef15e86d93a71c3bf3c`, unchanged by this phase).
> Code: `src/preprocessing.py`. Run from `ml/`: `.\venv\Scripts\python.exe -m src.preprocessing`
> Based on the findings in `docs/eda_report.md`.

## 1. Outputs

| File | Content |
|---|---|
| `data/processed/train.csv`, `val.csv`, `test.csv` | 7 `meta__` columns (for reporting only) + 69 model features + target (last column) |
| `models/preprocessor.joblib` | Fitted scikit-learn `Pipeline` (engineer → impute/encode). Reused by training and the API |
| `models/feature_schema.json` | Required input columns, exact feature order, target, exclusions, split info, library versions |

`meta__` columns (date, meal_type, dish_name, dish_category, is_exam_day, interested_taps, raw
historical_dish_demand) are **not features**. They exist so Phase 5 can compute the baseline and report
error by meal type, dish and exam day. Training code must select columns from
`feature_schema.json["feature_names"]`, never "all columns".

## 2. Chronological split (whole days, no shuffling)

| Split | Rows | Days | Date range | Exam days | New-dish rows |
|---|---|---|---|---|---|
| Train | 940 | 63 | 2026-07-01 → 2026-09-01 | 0 | 1 |
| Validation | 182 | 13 | 2026-09-02 → 2026-09-14 | 6 | 0 |
| Test | 215 | 14 | 2026-09-15 → 2026-09-28 | 2 | 0 |
| **Total** | **1,337** | 90 | | 8 | 1 |

Days are split 63 / 13 / 14, i.e. `round(0.70 × 90)` and `round(0.85 × 90)`. Splitting by whole days keeps
all dishes of a meal together. Every dish–meal pair in validation and test also appears in training.
**Decision (a)** from the EDA: training has no exam days. Phase 5 reports exam-day error separately.

## 3. Features (69 after encoding)

### Included

| Group | Columns | Why |
|---|---|---|
| History (3) | `historical_dish_demand`, `historical_dish_rating`, `previous_leftover_kg` | Strongest signal (r = 0.91 for demand). Verified past-only in Phase 3 and again here |
| Pre-meal app signal (2) | `interested_taps`, `total_responses` | Known at the prediction cut-off (see §6). r = 0.84 for taps |
| Calendar / weather (7) | `day_of_week`, `is_weekend`, `is_holiday`, `is_exam_day`, `is_festival`, `temperature`, `rainfall` | Large calendar effects found in the EDA. Weather is forecast-available |
| Context (1) | `previous_meal_attendance` | Weak overall but positive within each meal type (0.10–0.24) |
| **Engineered (5)** | `tap_share` = taps ÷ responses | Normalised interest (EDA: r rises from 0.84 to 0.89) |
| | `response_rate` = responses ÷ total_students | How representative the taps are |
| | `projected_interest` = taps × students ÷ responses | Taps scaled up as if everyone had answered (actual ≈ 2.6× taps) |
| | `num_dishes_in_meal` | Menu size; more choice means a smaller share per dish |
| | `is_new_dish` | 1 when the dish has no history, so the model knows the history was filled in |
| Categorical (3 → 51 one-hot) | `meal_type` (3), `dish_category` (10), `dish_name` (38) | Meal type and dish identity are the main demand drivers |

### Excluded (nothing is dropped silently)

| Column | Reason |
|---|---|
| `actual_dish_consumers` | **Target** — kept separately as y |
| `data_source` | Metadata, always "synthetic" |
| `date` (raw) | Identifier / split key. Its useful parts are already separate columns |
| `total_students` (raw) | Constant 1000, so no information. Used only inside `response_rate` and `projected_interest` |
| `month` (not derived) | Training is July–August (+1 September day) and test is all September, so the model would extrapolate |
| `dish_times_served_before` (not derived) | Can't be computed correctly: servings before the CSV window are missing |

No **rows** are dropped. All 1,337 rows are in exactly one split.

## 4. Missing values

**What is missing:** one training row, Aloo Matar · dinner · 2026-07-05, the first-ever serving of that
dish. All three history columns are missing **together**; every other column is present.

**Strategy (fitted on training only):** `GroupMedianImputer` fills each missing history value with the
training median of the most specific group available. It tries **(dish_category, meal_type)** first, then
**meal_type**, then the overall median. For this row (main_veg, dinner) that gives demand 340.4,
rating 3.91 and leftover 12.1 kg, against real later values of about 250–300 for Aloo Matar.

* This is an **estimate, not invented history**: it says "a typical main_veg dinner dish". `is_new_dish = 1`
  marks the row so the model can treat it differently.
* The row's own target (299) is never used to fill it.

**Other columns:** numeric → training median; booleans → most frequent training value; categoricals →
the constant "unknown". None of these are triggered in the current data (0 missing), but they protect the
API when optional fields (`previous_meal_attendance`, `temperature`, `rainfall`, leftover) are missing.

## 5. Encoding & scaling

* **One-hot encoding** of `meal_type`, `dish_category`, `dish_name` with `handle_unknown="ignore"`. An
  unseen dish gets all-zero `dish_name_*` columns but keeps its `dish_category_*` column, so
  it **falls back to its category** (tested with a fake "Mystery Dish").
* **No scaling.** Random Forest and XGBoost split on thresholds and are unaffected by feature scale. If a
  linear model is added later, a scaler must be added to the pipeline and fitted on training only.
* **No outlier removal.** The EDA showed outliers are valid values (rainy days, real leftovers, real ratings).

## 6. Prediction-time assumption (`interested_taps`, `total_responses`)

A prediction is made at a **fixed cut-off before the meal** (for example when app voting closes). At that
moment the menu is known, and `interested_taps` and `total_responses` are the final counts for that
meal. The training rows must contain the counts frozen at the **same cut-off**. If students can still
tap after the cut-off, those later taps must not appear in training data. → This needs to be agreed with
the backend developer (when `/predict` is called; contract open question 5).

## 7. Leakage prevention — validation results (all 22 checks PASS)

| Check | Result |
|---|---|
| Target not among features | PASS |
| No current-meal post-meal columns (consumer / leftover / rating / attendance unless `previous_`/`historical_`) | PASS |
| `date`, `data_source`, `total_students` absent from features | PASS |
| `historical_dish_demand` recomputed past-only | PASS (1,137 / 1,137 rows match) |
| History imputer medians equal medians of **training rows** | PASS (fitting on all data gives different values, so the check can detect misuse) |
| Numeric imputer medians equal training medians | PASS |
| Encoder categories equal training categories | PASS |
| Target within [0, total_students] — train / val / test | PASS ×3 |
| No missing values after transform — train / val / test | PASS ×3 (0 NaN) |
| Identical feature columns & order — train / val / test | PASS ×3 |
| train < val < test, no shared dates | PASS |
| No rows lost or duplicated | PASS (940 + 182 + 215 = 1,337) |
| Each split in time order | PASS |
| Unseen dish + missing optional inputs transform safely | PASS |
| Raw CSV unchanged | PASS (same MD5) |
| Saved pipeline loadable by other programs (not pickled as `__main__`) | PASS |

Other safeguards: all engineered features are **stateless** (row-wise or within the same meal, using
pre-meal information only), so they cannot carry information across splits. The **only** `fit` call
uses the training split. `remainder="drop"` guarantees unlisted columns never reach the model.

## 8. Final feature schema (order matters — the same in all splits and in the API)

```
 1 historical_dish_demand      2 historical_dish_rating      3 previous_leftover_kg
 4 day_of_week                 5 temperature                 6 rainfall
 7 previous_meal_attendance    8 interested_taps             9 total_responses
10 tap_share                  11 response_rate              12 projected_interest
13 num_dishes_in_meal         14 is_weekend                 15 is_holiday
16 is_exam_day                17 is_festival                18 is_new_dish
19-21 meal_type_{breakfast,dinner,lunch}
22-31 dish_category_{beverage,bread,breakfast_item,dal,dessert,fruit,main_nonveg,main_veg,side,staple_rice}
32-69 dish_name_{38 dishes, alphabetical}
```
The authoritative list is `models/feature_schema.json["feature_names"]`.
**Target:** `actual_dish_consumers` (integer, 0 ≤ y ≤ total_students).

## 9. Limitations & assumptions affecting model training

1. **`is_exam_day` is always 0 in training**, so the model cannot learn the exam effect (decision (a)).
   Expect larger errors on the 6 validation and 2 test exam days; report them separately.
2. **`is_new_dish` has only 1 positive training row**, so the model can barely learn from it. With real
   data (many new dishes) it becomes more important.
3. **Only 940 training rows and 69 features**, with rare dishes at 9–13 servings. Some `dish_name_*` columns have
   few examples, so we should watch for overfitting and compare against the baseline.
4. `previous_meal_attendance`, `previous_leftover_kg` and `historical_dish_rating` depend on the backend
   recording headcount, leftovers and ratings (contract open question 6). If it doesn't, the API will pass
   them as missing and the imputer fills training medians. Phase 5 should test whether the model still works without them.
5. History columns for real data must be computed with the same past-only rules (mean of the last 5
   servings, `shift(1)`), and the API needs a source for them. That's a Phase 6 design point.
6. Everything is fitted on synthetic data. Model scores will show how well the simulator's rules can be
   learned, not real-world accuracy.
