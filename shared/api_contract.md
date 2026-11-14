# MessMind — ML Prediction API Contract (v0.3, DRAFT)

> **Owners:** ML service — Developer 1. Caller (main backend) — Developer 2.
> **Status:** v0.3 implements decisions approved by Developer 1 on 2026-11-14 (see changelog).
> **Developer 2 must review and agree** before the backend depends on it.
> Changes after agreement bump the version and are noted in the changelog below.

## 1. Principles

- The ML service is a **separate FastAPI process**. It never connects to PostgreSQL.
- The main backend calls it over HTTP and stores the returned predictions itself.
- The ML service is **stateless**. The backend sends everything known **before the meal**: menu, taps,
  context, and **each dish's history**, which it computes from past actuals stored in PostgreSQL (see §2.5).
- Predictions come from a model trained on **synthetic data** (`trained_on: "synthetic"`). Do not use
  them for real cooking decisions until the model has been retrained on real records (§3).

Base URL (local dev): `http://localhost:8001` · Interactive docs: `http://localhost:8001/docs`

## 2. Endpoints

### 2.1 `GET /health`

```json
{ "status": "ok", "model_loaded": true, "model_version": "rf-v1-synthetic" }
```

If the model artifacts could not be loaded, the endpoint still answers with HTTP 200:
`{ "status": "degraded", "model_loaded": false, "model_version": null }`.
Use `model_loaded` to decide whether to call `/predict`.

### 2.2 `GET /model-info`

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
  "feature_names": ["historical_dish_demand", "...", "dish_name_Vegetable Soup"],
  "meal_types": ["breakfast", "lunch", "dinner"],
  "known_dish_categories": ["beverage", "bread", "breakfast_item", "dal", "dessert", "fruit", "main_nonveg", "main_veg", "side", "staple_rice"],
  "known_dish_names": ["Aloo Gobi", "..."],
  "metrics": { "validation_mae": 31.08, "test_mae": 31.44, "test_baseline_mae": 56.22 },
  "limitations": ["..."]
}
```

`trained_at` from v0.2 was replaced by `frozen_on`, the date the model was frozen (no training timestamp was recorded).
No filesystem paths are exposed.

### 2.3 `POST /predict`

Predicts actual consumers for **every dish in one meal**. The whole menu must be sent in one request, because
the model uses the menu size and the meal's shared `total_responses`.

**Request**

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

**Meal-level fields**

| Field | Type | Required | Rules |
|---|---|---|---|
| `meal_id` | string | yes | Backend's unique ID for the meal; 1–100 characters. Echoed back. |
| `date` | string `YYYY-MM-DD` | yes | A real calendar date. |
| `meal_type` | enum | yes | `breakfast` \| `lunch` \| `dinner` |
| `total_students` | int | yes | > 0. *The model was trained only on a 1000-student mess; other sizes are warned (§2.6).* |
| `total_responses` | int | yes | Distinct students who responded in the app for this meal (at the voting cut-off); 0 ≤ x ≤ `total_students` |
| `is_holiday` | bool | no (default `false`) | |
| `is_exam_day` | bool | no (default `false`) | |
| `is_festival` | bool | no (default `false`) | |
| `temperature` | float °C | no | −30 … 60. Forecast for the day. If missing, the ML service uses its training median. |
| `rainfall` | float mm | no | ≥ 0. Forecast for the day. If missing, training median. |
| `previous_meal_attendance` | int | no | 0 ≤ x ≤ `total_students`. Headcount of the meal immediately before this one. If missing, training median. |
| `dishes` | array | yes | 1–30 items. `dish_id`s unique **and** `dish_name`s unique within the meal. |

**Dish-level fields**

| Field | Type | Required | Rules |
|---|---|---|---|
| `dish_id` | string | yes | Stable across menus. Echoed back. Not used by the model. |
| `dish_name` | string | yes | Non-empty. Unknown names are accepted (warning `unseen_dish`). |
| `dish_category` | string | yes | Non-empty. Recommended values: `staple_rice`, `bread`, `dal`, `main_veg`, `main_nonveg`, `side`, `dessert`, `beverage`, `breakfast_item`, `fruit`. Other values are accepted with warning `unseen_dish_category`. |
| `is_veg` | bool | yes | Not used by the current model. |
| `is_special` | bool | no (default `false`) | Not used by the current model. |
| `interested_taps` | int | yes | 0 ≤ x ≤ `total_responses`. Counted at the voting cut-off. |
| `historical_dish_demand` | float | no, **strongly recommended** | ≥ 0. See §2.5. If missing, the dish is treated as **new** (warning `new_dish_no_history`). |
| `historical_dish_rating` | float | no | 1 … 5. See §2.5. If missing, training median for the dish category. |
| `previous_leftover_kg` | float | no | ≥ 0. See §2.5. If missing, training median for the dish category. |

All numbers must be finite. `NaN` and `Infinity` are rejected. Integer fields must be JSON integers (`1000`, not `1000.5` or `"1000"`).
Booleans must be JSON `true`/`false`.

**Response `200`**

```json
{
  "meal_id": "2026-11-16-lunch",
  "model_version": "rf-v1-synthetic",
  "trained_on": "synthetic",
  "predictions": [
    { "dish_id": "D001", "interested_taps": 170, "predicted_consumers": 535, "warnings": [] },
    { "dish_id": "D045", "interested_taps": 90, "predicted_consumers": 207,
      "warnings": ["unseen_dish", "new_dish_no_history", "imputed:historical_dish_rating", "imputed:previous_leftover_kg"] }
  ]
}
```

*(Actual output of the frozen model for the request above.)*

- `predictions` are in the **same order** as `dishes`.
- `predicted_consumers` is an integer in `[0, total_students]` (rounded, then clipped).
- The **sum** of `predicted_consumers` across dishes can exceed `total_students`. That is expected, because students eat several dishes.

### 2.4 `POST /predict/batch`

Predicts several meals in one call. **Each meal is validated and predicted independently**: one invalid
meal does not block the others.

**Request**

```json
{ "meals": [ { ...meal like /predict... }, { ...another meal... } ] }
```

`meals`: 1–100 items.

**Response `200`** (also when some meals are invalid)

```json
{
  "model_version": "rf-v1-synthetic",
  "trained_on": "synthetic",
  "n_meals": 2,
  "n_succeeded": 1,
  "n_failed": 1,
  "results": [
    { "index": 0, "meal_id": "2026-11-16-lunch", "status": "ok",
      "prediction": { "...same as /predict response..." }, "errors": null },
    { "index": 1, "meal_id": "2026-11-16-dinner", "status": "error", "prediction": null,
      "errors": [ { "loc": ["total_students"], "msg": "Input should be greater than 0" } ] }
  ]
}
```

- `results[i]` corresponds to `meals[i]`. `meal_id` is `null` if it could not be read.
- The whole request returns **422** only if the body itself is malformed (not JSON, no `meals` list, 0 or more than 100 meals).

### 2.5 How the backend computes history fields

All three use **only meals that happened before** the meal being predicted, never the current meal.

| Field | Definition |
|---|---|
| `historical_dish_demand` | Mean `actual_dish_consumers` of this dish at **this meal type** over its **last 5** past servings (fewer if served fewer times). Omit if never served. |
| `historical_dish_rating` | Mean post-meal rating of this dish (any meal type) over its last 5 past servings. Omit if no ratings. |
| `previous_leftover_kg` | Leftover kg of this dish at its most recent past serving at this meal type. Omit if unknown. |

### 2.6 Warnings

| Warning | Meaning |
|---|---|
| `unseen_dish` | The dish name was not in the training data; the prediction relies on its category |
| `unseen_dish_category` | The category was not in the training data |
| `new_dish_no_history` | No `historical_dish_demand` was sent; the dish is treated as new |
| `imputed:<field>` | An optional field was missing and filled from training data |
| `no_app_responses` | `total_responses` = 0 |
| `total_students_outside_training_range` | Mess size differs from the 1000 students seen in training |
| `clipped_to_valid_range` | The raw model output was outside `[0, total_students]` and was clipped |

### 2.7 Errors

| Code | When | Body |
|---|---|---|
| `422` | Request fails validation | `{ "detail": [ { "loc": [...], "msg": "...", "type": "..." } ] }` |
| `503` | Model not loaded | `{ "detail": "model not loaded" }` |
| `500` | Unexpected internal error | `{ "detail": "internal error" }` (no internal details) |

## 3. Training-data export (backend → ML)

To retrain on real data, the backend exports completed meals as CSV (one row per dish per meal):

```
meal_id,date,meal_type,total_students,is_holiday,is_exam_day,is_festival,temperature,rainfall,
total_responses,meal_attendance,dish_id,dish_name,dish_category,is_veg,is_special,interested_taps,
actual_dish_consumers,leftover_kg,post_meal_rating
```

- `actual_dish_consumers` is the training target, entered by the admin after the meal.
- `meal_attendance`, `leftover_kg`, `post_meal_rating` are optional and are **never** used as
  inputs for the same meal; the ML side turns them into history features for *later* meals
  (`previous_meal_attendance`, `previous_leftover_kg`, `historical_dish_rating`).
- Only meals with `actual_dish_consumers` filled in should be exported.

## 4. Open questions (to agree with Developer 2)

1. Is `meal_type` list correct for our mess? (breakfast / lunch / dinner only.)
2. Who owns the holiday / exam calendar — admin input in the backend (then sent in request) or a static file?
3. ~~Final `dish_category` list~~ → **resolved in v0.3**: free text, recommended values in §2.3.
4. Port number and how the backend discovers the ML URL (env var `ML_API_URL` suggested).
5. When does the backend call `/predict`? It must be **after app voting closes** (the cut-off), so taps are final.
6. Does the backend record a total headcount per meal and a post-meal dish rating? They feed
   `previous_meal_attendance` and `historical_dish_rating`. **History source resolved in v0.3**: the backend computes
   and sends history (§2.5).
7. Where does weather come from — backend fetches a forecast and sends it, or ML uses defaults (current behaviour if omitted)?

## Changelog

- **v0.3** (2026-11-14) — decisions approved by Developer 1:
  * History is sent by the backend: new optional dish fields `historical_dish_demand`,
    `historical_dish_rating`, `previous_leftover_kg` (§2.5). The ML service is stateless.
  * New endpoint `POST /predict/batch` with **per-meal** results/errors (§2.4).
  * One `/predict` request = one meal with all its dishes (unchanged shape); `dish_name` must also be unique per meal.
  * `dish_category` is free text with recommended values (adds `fruit`, removes `snack_item` from the list); unknown → warning.
  * `/model-info`: `trained_at` → `frozen_on`; added target, features, known categories, metrics, limitations.
  * `/health`: degraded state documented; `500` error documented; warnings table (§2.6); numeric rules made explicit.
  * Mock mode removed (a real model is available).
- **v0.2** — field names aligned with the Phase 2 training data (`total_students`, `total_responses`,
  `interested_taps`, `is_exam_day`); added `is_festival`, `temperature`, `rainfall`,
  `previous_meal_attendance`; dropped `snacks`; export adds `meal_attendance`, `post_meal_rating`.
- **v0.1** — initial draft (Phase 1).
