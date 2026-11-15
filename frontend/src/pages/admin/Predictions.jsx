import { useState } from 'react';
import { Link } from 'react-router-dom';

import { apiGet } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading, PredictionBadge, SyntheticNote } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { mealTitle, predictionCounts } from '../../lib/format.js';

const isFailure = (p) => p && p.status !== 'ok';

export default function Predictions() {
  const sim = useResource((signal) => apiGet('/api/admin/simulation', { signal }), []);
  const run = sim.data?.run;
  const meals = useResource(
    (signal) => (run ? apiGet('/api/admin/meals', { signal }) : Promise.resolve({ meals: [] })),
    [run?.id], { pollMs: run?.status === 'running' ? 5000 : 0 },
  );
  const [failuresOnly, setFailuresOnly] = useState(false);

  const active = (meals.data?.meals ?? []).filter((m) => m.phase === 'active' && (m.provisional || m.final));
  const shown = failuresOnly ? active.filter((m) => isFailure(m.provisional) || isFailure(m.final)) : active;
  const counts = predictionCounts(active);

  return (
    <>
      <h2 className="page-title">Predictions</h2>
      <p className="small muted">
        Provisional predictions use the votes received by T-4h (voting still open, likely an under-estimate); final
        predictions use the counts frozen at the T-30m cutoff. Days 1–30 are the learning period and are never predicted.
      </p>
      {(sim.loading || meals.loading) && <Loading />}
      <ErrorBox error={sim.error || meals.error} onRetry={() => { sim.reload(); meals.reload(); }} />
      {sim.data && !run && <Empty>No simulation run yet. <Link to="/admin/simulation">Start one.</Link></Empty>}
      {run && meals.data && active.length === 0 && (
        <Empty>No predictions yet — they start with Day 31 breakfast (provisional at 03:30 simulated time).</Empty>
      )}
      {active.length > 0 && (
        <>
          <div className="grid stats">
            {['provisional', 'final'].map((kind) => (
              <section key={kind} className="card" aria-label={`${kind} summary`}>
                <h3>{kind === 'provisional' ? 'Provisional' : 'Final'}</h3>
                <p className="badge-group">
                  <Badge tone="ok">{counts[kind].ok} OK</Badge>
                  <Badge tone="warn">{counts[kind].unavailable} unavailable</Badge>
                  <Badge tone="bad">{counts[kind].error} failed</Badge>
                </p>
              </section>
            ))}
          </div>
          <label className="inline-check">
            <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> Show only meals with a failed or unavailable prediction
          </label>
          {shown.length === 0
            ? <Empty>No failed or unavailable predictions.</Empty>
            : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Meal</th><th>Provisional</th><th>Final</th><th>Kitchen</th></tr></thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.id}>
                        <td><Link to={`/admin/meals/${m.id}`}>{mealTitle(m)}</Link></td>
                        <td><PredictionBadge prediction={m.provisional} phase={m.phase} /></td>
                        <td><PredictionBadge prediction={m.final} phase={m.phase} /></td>
                        <td className="small">{m.status !== 'completed' ? 'Not cooked yet'
                          : m.final?.status === 'ok' ? 'Final prediction × 1.05' : 'Fixed plan (fallback)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}
      <SyntheticNote />
    </>
  );
}
