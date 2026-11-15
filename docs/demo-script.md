# MessMind — demo script (about 10 minutes)

> **Everything shown is synthetic.** 1,000 synthetic students, a synthetic 60-day term, synthetic votes, attendance,
> leftovers and ratings. The ML model was trained on synthetic data. No number in this demo is real-world performance.

## 0. Before the demo

1. Set up and start the backend, frontend and (optionally) the ML service as in the [README](../README.md#run-locally).
   Start the ML service only with its own documented setup in `ml/README.md`. Do not change or retrain it.
2. Have the admin and demo-student (S0001) credentials from `.env` to hand. Use two browser windows (or one normal and
   one private window) so both can stay signed in.
3. If a previous run exists: **Admin → Simulation → Reset**, type `RESET`, confirm. This deletes runs, votes,
   predictions and outcomes. Dishes, students and accounts stay.

If the ML service is not running, the demo still works. Predictions are recorded as **unavailable** and the kitchen
cooks the fixed plan. That fallback is part of the story (step 5).

## 1. The problem (30 s)

The mess cooks a fixed plan per dish. Students' real demand changes with the menu, exams, holidays, festivals and
weather, so food is wasted. MessMind asks students before each meal and predicts per-dish demand.

## 2. Admin dashboard (1 min)

Sign in as the admin. The **Dashboard** shows the backend, database and ML readiness (model version, `trained_on:
synthetic`, contract 0.3). Point out the synthetic-data banner on every page.

## 3. Start a run (1 min)

**Simulation → Start a simulation.** Use a fixed seed (e.g. `2026`) so the run can be repeated exactly. Leave 60 days and
the start date as they are. Explain the timeline:

* Each meal opens for voting 12 h before serving, gets a **provisional** prediction at T−4 h, closes at **T−30 min**
  (final prediction) and is completed 45 min after serving.
* **Days 1–30** are the learning period: no predictions, the kitchen cooks the fixed plan.
* From **Day 31** the kitchen cooks the final prediction × 1.05, or the fixed plan if that prediction is not OK.

**Jump to day 31**, then press **Next step** twice so breakfast and lunch of Day 31 are open for voting.

## 4. Student view (2 min)

In the second window, sign in as the demo student (S0001). The **Vote** page lists the meals that are open by the
simulated clock.

* Lunch: tick two dishes → **Submit answer** ("Saved. You can change it until voting closes.").
* Breakfast: choose **Not eating** → submit. Explain that "Not eating" counts as a response. A student who does not answer
  is not counted.
* Try to submit "eating" with no dish: the form asks for at least one dish, or "Not eating".
* **My responses** shows the answers, with "can still change" until the cutoff.

Back in the admin window press **Next step** until Day 31 lunch has closed. In the student window lunch has left the Vote page, and
**My responses** shows the answer as no longer changeable.

## 5. Predictions (2 min)

**Meals → Day 31 → lunch** (meal detail):

* Menu with the editable display name and the immutable ML name the model receives.
* Frozen tap counts, the provisional attempt (marked as a likely under-estimate) and the final attempt, with status,
  reason, and the model version and `trained_on` value.
* After completion: per dish, prepared vs fixed plan vs actually eaten, leftover kg and shortfall.

If the ML service was stopped (or had an error), show the **unavailable** attempt and its reason, then **Retry … prediction**. A
retry after the meal completed is recorded only. The page says the kitchen will not use it, and the cooked quantities
do not change. On **Predictions**, “Show only meals with a failed or unavailable prediction” lists every meal whose
prediction was not OK.

## 6. Run to the end (1 min)

**Play** with a high speed (e.g. 600 simulated minutes per second), or **End of day** repeatedly, until the run shows
*completed* (180 meals). Manual controls are disabled while the clock runs. **Pause** first to use them.

## 7. Reports and export (2 min)

**Reports:**

* **Prediction accuracy**: MAE (servings per dish) of provisional and final predictions vs the synthetic actuals, per
  meal type, next to a baseline (the dish's recent average demand). The counts of OK, unavailable and failed predictions
  stay visible. Only OK predictions are scored.
* **Waste vs fixed plan**: leftover kg against what the fixed plan would have left, for the learning period (same
  numbers, as expected) and the prediction period (the saving), plus any shortfall.

**Download training CSV**: completed meals in the API contract's §3 format, one row per dish per meal. Stress: it is
**only an export**. Nothing retrains automatically. Retraining would be a separate, reviewed ML step, and on real data
only.

## 8. Close (30 s)

* The same seed gives the same run every time (checked by the end-to-end test).
* The backend enforces every permission. The student cannot reach admin data, and the UI only hides links.
* Limitations: synthetic data and a synthetic model. The real ML service is not exercised by CI (a mock is used). An
  opt-in live test exists for local use.

## Checking the demo flow automatically

`backend/tests/e2e-simulation.test.js` runs this flow through the HTTP API with a **mock** ML service. It starts a run,
jumps to Day 31, records the demo student's votes, injects one ML outage and runs all 60 days. It checks that 180 meals
complete, the kitchen rule holds, reports are consistent, and the export has one row per dish serving. It then resets,
replays the run with the same seed and checks that the export is byte-identical.

```bash
cd backend && npm test -- tests/e2e-simulation.test.js
```
