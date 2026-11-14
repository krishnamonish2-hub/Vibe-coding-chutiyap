# MessMind — ML Service Integration Handoff

> **For:** the backend developer connecting the main MessMind backend to the ML prediction service.
> **Contract:** [`shared/api_contract.md`](../../shared/api_contract.md) **v0.3 (DRAFT — needs your sign-off)**.
> **Model:** Random Forest `rf-v1-synthetic`, trained on **synthetic data only**. Treat predictions as a
> demo until the model is retrained on real records.
> **Every JSON example in this document is real output** of the running service. `tests/test_integration_docs.py`
> re-sends each request and fails if any response here goes out of date.
> Step-by-step task list: [`integration_checklist.md`](integration_checklist.md).

---

## 1. Architecture

```
 Students' app ─┐                                         ┌──────────── ML service (this repo: ml/) ────────────┐
 Admin dashboard┴─► Main backend ──► PostgreSQL           │  FastAPI  (api/main.py, api/routes.py)               │
                    (your code)                           │    └─ request validation  (api/schemas.py)           │
                         │  HTTP JSON (server-to-server)  │    └─ model service       (api/model_loader.py)      │
                         └───────────────────────────────►│          └─ src/predict.py  (2nd validation, predict) │
                           POST /predict  /predict/batch  │                └─ models/  (frozen artifacts, read-only)│
                           GET  /health   /model-info     └──────────────────────────────────────────────────────┘
```

* **Independent and stateless.** The ML service has no database and keeps no history. Everything it needs
  arrives in each request, so you can restart it at any time without losing anything.
* **Only the backend calls it.** The frontend must not call the ML service directly, which is why no CORS is configured.
* **No authentication.** Run it on `localhost` or a private network only, never on a public interface.
* **One model, frozen.** Artifacts are checked by MD5 at startup. The service never trains or refits anything.

## 2. Running the ML service

From the `ml/` folder (Windows PowerShell):

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt       # once
.\venv\Scripts\python.exe -m src.verify_artifacts                  # optional: 67 artifact checks
.\venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001
```

| Item | Value |
|---|---|
| Base URL | `http://127.0.0.1:8001` (contract: `http://localhost:8001`) |
| Swagger UI | `http://127.0.0.1:8001/docs` |
| OpenAPI JSON | `http://127.0.0.1:8001/openapi.json` |
| Artifacts folder | `ml/models/` (committed). Override with env var `MESSMIND_MODELS_DIR` |
| Startup log line | `INFO messmind.api: Loaded rf-v1-synthetic (69 features, trained_on=synthetic)` |
| Tests | `.\venv\Scripts\python.exe -m pytest` (no server needed) |

The `models/` folder is committed to the repository (the model is about 33 MB), so a fresh clone has everything.
Run `src.verify_artifacts` to confirm the files match the frozen versions.

## 3. Backend → ML communication flow

```
 1  Admin publishes the menu for a meal (dish_id, dish_name, dish_category, is_veg, is_special)
 2  Students tap dishes in the app ........................ until the VOTING CUT-OFF
 3  At/after the cut-off the backend freezes the counts:
       interested_taps per dish  (distinct students who tapped that dish)
       total_responses           (distinct students who responded for this meal)
 4  Backend gathers context: total_students, calendar flags, weather forecast (optional)
 5  Backend computes HISTORY from completed past meals only (Section 6)
 6  GET  /health  -> model_loaded == true ?  (can be cached for a few minutes)
 7  POST /predict (one meal)  or  POST /predict/batch (several meals, e.g. tomorrow's three)
 8  Backend stores each prediction with model_version, trained_on, warnings, timestamp
    and the exact request it sent (needed to audit or re-check later)
 9  Dashboard shows predicted_consumers (+ "synthetic model" notice, + warnings)
10  After the meal the admin enters actual_dish_consumers (+ leftover_kg, rating, headcount)
    -> these become HISTORY for future meals, and training data later (contract Section 3)
```

**Timing rules**
* Call `/predict` **after** the voting cut-off. The model was trained on *final* tap counts, so taps
  still coming in would make it under-predict.
* If you call `/predict` again for the same meal (for example on each dashboard load), send the **same frozen
  inputs**. Never let actuals or leftovers from that meal leak into a later request for it.

**Handling responses**

| HTTP | Meaning | What the backend should do |
|---|---|---|
| 200 | Predictions returned | Store them and show them with their `warnings` |
| 422 | Your request broke a validation rule | It is a bug in the payload: log `detail`, do **not** retry unchanged |
| 503 `{"detail":"model not loaded"}` | ML service up but model failed to load | Show "prediction unavailable"; alert the ML developer; retry later |
| 500 `{"detail":"internal error"}` | Unexpected ML error | Retry once; then show "prediction unavailable" and report |
| timeout / connection refused | ML service down | Show "prediction unavailable". Suggested timeout: 10 s; a 5-dish meal takes about 0.3 s locally |

When predictions are unavailable, **do not invent numbers**: show no prediction, or show raw tap counts clearly
labelled as taps.

## 4. Endpoints (exact examples)

### 4.1 `GET /health`

Model loaded:

<!-- example id=health method=GET path=/health status=200 -->
```json
{
  "status": "ok",
  "model_loaded": true,
  "model_version": "rf-v1-synthetic"
}
```

Model artifacts missing or changed. The service still runs and answers with HTTP 200:

<!-- example id=health-degraded method=GET path=/health status=200 server=degraded -->
```json
{
  "status": "degraded",
  "model_loaded": false,
  "model_version": null
}
```

### 4.2 `GET /model-info`

Use it to display the model version and limitations, and to see which dish names and categories the model knows.

<details><summary>Full response (HTTP 200)</summary>

<!-- example id=model-info method=GET path=/model-info status=200 -->
```json
{
  "model_version": "rf-v1-synthetic",
  "model_type": "random_forest",
  "trained_on": "synthetic",
  "frozen_on": "2026-11-14",
  "feature_schema_version": "0.1",
  "contract_version": "0.3",
  "target": "actual_dish_consumers",
  "n_features": 69,
  "feature_names": [
    "historical_dish_demand",
    "historical_dish_rating",
    "previous_leftover_kg",
    "day_of_week",
    "temperature",
    "rainfall",
    "previous_meal_attendance",
    "interested_taps",
    "total_responses",
    "tap_share",
    "response_rate",
    "projected_interest",
    "num_dishes_in_meal",
    "is_weekend",
    "is_holiday",
    "is_exam_day",
    "is_festival",
    "is_new_dish",
    "meal_type_breakfast",
    "meal_type_dinner",
    "meal_type_lunch",
    "dish_category_beverage",
    "dish_category_bread",
    "dish_category_breakfast_item",
    "dish_category_dal",
    "dish_category_dessert",
    "dish_category_fruit",
    "dish_category_main_nonveg",
    "dish_category_main_veg",
    "dish_category_side",
    "dish_category_staple_rice",
    "dish_name_Aloo Gobi",
    "dish_name_Aloo Matar",
    "dish_name_Aloo Paratha",
    "dish_name_Banana",
    "dish_name_Bhindi Fry",
    "dish_name_Boiled Eggs",
    "dish_name_Bread Omelette",
    "dish_name_Buttermilk",
    "dish_name_Chapati",
    "dish_name_Chicken Biryani",
    "dish_name_Chicken Curry",
    "dish_name_Chole",
    "dish_name_Coffee",
    "dish_name_Cornflakes and Milk",
    "dish_name_Curd",
    "dish_name_Dal Fry",
    "dish_name_Dal Tadka",
    "dish_name_Egg Curry",
    "dish_name_Gulab Jamun",
    "dish_name_Ice Cream",
    "dish_name_Idli Sambar",
    "dish_name_Kadai Paneer",
    "dish_name_Kadhi",
    "dish_name_Kheer",
    "dish_name_Lauki Sabzi",
    "dish_name_Masala Dosa",
    "dish_name_Mixed Veg",
    "dish_name_Palak Paneer",
    "dish_name_Paneer Butter Masala",
    "dish_name_Poha",
    "dish_name_Rajma",
    "dish_name_Rice",
    "dish_name_Salad",
    "dish_name_Soya Chunks",
    "dish_name_Tea",
    "dish_name_Upma",
    "dish_name_Veg Biryani",
    "dish_name_Vegetable Soup"
  ],
  "meal_types": [
    "breakfast",
    "lunch",
    "dinner"
  ],
  "known_dish_categories": [
    "beverage",
    "bread",
    "breakfast_item",
    "dal",
    "dessert",
    "fruit",
    "main_nonveg",
    "main_veg",
    "side",
    "staple_rice"
  ],
  "known_dish_names": [
    "Aloo Gobi",
    "Aloo Matar",
    "Aloo Paratha",
    "Banana",
    "Bhindi Fry",
    "Boiled Eggs",
    "Bread Omelette",
    "Buttermilk",
    "Chapati",
    "Chicken Biryani",
    "Chicken Curry",
    "Chole",
    "Coffee",
    "Cornflakes and Milk",
    "Curd",
    "Dal Fry",
    "Dal Tadka",
    "Egg Curry",
    "Gulab Jamun",
    "Ice Cream",
    "Idli Sambar",
    "Kadai Paneer",
    "Kadhi",
    "Kheer",
    "Lauki Sabzi",
    "Masala Dosa",
    "Mixed Veg",
    "Palak Paneer",
    "Paneer Butter Masala",
    "Poha",
    "Rajma",
    "Rice",
    "Salad",
    "Soya Chunks",
    "Tea",
    "Upma",
    "Veg Biryani",
    "Vegetable Soup"
  ],
  "metrics": {
    "validation_mae": 31.08,
    "test_mae": 31.44,
    "test_baseline_mae": 56.22
  },
  "limitations": [
    "Trained and evaluated only on SYNTHETIC data: metrics show how well simulated patterns are learned, not real-mess accuracy. Retrain on real records before using predictions for real cooking decisions.",
    "Exam days not in training: exam-day demand under-predicted (~ -17 to -22 consumers).",
    "Tree model ceiling: demand above the training maximum (830) is under-predicted.",
    "Missing optional inputs (attendance, leftovers, rating) raise MAE to ~42.",
    "Missing historical_dish_demand marks a dish as NEW; known dishes must be sent with their history.",
    "total_students was constant (1000) in training: the model does not know how demand scales with mess size. Other sizes are only kept valid by clipping (warning: total_students_outside_training_range).",
    "Small evaluation sets (val 182 rows / 13 days, test 215 rows / 14 days)."
  ]
}
```
</details>

### 4.3 `POST /predict`: one meal with all its dishes

Request (the contract v0.3 §2.3 example):

<!-- example id=predict part=request method=POST path=/predict -->
```json
{
  "meal_id": "2026-11-16-lunch",
  "date": "2026-11-16",
  "meal_type": "lunch",
  "total_students": 1000,
  "total_responses": 410,
  "is_holiday": false,
  "is_exam_day": false,
  "is_festival": false,
  "temperature": 29.5,
  "rainfall": 0.0,
  "previous_meal_attendance": 720,
  "dishes": [
    {
      "dish_id": "D001",
      "dish_name": "Rice",
      "dish_category": "staple_rice",
      "is_veg": true,
      "is_special": false,
      "interested_taps": 170,
      "historical_dish_demand": 680.0,
      "historical_dish_rating": 3.8,
      "previous_leftover_kg": 12.0
    },
    {
      "dish_id": "D045",
      "dish_name": "Jeera Aloo",
      "dish_category": "main_veg",
      "is_veg": true,
      "interested_taps": 90
    }
  ]
}
```

Response:

<!-- example id=predict method=POST path=/predict status=200 -->
```json
{
  "meal_id": "2026-11-16-lunch",
  "model_version": "rf-v1-synthetic",
  "trained_on": "synthetic",
  "predictions": [
    {
      "dish_id": "D001",
      "interested_taps": 170,
      "predicted_consumers": 535,
      "warnings": []
    },
    {
      "dish_id": "D045",
      "interested_taps": 90,
      "predicted_consumers": 207,
      "warnings": [
        "unseen_dish",
        "new_dish_no_history",
        "imputed:historical_dish_rating",
        "imputed:previous_leftover_kg"
      ]
    }
  ]
}
```

Rice has full history and gets no warnings. Jeera Aloo is unknown to the model and has no history, so it gets
`unseen_dish` and `new_dish_no_history`.

Request with **only the required fields** (no history, no weather, no flags):

<!-- example id=predict-minimal part=request method=POST path=/predict -->
```json
{
  "meal_id": "2026-11-17-breakfast",
  "date": "2026-11-17",
  "meal_type": "breakfast",
  "total_students": 1000,
  "total_responses": 300,
  "dishes": [
    {"dish_id": "D101", "dish_name": "Tea", "dish_category": "beverage", "is_veg": true, "interested_taps": 150},
    {"dish_id": "D102", "dish_name": "Poha", "dish_category": "breakfast_item", "is_veg": true, "interested_taps": 110}
  ]
}
```

<!-- example id=predict-minimal method=POST path=/predict status=200 -->
```json
{
  "meal_id": "2026-11-17-breakfast",
  "model_version": "rf-v1-synthetic",
  "trained_on": "synthetic",
  "predictions": [
    {
      "dish_id": "D101",
      "interested_taps": 150,
      "predicted_consumers": 513,
      "warnings": [
        "imputed:temperature",
        "imputed:rainfall",
        "imputed:previous_meal_attendance",
        "new_dish_no_history",
        "imputed:historical_dish_rating",
        "imputed:previous_leftover_kg"
      ]
    },
    {
      "dish_id": "D102",
      "interested_taps": 110,
      "predicted_consumers": 315,
      "warnings": [
        "imputed:temperature",
        "imputed:rainfall",
        "imputed:previous_meal_attendance",
        "new_dish_no_history",
        "imputed:historical_dish_rating",
        "imputed:previous_leftover_kg"
      ]
    }
  ]
}
```

This works, but **Tea and Poha are treated as new dishes** because no history was sent. Expect worse accuracy
(Section 6.6).

### 4.4 `POST /predict/batch`: several meals, per-meal results

The second meal is deliberately invalid (`total_students: 0`). It fails on its own, and the first meal is still predicted.

<!-- example id=batch part=request method=POST path=/predict/batch -->
```json
{
  "meals": [
    {
      "meal_id": "2026-11-17-breakfast",
      "date": "2026-11-17",
      "meal_type": "breakfast",
      "total_students": 1000,
      "total_responses": 300,
      "dishes": [
        {"dish_id": "D101", "dish_name": "Tea", "dish_category": "beverage", "is_veg": true, "interested_taps": 150,
         "historical_dish_demand": 560.0, "historical_dish_rating": 3.7, "previous_leftover_kg": 4.0}
      ]
    },
    {
      "meal_id": "2026-11-17-lunch",
      "date": "2026-11-17",
      "meal_type": "lunch",
      "total_students": 0,
      "total_responses": 0,
      "dishes": [
        {"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 0}
      ]
    }
  ]
}
```

<!-- example id=batch method=POST path=/predict/batch status=200 -->
```json
{
  "model_version": "rf-v1-synthetic",
  "trained_on": "synthetic",
  "n_meals": 2,
  "n_succeeded": 1,
  "n_failed": 1,
  "results": [
    {
      "index": 0,
      "meal_id": "2026-11-17-breakfast",
      "status": "ok",
      "prediction": {
        "meal_id": "2026-11-17-breakfast",
        "model_version": "rf-v1-synthetic",
        "trained_on": "synthetic",
        "predictions": [
          {
            "dish_id": "D101",
            "interested_taps": 150,
            "predicted_consumers": 590,
            "warnings": [
              "imputed:temperature",
              "imputed:rainfall",
              "imputed:previous_meal_attendance"
            ]
          }
        ]
      },
      "errors": null
    },
    {
      "index": 1,
      "meal_id": "2026-11-17-lunch",
      "status": "error",
      "prediction": null,
      "errors": [
        {
          "loc": [
            "total_students"
          ],
          "msg": "Input should be greater than 0",
          "type": "greater_than"
        }
      ]
    }
  ]
}
```

* `results[i]` always corresponds to `meals[i]`; check `status` for each one.
* Limits: 1–100 meals per batch, and 1–30 dishes per meal.
* The whole batch is rejected (422) **only** if the body is malformed:

<!-- example id=batch-empty part=request method=POST path=/predict/batch -->
```json
{"meals": []}
```

<!-- example id=batch-empty method=POST path=/predict/batch status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        "meals"
      ],
      "msg": "List should have at least 1 item after validation, not 0",
      "type": "too_short"
    }
  ]
}
```

## 5. Input fields

### 5.1 Meal-level fields

| Field | Type | Required | Rule | How the backend gets it |
|---|---|---|---|---|
| `meal_id` | string | **yes** | 1–100 chars | Your meal primary key, echoed back |
| `date` | string `YYYY-MM-DD` | **yes** | real date | Meal date (local date of the mess) |
| `meal_type` | `breakfast`/`lunch`/`dinner` | **yes** | exact lowercase | Menu |
| `total_students` | integer | **yes** | > 0 | Students registered with this mess on that date |
| `total_responses` | integer | **yes** | 0 ≤ x ≤ `total_students` | Distinct students who responded in the app for this meal, counted at the cut-off (open item D9) |
| `is_holiday` | boolean | no (`false`) | | Academic calendar (open item D4) |
| `is_exam_day` | boolean | no (`false`) | | Academic calendar |
| `is_festival` | boolean | no (`false`) | | Calendar / admin flag |
| `temperature` | number °C | no | −30 … 60 | Daily forecast (open item D5). If omitted, the training median is used |
| `rainfall` | number mm | no | ≥ 0 | Daily forecast. If omitted, the training median is used |
| `previous_meal_attendance` | integer | no | 0 ≤ x ≤ `total_students` | History (Section 6.5). If omitted, the training median is used |
| `dishes` | array | **yes** | 1–30 items; unique `dish_id` and unique `dish_name` | The meal's full menu, **all dishes in one request** |

### 5.2 Dish-level fields

| Field | Type | Required | Rule | How the backend gets it |
|---|---|---|---|---|
| `dish_id` | string | **yes** | 1–100 chars, unique in meal | Your dish key (stable across menus), echoed back |
| `dish_name` | string | **yes** | 1–100 chars, unique in meal | Dish name. Unknown names are accepted with the warning `unseen_dish` |
| `dish_category` | string | **yes** | 1–100 chars | Recommended: `staple_rice`, `bread`, `dal`, `main_veg`, `main_nonveg`, `side`, `dessert`, `beverage`, `breakfast_item`, `fruit`. Others are accepted with the warning `unseen_dish_category` |
| `is_veg` | boolean | **yes** | | Dish master data (not used by the model yet) |
| `is_special` | boolean | no (`false`) | | Dish master data (not used by the model yet) |
| `interested_taps` | integer | **yes** | 0 ≤ x ≤ `total_responses` | Distinct students who tapped this dish for this meal, counted at the cut-off |
| `historical_dish_demand` | number | no, **strongly recommended** | ≥ 0 | Section 6.2 |
| `historical_dish_rating` | number | no | 1 … 5 | Section 6.3 |
| `previous_leftover_kg` | number | no | ≥ 0 | Section 6.4 |

`interested_taps` is an **input**, recorded before the meal. `predicted_consumers` estimates the *actual* eaters,
and it is usually much higher than taps because many students never use the app.

## 6. History fields in detail (contract §2.5)

The model learned from history computed in one specific way. If the backend computes it differently, the model
receives numbers it misreads. Follow these definitions exactly.

### 6.1 The golden rule: no future data (leakage)

> A history value for meal **M** may only use meals that **finished before M started**, and whose results
> have **already been entered**. Never use anything recorded for M itself, even when you re-request a
> prediction for M after it happened.

Meal order: `breakfast` (0) → `lunch` (1) → `dinner` (2) → next day's `breakfast`. "Before M" means an
earlier date, **or** the same date with a lower meal order.

### 6.2 `historical_dish_demand`

| | |
|---|---|
| **Meaning** | How many students *actually* ate this dish recently, at this meal type |
| **Type / unit** | number (float), students (consumers per serving) |
| **Required?** | Optional in the contract, but **send it for every dish that has been served before**. Without it, the dish is treated as **new** |
| **Source** | Your table of actual consumption per dish per meal (`actual_dish_consumers`, entered by the admin) |
| **Definition** | Mean of `actual_dish_consumers` over the **last 5 servings of the same dish at the same `meal_type`**, all strictly before this meal. If it was served only 1–4 times before, average those |
| **Missing** | Dish never served at this meal type, or no actuals recorded → **omit the field (or send `null`)**. Never send `0`, which would mean "nobody ate it" |
| **Timing** | Same meal type means always an earlier *date*. Only servings whose actuals have been entered |

### 6.3 `historical_dish_rating`

| | |
|---|---|
| **Meaning** | How much students liked this dish recently |
| **Type / unit** | number, rating scale **1–5** (stars) |
| **Required?** | Optional. If missing, the training median for the dish category is used (`imputed:historical_dish_rating`) |
| **Source** | Post-meal ratings (contract §3 `post_meal_rating`). Open item D6: does the app collect ratings? |
| **Definition** | For each past serving, the average rating given that serving. Then the mean of those per-serving averages over the **last 5 servings of the dish at any meal type**, strictly before this meal |
| **Missing** | No ratings recorded for this dish → **omit**. Never send a default such as `3.0` |
| **Timing** | Any meal type, so a serving earlier on the **same day** counts. Only ratings already submitted |

### 6.4 `previous_leftover_kg`

| | |
|---|---|
| **Meaning** | How much of this dish was left over the last time it was served at this meal type |
| **Type / unit** | number, **kilograms** |
| **Required?** | Optional. If missing, the training median for the dish category is used (`imputed:previous_leftover_kg`) |
| **Source** | Leftover quantity entered by the admin after the meal (contract §3 `leftover_kg`) |
| **Definition** | `leftover_kg` of the **single most recent previous serving of the same dish at the same `meal_type`** |
| **Missing** | Dish never served before, or the leftover of that most recent serving was not recorded → **omit**. Do *not* fall back to an older serving, and do not send `0`. `0` means "everything was eaten" |
| **Timing** | Same meal type means an earlier date. Only leftovers already entered |

### 6.5 `previous_meal_attendance` (meal-level, also history)

| | |
|---|---|
| **Meaning** | Total headcount of the meal slot **immediately before** this one |
| **Type / unit** | integer, students |
| **Required?** | Optional. If missing, the training median is used (`imputed:previous_meal_attendance`) |
| **Source** | A total headcount per meal (open item D6: is it recorded?). **Not** the sum of dish consumers, because students eat several dishes |
| **Definition** | Lunch → same day's breakfast; dinner → same day's lunch; breakfast → previous day's dinner |
| **Missing** | That meal was not served, or its headcount is not recorded yet → **omit** |

### 6.6 What happens when history is missing

| What is sent | Validation MAE (synthetic) |
|---|---|
| All history fields, as in training | **31.1** consumers per dish |
| No history fields at all (contract-valid) | 35.1 (every dish flagged `new_dish_no_history`) |
| Required fields only | 36.6 |
| *Baseline: "same as last 5 servings"* | *61.7* |

The ML service fills missing history with **training medians per (dish_category, meal_type)** and tells the model
the dish is new. It never invents dish-specific history. The backend should **never fill gaps with made-up or
placeholder values** either. Omit the field and let the warnings show it.

### 6.7 Illustrative SQL (adapt to your schema)

Table and column names below are **assumptions** for illustration, not a required schema. Assume one row per
dish per completed meal:
`dish_meal_actuals(meal_id, meal_date, meal_order, meal_type, dish_id, actual_dish_consumers, leftover_kg, avg_rating)`.
Parameters: `:dish_id`, `:meal_type`, `:meal_date`, `:meal_order` of the meal being predicted.

```sql
-- historical_dish_demand: last 5 servings, same dish + same meal type, strictly earlier dates
SELECT AVG(actual_dish_consumers) FROM (
  SELECT actual_dish_consumers FROM dish_meal_actuals
  WHERE dish_id = :dish_id AND meal_type = :meal_type
    AND meal_date < :meal_date AND actual_dish_consumers IS NOT NULL
  ORDER BY meal_date DESC LIMIT 5) t;                      -- NULL -> omit the field

-- historical_dish_rating: last 5 rated servings, same dish, ANY meal type, strictly before this meal
SELECT AVG(avg_rating) FROM (
  SELECT avg_rating FROM dish_meal_actuals
  WHERE dish_id = :dish_id AND avg_rating IS NOT NULL
    AND (meal_date < :meal_date OR (meal_date = :meal_date AND meal_order < :meal_order))
  ORDER BY meal_date DESC, meal_order DESC LIMIT 5) t;     -- NULL -> omit

-- previous_leftover_kg: most recent earlier serving, same dish + meal type (no fallback further back)
SELECT leftover_kg FROM dish_meal_actuals
WHERE dish_id = :dish_id AND meal_type = :meal_type AND meal_date < :meal_date
ORDER BY meal_date DESC LIMIT 1;                           -- no row or NULL -> omit
```

Tip: store the computed history together with each prediction. Then you can always show which inputs produced a
number, and re-requests stay identical.

## 7. Validation rules and error responses

**Rules enforced** (contract v0.3 §2.3 plus the implementation details marked ★):
* Required fields must be present. Every number must be finite: `NaN`, `Infinity` and `-Infinity` are rejected.
* Integer fields (`total_students`, `total_responses`, `interested_taps`, `previous_meal_attendance`) must be JSON
  integers: `170` is accepted; `170.5`, `"170"` and `true` are rejected.
* Booleans must be JSON `true`/`false` (`1` and `"yes"` are rejected).
* `total_students > 0`; `0 ≤ total_responses ≤ total_students`; `0 ≤ interested_taps ≤ total_responses`;
  `previous_meal_attendance ≤ total_students`.
* `date` is `YYYY-MM-DD` and a real date (`2026-02-30` is rejected); `meal_type` is one of the three values.
* Ranges: `temperature` −30…60, `rainfall` ≥ 0, `historical_dish_demand` ≥ 0, `historical_dish_rating` 1…5,
  `previous_leftover_kg` ≥ 0.
* Unique `dish_id` and unique `dish_name` within a meal; 1–30 dishes; batch of 1–100 meals.
* ★ **Unknown fields are rejected** (`extra_forbidden`), so a typo such as `historical_demand` cannot silently drop history.
* ★ `dish_id`, `dish_name` and `dish_category` are limited to 100 characters; surrounding whitespace is trimmed.

**Error body:** `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`. `loc` points to the field (for example
`["dishes", 0, "interested_taps"]`); cross-field rules use `loc: []`.

All examples below send a one-dish meal with a single deliberate mistake.

Cross-field rule broken (`interested_taps` > `total_responses`):

<!-- example id=err-taps part=request method=POST path=/predict -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_students": 1000, "total_responses": 400,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 401}]}
```

<!-- example id=err-taps method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [],
      "msg": "Value error, dishes[0].interested_taps must be <= total_responses",
      "type": "value_error"
    }
  ]
}
```

Missing required field (`total_students`):

<!-- example id=err-missing part=request method=POST path=/predict -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_responses": 400,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 100}]}
```

<!-- example id=err-missing method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        "total_students"
      ],
      "msg": "Field required",
      "type": "missing"
    }
  ]
}
```

Invalid `total_students` (must be > 0):

<!-- example id=err-students part=request method=POST path=/predict -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_students": 0, "total_responses": 0,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 0}]}
```

<!-- example id=err-students method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        "total_students"
      ],
      "msg": "Input should be greater than 0",
      "type": "greater_than"
    }
  ]
}
```

Wrong type (decimal taps) **and** a typo'd field name. Every problem is listed:

<!-- example id=err-type part=request method=POST path=/predict -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_students": 1000, "total_responses": 400,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 100.5,
             "historical_demand": 600.0}]}
```

<!-- example id=err-type method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        "dishes",
        0,
        "interested_taps"
      ],
      "msg": "Input should be a valid integer",
      "type": "int_type"
    },
    {
      "loc": [
        "dishes",
        0,
        "historical_demand"
      ],
      "msg": "Extra inputs are not permitted",
      "type": "extra_forbidden"
    }
  ]
}
```

Non-finite number (`NaN`, which some JSON serializers emit for missing floats; send `null` or omit instead):

<!-- example id=err-nan part=request method=POST path=/predict -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_students": 1000, "total_responses": 400, "rainfall": NaN,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 100}]}
```

<!-- example id=err-nan method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        "rainfall"
      ],
      "msg": "Input should be a finite number",
      "type": "finite_number"
    }
  ]
}
```

Body is not valid JSON (here `loc` is the character position where parsing failed):

<!-- example id=err-json part=request method=POST path=/predict -->
```text
{not json
```

<!-- example id=err-json method=POST path=/predict status=422 -->
```json
{
  "detail": [
    {
      "loc": [
        1
      ],
      "msg": "JSON decode error",
      "type": "json_invalid"
    }
  ]
}
```

Model not loaded (degraded service). The same body is returned by `/model-info` and `/predict/batch`:

<!-- example id=err-503 part=request method=POST path=/predict server=degraded -->
```json
{"meal_id": "m1", "date": "2026-11-17", "meal_type": "lunch", "total_students": 1000, "total_responses": 400,
 "dishes": [{"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": true, "interested_taps": 100}]}
```

<!-- example id=err-503 method=POST path=/predict status=503 server=degraded -->
```json
{
  "detail": "model not loaded"
}
```

Unexpected errors return `500 {"detail": "internal error"}`, with details in the ML server log only.

## 8. Model loading and prediction workflow (inside the ML service)

**At startup (once):**
1. Read `models/model_card.json`.
2. Check that `random_forest.joblib`, `preprocessor.joblib` and `feature_schema.json` exist and that their MD5s match the frozen versions.
3. Load them and confirm the 69 feature names are in the same order everywhere.
4. If anything fails, the service starts **degraded**: `/health` reports `model_loaded: false`, and predictions return 503.

**Per request:**
1. **Validate the contract** (`api/schemas.py`): types, required fields, ranges, cross-field rules. Problems → 422.
2. **Adapt** (`api/model_loader.py`): drop `meal_id`, `dish_id`, `is_veg` and `is_special`, which the model doesn't use, and keep the dish order.
3. **Validate again** (`src/predict.py`):
   * derive `day_of_week` and `is_weekend` from `date`;
   * set missing flags to `false`;
   * collect warnings.
4. **Transform with the saved, training-fitted pipeline**. It is never refitted:
   * `tap_share = taps / total_responses`;
   * `response_rate = total_responses / total_students`;
   * `projected_interest = taps × total_students / total_responses`;
   * `num_dishes_in_meal`;
   * `is_new_dish`;
   * missing history → training median per (category, meal type);
   * one-hot encoding of meal type, category and dish name, where an unseen value becomes all zeros.
5. **Predict** with the Random Forest (69 features, fixed order).
6. **Post-process**: round to a whole number and clip to `[0, total_students]`.
7. **Return** predictions in the same order as `dishes`, with warnings.

**Warnings** (show them to admins; none of them means the request failed):

| Warning | Meaning | Backend action |
|---|---|---|
| `new_dish_no_history` | `historical_dish_demand` not sent | Expected for genuinely new dishes; otherwise check your history query |
| `unseen_dish` | Dish name not in training data | Expected for real menus (the model was trained on synthetic dish names) |
| `unseen_dish_category` | Category not in the recommended list | Check spelling, or map to a recommended value |
| `imputed:<field>` | Optional field missing, filled from training data | Send the field if you have it |
| `no_app_responses` | `total_responses` = 0 | Prediction relies on history only |
| `total_students_outside_training_range` | Mess size ≠ 1000 (training value) | Treat the number with extra caution |
| `clipped_to_valid_range` | Raw output outside `[0, total_students]` | Treat the number with extra caution |

## 9. Where the implementation is stricter than the contract text

These don't conflict with contract v0.3, but the contract doesn't spell them out yet. They're suggested for v0.4,
after you review:

1. Unknown fields are rejected with 422 (`extra_forbidden`).
2. `dish_id`, `dish_name` and `dish_category` have a 100-character limit (the contract states it only for `meal_id`).
3. Error items always include `type`. The contract's §2.4 batch example shows only `loc` and `msg`.
4. Leading and trailing whitespace in strings is trimmed.

## 10. Open integration dependencies

| # | Dependency | Owner | Blocks |
|---|---|---|---|
| D1 | **Sign off contract v0.3**, especially §2.5 history | Backend + ML | Everything |
| D2 | **Compute and send history** (Section 6) from stored actuals | Backend | Good accuracy (31 vs 35–37 MAE) |
| D3 | **Voting cut-off** and when `/predict` is called (contract Q5) | Backend | Correct tap counts |
| D4 | Holiday / exam / festival calendar owner (Q2) | Backend | `is_*` flags |
| D5 | Weather forecast source (Q7). Omitting it is allowed (training median is used) | Backend | `temperature`, `rainfall` |
| D6 | Record meal **headcount** and post-meal **ratings**? (Q6) | Backend | `previous_meal_attendance`, `historical_dish_rating` |
| D7 | ML URL configuration, e.g. env var `ML_API_URL=http://127.0.0.1:8001` (Q4) | Backend | Connectivity |
| D8 | Confirm meal types are only breakfast / lunch / dinner (Q1) | Backend | `meal_type` |
| D9 | Exact definition of **`total_responses`**: distinct students who submitted any response for the meal (including "not eating", if the app offers it)? | Backend + ML | Tap-based features |
| D10 | ~~How the backend environment gets `ml/models/`~~ resolved: `ml/models/` is committed to the repository | ML | — |
| D11 | Deployment: private network only (no auth) and process supervision | Both | Production |
| D12 | **Retrain on real data** using the contract §3 export, before real decisions | ML (needs export from backend) | Real accuracy |
| D13 | Add the Section 9 details to contract v0.4 | Both | Documentation |
