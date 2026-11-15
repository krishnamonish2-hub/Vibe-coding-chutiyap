# MessMind — Phase 0 Decision Record

> **Status:** APPROVED by the project owner on 2026-11-14.
> **Scope:** Vibe-a-thon prototype. Entirely synthetic demonstration; not a production system for a real mess.
> Changes to any decision below require explicit owner approval and a new entry in the change log at the end.

## 1. Confirmed requirements (non-negotiable)

| # | Requirement |
|---|---|
| R-01 | Prototype for a Vibe-a-thon, not a production system. |
| R-02 | Synthetic data for the entire demonstration; synthetic population of **1,000 students**. |
| R-03 | Simulated Days **1–30 are learning mode**: no official ML predictions. |
| R-04 | Prediction mode activates on simulated **Day 31**. |
| R-05 | **Provisional** prediction 4 hours before serving (T-4h); **final** prediction 30 minutes before serving (T-30m). |
| R-06 | Historical inputs: previous dish consumption, leftovers, ratings and previous meal attendance. |
| R-07 | An explicit **Not Eating** response counts toward `total_responses`; **no response** does not count. |
| R-08 | Dish IDs stay stable when display names change. |
| R-09 | Admin can start and reset the simulation; **reset requires confirmation**. |
| R-10 | The existing ML model, artifacts, preprocessing, feature order, schemas, implementation and dependency versions are preserved. No automatic retraining. No upgrades without approval. |
| R-11 | Nothing under `ml/` or `shared/` is modified. The ML service stays independent and runs on its existing setup. |

## 2. Decision register (all approved)

| ID | Decision |
|---|---|
| **D1** | Simulation length **60 days** (30 learning + 30 prediction days). Calendar starts on a fixed Monday (configurable). The run clock starts at **Day 0 19:30** (Day 1 breakfast serve − 12 h); Day 0 has no meals. |
| **D2** | Serve 07:30 / 12:30 / 19:30. For every meal: voting opens serve − 12 h; provisional count + prediction at serve − 4 h; voting closes + final count + prediction at serve − 30 m; meal completes at serve + 45 m. A vote is valid when `voting_opens_at ≤ responded_at < voting_closes_at`. Invariant (checked at startup and in tests): `previous.completes_at < next.provisional_at` for every consecutive pair of meals. |
| **D3** | About 2 random weekday holidays and 2 festivals per run; **exam days off by default** (configurable). Calibration runs use the generator's calendar (4 holidays, 3 festivals, 8-day exam block). |
| **D4** | Synthetic vote times are uniform over `[voting_opens_at, voting_closes_at)` in whole simulated seconds (~69.6 % before T-4h). |
| **D5** | Days 1–30: the generator's static kitchen plan. Day 31+: prepared = final prediction × 1.05 (fallback: static plan when no final prediction). Static-plan quantities are always stored for comparison. Actual consumption is **not** capped by prepared quantity; shortfall is recorded separately. |
| **D6** | Reset **deletes** the run (cascade) after typed confirmation (`RESET`). A durable audit entry with the run ID and summary is written in the same transaction **before** the delete. `audit_log` has no FK to runs and is append-only. |
| **D7** | Ratings are synthetic per-serving averages only; no student rating page. |
| **D8** | The simulator may record "eating with 0 dishes" (counts as a response). The student UI requires ≥ 1 dish or Not Eating. ML-neutral (only totals are sent). |
| **D9** | Simulated temperature and rainfall are sent to the ML (generator formula). |
| **D10** | The ML service runs in its existing virtual environment with its existing, documented versions. Nothing under `ml/` changes. (A pin file outside `ml/` is *not* approved as part of this decision.) |
| **D11** | One demo student account linked to synthetic student `S0001`; its vote replaces S0001's synthetic vote until the cutoff. |
| **D12** | ML API contract **v0.3 is approved as-is** for backend integration. This record is the approval; `shared/api_contract.md` is not edited. Implementation details stricter than the contract text (unknown fields rejected, 100-character string limit, `type` in error items, whitespace trimming) are tolerated by the backend. |

## 3. Additional approved answers

| ID | Answer |
|---|---|
| **Q1** | Use an **in-process scheduler** (single Node process prototype). |
| **Q2** | Tests may **read** `ml/data/raw/*.csv` (calibration). They must never write anything under `ml/`. |
| **Q3** | Include lightweight **GitHub Actions CI** (backend tests + frontend build) **and** the `ml-guard` job that fails if a change touches `ml/` or `shared/`. CI never requires the ML service. |
| **Q4** | Approved libraries — backend: `express`, `pg`, `zod`, `bcrypt`, `jsonwebtoken`, `cookie-parser`; tests: `vitest`, `supertest`; frontend: `react`, `react-dom`, `react-router-dom`, `vite` (with `@vitejs/plugin-react`). Each is installed only in the phase that first needs it. |

## 4. Approved clarifications

* **Provisional predictions** send the taps counted so far (`responded_at ≤ serve − 4h`), unchanged, and are labelled
  "Voting still open — likely an under-estimate". Final predictions use counts frozen at the cutoff. Each kind is stored
  separately; retries resend the stored request unchanged.
* **Backend request validation** mirrors `ml/api/schemas.py` field by field (see `docs/architecture.md` §6) and is
  never looser than the ML schema.
* **Dates:** `pg` returns `DATE` (OID 1082) as a `YYYY-MM-DD` string; simulated timestamps are `timestamptz` in UTC.
* **Calibration tests** compare distributions and probabilities, not only averages, against the training CSV (read-only).
* **Live ML contract test** is opt-in (`ML_LIVE_TESTS=1`) and skipped in CI.

## 5. Change log

| Date | Change |
|---|---|
| 2026-11-14 | Phase 0 approved (D1–D12, Q1–Q4). |
| 2026-11-15 | **Session invalidation (owner-approved Option 1):** per-user session versioning — migration `003` adds `users.session_version`; tokens carry it as `sv`; each authenticated request checks it against the database; logout increments it and clears the cookie, so copied tokens are rejected immediately. Logout ends all of that user's sessions. Login and logout are not audited (audit behaviour unchanged). |
| 2026-11-14 | **Phase 3 decisions** (approved by the owner): (1) `PATCH /api/admin/dishes/:id` edits **`display_name` only**; the earlier plan to also edit `active` is dropped. (2) D6 reset is implemented in Phase 3 as a tested service (`resetSimulation`); the HTTP route and scheduler stop are wired in Phase 4. (3) Login accounts come only from `.env` at seed time (`ADMIN_*`, `DEMO_STUDENT_*`, passwords ≥ 12 characters); unset accounts are skipped; existing passwords are never overwritten. (4) Dish display names are unique ignoring case (migration `002`). Also approved: creating the accounts in Phase 3 instead of the Phase 2 seed, and enforcing the voting window and 1–30 dishes per menu in the backend (Phases 4 and 7) rather than in the database. |
| 2026-11-14 | **Phase 2 refinements** (no change to any decision): admin and demo-student accounts are created in Phase 3 together with password hashing (bcrypt), instead of in the Phase 2 seed; `prediction_items` carries `meal_id` with composite FKs (same pattern as `response_picks`); `meal_dishes` has an FK on `(dish_id, ml_dish_name)` so a menu copy always uses the dish's real ML name; dishes with meat or eggs are marked `is_veg = false` (the model does not use `is_veg`). |
| 2026-11-14 | **Database correction:** `response_picks` now carries `meal_id` and uses composite foreign keys so a pick's dish must belong to the same meal as its response, and picks are only possible for `eating` responses (see `docs/architecture.md` §4.2). No trigger needed. |
