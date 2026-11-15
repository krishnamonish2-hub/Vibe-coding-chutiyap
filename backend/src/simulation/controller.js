// Simulation controller: one per backend process (single-process prototype, decision Q1).
//
// * An in-process lock serialises everything that moves simulated time or replaces the run (start, advance, clock
//   ticks, reset). Manual advance while the accelerated clock runs, or while another advance is in progress, is
//   rejected with HTTP 409 (Phase 4A decision 4).
// * The accelerated clock is an async loop: await one tick (advance by speed_sim_minutes), then wait tickMs. Ticks
//   never overlap and wait for slow steps.
// * After a restart a run left 'running' is set to 'paused' (recoverOnStartup); all state is in the database.

import { withTransaction } from '../db/transaction.js';
import { createDisabledMlClient } from '../ml/client.js';
import { ApiError } from '../middleware/error-handler.js';
import { recordAudit } from '../services/audit.js';
import { resetSimulation } from '../services/simulation-reset.js';
import { advanceTo, createRun, loadRun, nextPendingStep, runEndAt } from './engine.js';
import { dayNumberAt, startOfDay } from './schedule.js';

const busyError = () => new ApiError(409, 'simulation_busy', 'Another simulation operation is in progress');
const noRunError = () => new ApiError(404, 'no_simulation_run', 'There is no simulation run');

export function createSimulationController({ pool, ml = createDisabledMlClient(), tickMs = 1000, log = console }) {
  let locked = false;
  const waiters = [];
  let timer = null;
  let running = false; // accelerated clock active
  let currentTick = null;
  let lastClockError = null;

  async function acquire() {
    if (!locked) { locked = true; return; }
    await new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    const next = waiters.shift();
    if (next) next(); else locked = false;
  }
  async function exclusive(fn) {
    await acquire();
    try { return await fn(); } finally { release(); }
  }
  // Fails immediately (409) instead of waiting when the lock is taken.
  async function exclusiveNow(fn) {
    if (locked) throw busyError();
    return exclusive(fn);
  }

  async function status() {
    const run = await loadRun(pool);
    if (!run) return { run: null, clock_running: false, last_clock_error: lastClockError, ml: ml.status() };
    const day = Math.max(0, dayNumberAt(run.start_date, run.sim_now));
    const pending = await nextPendingStep(pool, run.id);
    const { rows: [m] } = await pool.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE status = 'completed'))::int AS completed
         FROM meals WHERE run_id = $1`, [run.id]);
    return {
      run: {
        id: Number(run.id), status: run.status, seed: Number(run.seed), start_date: run.start_date,
        total_days: run.total_days, learning_days: run.learning_days, activation_day: run.activation_day,
        total_students: run.total_students, speed_sim_minutes: run.speed_sim_minutes,
        sim_now: run.sim_now.toISOString(), calendar: run.calendar_config,
      },
      current_day: Math.min(day, run.total_days),
      phase: day >= run.activation_day ? 'active' : 'learning',
      next_step: pending ? { meal_id: pending.meal.id, step: pending.step.name, due_at: pending.dueAt.toISOString() } : null,
      meals: m,
      clock_running: running,
      last_clock_error: lastClockError,
      ml: ml.status(),
    };
  }

  async function start(params, userId) {
    return exclusiveNow(async () => {
      if (await loadRun(pool)) throw new ApiError(409, 'simulation_exists', 'A simulation run already exists; reset it first');
      const created = await withTransaction(pool, async (client) => {
        const result = await createRun(client, params);
        await recordAudit(client, {
          userId, action: 'simulation.start', entity: `simulation_run:${result.run.id}`,
          after: { seed: params.seed, start_date: result.run.start_date, total_days: result.run.total_days,
            speed_sim_minutes: result.run.speed_sim_minutes, calendar: result.run.calendar_config,
            days: result.days, meals: result.meals },
        });
        return result;
      });
      lastClockError = null;
      return created;
    });
  }

  function requireAdvanceable(run) {
    if (!run) throw noRunError();
    if (run.status === 'completed') throw new ApiError(409, 'simulation_completed', 'The simulation run has finished');
  }

  async function advance(spec) {
    if (running) throw new ApiError(409, 'clock_running', 'Pause the accelerated clock before advancing manually');
    return exclusiveNow(async () => {
      const run = await loadRun(pool);
      requireAdvanceable(run);
      const day = dayNumberAt(run.start_date, run.sim_now);
      let target;
      if (spec.to === 'next_step') {
        const pending = await nextPendingStep(pool, run.id);
        target = pending.dueAt;
      } else if (spec.to === 'end_of_day') {
        target = startOfDay(run.start_date, Math.max(day, 0) + 1);
      } else {
        if (spec.day <= Math.max(day, 0) || spec.day > run.total_days) {
          throw new ApiError(400, 'invalid_day', `day must be between ${Math.max(day, 0) + 1} and ${run.total_days}`);
        }
        target = startOfDay(run.start_date, spec.day);
      }
      const end = await runEndAt(pool, run.id);
      const executed = await advanceTo(pool, run.id, target > end ? end : target, { ml });
      return { steps_executed: executed };
    });
  }

  async function tick() {
    await exclusive(async () => {
      const run = await loadRun(pool);
      if (!run || run.status !== 'running') { running = false; return; }
      const target = new Date(run.sim_now.getTime() + run.speed_sim_minutes * 60_000);
      await advanceTo(pool, run.id, target, { ml });
      const after = await loadRun(pool);
      if (!after || after.status !== 'running') running = false;
    });
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      currentTick = tick()
        .catch(async (err) => {
          lastClockError = String(err.message).slice(0, 500);
          log.error?.('simulation clock stopped:', err);
          running = false;
          await pool.query("UPDATE simulation_runs SET status = 'paused' WHERE status = 'running'").catch(() => {});
        })
        .finally(() => { currentTick = null; schedule(); });
    }, tickMs);
  }

  async function play({ speedSimMinutes } = {}) {
    return exclusiveNow(async () => {
      const run = await loadRun(pool);
      requireAdvanceable(run);
      await pool.query(
        `UPDATE simulation_runs SET status = 'running', speed_sim_minutes = COALESCE($2, speed_sim_minutes)
          WHERE id = $1`, [run.id, speedSimMinutes ?? null]);
      lastClockError = null;
      if (!running) { running = true; schedule(); }
    });
  }

  // Stops the loop and waits for an in-flight tick. Does not change the database status.
  async function stopClock() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (currentTick) await currentTick;
  }

  async function pause() {
    const run = await loadRun(pool);
    if (!run) throw noRunError();
    await stopClock();
    await exclusive(() => pool.query("UPDATE simulation_runs SET status = 'paused' WHERE id = $1 AND status = 'running'", [run.id]));
  }

  // D6 reset endpoint: stop the clock, then run the approved reset service under the lock.
  async function reset({ confirm, userId }) {
    await stopClock();
    return exclusive(() => resetSimulation(pool, { userId, confirm }));
  }

  async function recoverOnStartup() {
    const { rowCount } = await pool.query("UPDATE simulation_runs SET status = 'paused' WHERE status = 'running'");
    return rowCount;
  }

  return {
    status, start, advance, play, pause, reset, recoverOnStartup,
    shutdown: stopClock,
    get clockRunning() { return running; },
    get busy() { return locked; },
  };
}
