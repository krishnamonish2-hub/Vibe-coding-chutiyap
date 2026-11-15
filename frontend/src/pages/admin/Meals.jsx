import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { apiGet } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading, PredictionBadge } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { MEAL_LABEL, MEAL_STATUS_LABEL, formatNumber, formatTime } from '../../lib/format.js';

const FILTERS = { all: 'All', upcoming: 'Upcoming', completed: 'Completed' };

export default function Meals() {
  const [params, setParams] = useSearchParams();
  const sim = useResource((signal) => apiGet('/api/admin/simulation', { signal }), []);
  const run = sim.data?.run;
  const requested = Number(params.get('day'));
  const day = Number.isInteger(requested) && requested >= 1 ? requested : Math.max(1, sim.data?.current_day ?? 1);
  const [filter, setFilter] = useState('all');

  const meals = useResource(
    (signal) => (run ? apiGet(`/api/admin/meals?day=${day}`, { signal }) : Promise.resolve({ meals: [] })),
    [run?.id, day], { pollMs: run?.status === 'running' ? 3000 : 0 },
  );

  const goDay = (d) => setParams({ day: String(Math.min(Math.max(d, 1), run?.total_days ?? d)) });
  const list = (meals.data?.meals ?? []).filter((m) => filter === 'all'
    || (filter === 'completed' ? m.status === 'completed' : m.status !== 'completed'));

  return (
    <>
      <h2 className="page-title">Meals</h2>
      {sim.loading && <Loading />}
      <ErrorBox error={sim.error} onRetry={sim.reload} />
      {sim.data && !run && <Empty>No simulation run yet. <Link to="/admin/simulation">Start one</Link> to see meals.</Empty>}
      {run && (
        <>
          <div className="row toolbar">
            <button type="button" className="secondary" onClick={() => goDay(day - 1)} disabled={day <= 1}>‹ Previous day</button>
            <strong aria-live="polite">Day {day} of {run.total_days}</strong>
            <button type="button" className="secondary" onClick={() => goDay(day + 1)} disabled={day >= run.total_days}>Next day ›</button>
            <span className="badge-group" role="group" aria-label="Filter meals">
              {Object.entries(FILTERS).map(([k, label]) => (
                <button key={k} type="button" className={filter === k ? 'chip active' : 'chip'} aria-pressed={filter === k}
                  onClick={() => setFilter(k)}>{label}</button>
              ))}
            </span>
          </div>
          {meals.loading && <Loading />}
          <ErrorBox error={meals.error} onRetry={meals.reload} />
          {meals.data && list.length === 0 && <Empty>No {filter === 'all' ? '' : FILTERS[filter].toLowerCase()} meals on Day {day}.</Empty>}
          {list.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Meal</th><th>Serve (UTC)</th><th>Status</th><th>Responses (prov. / final)</th><th>Provisional</th><th>Final</th><th>Headcount</th></tr>
                </thead>
                <tbody>
                  {list.map((m) => (
                    <tr key={m.id}>
                      <td><Link to={`/admin/meals/${m.id}`}>{MEAL_LABEL[m.meal_type]}</Link>{' '}
                        <Badge tone={m.phase === 'active' ? 'info' : 'neutral'}>{m.phase === 'active' ? 'Active' : 'Learning'}</Badge></td>
                      <td>{formatTime(m.serve_at)}</td>
                      <td>{MEAL_STATUS_LABEL[m.status] ?? m.status}</td>
                      <td>{formatNumber(m.prov_total_responses)} / {formatNumber(m.final_total_responses)}</td>
                      <td><PredictionBadge prediction={m.provisional} phase={m.phase} /></td>
                      <td><PredictionBadge prediction={m.final} phase={m.phase} /></td>
                      <td>{formatNumber(m.headcount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
