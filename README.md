# MessMind

Dish-wise meal planning and food-waste reduction prototype for a college mess, built for a Vibe-a-thon.
Students vote on individual dishes, an independent ML service predicts how many students will actually eat each
dish, and the admin plans quantities from those predictions.

> **Everything is synthetic.** The demonstration uses a simulated population of 1,000 students, and the ML model was
> trained on synthetic data. Nothing here represents real mess accuracy.

## Architecture

```
frontend (React + Vite) ──► backend (Node.js + Express) ──► PostgreSQL
                                   │
                                   └──► ML service (Python + FastAPI, ml/) — independent, backend-only
```

* Design: [docs/architecture.md](docs/architecture.md)
* Approved decisions: [docs/decisions.md](docs/decisions.md)
* ML service: [ml/README.md](ml/README.md) · ML API contract: [shared/api_contract.md](shared/api_contract.md) (v0.3)

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | Express API, migration runner, (later) simulation engine and ML client |
| `frontend/` | React + Vite web app |
| `ml/` | ML service, model artifacts and data. **Not modified by backend/frontend work.** |
| `shared/` | ML API contract. **Not modified.** |
| `docs/` | Architecture and decision record |
| `.github/workflows/ci.yml` | Backend tests, frontend build, `ml-guard` |

## Status

Phases 1–3 are in place: backend and frontend skeletons, configuration, migration runner, `GET /api/health`, CI, the
PostgreSQL schema and synthetic seed (38 dishes, 1,000 students), sign-in with admin/student roles enforced by the
backend, dish display-name renaming, the audit log and the reset service. Phase 4A (in review) adds the synthetic
simulation engine (60 simulated days, accelerated or step-by-step clock, synthetic votes and outcomes), the admin
simulation/meal API, the student voting API and the reset endpoint; ML predictions follow in Phase 4B. Later phases are listed in [docs/architecture.md](docs/architecture.md#3-phase-map).

## Prerequisites

* Node.js ≥ 22.12 and npm
* PostgreSQL 16
* The ML service, run with its own existing setup (see [ml/README.md](ml/README.md)); optional until Phase 5

## Run locally

1. Copy `.env.example` to `.env` at the repository root and set `DATABASE_URL`, `JWT_SECRET` and the two seed
   accounts (`ADMIN_*`, `DEMO_STUDENT_*`). Never commit `.env`.
2. Backend:

   ```bash
   cd backend && npm ci && npm run migrate && npm run seed && npm start
   ```

3. Frontend (in a second terminal; proxies `/api` to the backend):

   ```bash
   cd frontend && npm ci && npm run dev
   ```

4. Open http://localhost:5173 and sign in with the admin or demo-student account from `.env`. The status panel shows
   the backend, database and ML service.

The ML service is started exactly as documented in `ml/README.md` (port 8001). If it is not running, the status panel
shows it as not reachable and the rest of the app still works.

## Tests

```bash
cd backend && npm test
```

Database tests run when `DATABASE_URL` is set and skip otherwise; they work in a temporary schema that is dropped
afterwards. CI runs them against a PostgreSQL 16 service container. CI never starts the ML service.

## Ground rules

* Do not modify anything under `ml/` or `shared/` (enforced by the `ml-guard` CI job).
* Do not retrain or replace the ML model; do not change its dependencies or API contract.
* Never present synthetic metrics or predictions as real-world performance.
