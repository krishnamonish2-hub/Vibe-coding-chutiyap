# MessMind — Backend ↔ ML Integration Checklist

> Work through these steps in order. Details and exact examples are in
> [`integration_handoff.md`](integration_handoff.md); the agreement itself is
> [`shared/api_contract.md`](../../shared/api_contract.md) v0.3.
> **Owner:** **B** = backend developer · **M** = ML developer · **B+M** = both.

## Step 0: Agree the contract
- [ ] **B** Read contract v0.3 and handoff Sections 5–7.
- [ ] **B+M** Sign off v0.3, especially §2.5 (backend sends history) and §2.4 (batch semantics). Update the status line.
- [ ] **B+M** Decide the open questions: meal types (Q1), calendar owner (Q2), ML URL config (Q4), voting cut-off (Q5),
      headcount and ratings recording (Q6), weather source (Q7), exact `total_responses` definition (handoff D9).
- [ ] **B+M** Agree to add the handoff Section 9 details (unknown fields rejected, string limits, `type` in errors) to contract v0.4.

## Step 1: Run the ML service locally
- [ ] **B** Clone the repository: `ml/models/` (frozen artifacts) is included.
- [ ] **B** In `ml/`, run `.\venv\Scripts\python.exe -m pip install -r requirements.txt`.
- [ ] **B** Run `.\venv\Scripts\python.exe -m src.verify_artifacts` → `SUMMARY: 67/67 checks passed`.
- [ ] **B** Run `.\venv\Scripts\python.exe -m pytest` → all tests pass.
- [ ] **B** Start the service: `.\venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001`.
- [ ] **B** `GET http://127.0.0.1:8001/health` → `"model_loaded": true`.
- [ ] **B** Open `http://127.0.0.1:8001/docs` and send the §2.3 example with **Try it out**. Expect Rice → 535 and Jeera Aloo → 207.

## Step 2: Configure the backend
- [ ] **B** Add a setting such as `ML_API_URL=http://127.0.0.1:8001`, with no hard-coded URL.
- [ ] **B** Use an HTTP client timeout (suggested: 10 s) and send `Content-Type: application/json`.
- [ ] **B** Call the ML service **only from the backend**. The frontend never calls it.
- [ ] **B** Keep the ML service on localhost or a private network. It has no authentication.

## Step 3: Make sure the database stores what the ML needs
- [ ] **B** Menu per meal: `meal_id`, `date`, `meal_type`, and per dish `dish_id`, `dish_name`, `dish_category`, `is_veg`, `is_special`.
- [ ] **B** Taps per student, per dish, per meal, with timestamps, so counts can be frozen at the cut-off.
- [ ] **B** `total_students` (registered students) per date.
- [ ] **B** After each meal, per dish: `actual_dish_consumers` (**required** for history and retraining); `leftover_kg` (optional); post-meal rating (optional).
- [ ] **B** After each meal: total headcount (optional, for `previous_meal_attendance`).
- [ ] **B** Calendar flags: holiday, exam day, festival.
- [ ] **B** `dish_category` values mapped to the recommended list: `staple_rice`, `bread`, `dal`, `main_veg`, `main_nonveg`,
      `side`, `dessert`, `beverage`, `breakfast_item`, `fruit`.

## Step 4: Build the request (one meal, all dishes)
- [ ] **B** Freeze `interested_taps` (distinct students per dish) and `total_responses` (distinct responders) **at the voting cut-off**.
- [ ] **B** Check the counting rules: `0 ≤ interested_taps ≤ total_responses ≤ total_students`, and `total_students > 0`.
- [ ] **B** Send integers as JSON integers, booleans as `true`/`false`, and dates as `YYYY-MM-DD`.
- [ ] **B** Put **all dishes of the meal** in one request, with unique `dish_id` and unique `dish_name`.
- [ ] **B** Omit optional fields you don't have, or send `null`. **Never** send `NaN`, `0` or made-up defaults as placeholders.
- [ ] **B** Send only contract fields. Unknown fields are rejected with 422.

## Step 5: Compute history (handoff Section 6, contract §2.5)
- [ ] **B** `historical_dish_demand` = mean actual consumers over the **last 5 servings, same dish, same meal type, earlier dates**.
- [ ] **B** `historical_dish_rating` = mean of per-serving average ratings over the **last 5 rated servings, same dish, any meal type, strictly before this meal**.
- [ ] **B** `previous_leftover_kg` = leftover of the **most recent earlier serving, same dish, same meal type**. If it's not recorded, omit it; don't fall back to an older serving.
- [ ] **B** `previous_meal_attendance` = headcount of the **immediately preceding meal slot** (breakfast ← previous day's dinner).
- [ ] **B** **Leakage check:** history never includes the meal being predicted, even when re-requesting it after the meal.
- [ ] **B** Use only results that are already entered. When nothing exists, omit the field.
- [ ] **B** Unit-test the history queries on a small hand-made dataset (e.g. a dish served 7 times, so the mean of the last 5 is known).
- [ ] **B** Store the computed history with each prediction, for auditing and identical re-requests.

## Step 6: Call the API and handle responses
- [ ] **B** Optionally check `GET /health` before calling (cache it for a few minutes); `model_loaded == false` means predictions aren't possible.
- [ ] **B** `POST /predict` for one meal, or `POST /predict/batch` with `{"meals": [...]}` (1–100) for several.
- [ ] **B** **200:** map `predictions[i]` to `dishes[i]` by `dish_id`. In a batch, check each `results[i].status`.
- [ ] **B** **422:** log `detail` (field path in `loc`). It's a payload bug, so don't retry unchanged.
- [ ] **B** **503:** show "prediction unavailable", retry later, and alert the ML developer.
- [ ] **B** **500, timeout or connection error:** retry once, then show "prediction unavailable".
- [ ] **B** Never replace a missing prediction with invented numbers.

## Step 7: Store and display
- [ ] **B** Store `predicted_consumers`, `warnings`, `model_version`, `trained_on`, the request payload and a timestamp per dish.
- [ ] **B** Dashboard: show `predicted_consumers` next to `interested_taps`. They are different things: actual eaters vs app taps.
- [ ] **B** Dashboard: show a visible notice while `trained_on == "synthetic"`: *"Demo model trained on synthetic data."*
- [ ] **B** Dashboard: show `warnings` in plain words, e.g. "new dish: no history" or "mess size differs from training".
- [ ] **B** Don't expect dish predictions to add up to the number of students; students eat several dishes.

## Step 8: After the meal
- [ ] **B** Admin enters `actual_dish_consumers` per dish (plus leftovers, rating and headcount if collected).
- [ ] **B** Those values feed history for **future** meals only.
- [ ] **B** Implement the contract §3 CSV export of completed meals, for retraining on real data.

## Step 9: End-to-end tests (backend side)
- [ ] **B+M** A real meal from the backend gets 200, and predictions are integers in `[0, total_students]`.
- [ ] **B+M** A known dish **with** history gets no `new_dish_no_history` warning. If it does, the history isn't being sent.
- [ ] **B+M** A genuinely new dish gets `new_dish_no_history` and still returns a prediction.
- [ ] **B+M** A batch with one deliberately broken meal: the other meals still succeed.
- [ ] **B+M** ML service stopped → backend shows "prediction unavailable" and doesn't crash.
- [ ] **B+M** ML started with no artifacts → `/health` is degraded, `/predict` returns 503, and the backend handles it.
- [ ] **B+M** Re-requesting a past meal with the stored request gives the same predictions.
- [ ] **B+M** History queries never return values from the predicted meal itself (leakage test).

## Step 10: Before real use
- [ ] **M** Retrain and re-evaluate on real exported records (D12), then release a new model version.
- [ ] **B+M** Deployment: private network, a process manager for uvicorn, logs kept, and `/health` monitored.
- [ ] **B+M** Remove the "synthetic" notice only after `trained_on` changes to real data.
