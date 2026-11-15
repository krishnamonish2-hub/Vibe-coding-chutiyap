// Simulation reset (decision D6, architecture §4.3).
//
// One transaction: lock the run → build a summary → write the audit entry → delete the run (ON DELETE CASCADE removes
// every run-scoped row) → commit. The audit entry is written before the delete and committed together with it.
// If anything fails, everything rolls back and a separate `simulation.reset_failed` entry is recorded.
//
// Phase 3 provides this service only. Phase 4 exposes it as POST /api/admin/simulation/reset and stops the simulated
// clock (in-process mutex) before calling it.

import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../middleware/error-handler.js';
import { recordAudit } from './audit.js';

export const RESET_CONFIRMATION = 'RESET';

async function summarise(client, run) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM sim_days WHERE run_id = $1)::int                                   AS days,
       (SELECT count(*) FROM meals WHERE run_id = $1)::int                                      AS meals,
       (SELECT count(*) FROM meals WHERE run_id = $1 AND status = 'completed')::int             AS meals_completed,
       (SELECT count(*) FROM meal_responses r JOIN meals m ON m.id = r.meal_id
         WHERE m.run_id = $1)::int                                                              AS responses,
       (SELECT count(*) FROM dish_outcomes o JOIN meals m ON m.id = o.meal_id
         WHERE m.run_id = $1)::int                                                              AS outcomes,
       (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (
          SELECT p.status, count(*)::int AS n FROM prediction_requests p JOIN meals m ON m.id = p.meal_id
          WHERE m.run_id = $1 GROUP BY p.status) s)                                             AS prediction_attempts`,
    [run.id],
  );
  return {
    run_id: Number(run.id),
    seed: Number(run.seed),
    status: run.status,
    start_date: run.start_date,
    total_days: run.total_days,
    sim_now: run.sim_now.toISOString(),
    counts: rows[0],
  };
}

export async function resetSimulation(pool, { userId = null, confirm } = {}) {
  if (confirm !== RESET_CONFIRMATION) {
    throw new ApiError(400, 'confirmation_required', `Type ${RESET_CONFIRMATION} to confirm the reset`);
  }
  let runId = null;
  try {
    return await withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM simulation_runs ORDER BY id LIMIT 1 FOR UPDATE');
      if (rows.length === 0) throw new ApiError(404, 'no_simulation_run', 'There is no simulation run to reset');
      const run = rows[0];
      runId = Number(run.id);

      const summary = await summarise(client, run);
      const entry = await recordAudit(client, {
        userId, action: 'simulation.reset', entity: `simulation_run:${runId}`, before: summary,
      });
      await client.query('DELETE FROM simulation_runs WHERE id = $1', [run.id]);
      return { summary, auditId: Number(entry.id) };
    });
  } catch (err) {
    if (!(err instanceof ApiError)) {
      await recordAudit(pool, {
        userId,
        action: 'simulation.reset_failed',
        entity: runId === null ? 'simulation_run:unknown' : `simulation_run:${runId}`,
        after: { error: err.code ?? err.name ?? 'Error', message: String(err.message).slice(0, 500) },
      }).catch(() => {});
    }
    throw err;
  }
}
