# MessMind ML

Python machine-learning service that predicts **how many students will actually
eat each dish** at a mess meal. It is dish-wise, not just total attendance: one
student usually eats several dishes, so dish predictions can sum to more than
the number of students.

> **Status:** model packaged (Phase 8) and served by a FastAPI service (Phase 9, see below). Selected model: **Random Forest `rf-v1-synthetic`**, frozen
> 2026-11-14. Test MAE **31.44** consumers per dish against **56.22** for the historical-demand baseline.
> **All data so far is SYNTHETIC.** Metrics do not represent real-mess accuracy; retrain on real
> records before using predictions for real cooking decisions.

## Inputs vs target

| | Examples | Role |
|---|---|---|
| Known **before** the meal | menu, dish category, date, holiday/exam/festival flags, weather, `interested_taps` (app taps), `total_responses`, past history of the dish | **Features** |
| Known **after** the meal | `actual_dish_consumers`, leftovers, ratings | `actual_dish_consumers` = **target**; other post-meal values are used only as *history* for later meals |

Details: [docs/data_dictionary.md](docs/data_dictionary.md), [docs/preprocessing_report.md](docs/preprocessing_report.md).

## How this fits the whole system

```
React apps ──► Main backend (Dev 2) ──► PostgreSQL
                    │  HTTP POST /predict
                    ▼
             ML service (this folder, Dev 1) — FastAPI, loads the packaged model
```

The ML service is **independent**: it never touches the main database. The
backend sends meal/menu/tap data and stores the predictions it receives.
API contract: [../shared/api_contract.md](../shared/api_contract.md).

## Folder guide

| Folder | Purpose |
|---|---|
| `api/` | FastAPI prediction service (contract v0.3). |
| `config/` | Settings (paths, model parameters). |
| `data/raw/` | Raw data (synthetic generator output or real exports). Committed (synthetic, regenerable). |
| `data/processed/` | Train / validation / test splits with engineered features. Committed (regenerable). |
| `docs/` | Data dictionary, phase reports, final figures (`docs/figures/`). |
| `models/` | Model, preprocessor, schema, model card and metadata. Committed (see below). |
| `notebooks/` | Jupyter notebooks (`01_eda.ipynb`). |
| `reports/figures/` | Generated diagnostic plots. Committed. |
| `src/` | Python modules: data generation, preprocessing, training, evaluation, **inference**. |
| `venv/` | Existing virtual environment. Reuse it, do not recreate. Not committed. |

## Setup (Windows PowerShell, from this `ml` folder)

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt   # install dependencies
.\venv\Scripts\python.exe src\check_env.py                     # verify Python, packages, folders
```

Always run Python through `.\venv\Scripts\python.exe` (plain `python` is the system Python).

## Pipeline commands (run from this `ml` folder)

```powershell
.\venv\Scripts\python.exe src\generate_data.py          # Phase 2: synthetic data -> data/raw/
.\venv\Scripts\python.exe -m src.preprocessing          # Phase 4: splits + preprocessor -> data/processed/, models/
.\venv\Scripts\python.exe -m src.train_random_forest    # Phase 5: tune + train RF (train/val only) -> models/
.\venv\Scripts\python.exe -m src.train_xgboost          # Phase 6: tune + train XGBoost, compare with RF & baseline
.\venv\Scripts\python.exe -m src.evaluate_final         # Phase 7: frozen RF on the test set
.\venv\Scripts\python.exe -m src.package_model          # Phase 8: write models/model_card.json (read-only on model)
.\venv\Scripts\python.exe -m src.verify_artifacts       # Phase 8: 67 checks on artifacts + inference
```

Every step uses fixed seeds. Re-runs of individual phases reproduced identical data and metrics, but a full
rebuild to byte-identical model files has not been tested. The checksums in `models/model_selection.json` and
`src.verify_artifacts` detect any difference.

## Model artifacts

Everything needed to predict from raw input:

| File | What it is | Needed at inference? |
|---|---|---|
| `models/random_forest.joblib` | Frozen Random Forest (500 trees, ≈ 34 MB) | **yes** |
| `models/preprocessor.joblib` | Fitted pipeline: feature engineering → train-fitted imputers → one-hot encoder (no scaler; tree model) | **yes** |
| `models/feature_schema.json` | Exact ordered list of the 69 model features + target | **yes** |
| `models/model_card.json` | Model name/type/version, hyperparameters, feature order, target, input spec, training ranges, dataset ID, split dates, validation + test metrics, limitations, artifact MD5s | **yes** (loaded first) |
| `models/model_selection.json` | Frozen selection record + checksums | for verification |
| `models/random_forest_metadata.json` | Training/tuning details (Phase 5) | reference |
| `models/final_evaluation.json` | Final test-set results (Phase 7) | reference |

`models/` is committed to the repository (largest file: `random_forest.joblib`, about 33 MB), so after cloning
the artifacts are already present. Run `src.verify_artifacts`; it fails if any file differs from the frozen version.
Do **not** re-run the training commands on a working checkout: they overwrite the frozen artifacts.

## Using the model (Python)

Run from `ml/` (or put `ml/` on `sys.path`); the saved preprocessor imports `src.preprocessing`.

```python
from src.predict import MessMindPredictor, InputValidationError

predictor = MessMindPredictor()          # loads once; verifies MD5s and feature order

result = predictor.predict_meal({
    "date": "2026-11-16", "meal_type": "lunch",
    "total_students": 1000, "total_responses": 410,           # required (same for the whole meal)
    "is_holiday": False, "is_exam_day": False, "is_festival": False,   # optional, default False
    "temperature": 29.5, "rainfall": 0.0, "previous_meal_attendance": 720,   # optional
    "dishes": [
        {"dish_name": "Rice", "dish_category": "staple_rice", "interested_taps": 170,      # required
         "historical_dish_demand": 680.0, "historical_dish_rating": 3.8,                    # optional but
         "previous_leftover_kg": 12.0},                                                     # strongly advised
        {"dish_name": "Jeera Aloo", "dish_category": "main_veg", "interested_taps": 90},
    ],
})
# result["predictions"] (actual output of this example):
#   Rice       -> predicted_consumers 535 (raw 535.38), warnings []
#   Jeera Aloo -> predicted_consumers 207 (raw 207.3),  warnings ['unseen_dish', 'new_dish_no_history',
#                 'imputed:historical_dish_rating', 'imputed:previous_leftover_kg']
```

**What happens inside `predict_meal` / `predict_records`:**
1. **Validate**:
   * required fields present; numbers finite;
   * `total_students > 0`, `0 ≤ interested_taps ≤ total_responses ≤ total_students`;
   * strict `YYYY-MM-DD` date; `meal_type` ∈ breakfast/lunch/dinner;
   * ranges for optional fields; no duplicate dish within a meal.

   All problems are raised together as `InputValidationError(errors=[...])`.
2. **Fill defaults**: `day_of_week` and `is_weekend` are derived from the date; missing flags are set to `False`; missing optional numbers become NaN.
3. **Transform** with the *saved* pipeline (never refitted):
   * engineered ratios (`tap_share`, `response_rate`, `projected_interest`), `num_dishes_in_meal`, `is_new_dish`;
   * missing history is filled from training medians;
   * one-hot encoding, where an unseen dish → all zeros, falling back to its category.
4. **Check the feature order** against the schema, then **predict**.
5. **Post-process**: round to whole students and clip to `[0, total_students]`; bounds are re-checked.
6. **Return** `predicted_consumers` (int), `raw_prediction` and `warnings`:

| Warning | Meaning |
|---|---|
| `unseen_dish` | The dish name was not in training |
| `unseen_dish_category` | The dish category was not in training |
| `new_dish_no_history` | No `historical_dish_demand` was sent |
| `imputed:<field>` | That optional field was filled from training data |
| `no_app_responses` | No students responded in the app for this meal |
| `total_students_outside_training_range` | The mess size differs from the 1000 students seen in training |
| `clipped_to_valid_range` | The raw prediction was outside `[0, total_students]` and was clipped |

> **Important:** send `historical_dish_demand` for every dish that has been served before. If it is
> missing, the dish is treated as **new** and predictions get worse.

## Prediction API (FastAPI)

Independent HTTP service for the main backend. It implements
[../shared/api_contract.md](../shared/api_contract.md) **v0.3**, loads the packaged model **once** at
startup, and never touches the database.

**Setup and start** (from this `ml` folder; dependencies come from `requirements.txt`):

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt          # only if not installed yet
.\venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001
```

* Local URL: **http://127.0.0.1:8001**
* Swagger UI (try requests in the browser): **http://127.0.0.1:8001/docs** · OpenAPI JSON: `/openapi.json`
* Optional: set the env var `MESSMIND_MODELS_DIR` to load artifacts from another folder.
* If the artifacts are missing or changed, the server still starts in a **degraded** state:
  `/health` reports `model_loaded: false`, and prediction endpoints return **503**.

**Endpoints**

| Method & path | Purpose |
|---|---|
| `GET /health` | `{"status": "ok", "model_loaded": true, "model_version": "rf-v1-synthetic"}` (`degraded` / `false` if the model failed to load) |
| `GET /model-info` | Model version/type, `trained_on`, `frozen_on`, target, the 69 ordered feature names, known meal types/categories/dishes, validation/test MAE, limitations. No file paths. |
| `POST /predict` | One meal with all its dishes → one prediction per dish |
| `POST /predict/batch` | `{"meals": [...]}`, 1–100 meals → per-meal results. An invalid meal gets `status: "error"` and doesn't block the others. Malformed body → 422 |

**Example: `POST /predict`** (actual output of the frozen model)

```json
{
  "meal_id": "2026-11-16-lunch", "date": "2026-11-16", "meal_type": "lunch",
  "total_students": 1000, "total_responses": 410,
  "is_holiday": false, "is_exam_day": false, "is_festival": false,
  "temperature": 29.5, "rainfall": 0.0, "previous_meal_attendance": 720,
  "dishes": [
    {"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true,
     "is_special": false, "interested_taps": 170, "historical_dish_demand": 680.0,
     "historical_dish_rating": 3.8, "previous_leftover_kg": 12.0},
    {"dish_id": "D045", "dish_name": "Jeera Aloo", "dish_category": "main_veg", "is_veg": true,
     "interested_taps": 90}
  ]
}
```

Response `200`:

```json
{
  "meal_id": "2026-11-16-lunch", "model_version": "rf-v1-synthetic", "trained_on": "synthetic",
  "predictions": [
    {"dish_id": "D001", "interested_taps": 170, "predicted_consumers": 535, "warnings": []},
    {"dish_id": "D045", "interested_taps": 90, "predicted_consumers": 207,
     "warnings": ["unseen_dish", "new_dish_no_history", "imputed:historical_dish_rating",
                  "imputed:previous_leftover_kg"]}
  ]
}
```

Validation error example (`422`), sent when `interested_taps` > `total_responses`:

```json
{"detail": [{"loc": [], "msg": "Value error, dishes[0].interested_taps must be <= total_responses", "type": "value_error"}]}
```

From PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/predict -ContentType "application/json" -InFile meal.json
```

**Run the tests** (82 tests: API behaviour + checks that every documented example matches the live API; no server needs to be running):

```powershell
.\venv\Scripts\python.exe -m pytest
```

**Backend integration:** [docs/integration_handoff.md](docs/integration_handoff.md) (everything the backend developer needs) and [docs/integration_checklist.md](docs/integration_checklist.md) (step-by-step).

**Code layout:** `api/main.py` (app setup and error handlers) · `api/routes.py` (endpoints) ·
`api/schemas.py` (contract validation) · `api/model_loader.py` (loads the model once and adapts requests to
`src/predict.py`) · `tests/test_api.py`.

## Development rules

- Split data **chronologically** (train → validation → test by date).
- Historical features use **only earlier meals** (`shift(1)` before rolling).
- Always compare ML models against a simple baseline.
- Never report metrics that were not actually produced by running the code.
- Never retrain or modify the frozen model in place; a new model needs a new version and new evaluation data.
