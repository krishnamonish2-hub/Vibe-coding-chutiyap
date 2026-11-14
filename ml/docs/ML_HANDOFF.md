# MessMind — ML Developer Handoff Report

> **Audience:** the backend developer (Developer 2) and their AI coding assistant.
> **Scope:** everything on the ML side (`ml/`) and the shared contract (`shared/api_contract.md`), as of 2026-11-14.
> **Sources:** every number below comes from the saved artifacts (`ml/models/*.json`) and the phase reports in
> `ml/docs/`. No numbers were estimated.
> ⚠️ **All data is SYNTHETIC.** Metrics measure how well the model learned the simulator's rules,
> **not real-world accuracy**. No real mess data has been used yet.

---

## 1. Project overview

**MessMind** reduces food waste in institutional kitchens such as college messes. Students tap the dishes they
plan to eat in an app. The system predicts **how many students will actually eat each dish** at a meal, and
admins cook to that number. Admins then record actual consumption, which becomes training data.

**The ML system** is a separate Python service (`ml/`). It is a **dish-wise regression model** served over HTTP by FastAPI.
* Target: `actual_dish_consumers`, the students who actually ate the dish. Students eat several dishes, so dish
  predictions can add up to more than the number of students.
* `interested_taps` (app taps) is an **input**, never the target.

**Interaction with the backend**
```
Student app / Admin dashboard ──► Main backend (Developer 2) ──► PostgreSQL
                                        │  HTTP JSON (server-to-server only)
                                        ▼
                         ML service (ml/, FastAPI, port 8001)
                         stateless · no DB access · loads frozen model once
```
The backend sends one meal (its menu, the tap counts, the context and each dish's history). The ML service returns one
prediction per dish. The ML service never reads or writes the database.

## 2. Completed work (Phases 1–9)

| Phase | Result | Main artifacts |
|---|---|---|
| 1. Setup | Existing venv (Python 3.14.2) verified; packages installed; `.gitignore`; first contract draft | `ml/requirements.txt`, `ml/src/check_env.py` |
| 2. Synthetic data | **1,337 rows × 20 columns**: 90 days (2026-07-01 → 2026-09-28), 1,000 students, 3 meals/day, 4–6 dishes/meal, 38 dish names (40 dish–meal pairs). Seed 42, plus a 21-day warm-up for history. All rows `data_source = "synthetic"` | `ml/src/generate_data.py`, `ml/data/raw/messmind_training_data.csv`, `ml/docs/data_dictionary.md` |
| 3. EDA | No duplicates; 1 row with missing history (a genuinely new dish). Strongest signals: past demand (r = 0.91) and taps (r = 0.84). Actual consumers ≈ 2.6× taps. Large calendar effects (holiday −19 to −28 pts, weekend −10 to −30). Leakage checks passed | `ml/notebooks/01_eda.ipynb`, `ml/docs/eda_report.md` |
| 4. Preprocessing | Chronological split by whole days: **train 940 rows** (2026-07-01 → 09-01), **val 182** (09-02 → 09-14), **test 215** (09-15 → 09-28). Pipeline fitted on train only; 69 features; 22 validation checks pass | `ml/src/preprocessing.py`, `ml/models/preprocessor.joblib`, `ml/models/feature_schema.json`, `ml/docs/preprocessing_report.md` |
| 5. Random Forest | 48-setting grid (fit on train, select on validation). **Val MAE 31.08**, against 61.66 for the baseline | `ml/src/train_random_forest.py`, `ml/models/random_forest.joblib`, `ml/docs/random_forest_report.md` |
| 6. XGBoost | 40-setting random search with early stopping. **Val MAE 32.33**. The gap to RF (+1.25) is **not statistically meaningful** (95% CI [−0.69, +3.28]) | `ml/src/train_xgboost.py`, `ml/models/xgboost_model.json`, `ml/docs/xgboost_report.md` |
| 7. Final test | RF selected and **frozen 2026-11-14** on validation results only; then scored once on the untouched test set. **Test MAE 31.44** against 56.22 for the baseline | `ml/src/evaluate_final.py`, `ml/models/model_selection.json`, `ml/models/final_evaluation.json`, `ml/docs/final_evaluation_report.md` |
| 8. Packaging | Model card, reusable inference module, 67-check verification suite (all pass) | `ml/src/predict.py`, `ml/src/package_model.py`, `ml/src/verify_artifacts.py`, `ml/models/model_card.json` |
| 9. API | FastAPI service implementing contract **v0.3**; `/health`, `/model-info`, `/predict`, `/predict/batch`; **82 tests pass** | `ml/api/*.py`, `ml/tests/*.py`, `ml/docs/integration_handoff.md` |

### Key metrics (synthetic data)

**Selected model:** Random Forest `rf-v1-synthetic`
(`n_estimators=500, max_depth=12, min_samples_split=2, min_samples_leaf=1, max_features=1.0, random_state=42`).
**Baseline:** `historical_dish_demand`, the mean consumers over the dish's last 5 past servings at that meal type.

| Split | Model | MAE | RMSE | R² | Bias |
|---|---|---|---|---|---|
| Train | RF | 11.83 | 15.35 | 0.993 | +0.05 |
| Validation | Baseline | 61.66 | 83.78 | 0.808 | −17.24 |
| Validation | **RF** | **31.08** | **41.79** | **0.952** | −10.65 |
| Validation | XGBoost (not selected) | 32.33 | 45.32 | 0.944 | −12.79 |
| Test | Baseline | 56.22 | 74.48 | 0.851 | +10.74 |
| Test | **RF (raw)** | **31.44** | **41.72** | **0.953** | −3.08 |
| Test | RF rounded + clipped (API output) | 31.45 | 41.73 | 0.953 | −3.07 |

* **Test, RF vs baseline:** −24.78 MAE, 95% day-block bootstrap CI [−34.58, −16.59]. RF wins on all 14 test days and all meal types
  (test MAE: breakfast 27.3, lunch 35.2, dinner 31.7).
* **Exam days on test** (30 rows, 2 days): RF bias **−17.1**, an under-prediction, because training contained no exam days.
* **Optional inputs missing** (previous attendance, leftover, rating replaced by training medians): test MAE **41.96**.
* **Top features** (validation permutation importance, MAE increase when shuffled): `tap_share` 52.7,
  `historical_dish_demand` 48.4, `projected_interest` 46.4, `historical_dish_rating` 9.4; all others < 2.

## 3. Final project structure

Only the folders below exist in `MessMind/`. **The backend and frontend code are not in this folder** and were not inspected.

```
MessMind/
├── shared/
│   └── api_contract.md            ML ⇄ backend contract, v0.3 DRAFT (needs Developer 2 sign-off)
└── ml/
    ├── README.md                  Setup, pipeline commands, model usage, API usage
    ├── requirements.txt           pandas numpy matplotlib seaborn scikit-learn xgboost joblib scipy fastapi uvicorn
    │                              pydantic pytest httpx ipykernel nbformat nbclient (no versions pinned)
    ├── pytest.ini                 pytest config (pythonpath=., testpaths=tests)
    ├── .gitignore                 ignores venv/, data/raw/*, data/processed/*, models/*, reports/figures/*
    ├── api/                       ── FastAPI service ──
    │   ├── main.py                app factory create_app(), loads model once at startup, 422/500 handlers
    │   ├── routes.py              GET /health, GET /model-info, POST /predict, POST /predict/batch
    │   ├── schemas.py             Pydantic request/response models = contract v0.3 validation
    │   └── model_loader.py        ModelService: loads src/predict.py predictor; maps request ⇄ response
    ├── src/                       ── ML code ──
    │   ├── check_env.py           Phase 1: verifies venv, packages, folders
    │   ├── generate_data.py       Phase 2: synthetic data generator (+ writes docs/data_dictionary.md)
    │   ├── preprocessing.py       Phase 4: feature engineering, GroupMedianImputer, pipeline, chronological split
    │   ├── evaluation.py          shared loading, baseline, metrics, bootstrap, plots (refuses test unless allowed)
    │   ├── train_random_forest.py Phase 5: RF tuning/training
    │   ├── train_xgboost.py       Phase 6: XGBoost tuning/training + comparison
    │   ├── evaluate_final.py      Phase 7: frozen RF on test set (checks freeze MD5s first)
    │   ├── package_model.py       Phase 8: writes models/model_card.json (read-only on model)
    │   ├── predict.py             Phase 8: MessMindPredictor (validate → transform → predict → round/clip)
    │   └── verify_artifacts.py    Phase 8: 67 checks on artifacts + inference parity
    ├── tests/
    │   ├── test_api.py            64 API tests (validation, bounds, unseen categories, 503 on load failure)
    │   └── test_integration_docs.py  18 tests: every example in integration_handoff.md + contract §2.1–2.3 vs live API
    ├── models/                    ── artifacts (committed; ~37 MB) ──
    │   ├── random_forest.joblib   ★ frozen selected model (33 MB)
    │   ├── preprocessor.joblib    ★ fitted preprocessing pipeline
    │   ├── feature_schema.json    ★ ordered 69 feature names, target, split info
    │   ├── model_card.json        ★ metadata, input spec, training ranges, metrics, limitations, MD5s
    │   ├── model_selection.json   freeze record (selected model + MD5s), 2026-11-14
    │   ├── final_evaluation.json  Phase 7 test results
    │   ├── random_forest_metadata.json / random_forest_tuning.csv     Phase 5 details
    │   ├── xgboost_model.json / xgboost_metadata.json / xgboost_tuning.csv   Phase 6 (not used by the API)
    │   └── model_comparison_validation.csv                            baseline vs RF vs XGB on validation
    ├── data/                      (committed; synthetic, regenerable)
    │   ├── raw/messmind_training_data.csv          synthetic dataset (1,337 rows)
    │   └── processed/{train,val,test}.csv          model-ready splits (meta__ cols + 69 features + target)
    ├── docs/
    │   ├── ML_HANDOFF.md          this report
    │   ├── integration_handoff.md full backend integration guide with verified examples
    │   ├── integration_checklist.md  step-by-step backend checklist
    │   ├── data_dictionary.md     raw dataset columns (auto-generated)
    │   ├── eda_report.md / preprocessing_report.md / random_forest_report.md / xgboost_report.md
    │   ├── final_evaluation_report.md   + figures/final_*.png (tracked)
    │   └── feature_schema.md      early (Phase 1) design notes, partly superseded by data_dictionary.md
    ├── notebooks/01_eda.ipynb     executed EDA notebook
    ├── reports/figures/           generated diagnostic plots (committed)
    ├── config/                    empty (placeholder)
    └── venv/                      existing virtual environment (not committed)
```
★ = required at inference time.

## 4. ML architecture and data flow

**Target:** `actual_dish_consumers` (integer, 0 … `total_students`).

**Raw inputs per dish** (contract names): `date`, `meal_type`, `total_students`, `total_responses`, `is_holiday`,
`is_exam_day`, `is_festival`, `temperature`, `rainfall`, `previous_meal_attendance` (meal level); `dish_name`,
`dish_category`, `interested_taps`, `historical_dish_demand`, `historical_dish_rating`, `previous_leftover_kg` (dish level).

**The 69 model features**, in this order (authoritative list: `models/feature_schema.json`):
1. **History:** `historical_dish_demand`, `historical_dish_rating`, `previous_leftover_kg`.
2. **Numeric:** `day_of_week`, `temperature`, `rainfall`, `previous_meal_attendance`, `interested_taps`, `total_responses`.
3. **Engineered:** `tap_share`, `response_rate`, `projected_interest`, `num_dishes_in_meal`.
4. **Flags:** `is_weekend`, `is_holiday`, `is_exam_day`, `is_festival`, `is_new_dish`.
5. **One-hot:** `meal_type_*` (3), `dish_category_*` (10), `dish_name_*` (38).

**Excluded:** the target, `data_source`, the raw `date`, and raw `total_students`. `total_students` is constant at 1000 in training, so it is used only inside ratios.

**Preprocessing** (`models/preprocessor.joblib`, fitted on train only, never refitted):

| Step | What it does |
|---|---|
| `engineer` | Stateless ratios: `tap_share = taps/total_responses`, `response_rate = total_responses/total_students`, `projected_interest = taps × total_students / total_responses`, `num_dishes_in_meal`, and `is_new_dish = historical_dish_demand is missing` |
| `history` | `GroupMedianImputer`: train medians by (dish_category, meal_type) → meal_type → overall |
| `numeric` | Median imputer |
| `boolean` | Most-frequent imputer |
| `categorical` | "unknown" fill, then `OneHotEncoder(handle_unknown="ignore")`. Unseen values become all zeros |

There is no scaling, because tree models don't need it.

**Loading and inference** (`src/predict.py` → `MessMindPredictor`):
1. **Startup:**
   * read `model_card.json`;
   * check the MD5s of the model, preprocessor and schema against the frozen values;
   * load them;
   * check that the feature order is identical across the preprocessor, schema, model and card.
2. **Per request:**
   * validate (required fields, finite numbers, `0 ≤ interested_taps ≤ total_responses ≤ total_students`, strict `YYYY-MM-DD`);
   * derive `day_of_week` and `is_weekend` from the date;
   * set missing flags to `false`;
   * `preprocessor.transform`, then `model.predict`;
   * **round, then clip to `[0, total_students]`**;
   * attach warnings.
3. **Output order:** predictions come back in the same order as `dishes`.

**API endpoints** (FastAPI, `http://127.0.0.1:8001`):

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | – | `{"status":"ok","model_loaded":true,"model_version":"rf-v1-synthetic"}`, or `degraded` / `false` / `null` when artifacts fail to load |
| `GET /model-info` | – | `model_version, model_type, trained_on, frozen_on, feature_schema_version, contract_version, target, n_features, feature_names, meal_types, known_dish_categories, known_dish_names, metrics, limitations` (no file paths) |
| `POST /predict` | one meal: meal fields + `dishes[]` | `{"meal_id", "model_version", "trained_on", "predictions":[{"dish_id","interested_taps","predicted_consumers","warnings"}]}` |
| `POST /predict/batch` | `{"meals":[...]}` (1–100) | `{"model_version","trained_on","n_meals","n_succeeded","n_failed","results":[{"index","meal_id","status":"ok"\|"error","prediction","errors"}]}` |

Verified example (contract §2.3 request): Rice (with history) → **535**; Jeera Aloo (unseen, no history) → **207**, with warnings
`unseen_dish`, `new_dish_no_history`, `imputed:historical_dish_rating`, `imputed:previous_leftover_kg`.
All exact examples are in `docs/integration_handoff.md` §4 and §7 and are tested by `tests/test_integration_docs.py`.

**Expected backend flow:**
1. Publish the menu.
2. Students tap until the **voting cut-off**.
3. Freeze `interested_taps` and `total_responses`.
4. Compute history from **completed past meals only**.
5. `POST /predict` (or `/predict/batch`).
6. Store each prediction with `model_version`, `warnings` and the request sent.
7. After the meal, the admin enters `actual_dish_consumers`; it becomes history for future meals.

## 5. API contract summary (`shared/api_contract.md` v0.3, DRAFT)

**Status:** decisions approved by Developer 1 on 2026-11-14; **Developer 2 has not signed off yet.**

**Required fields:**
* Meal level: `meal_id` (string, 1–100 characters), `date` (`YYYY-MM-DD`), `meal_type` (`breakfast`|`lunch`|`dinner`),
  `total_students` (int > 0), `total_responses` (int, 0 … `total_students`), `dishes` (1–30).
* Dish level: `dish_id`, `dish_name`, `dish_category` (non-empty strings), `is_veg` (bool), `interested_taps` (int, 0 … `total_responses`).

**Optional fields:**
* Meal level: `is_holiday`, `is_exam_day`, `is_festival` (default `false`); `temperature` (−30 … 60 °C);
  `rainfall` (≥ 0 mm); `previous_meal_attendance` (int, ≤ `total_students`).
* Dish level: `is_special` (default `false`); `historical_dish_demand` (≥ 0, **strongly recommended**);
  `historical_dish_rating` (1 … 5); `previous_leftover_kg` (≥ 0).

**§2.5 history fields** (computed by the **backend** from data it stores):

| Field | Definition | Unit |
|---|---|---|
| `historical_dish_demand` | Mean `actual_dish_consumers` over the **last 5 servings of the same dish at the same `meal_type`**, earlier dates only (fewer if served fewer times) | students |
| `historical_dish_rating` | Mean of per-serving average ratings over the **last 5 servings of the dish at any meal type**, strictly before this meal | 1–5 |
| `previous_leftover_kg` | Leftover of the **most recent earlier serving of the same dish at the same `meal_type`** | kg |
| `previous_meal_attendance` (meal-level) | Headcount of the immediately preceding meal slot (breakfast ← previous day's dinner). Defined in `integration_handoff.md` §6.5 | students |

**Validation rules:**
* All numbers must be finite; `NaN` and `Infinity` → 422.
* Integer fields must be JSON integers, and booleans must be JSON `true`/`false`.
* The date must be a real calendar date.
* `dish_id` and `dish_name` must each be unique within a meal.
* ★ Implementation details not yet written in the contract (suggested for v0.4):
  * unknown fields are rejected (`extra_forbidden`);
  * dish strings are limited to 100 characters;
  * error items always include a `type`;
  * strings are trimmed.

**Errors:**

| Code | When |
|---|---|
| `422` | `{"detail":[{"loc","msg","type"}]}` |
| `503` | `{"detail":"model not loaded"}` |
| `500` | `{"detail":"internal error"}` |

**Missing history:**
* **Omit the field (or send `null`). Never send `0`, `NaN` or invented values.**
* A missing `historical_dish_demand` marks the dish as **new** (`new_dish_no_history`). The service then fills training medians per
  (dish_category, meal_type).
* Without any history fields, validation MAE rises from **31.09 to 35.12**; with required fields only it is **36.59**.
  These were measured on validation in Phase 9 and are documented in `integration_handoff.md` §6.6.

**Assumptions the backend must follow:**
* **No leakage:** history uses only meals finished *before* the predicted meal whose results have already been entered.
  Never use the predicted meal's own values, even when re-requesting it later.
* Call `/predict` **after the voting cut-off**, with frozen counts.
* Send the **whole menu** of a meal in one request.
* Only the backend calls the ML service, on a private network (it has no authentication).

## 6. Current status and pending issues

### Completed and verified (as of 2026-11-14)
* `pytest`: **82 passed**: 64 API tests and 18 checks that the documented examples match the live API.
* `src.verify_artifacts`: **67/67 checks passed**. The artifacts match the frozen MD5s (`random_forest.joblib` `17c3d7049cd489b9ceab7a3c05b64d96`,
  `preprocessor.joblib` `df5f28af320f3afcf7fb3c47b25e5be6`, `feature_schema.json` `58bced1bbc4440a326642c50fdb9fbad`).
* Inference parity: raw records through `predict.py` reproduce the processed features exactly, and the Phase 7 test MAE.
* The server was started with uvicorn and all four endpoints were tested over HTTP in Phase 9. API predictions are identical to `predict.py`.
* The pipeline is deterministic (fixed seeds). Regenerating the data reproduced identical files (Phases 2 and 4).

### Pending backend integration (Developer 2)
* History computation (§2.5) from stored actuals, leftovers, ratings and headcount.
* The HTTP client to the ML service, with error handling, prediction storage and dashboard display.
* The training-data CSV export (contract §3), needed for retraining on real data.
* End-to-end tests (see `docs/integration_checklist.md` Step 9).

### Decisions or confirmations needed from the teammate
1. Sign off **contract v0.3**, especially §2.5 (backend sends history) and §2.4 (per-meal batch errors).
2. **Voting cut-off** and when `/predict` is called (contract Q5).
3. Whether a meal **headcount** and post-meal **ratings** are recorded (Q6).
4. Exact definition of **`total_responses`**. Does a "not eating" response count? (`integration_handoff.md` D9)
5. Holiday / exam / festival calendar owner (Q2); weather source, or omit it (Q7).
6. ML URL configuration, e.g. `ML_API_URL=http://127.0.0.1:8001` (Q4); meal types limited to three (Q1).
7. Whether to adopt the four implementation details above into contract v0.4.

### Known limitations and risks (documented in the reports)
* **Synthetic data only.** Real-world accuracy is unknown. Real dish names will mostly trigger `unseen_dish`, and the model must be retrained on
  real exports before real cooking decisions.
* **Exam days not in training**, so they are under-predicted (test bias −17.1; validation exam-day bias −21.9).
* **High-demand ceiling:** tree models can't exceed the training maximum (830). Test rows with actual ≥ 750 were under-predicted by about 42.
* **Mess size:** `total_students` was always 1000 in training. Other sizes only stay in range thanks to clipping, and are warned with
  `total_students_outside_training_range`.
* **Small evaluation sets:** val 182 rows over 13 days; test 215 rows over 14 days. The test set has now been used, so future model changes need new data.
* **Train/validation gap:** RF train MAE 11.83 against validation 31.08. It's stable on test, but the model fits training rows much more closely than new days.
* **Disclosure:** the test set was first scored on 2026-11-14 by an earlier script (`evaluate_test.py`, since replaced). That happened after
  the freeze, with no changes afterwards (see `final_evaluation_report.md` §1).
* **Repository:** a dedicated git repository now exists at the `MessMind/` root (branch `main`), separate from any parent folder.
* **Artifacts are committed** (`ml/models/`; the largest file, `random_forest.joblib`, is 33 MB, below GitHub's 100 MB limit). Run `src.verify_artifacts` after cloning.
* **Dependencies are not version-pinned** in `requirements.txt`. The tested versions are Python 3.14.2, pandas 3.1.1, numpy 2.5.4,
  scikit-learn 1.9.1, xgboost 3.4.1, fastapi 0.162.6, pydantic 2.14.3, uvicorn 0.54.0, pytest 9.2.0, httpx 0.28.1, scipy 1.18.1.
  Unpickling `*.joblib` with a different scikit-learn version may fail or behave differently. **Uncertain:** this hasn't been tested with other versions.
* **Test warning:** Starlette deprecates using `httpx` with its TestClient (it suggests `httpx2`). The tests still pass. This hasn't been addressed.
* **No authentication or rate limiting** on the ML API. It must not be exposed publicly.

## 7. Instructions for the teammate (next steps)

- [ ] Read `shared/api_contract.md` v0.3 and `ml/docs/integration_handoff.md` (Sections 3, 5–7).
- [ ] **Agree to contract v0.3**, or request changes, and answer the open questions in Section 6.
- [ ] **Confirm how the history fields will be retrieved**: which tables and columns hold per-dish actuals, leftovers, ratings and
      meal headcount. Implement the queries per `integration_handoff.md` §6.7, which is illustrative SQL to adapt to your schema.
- [ ] Get `ml/models/` (copy or regenerate), run `src.verify_artifacts` and `pytest`, start the service, and check `/health`.
- [ ] **Connect the backend:** add a configurable `ML_API_URL`, a 10 s timeout, and server-to-server calls only. Freeze taps at the cut-off; send whole menus;
      omit unknown optional values.
- [ ] **Handle errors:**

  | Response | What to do |
  |---|---|
  | 200 | Use the predictions |
  | 422 | Fix the payload; don't retry it unchanged |
  | 503, 500 or timeout | Show "prediction unavailable"; retry later |

  Never display invented numbers.
- [ ] **Store predictions:** `predicted_consumers`, `warnings`, `model_version`, `trained_on`, the request payload and a timestamp.
- [ ] Dashboard: show predictions next to taps, the warnings, and a "synthetic model" notice.
- [ ] **Test end to end** (`integration_checklist.md` Step 9):
  - a known dish with history has no `new_dish_no_history`;
  - a batch with one broken meal still returns the others;
  - with the ML service down, the backend degrades gracefully;
  - history queries never include the predicted meal itself.
- [ ] Implement the contract §3 export so the model can be retrained on real data.

## 8. Running the ML service (Windows, from `MessMind\ml`)

```powershell
cd <your-checkout>\MessMind\ml                       # adjust to your checkout location

# Option A: activate the existing venv (then `python` = venv Python)
.\venv\Scripts\Activate.ps1
# If PowerShell blocks scripts once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -c "import sys; print(sys.executable)"         # should end with ml\venv\Scripts\python.exe

# Option B: no activation, call the venv Python directly (used in all docs)
.\venv\Scripts\python.exe -m pip install -r requirements.txt   # only if packages are missing
.\venv\Scripts\python.exe src\check_env.py                     # -> RESULT: ALL CHECKS PASSED
.\venv\Scripts\python.exe -m src.verify_artifacts              # -> SUMMARY: 67/67 checks passed

# Start the API (loads the model once; Ctrl+C to stop)
.\venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001

# Run all tests (no server needed)
.\venv\Scripts\python.exe -m pytest                            # -> 82 passed
```

| What | Where |
|---|---|
| API base URL | `http://127.0.0.1:8001` |
| Swagger UI | `http://127.0.0.1:8001/docs` |
| OpenAPI JSON | `http://127.0.0.1:8001/openapi.json` |
| Quick check | `Invoke-RestMethod http://127.0.0.1:8001/health` |
| Other models folder | set env var `MESSMIND_MODELS_DIR` before starting |

Plain `python` without activating runs the **system** Python, which lacks the packages. Always use the venv.

**Regenerating everything from scratch.** Only do this if `data/` or `models/` are missing. ⚠️ These commands
**overwrite** `ml/data/` and `ml/models/`, including the frozen model, so do not run them on a working setup:
```powershell
.\venv\Scripts\python.exe src\generate_data.py
.\venv\Scripts\python.exe -m src.preprocessing
.\venv\Scripts\python.exe -m src.train_random_forest
.\venv\Scripts\python.exe -m src.train_xgboost
.\venv\Scripts\python.exe -m src.evaluate_final
.\venv\Scripts\python.exe -m src.package_model
.\venv\Scripts\python.exe -m src.verify_artifacts      # must report 67/67; it fails if the RF differs from the frozen MD5
```
**Uncertain:** the regenerated `random_forest.joblib` *should* be byte-identical (fixed seeds, and identical metrics were
observed on reruns), but a full regenerate-from-scratch to an identical MD5 has not been run. If the MD5 differs,
`verify_artifacts` and the API refuse it, and you need the ML developer's copy of `models/`.
