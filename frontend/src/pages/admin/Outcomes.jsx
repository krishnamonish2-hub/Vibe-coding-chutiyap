import { Link } from 'react-router-dom';

import { apiGet } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading, SyntheticNote } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { formatNumber, mealTitle, sumOutcomes } from '../../lib/format.js';

function Totals({ title, totals, note }) {
  return (
    <section className="card" aria-label={title}>
      <h3>{title}</h3>
      {totals.meals === 0 ? <Empty>No completed meals.</Empty> : (
        <dl className="facts">
          <dt>Meals</dt><dd>{totals.meals}</dd>
          <dt>Prepared (servings)</dt><dd>{formatNumber(totals.prepared_servings)}</dd>
          <dt>Fixed plan would prepare</dt><dd>{formatNumber(totals.static_plan_servings)}</dd>
          <dt>Actually eaten</dt><dd>{formatNumber(totals.actual_consumers)}</dd>
          <dt>Leftover</dt><dd>{formatNumber(totals.leftover_kg, 1)} kg</dd>
          <dt>Fixed-plan leftover</dt><dd>{formatNumber(totals.static_plan_leftover_kg, 1)} kg</dd>
          <dt>Shortfall (servings)</dt><dd>{formatNumber(totals.shortfall_servings)}</dd>
        </dl>
      )}
      {note && <p className="small muted">{note}</p>}
    </section>
  );
}

export default function Outcomes() {
  const sim = useResource((signal) => apiGet('/api/admin/simulation', { signal }), []);
  const run = sim.data?.run;
  const meals = useResource(
    (signal) => (run ? apiGet('/api/admin/meals', { signal }) : Promise.resolve({ meals: [] })),
    [run?.id], { pollMs: run?.status === 'running' ? 5000 : 0 },
  );
  const completed = (meals.data?.meals ?? []).filter((m) => m.status === 'completed' && m.outcomes);
  const learning = sumOutcomes(completed.filter((m) => m.phase === 'learning'));
  const active = sumOutcomes(completed.filter((m) => m.phase === 'active'));

  return (
    <>
      <h2 className="page-title">Outcomes</h2>
      <p className="small muted">
        Synthetic actual consumption, prepared quantities and leftovers per completed meal. The fixed plan is always
        recorded as a counterfactual. It is what the kitchen would have prepared without predictions.
      </p>
      {(sim.loading || meals.loading) && <Loading />}
      <ErrorBox error={sim.error || meals.error} onRetry={() => { sim.reload(); meals.reload(); }} />
      {sim.data && !run && <Empty>No simulation run yet. <Link to="/admin/simulation">Start one.</Link></Empty>}
      {run && meals.data && completed.length === 0 && <Empty>No completed meals yet.</Empty>}
      {completed.length > 0 && (
        <>
          <div className="grid">
            <Totals title="Learning period (Days 1–30)" totals={learning} note="Always cooked with the fixed plan." />
            <Totals title="Prediction period (Day 31+)" totals={active}
              note="Cooked from the final prediction × 1.05 when it succeeded, otherwise the fixed plan." />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Meal</th><th>Prepared</th><th>Fixed plan</th><th>Actual</th><th>Leftover kg</th><th>Fixed-plan leftover kg</th><th>Shortfall</th></tr>
              </thead>
              <tbody>
                {[...completed].reverse().map((m) => (
                  <tr key={m.id}>
                    <td><Link to={`/admin/meals/${m.id}`}>{mealTitle(m)}</Link>{m.outcomes.edited && <> <Badge tone="warn">edited</Badge></>}</td>
                    <td>{formatNumber(m.outcomes.prepared_servings)}</td>
                    <td>{formatNumber(m.outcomes.static_plan_servings)}</td>
                    <td>{formatNumber(m.outcomes.actual_consumers)}</td>
                    <td>{formatNumber(m.outcomes.leftover_kg, 1)}</td>
                    <td>{formatNumber(m.outcomes.static_plan_leftover_kg, 1)}</td>
                    <td>{m.outcomes.shortfall_servings > 0 ? <Badge tone="bad">{m.outcomes.shortfall_servings}</Badge> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SyntheticNote />
    </>
  );
}
