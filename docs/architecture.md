# MessMind — Architecture (approved Phase 0 design)

> Decisions and their history: [decisions.md](decisions.md). ML service documentation: [../ml/README.md](../ml/README.md),
> ML contract: [../shared/api_contract.md](../shared/api_contract.md) (v0.3, approved as-is, not edited).
> Everything in the demonstration is **synthetic**. The ML model is trained on synthetic data (`trained_on: "synthetic"`).

## 1. System overview

```
React + Vite (admin + demo student)
   │  /api JSON (Vite dev proxy → backend), JWT in httpOnly cookie (Phase 3)
   ▼
Express backend — one Node process
   ├─ auth, dishes, meals, student responses
   ├─ simulation engine (simulated clock + per-meal state machine, in-process scheduler)
   ├─ history service (point-in-time SQL)
   ├─ prediction service (frozen counts → request → ML → stored)
   └─ reports / CSV export
   │                         │
   ▼                         ▼  HTTP to ML_API_URL (127.0.0.1:8001), backend only
PostgreSQL               ML FastAPI service — unchanged, existing venv and start command
```

**Boundaries:** Frontend ↔ backend ↔ PostgreSQL, and backend → ML. The ML service never touches PostgreSQL or the
frontend; the browser never calls the ML service (no CORS on the ML service).

**Repository layout**

| Path | Owner | Notes |
|---|---|---|
| `ml/`, `shared/` | ML developer | **Read-only for this work.** Guarded in CI (`ml-guard`). |
| `backend/` | Backend | Express app, migrations, simulation engine, tests |
| `frontend/` | Frontend | React + Vite app |
| `docs/` | Both | Architecture, decisions, demo script |
| `.github/workflows/ci.yml` | Both | Backend tests, frontend build, ml-guard |

## 2. Simulation schedule (D1, D2)

The run clock starts at **Day 0 19:30** (simulated, UTC). Days 1–60 have three meals each. For every meal:

| Step | Time | Meal status | Effect |
|---|---|---|---|
| open_voting | serve − 12 h | `scheduled → voting_open` | Generate synthetic responses with `responded_at` uniform in `[open, close)` |
| provisional | serve − 4 h | `voting_open → provisional_taken` | Freeze provisional counts; **Day ≥ 31:** call ML (`provisional`) |
| close_voting | serve − 30 m | `provisional_taken → voting_closed` | Lock votes; freeze final counts; **Day ≥ 31:** call ML (`final`) |
| complete | serve + 45 m | `voting_closed → completed` | Generate headcount, actuals, prepared/leftover (D5), rating |

| Meal | Opens | Provisional | Close + final | Serve | Complete |
|---|---|---|---|---|---|
| Breakfast | 19:30 (previous day) | 03:30 | 07:00 | 07:30 | 08:15 |
| Lunch | 00:30 | 08:30 | 12:00 | 12:30 | 13:15 |
| Dinner | 07:30 | 15:30 | 19:00 | 19:30 | 20:15 |

Invariant: `previous.completes_at < next.provisional_at` (smallest gap 15 min, breakfast → lunch), so both
predictions of a meal see identical history. Checked at startup and in tests.

**Scheduler:** no event table. Due steps are derived from meal timestamps, ordered by `(due_at, meal order, step order)`,
each run in its own transaction as a conditional status update (`… WHERE status = <expected>`), which prevents
duplicates. Manual advance (`next_step`, `end_of_day`, `day N`) and an accelerated loop (`await step; setTimeout 1 s`)
share the same code; an in-process mutex prevents overlap. After a restart the run is `paused`. Each meal has its own
seeded PRNG `(run seed, meal index)`, so results do not depend on how time was advanced.

## 3. Phase map

| Phase | Scope | Depends on |
|---|---|---|
| P1 | Foundation: backend + frontend skeletons, config, DB pool + migration runner, health endpoint, CI | Phase 0 |
| P2 | Schema migration (`backend/db/migrations/001_schema.sql`) + seed (38 dishes, 1,000 synthetic students) | P1 |
| P3 | Auth, roles, admin + demo student accounts (needs password hashing), dish rename, audit log service | P2 |
| P4 | Simulation engine (learning mode, no ML) + calibration tests | P2, P3 |
| P5 | ML integration: client, request schema/builder, history, predictions, Day 31 activation, live contract test | P4 + ML service unchanged |
| P6 | Admin pages | P5 (simulation page after P4) |
| P7 | Demo student pages/API | P3, P4 |
| P8 | Reports + CSV export (contract §3) | P5 |
| P9 | End-to-end run, demo script | P5–P8 |

## 4. Database design

### 4.1 Tables

| Table | Columns (PK **bold**) | Constraints / indexes |
|---|---|---|
| `schema_migrations` | **version**, applied_at | Created by the migration runner (P1) |
| `users` | **id**, email, password_hash, role (`admin`\|`student`), student_id, session_version (≥ 1, default 1; migration 003), created_at | email unique, lower-case; student_id unique → students; CHECK role = student ⇔ student_id not null. Accounts are created in P3 |
| `students` | **id** integer, code (`S0001`…`S1000`) | code unique |
| `dishes` | **id** text (`D001`…, immutable), display_name, ml_dish_name, category, is_veg, portion_kg, active, created_at, updated_at | ml_dish_name unique; id and ml_dish_name immutable (trigger); display_name unique ignoring case (migration 002); category one of the 10 recommended values; unique (id, ml_dish_name). Only display_name is editable through the API |
| `simulation_runs` | **id**, status (`running`\|`paused`\|`completed`), seed, start_date (Day 1), total_days, learning_days, activation_day, total_students, speed_sim_minutes, sim_now, calendar_config, created_at | at most one row; CHECK learning_days = 30, activation_day = 31, total_students = 1000, sim_now ≥ Day 0 19:30 UTC. The current day is derived from sim_now |
| `sim_days` | **(run_id, day_number)**, date, is_weekend, is_holiday, is_exam_day, is_festival, temperature, rainfall | FK run ON DELETE CASCADE |
| `meals` | **id** text (`r{run}-d031-lunch`), run_id, day_number, date, meal_type, serve_at, voting_opens_at, provisional_at, voting_closes_at, completes_at, phase, status, prov_total_responses, prov_not_eating, final_total_responses, final_not_eating, headcount | unique (run_id, date, meal_type); index (run_id, meal_type, serve_at); FK run CASCADE |
| `meal_dishes` | **(meal_id, dish_id)**, ml_dish_name, display_name, category, is_veg, is_special, position | unique (meal_id, ml_dish_name), unique (meal_id, position); FK meal CASCADE; FK (dish_id, ml_dish_name) → dishes (copied ML name must be the real one) |
| `meal_responses` | **id**, meal_id, student_id, response (`eating`\|`not_eating`), responded_at | unique (meal_id, student_id); **unique (id, meal_id, response)**; index (meal_id, responded_at) |
| `response_picks` | **(response_id, dish_id)**, meal_id, response | see §4.2 |
| `meal_dish_counts` | **(meal_id, dish_id)**, prov_taps, final_taps | FK (meal_id, dish_id) → meal_dishes CASCADE |
| `prediction_requests` | **id**, meal_id, kind, attempt, status, is_current, request_payload, response_payload, http_status, error_detail, model_version, trained_on, sim_at, wall_at | unique (meal_id, kind, attempt); partial unique (meal_id, kind) WHERE is_current |
| `prediction_items` | **(request_id, dish_id)**, meal_id, interested_taps, predicted_consumers, warnings, hist_demand, hist_rating, prev_leftover_kg | FK (request_id, meal_id) → prediction_requests CASCADE; FK (meal_id, dish_id) → meal_dishes CASCADE (same pattern as response_picks) |
| `dish_outcomes` | **(meal_id, dish_id)**, actual_consumers, prepared_servings, static_plan_servings, leftover_kg, static_plan_leftover_kg, shortfall_servings, avg_rating, source, edited_at | FK (meal_id, dish_id) → meal_dishes CASCADE; index (dish_id) |
| `audit_log` | **id**, at, user_id, action, entity, before, after | no FK to runs; user_id ON DELETE SET NULL; append-only trigger |

`meals` also enforces the approved schedule with CHECK constraints: id format `r{run}-d{day:03}-{meal_type}`, serve times
07:30/12:30/19:30 UTC on its own date, offsets −12 h/−4 h/−30 m/+45 m, `phase` from the day number, frozen counts
present exactly when the status has passed that step, and a composite FK `(run_id, day_number, date)` → `sim_days`.

Every history query joins `meals` and filters on `run_id`. Predictions (`prediction_*`) and actual outcomes
(`dish_outcomes`) are separate tables.

### 4.2 Response picks — corrected relationship (composite foreign keys)

Requirement: a pick's dish must be on the **same meal** as the pick's response, and only `eating` responses may have
picks. This is enforced declaratively; no trigger is needed.

```sql
CREATE TABLE meal_responses (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id      text        NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  student_id   integer     NOT NULL REFERENCES students(id),
  response     text        NOT NULL CHECK (response IN ('eating', 'not_eating')),
  responded_at timestamptz NOT NULL,
  UNIQUE (meal_id, student_id),
  UNIQUE (id, meal_id, response)            -- target of the composite FK below
);

CREATE TABLE response_picks (
  response_id bigint NOT NULL,
  meal_id     text   NOT NULL,
  dish_id     text   NOT NULL,
  response    text   NOT NULL DEFAULT 'eating' CHECK (response = 'eating'),
  PRIMARY KEY (response_id, dish_id),
  -- the pick belongs to this response, of this meal, and that response is 'eating'
  FOREIGN KEY (response_id, meal_id, response)
    REFERENCES meal_responses (id, meal_id, response) ON DELETE CASCADE ON UPDATE CASCADE,
  -- the dish is on the same meal's menu
  FOREIGN KEY (meal_id, dish_id)
    REFERENCES meal_dishes (meal_id, dish_id) ON DELETE CASCADE
);
CREATE INDEX response_picks_meal_dish ON response_picks (meal_id, dish_id);
```

Behaviour:

* A pick for a dish that is not on the response's meal fails the `(meal_id, dish_id)` FK.
* A pick whose `meal_id` differs from its response's meal fails the `(response_id, meal_id, response)` FK.
* A pick on a `not_eating` response fails the same FK (no matching `'eating'` row).
* Changing a response from `eating` to `not_eating` while it still has picks cascades the new value into the picks,
  which then violates `CHECK (response = 'eating')`; the update is rejected. The service deletes picks first.
* Deleting a response, a meal or a run removes its picks.

P2 tests cover all five cases.

### 4.3 Reset (D6)

One transaction: lock run (`FOR UPDATE`) → build summary (run id, seed, dates, status, sim_now, day, counts) →
`INSERT audit_log (action 'simulation.reset', entity 'simulation_run:<id>', before = summary)` →
`DELETE simulation_runs` (cascade) → `COMMIT`. On failure everything rolls back and `simulation.reset_failed` is
logged separately. The confirmation must be exactly `RESET`.

Phase 3 implements this as `resetSimulation()` in `backend/src/services/simulation-reset.js` (tested).
Phase 4 exposes it as `POST /api/admin/simulation/reset` and stops the scheduler (mutex held) before calling it.

## 5. Backend API (all under `/api`)

| Method & path | Role | Phase |
|---|---|---|
| `GET /api/health` | public | **P1** |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | any | P3 |
| `GET /api/admin/dishes`, `PATCH /api/admin/dishes/:id` | admin | P3 |
| `GET /api/admin/simulation`, `POST …/start`, `…/advance`, `…/play`, `…/pause`, `…/reset` | admin | P4 |
| `GET /api/admin/meals?day=`, `GET /api/admin/meals/:id`, `PUT /api/admin/meals/:id/outcomes` | admin | P4 |
| `POST /api/admin/meals/:id/predictions/:kind/retry` | admin | P5 |
| `GET /api/admin/reports/accuracy`, `GET /api/admin/reports/waste`, `GET /api/admin/export/training.csv` | admin | P8 |
| `GET /api/student/meals/upcoming`, `PUT /api/student/meals/:id/response` | student | P7 |

Errors: `{ "error": { "code", "message", "details?" } }`.

**Authentication and authorization (P3).** `POST /api/auth/login {email, password}` sets an httpOnly,
`SameSite=Strict` session cookie (`messmind_session`, path `/api`, HS256 JWT holding the user id `sub` and the user's
`session_version` at login as `sv`, 8 h default, `Secure` when `COOKIE_SECURE=true`, default on in production). Every
protected request re-reads the user, role and `session_version` from the database and rejects the token unless `sv`
matches, so deleted accounts, role changes and logouts apply immediately. **Logout** increments `session_version`
(only if the presented token is still current) and clears the cookie: every token issued to that user before the
logout — including copies — stops working at once, on all of that user's devices. A new login receives the new version.
Tokens without `sv` (issued before migration 003) are rejected. Admin routes use `requireAuth` + `requireRole('admin')`
on the server: no session → 401 `unauthenticated`, wrong role → 403 `forbidden`. Writes must be `application/json`
(415 otherwise). Failed logins are limited per client IP (default 10 per 15 min → 429). Wrong password and unknown
email give the same 401.

**Dish renaming (P3).** `PATCH /api/admin/dishes/:id` accepts exactly `{ "display_name": "…" }` (trimmed, 1–100
characters). `id` or `ml_dish_name` in the body → 400 `immutable_field`; any other field → 400 `validation_error`;
name used by another dish (ignoring case) → 409 `display_name_taken`. A real change writes a `dish.rename` audit entry
(`before`/`after` display and ML names) in the same transaction; renaming to the current name is a no-op.

**Audit actions so far:** `user.create` (seed), `dish.rename`, `simulation.reset`, `simulation.reset_failed`.

`GET /api/health` → `200 { status: "ok"|"degraded", backend: "ok", database: "ok", ml: { reachable, model_loaded,
model_version } }`; `503` with `database: "error"` when PostgreSQL is unavailable. ML down ⇒ `degraded` (still 200).

## 6. ML integration (P5) — backend schema vs `ml/api/schemas.py`

The backend validates every request with a Zod schema that is never looser than the ML Pydantic schema
(`extra="forbid"`, strict types, strings trimmed then 1–100 characters, `meal_type` literal not trimmed, finite floats,
JSON integers accepted for floats, `null` rejected for booleans).

| Field | ML (actual) | Backend Zod / policy |
|---|---|---|
| object | extra fields forbidden | `.strict()` |
| `meal_id`, `dish_id`, `dish_name`, `dish_category` | strict str, 1–100 after trim | `str100` = `string().min(1).max(100)` + must equal its trim |
| `date` | regex `^\d{4}-\d{2}-\d{2}$` + real date | same regex + UTC round-trip date check |
| `meal_type` | literal breakfast/lunch/dinner | `z.enum` |
| `total_students` | strict int > 0 | int, positive, **= 1000** |
| `total_responses`, `interested_taps` | strict int ≥ 0 | int ≥ 0 |
| `is_holiday`, `is_exam_day`, `is_festival`, `is_special` | strict bool, default false | boolean, **always sent** |
| `is_veg` | strict bool, required | boolean |
| `temperature` | finite −30…60, optional | finite, range, omitted when missing |
| `rainfall`, `historical_dish_demand`, `previous_leftover_kg` | finite ≥ 0, optional | finite ≥ 0, omitted when missing |
| `historical_dish_rating` | finite 1…5, optional | finite 1…5, omitted when missing |
| `previous_meal_attendance` | strict int ≥ 0, optional | int ≥ 0, omitted when missing |
| `dishes` | 1–30 | 1–30 |
| cross-field | responses ≤ students; prev attendance ≤ students; taps ≤ responses; unique `dish_id`; unique `dish_name` | identical `superRefine` |

`dish_name` = `dishes.ml_dish_name` (exact training spelling). History mirrors `ml/src/generate_data.py`
(`historical_dish_demand` last 5 same dish + meal type, 1 dp; `historical_dish_rating` last 5 per-serving averages, any
meal type, 2 dp; `previous_leftover_kg` most recent same dish + meal type, 1 dp; `previous_meal_attendance` previous
slot headcount). Missing values are omitted. Only `POST /predict` is used. 422 → `error` (no retry); 503/500/timeout →
one retry → `unavailable`. `/health` is checked via `model_loaded` (cached 60 s).

## 7. Frontend pages

Login · Admin: Simulation, Timeline, Meal detail, Dishes, Reports, Export (synthetic-data banner everywhere) ·
Student (demo): Upcoming meals, My responses. P1 delivered the shell with a backend status panel; P3 adds the login
page, sign-out, an auth context and protected routes (navigation only — the backend enforces every permission).

## 8. Configuration

| Variable | Used by | Default | Phase |
|---|---|---|---|
| `PORT` | backend | `4000` | P1 |
| `DATABASE_URL` | backend | — (required) | P1 |
| `ML_API_URL` | backend | `http://127.0.0.1:8001` | P1 (health), P5 |
| `ML_TIMEOUT_MS` | backend | `10000` (health check uses min(this, 2000)) | P1 |
| `JWT_SECRET` | backend server | — (required, ≥ 32 characters) | P3 |
| `SESSION_TTL_HOURS` | backend | `8` (max 168) | P3 |
| `COOKIE_SECURE` | backend | `true` in production, else `false` | P3 |
| `LOGIN_MAX_FAILURES` | backend | `10` per 15 minutes per IP | P3 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | seed | unset (account skipped); password ≥ 12 characters | P3 |
| `DEMO_STUDENT_EMAIL`, `DEMO_STUDENT_PASSWORD` | seed | unset (account skipped); linked to `S0001` | P3 |
| `ML_LIVE_TESTS` | backend tests | unset (skipped) | P5 |
| `VITE_BACKEND_URL` | frontend dev proxy | `http://127.0.0.1:4000` | P1 |
