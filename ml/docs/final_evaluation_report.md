# MessMind — Final Evaluation Report (Phase 7)

> **All data is SYNTHETIC.** These are unbiased scores of the selected model on held-out *future* days of the
> simulator. They measure how well it learned the simulator's rules, **not** accuracy in a real mess.
> Code: `src/evaluate_final.py`. Run from `ml/`: `.\venv\Scripts\python.exe -m src.evaluate_final`
> Results: `models/final_evaluation.json`. Figures: `docs/figures/final_*.png`.

## 1. Model under evaluation & integrity

* **Model:** Random Forest `rf-v1-synthetic` (`models/random_forest.joblib`), selected on **validation results
  only** (Phases 5–6) and frozen on 2026-11-14 in `models/model_selection.json`.
* **Test-set history (disclosure):** the test set was first opened on 2026-11-14 by an earlier evaluation
  script (`src/evaluate_test.py`, now replaced by this one). That happened **after** the selection was frozen. No
  model, hyperparameter, feature or preprocessing change was made after that. This phase re-scores the same frozen
  artifacts, and the numbers are identical to that first run.
* **8 / 8 freeze checks PASS:** the MD5s of the model, preprocessor, schema and all three processed splits match the freeze
  record, both before and after the run.
* **13 / 13 input checks PASS:** the target is `actual_dish_consumers`; there are 69 features whose names and order match the
  training schema and the model's own `feature_names_in_`; there are no NaN values and no target, ID or post-meal features;
  the dates run train < validation < test; and test rows and dates match the Phase 4 split record.
* Validation metrics recomputed here match the Phase 5 record exactly.
* **XGBoost was not scored on the test set.**

## 2. Test set

**215 rows · 14 days · 2026-09-15 → 2026-09-28** · breakfast 70 / lunch 72 / dinner 73 rows · 2 exam days (30 rows) ·
no new dishes. All dishes were seen in training.

## 3. Final metrics (raw model output, no clipping)

| Model | MAE | RMSE | R² | Bias |
|---|---|---|---|---|
| Historical-demand baseline | 56.22 | 74.48 | 0.851 | +10.74 |
| **Random Forest (frozen)** | **31.44** | **41.72** | **0.953** | −3.08 |

**Random Forest beats the baseline:** MAE is 24.8 lower (−44%). The day-block bootstrap 95% CI is [−34.6, −16.6], so
the difference is clearly meaningful. RF also has lower error than the baseline on **every one of the 14 test days**
(and all 13 validation days).

**Rounded + clipped (what the API will output):** MAE 31.45, RMSE 41.73, R² 0.953. Clipping to
`[0, total_students]` changed **0** predictions. The 0.01 difference comes only from rounding to whole students.

## 4. Validation vs test

| | Train (RF) | Validation | Test |
|---|---|---|---|
| RF MAE | 11.83 | 31.08 | **31.44** |
| RF RMSE | 15.35 | 41.79 | **41.72** |
| RF R² | 0.993 | 0.952 | **0.953** |
| RF bias | +0.05 | −10.65 | −3.08 |
| Baseline MAE | — | 61.66 | 56.22 |
| RF error as % of baseline | — | 50% | 56% |

| Meal | Val baseline | Val RF | Test baseline | Test RF |
|---|---|---|---|---|
| Breakfast | 61.6 | 28.0 | 57.5 | 27.3 |
| Lunch | 66.4 | 34.6 | 59.3 | 35.2 |
| Dinner | 57.0 | 30.4 | 51.9 | 31.7 |

**Interpretation:**
* **RF performance is stable:** test MAE differs from validation by +0.4 (about 1%), and RMSE and R² are practically unchanged.
  Every meal type moves by at most 1.3. Choosing hyperparameters on validation **did not overfit the validation set**.
* The **train/test gap** (11.8 against 31.4) is large, but it is the same as the train/validation gap, so it describes how tightly the
  model fits the training rows, not a loss of accuracy over time.
* **Bias improved from −10.7 to −3.1** because the test set has fewer exam days (14% of rows against 47%). On non-exam test days
  bias is −0.8; on exam days it is −17.1 (n = 30, 2 days).
* The **baseline looks better on test** (56.2 against 61.7) because the test set has fewer exam days. RF's relative advantage is a
  little smaller (56% of baseline error against 50%) because the baseline itself had an easier period.

## 5. Distribution checks (train vs validation vs test)

* **Target:** no significant shift (means 414 / 449 / 426; KS train-vs-test p = 0.26).
* **App signals** (`interested_taps`, `tap_share`, `projected_interest`): no significant shift (p ≥ 0.17).
  `total_responses` dipped in validation (exam period) and returned to the training level in test.
* **Shifted inputs:**
  * `temperature` and `rainfall` (KS p < 0.001): the simulator's seasonal drift.
  * `previous_meal_attendance` and `historical_dish_demand` (p ≤ 0.01): higher in test. History from the
    exam period (09-09 → 09-16) raises recent averages. This is **consistent with** the baseline over-predicting in test (bias +10.7),
    more strongly in the first test week (+13.3) than in the second (+8.1). That suggests the history is gradually "forgetting"
    the exam period.
* **Effect on RF:** none visible. Its daily MAE stays between 23.5 and 49.3 with no upward trend after the boundary
  (`final_daily_mae.png`), because it combines history with this meal's taps.

## 6. Diagnostics

| Check | Result |
|---|---|
| NaN / infinite predictions | 0 / 0 |
| Negative predictions | 0 |
| Predictions above `total_students` | 0 (range 114.6–797.7; total_students = 1000) |
| High demand (actual ≥ 750, n = 11) | under-predicted by 42 on average. Training max is 830 and test max is 859; tree models can't predict above the training range |
| Largest errors | ±105–130 consumers, all on non-exam days, mostly high-volume dishes (Rice, Chapati, Dal Fry, Veg Biryani). Example: Rice dinner 09-21 predicted 617 vs actual 487 |
| Residuals (`final_residuals.png`) | roughly symmetric around 0; spread grows with predicted size |
| Optional backend inputs missing (attendance, leftovers, rating → training medians) | MAE 41.96, RMSE 59.41, R² 0.905. Worse, but still better than the baseline |

Figures: `final_actual_vs_predicted.png`, `final_residuals.png`, `final_error_by_meal.png`, `final_daily_mae.png`.

## 7. Generalisation assessment

**The model generalises reasonably on this synthetic data.** Test performance matches validation within about 1%. It beats the
baseline on every meal type and every day. Its predictions are always valid, and it is robust to the moderate input shifts present. The
known weaknesses are systematic, not random: **exam-day under-prediction** (no exam days in training, decision (a)) and a
**ceiling on very high demand**.

## 8. Ready for API integration?

**Yes, for integration and demonstration with synthetic data.** It is **not** validated for real kitchen decisions. Conditions:

1. Serve `random_forest.joblib` + `preprocessor.joblib` + `feature_schema.json`, and verify their MD5s against
   `model_selection.json` at start-up.
2. Post-process every prediction: **round, then clip to `[0, total_students]`**, as the contract requires.
3. Return `trained_on: "synthetic"` and the model version in every response.
4. Resolve how the API gets **history features** (`historical_dish_demand`, rating, leftovers, previous attendance)
   and the **tap cut-off time** with the backend developer (contract open questions 5–6). Without the optional inputs, expect MAE ≈ 42.
5. The model file is about 34 MB. That's fine for a local or server deployment.

**Needs further work before real use:** retrain and re-test on real exported records (contract §3), include exam
periods in training, and monitor live error against actual consumption.

## 9. Limitations (synthetic data)

1. Every relationship the model learned was designed into the simulator. Real behaviour will be noisier and may differ.
2. The test set is small (215 rows, 14 days, 2 exam days), so sub-group results are indicative only.
3. Only 90 days of a single fictional term, with constant enrolment (1000) and a fixed dish catalogue.
4. The test set has now been used. Any future model change must be judged on **new** data, not by re-tuning against these numbers.
