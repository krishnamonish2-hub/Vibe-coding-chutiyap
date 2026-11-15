import { Link } from 'react-router-dom';

import { apiGet } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading, SyntheticNote } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { STEP_LABEL, formatSimTime, reasonLabel } from '../../lib/format.js';

// ML readiness from the live backend check (/api/health) plus the model info the simulation has read.
export function MlStatusCard({ health, healthError, modelInfo, lastCheck }) {
  let tone = 'bad';
  let text = 'Not reachable';
  if (healthError) text = 'Status unknown (backend not reachable)';
  else if (health?.ml?.ready) { tone = 'ok'; text = 'Ready'; }
  else if (health?.ml?.reachable) { tone = 'warn'; text = 'Reachable, model not ready'; }
  return (
    <section className="card" aria-labelledby="ml-heading">
      <h2 id="ml-heading">ML service</h2>
      <p><Badge tone={tone}>{text}</Badge></p>
      <dl className="facts">
        <dt>Model</dt><dd>{modelInfo?.model_version ?? health?.ml?.model_version ?? '—'}</dd>
        <dt>Trained on</dt><dd>{modelInfo?.trained_on ?? '—'}</dd>
        <dt>Contract</dt><dd>{modelInfo?.contract_version ?? '—'}</dd>
        {lastCheck && !lastCheck.ready && <><dt>Last simulation check</dt><dd>{reasonLabel(lastCheck.reason)}</dd></>}
      </dl>
      <p className="small muted">
        The ML service is private: only the backend calls it. Days 1–30 never call it. When it is unavailable, the kitchen
        uses the fixed plan and the prediction is recorded as unavailable — no numbers are invented.
      </p>
    </section>
  );
}

export function SimulationCard({ status }) {
  const { run } = status;
  return (
    <section className="card" aria-labelledby="sim-heading">
      <h2 id="sim-heading">Simulation</h2>
      <p className="badge-group">
        <Badge tone={run.status === 'running' ? 'info' : run.status === 'completed' ? 'ok' : 'neutral'}>
          {run.status === 'running' ? 'Running (accelerated)' : run.status === 'completed' ? 'Completed' : 'Paused'}
        </Badge>
        <Badge tone={status.phase === 'active' ? 'info' : 'neutral'}>
          {status.phase === 'active' ? 'Predictions active' : 'Learning period'}
        </Badge>
      </p>
      <dl className="facts">
        <dt>Simulated day</dt><dd>Day {status.current_day} of {run.total_days}</dd>
        <dt>Simulated time</dt><dd>{formatSimTime(run.sim_now)} <span className="small muted">(UTC)</span></dd>
        <dt>Meals completed</dt><dd>{status.meals.completed} of {status.meals.total}</dd>
        <dt>Next step</dt>
        <dd>{status.next_step ? `${STEP_LABEL[status.next_step.step] ?? status.next_step.step} · ${formatSimTime(status.next_step.due_at)}` : 'None — run finished'}</dd>
        <dt>Speed</dt><dd>{run.speed_sim_minutes} simulated min per second</dd>
        <dt>Seed</dt><dd>{run.seed}</dd>
      </dl>
      {status.last_clock_error && <p className="error" role="alert">Clock stopped: {status.last_clock_error}</p>}
    </section>
  );
}

export default function Dashboard() {
  const sim = useResource((signal) => apiGet('/api/admin/simulation', { signal }), [], { pollMs: 3000 });
  const health = useResource((signal) => apiGet('/api/health', { signal }), [], { pollMs: 15000 });

  return (
    <>
      <h2 className="page-title">Dashboard</h2>
      {sim.loading && <Loading />}
      <ErrorBox error={sim.error} onRetry={sim.reload} />
      <div className="grid">
        {sim.data && (sim.data.run
          ? <SimulationCard status={sim.data} />
          : (
            <section className="card">
              <h2>Simulation</h2>
              <Empty>No simulation run yet. <Link to="/admin/simulation">Start one on the Simulation page.</Link></Empty>
            </section>
          ))}
        {(sim.data || health.data || health.error) && (
          <MlStatusCard health={health.data} healthError={health.error} modelInfo={sim.data?.ml?.model_info}
            lastCheck={sim.data?.ml?.health} />
        )}
      </div>
      <SyntheticNote />
    </>
  );
}
