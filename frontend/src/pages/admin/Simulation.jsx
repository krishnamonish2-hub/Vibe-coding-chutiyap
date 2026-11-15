import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiGet, apiPost } from '../../api/client.js';
import ResetDialog from '../../components/ResetDialog.jsx';
import { ErrorBox, Loading, Notice } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { SimulationCard } from './Dashboard.jsx';

function StartForm({ onStarted }) {
  const [form, setForm] = useState({ seed: '', start_date: '2026-07-06', total_days: '60', speed_sim_minutes: '15' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { start_date: form.start_date, total_days: Number(form.total_days), speed_sim_minutes: Number(form.speed_sim_minutes) };
    if (form.seed.trim() !== '') body.seed = Number(form.seed);
    try {
      await apiPost('/api/admin/simulation/start', body);
      onStarted();
    } catch (err) {
      setError(err.body?.error?.details?.map((d) => `${d.path}: ${d.message}`).join('; ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card narrow" aria-labelledby="start-heading">
      <h2 id="start-heading">Start a simulation</h2>
      <p className="small muted">Synthetic 1,000-student mess. Days 1–30 are learning; ML predictions start on Day 31.</p>
      <form onSubmit={submit}>
        <label htmlFor="seed">Seed (optional, random if empty)</label>
        <input id="seed" inputMode="numeric" value={form.seed} onChange={set('seed')} />
        <label htmlFor="start_date">Day 1 date</label>
        <input id="start_date" type="date" value={form.start_date} onChange={set('start_date')} required />
        <label htmlFor="total_days">Total days (31–366)</label>
        <input id="total_days" type="number" min="31" max="366" value={form.total_days} onChange={set('total_days')} required />
        <label htmlFor="speed">Accelerated speed (simulated minutes per second)</label>
        <input id="speed" type="number" min="1" max="1440" value={form.speed_sim_minutes} onChange={set('speed_sim_minutes')} required />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start simulation'}</button>
      </form>
    </section>
  );
}

function Controls({ status, onChanged }) {
  const { run } = status;
  const running = run.status === 'running';
  const finished = run.status === 'completed';
  const [speed, setSpeed] = useState(String(run.speed_sim_minutes));
  const [day, setDay] = useState(String(Math.min(run.total_days, Math.max(status.current_day + 1, 1))));
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function act(label, path, body = {}) {
    setBusy(label); setError(null); setMessage(null);
    try {
      const res = await apiPost(path, body);
      if (typeof res?.steps_executed === 'number') setMessage(`${res.steps_executed} step${res.steps_executed === 1 ? '' : 's'} executed.`);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="controls-heading">
      <h2 id="controls-heading">Controls</h2>
      {finished && <Notice tone="ok">The run has finished (Day {run.total_days}). Reset to start a new one.</Notice>}

      <h3>Accelerated clock</h3>
      <div className="row">
        <label htmlFor="play-speed" className="inline">Speed (min/s)</label>
        <input id="play-speed" type="number" min="1" max="1440" className="short" value={speed}
          onChange={(e) => setSpeed(e.target.value)} disabled={finished || !!busy} />
        {running
          ? <button type="button" onClick={() => act('pause', '/api/admin/simulation/pause')} disabled={!!busy}>Pause</button>
          : (
            <button type="button" onClick={() => act('play', '/api/admin/simulation/play', { speed_sim_minutes: Number(speed) })}
              disabled={finished || !!busy}>{status.run.sim_now && status.meals.completed > 0 ? 'Resume' : 'Play'}</button>
          )}
      </div>

      <h3>Manual advance</h3>
      {running && <p className="small muted">Pause the accelerated clock to advance manually.</p>}
      <div className="row">
        <button type="button" className="secondary" disabled={running || finished || !!busy}
          onClick={() => act('step', '/api/admin/simulation/advance', { to: 'next_step' })}>Next step</button>
        <button type="button" className="secondary" disabled={running || finished || !!busy}
          onClick={() => act('day', '/api/admin/simulation/advance', { to: 'end_of_day' })}>End of day</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); act('jump', '/api/admin/simulation/advance', { to: 'day', day: Number(day) }); }}>
        <label htmlFor="jump-day" className="inline">Jump to day</label>
        <input id="jump-day" type="number" min="1" max={run.total_days} className="short" value={day}
          onChange={(e) => setDay(e.target.value)} disabled={running || finished || !!busy} />
        <button type="submit" className="secondary" disabled={running || finished || !!busy}>Go</button>
      </form>
      {busy && <p className="muted" role="status">Working…</p>}
      {message && <p className="small" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export default function Simulation() {
  const sim = useResource((signal) => apiGet('/api/admin/simulation', { signal }), [], { pollMs: 3000 });
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState(null);
  const [resetDone, setResetDone] = useState(null);
  const navigate = useNavigate();

  async function confirmReset(word) {
    setResetBusy(true); setResetError(null);
    try {
      const res = await apiPost('/api/admin/simulation/reset', { confirm: word });
      setResetOpen(false);
      setResetDone(res.summary);
      sim.reload();
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <>
      <h2 className="page-title">Simulation</h2>
      {sim.loading && <Loading />}
      <ErrorBox error={sim.error} onRetry={sim.reload} />
      {resetDone && (
        <Notice tone="ok">
          Run {resetDone.run_id} was reset ({resetDone.counts?.meals ?? 0} meals deleted). The reset is in the audit log.
        </Notice>
      )}
      {sim.data && !sim.data.run && <StartForm onStarted={() => { setResetDone(null); sim.reload(); navigate('/admin/simulation'); }} />}
      {sim.data?.run && (
        <div className="grid">
          <SimulationCard status={sim.data} />
          <Controls key={sim.data.run.id} status={sim.data} onChanged={sim.reload} />
          <section className="card danger-zone" aria-labelledby="reset-heading">
            <h2 id="reset-heading">Reset</h2>
            <p className="small">Deletes the current run and everything it generated. Requires typing RESET.</p>
            <button type="button" className="danger" onClick={() => { setResetError(null); setResetOpen(true); }}>Reset simulation…</button>
          </section>
        </div>
      )}
      <ResetDialog open={resetOpen} busy={resetBusy} error={resetError}
        onCancel={() => setResetOpen(false)} onConfirm={confirmReset} />
    </>
  );
}
