# MessMind — Random Forest Report (Phase 5)

> **All data is SYNTHETIC.** These metrics show how well the model recovers the rules built into
> `src/generate_data.py`. They are **not** an estimate of real-mess accuracy.
> Code: `src/train_random_forest.py` + shared helpers in `src/evaluation.py`.
> Run from `ml/`: `.\venv\Scripts\python.exe -m src.train_random_forest` (≈ 85 s; results reproduce exactly).
> **The test set was not loaded.** The loader refuses `test.csv`.

## 1. Setup

| Item | Value |
|---|---|
| Target | `actual_dish_consumers` |
| Features | 69, read from `models/feature_schema.json` in the saved order (checked) |
| Training data | `data/processed/train.csv`: 940 rows, 2026-07-01 → 2026-09-01 (63 days, 0 exam days) |
| Validation data | `data/processed/val.csv`: 182 rows, 2026-09-02 → 2026-09-14 (13 days, 6 exam days = 85 rows) |
| Input checks (8) | All PASS: target name, schema order, no NaN, no target/ID/post-meal feature, train ends before val |

## 2. Baseline

**Prediction = `historical_dish_demand`**, the mean actual consumers of the same dish at the same meal type over
its **last 5 past servings**. Phase 3 showed it is the strongest single predictor (r = 0.91), and Phases 3–4
verified it is past-only. The raw value is used. If it is missing (a new dish, none in validation), the
train-fitted imputed value is used. The baseline never sees current or future consumption.

## 3. Model & tuning

`RandomForestRegressor(random_state=42)`. A grid of **48 combinations** is **fitted on training data** and
**ranked by validation MAE** (ties go to the simpler model):

| Hyperparameter | Values tried | **Selected** |
|---|---|---|
| `n_estimators` | 200, 500 | **500** |
| `max_depth` | None, 12 | **12** |
| `min_samples_split` | 2, 10 | **2** |
| `min_samples_leaf` | 1, 3 | **1** |
| `max_features` | 1.0, 0.5, "sqrt" | **1.0** (all features at each split) |

The grid is kept small because validation is only 182 rows (13 days). Testing many more settings would
start to fit the noise in the validation set. The top four settings are within 0.2 MAE of each other
(31.08–31.26), so the choice between them is **within noise**. The 200-tree version scores 31.13 and would be
about 2.5× smaller than the saved 34 MB file. Full table: `models/random_forest_tuning.csv`.

## 4. Metrics (what they mean)

* **MAE**, mean absolute error: on average, how many consumers the prediction is off by. Easy to read in kitchen terms.
* **RMSE**, root mean squared error: like MAE, but large misses count much more. RMSE ≫ MAE means occasional big misses.
* **R²**: share of the variation in demand that the model explains (1 = perfect, 0 = no better than always predicting the mean).
* **Bias**: mean of (predicted − actual). Negative = under-predicts on average.
* MAPE is not used, because demand can be 0 and percentage errors become undefined or unstable.

## 5. Validation results (same 182 rows for both)

| Model | MAE | RMSE | R² | Bias |
|---|---|---|---|---|
| Baseline (historical demand) | 61.66 | 83.78 | 0.808 | −17.24 |
| **Random Forest** | **31.08** | **41.79** | **0.952** | −10.65 |

**Random Forest beats the baseline on every metric.** It roughly halves MAE (−50%) and RMSE (−50%),
and raises R² from 0.81 to 0.95. In kitchen terms, a typical dish forecast is off by about 31 plates instead of
about 62.

**Overfitting check (training data):** RF train MAE 11.8 against validation 31.1. The model fits training
rows much more closely than new days. That gap is typical for Random Forests, and validation performance is
still far better than the baseline, but it is a reason to keep the training set growing.

### By meal type (validation; all groups ≥ 58 rows)

| Meal | n | Baseline MAE | RF MAE | RF R² | RF bias |
|---|---|---|---|---|---|
| Breakfast | 58 | 61.6 | **28.0** | 0.93 | −17.9 |
| Lunch | 62 | 66.4 | **34.6** | 0.95 | −9.4 |
| Dinner | 62 | 57.0 | **30.4** | 0.93 | −5.2 |

### By exam day (decision (a): training had **no** exam days)

| Days | n | Baseline MAE | RF MAE | RF bias |
|---|---|---|---|---|
| Non-exam | 97 | 53.1 | **27.0** | −0.8 |
| Exam | 85 | 71.4 | **35.7** | **−21.9** |

On exam days the model **under-predicts by about 22 consumers on average**, because it never saw the exam
effect (+7 to +14% demand). On non-exam days it is almost unbiased. Most of the overall negative bias
(−10.7) comes from exam days. This is the expected cost of decision (a).

### If the backend cannot send optional inputs

With `previous_meal_attendance`, `previous_leftover_kg` and `historical_dish_rating` replaced by training
medians, as the API would do: **MAE 37.99, RMSE 52.98, R² 0.923.** That's worse than 31.1 but still far better
than the baseline (61.7). Of these, `historical_dish_rating` matters most (see §7).

## 6. Diagnostics (`reports/figures/rf_*.png`)

* **Actual vs predicted** (`rf_actual_vs_predicted.png`): RF points hug the diagonal much more tightly than
  the baseline across all three meal types.
* **Residuals** (`rf_residuals.png`): roughly bell-shaped and centred slightly below 0. Most errors fall within ±50;
  the worst are about −130 and +140. Errors widen for larger predicted values (the spread at ~550–700 is wider
  than at ~150–300), so absolute errors grow with demand size.
* **High-demand under-prediction:** for the 13 validation rows with actual ≥ 750, RF under-predicts by about
  60 on average. A Random Forest averages training targets, so it cannot predict above the training
  maximum (830); validation reaches 842. This is a structural limit of the method.
* **Prediction validity:** 0 NaN, 0 infinite, 0 negative, 0 above `total_students`; range 115.8–781.9.
  A Random Forest can only output averages of training targets, so its predictions always stay inside the
  training target range [90, 830].

**Constraining to [0, total_students] at inference:** the API (Phase 6) will **round to the nearest whole
number and clip to [0, total_students]** as a safety guard, required by the API contract. All metrics above
use the **raw, unclipped** predictions, so the evaluation is not altered. Clipping can only reduce
error, and for this model it currently changes nothing.

## 7. Feature importance

Two views (`rf_permutation_importance.png`, `rf_impurity_importance.png`):

| Feature | Permutation (MAE increase on validation when shuffled) | Impurity (training) |
|---|---|---|
| `tap_share` | **+52.7** | 0.340 |
| `historical_dish_demand` | **+48.4** | 0.304 |
| `projected_interest` | **+46.4** | 0.292 |
| `historical_dish_rating` | +9.4 | 0.023 |
| `dish_name_Tea` | +1.9 | 0.004 |
| everything else | < 1 each | < 0.01 each |

**Interpretation:**
* **Three features carry the model:** what students said this time (normalised taps: `tap_share`,
  `projected_interest`) and what the dish did recently (`historical_dish_demand`). Phase 4's engineered
  ratios were worth adding. Raw `interested_taps` adds almost nothing once its normalised versions exist.
* `historical_dish_rating` adds a smaller but clear signal (it tracks dish quality).
* **Calendar flags show near-zero importance.** That does **not** mean holidays or weekends don't matter.
  Their effect is already reflected in taps: fewer students respond and tap on a holiday. The flags add
  little beyond that in this simulator. `is_exam_day` cannot matter because it is always 0 in training.
* Dish one-hot columns matter little, because history and taps already describe each dish.
* Permutation importance is the more trustworthy view. It is measured on unseen validation data, while
  impurity importance favours continuous features.

## 8. Saved artifacts

| Path | Content |
|---|---|
| `models/random_forest.joblib` | Trained model (fit on train only; ≈ 34 MB) |
| `models/random_forest_metadata.json` | Version `rf-v1-synthetic`, hyperparameters, feature names/order, split info, all metrics, validity, MD5s of preprocessor/schema/raw data, library versions |
| `models/random_forest_tuning.csv` | All 48 tuning results |

The model must be used together with `models/preprocessor.joblib` and `models/feature_schema.json`. Their MD5s are
recorded in the metadata so a mismatch can be detected.

## 9. Limitations & open issues

1. **Synthetic data:** high R² mostly shows the model recovers the simulator's formulas. Real data will be noisier.
2. **Exam days are not learned** (decision (a)): −22 bias on exam days. Fix later by training on data that includes exams.
3. **Can't predict beyond the training range:** very high demand is under-predicted (≈ −60 for actual ≥ 750).
   XGBoost (next phase) has the same tree limitation. A model on a ratio target (consumers ÷ projected interest) could help.
4. **Validation is small** (182 rows, 13 days, two weeks of one month). Hyperparameter differences < 0.5 MAE are noise.
5. **Train/validation gap** (11.8 vs 31.1 MAE) shows the model fits training rows much more closely than new days.
   More data, or `min_samples_leaf` > 1, would make it more conservative.
6. **Model size:** 34 MB. The 200-tree option gives about the same accuracy at about 40% of the size, if size matters for deployment.
7. The final test-set evaluation has **not** been done. It is reserved for the end, after model comparison.
