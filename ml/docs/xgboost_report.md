# MessMind — XGBoost Report & Model Comparison (Phase 6)

> **All data is SYNTHETIC.** Metrics show how well each model recovers the rules built into the
> simulator, not real-mess accuracy.
> Code: `src/train_xgboost.py` (+ shared `src/evaluation.py`).
> Run from `ml/`: `.\venv\Scripts\python.exe -m src.train_xgboost` (≈ 85 s; XGBoost results reproduce exactly).
> **The test set was not loaded.** The Random Forest was **not** retrained: the saved Phase 5 model was re-scored
> and matched its recorded MAE (31.08).

## 1. Setup & checks

Same data as Phase 5: train 940 rows (2026-07-01 → 09-01), validation 182 rows (09-02 → 09-14), 69
features in schema order, target `actual_dish_consumers`. **11 input checks pass**. These include the
8 checks from Phase 5, plus three new ones: the split is identical to the one the RF used, the RF used the
same feature order, and the preprocessor is unchanged since RF training (MD5).

## 2. Model & tuning

* `XGBRegressor` (xgboost 3.4.1), objective `reg:squarederror`, `tree_method="hist"`, `random_state=42`.
* **Random search over 40 settings**, a budget similar to the RF's 48 so the comparison is fair. Each
  candidate is **fitted on training data** with **early stopping**: training stops when validation MAE has not
  improved for 100 rounds (max 3,000 trees).
  * Version handling: XGBoost ≥ 2 takes `early_stopping_rounds` in the constructor; older versions took it in
    `fit()`. The script detects which one is installed.
* Candidates are ranked by **validation MAE**.
* **Final model:** refit on **training data only** with `n_estimators` fixed to the best early-stopping
  round and no early stopping. The saved model therefore contains exactly the trees it uses. It reproduces
  the search model's validation MAE (32.33).

| Hyperparameter | Searched | **Selected** |
|---|---|---|
| `n_estimators` | early stopping (≤ 3000) | **428** |
| `max_depth` | 3, 4, 5, 6, 8 | **8** |
| `learning_rate` | 0.02, 0.05, 0.1 | **0.02** |
| `subsample` | 0.7, 0.85, 1.0 | **1.0** |
| `colsample_bytree` | 0.5, 0.75, 1.0 | **0.75** |
| `min_child_weight` | 1, 3, 5, 10 | **3** |
| `reg_lambda` | 0.5, 1, 5, 10 | **0.5** |

The top three candidates are within 0.1 MAE (32.33–32.44), which is noise. The third one (depth 5, 96 trees)
matches the winner on validation with far less overfitting (train MAE 17.4 against 3.1). Full table:
`models/xgboost_tuning.csv`.

**Note:** validation is used for both early stopping and model selection, as it was for RF tuning. Both
validation scores are therefore slightly optimistic. The untouched test set gives the unbiased number later.

## 3. Validation comparison (same 182 rows for all three)

| Model | MAE | RMSE | R² | Bias |
|---|---|---|---|---|
| Baseline (historical demand) | 61.66 | 83.78 | 0.808 | −17.24 |
| **Random Forest** (Phase 5) | **31.08** | **41.79** | **0.952** | −10.65 |
| XGBoost | 32.33 | 45.32 | 0.944 | −12.79 |

*MAE = average plates off; RMSE punishes big misses more; R² = share of demand variation explained;
bias = average (predicted − actual). MAPE is not used because demand can be 0.*

### Are the differences meaningful? (paired bootstrap, resampling whole days, 2,000×)

| Comparison (A − B) | MAE difference | 95% CI | A better in | Meaningful? |
|---|---|---|---|---|
| XGBoost − Random Forest | +1.25 | [−0.69, +3.28] | 10% of resamples | **No**: the interval includes 0 |
| XGBoost − Baseline | −29.32 | [−40.72, −18.69] | 100% | **Yes** |
| Random Forest − Baseline | −30.57 | [−41.37, −20.91] | 100% | **Yes** |

**Conclusion:** both ML models clearly beat the baseline, roughly halving its error. **Random Forest is
slightly better than XGBoost on every overall metric, but the gap (about 1.3 plates of MAE) is not
statistically meaningful** on 13 validation days. XGBoost did not win. On RMSE, RF's lead (41.8 against 45.3) means XGBoost
makes a few larger misses.

### By meal type and exam day (MAE; all groups ≥ 58 rows)

| Group | n | Baseline | Random Forest | XGBoost |
|---|---|---|---|---|
| Breakfast | 58 | 61.6 | 28.0 | **26.2** |
| Lunch | 62 | 66.4 | **34.6** | 36.7 |
| Dinner | 62 | 57.0 | **30.4** | 33.7 |
| Non-exam days | 97 | 53.1 | **27.0** | 28.1 |
| Exam days | 85 | 71.4 | **35.7** | 37.1 |

XGBoost is better at breakfast and RF at lunch and dinner. Both under-predict on **exam days** (bias RF −21.9,
XGB −24.1), because training contained no exam days (decision (a)). Full table: `models/model_comparison_validation.csv`.

### If the backend cannot send optional inputs
With `previous_meal_attendance`, `previous_leftover_kg` and `historical_dish_rating` replaced by training
medians: **XGBoost MAE 39.88, RF 37.99.** Both still beat the baseline (61.66) by a wide margin.

## 4. Diagnostics (`reports/figures/xgb_*.png`, `model_comparison_by_meal.png`)

* **Actual vs predicted:** XGBoost follows the diagonal about as tightly as RF, with a few more points far
  from it.
* **Residuals:** centred slightly below 0 (bias −12.8). Most errors are within ±50. The tails are longer than
  RF's: worst about −190 and +165, against about −130 and +140 for RF. Errors grow with predicted demand.
* **High demand is still under-predicted.** XGBoost's maximum prediction is 764, against RF's 782 and actual values up to
  842. Both are tree ensembles and can't easily predict above the training range (max 830).
* **Overfitting:** XGBoost train MAE **3.1** against validation 32.3, a larger gap than RF (11.8 / 31.1). With
  depth 8 and low regularisation, it memorises the 940 training rows.
* **Prediction validity:** 0 NaN, 0 infinite, 0 negative, 0 above `total_students`; range 114.9–763.9.
  *Unlike Random Forest, XGBoost adds up tree outputs and can in principle predict below 0 or above
  the training maximum*, so a guard at inference matters more for this model.

**Constraining to [0, total_students] at inference:** the API will **round and clip** every prediction to
`[0, total_students]` (API contract). Reported metrics use the **raw, unclipped** predictions.
Clipping changes nothing on validation, and wherever it does apply it can only reduce error.

## 5. Feature importance

| Feature | Permutation (validation MAE increase) | Total-gain share (training) | RF permutation (Phase 5) |
|---|---|---|---|
| `tap_share` | **+88.7** | 0.577 | +52.7 |
| `historical_dish_demand` | **+36.6** | 0.125 | +48.4 |
| `projected_interest` | **+17.1** | 0.210 | +46.4 |
| `historical_dish_rating` | +10.5 | 0.032 | +9.4 |
| `interested_taps` | +2.2 | 0.015 | < 0.1 |
| all others | < 2 each | < 0.01 each | < 2 each |

**Interpretation:** both models rely on the same four signals: normalised app interest, recent dish history,
and dish quality (rating). XGBoost leans much more on **`tap_share`**, while RF splits importance roughly
evenly across `tap_share`, `historical_dish_demand` and `projected_interest`. XGBoost uses one feature heavily
and builds corrections on top of it. Calendar flags again show near-zero importance, because their effect is
already reflected in taps. `is_exam_day` is constant in training and cannot be used.

## 6. Saved artifacts

| Path | Content |
|---|---|
| `models/xgboost_model.json` | Trained XGBoost model in XGBoost's portable JSON format (≈ 3.8 MB). Load with `XGBRegressor().load_model(path)`. Reload verified to reproduce predictions |
| `models/xgboost_metadata.json` | Version `xgb-v1-synthetic`, hyperparameters, feature names/order, split, all three models' validation metrics, bootstrap results, validity, MD5s, library versions |
| `models/xgboost_tuning.csv` | All 40 search results |
| `models/model_comparison_validation.csv` | Overall, meal-type and exam-day metrics for baseline, RF and XGBoost |

## 7. Limitations & open issues

1. **Synthetic data.** Both models mainly rediscover the simulator's formulas. Real data will be noisier, and the ranking could change.
2. **Small validation set** (182 rows, 13 days). RF and XGBoost can't be separated reliably, and hyperparameter choices within ~0.5 MAE are noise.
3. **Selection bias:** validation was used for early stopping and selection, so both validation scores are optimistic.
4. **Exam days are not learned** (decision (a)): about −22 to −24 bias on exam days for both models.
5. **High demand is under-predicted** by both tree models (training max 830).
6. **XGBoost overfits strongly** (train MAE 3.1). A shallower candidate performs the same on validation and may generalise better.
7. **Reproducibility:** XGBoost results are identical across runs. The re-scored RF metrics differ only in the
   15th significant digit, from parallel arithmetic order. That's numerically irrelevant.
8. **Model choice for the API is not final yet.** It should be decided before or at the final test evaluation,
   without using test results to pick the model.
