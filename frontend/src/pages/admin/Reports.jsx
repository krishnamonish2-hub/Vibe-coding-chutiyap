import { Link } from 'react-router-dom';

import { apiGet } from '../../api/client.js';
import { Empty, ErrorBox, Loading, Notice, SyntheticNote } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { MEAL_LABEL, formatNumber } from '../../lib/format.js';

const KIND_LABEL = { provisional: 'Provisional (T−4 h)', final: 'Final (T−30 min)' };
const noRun = (err) => err?.status === 404 && err?.code === 'no_simulation_run';

function AccuracyTable({ kind, data }) {
  const rows = [['All meals', data.overall], ...Object.entries(data.by_meal_type).map(([mt, m]) => [MEAL_LABEL[mt], m])];
  const s = data.current_status;
  return (
    <section className="card" aria-label={`${KIND_LABEL[kind]} accuracy`}>
      <h3>{KIND_LABEL[kind]}</h3>
      <p className="small muted">
        Current attempts: {s.ok} OK · {s.unavailable} unavailable · {s.error} failed. Only OK predictions of completed
        meals are scored; meals without one were cooked with the fixed plan.
      </p>
      {data.overall.n === 0 ? <Empty>No scored predictions yet.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Meals</th><th>Dish servings</th><th>Model MAE</th><th>Bias</th><th>Baseline MAE</th></tr></thead>
            <tbody>
              {rows.map(([label, m]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{m.n}</td>
                  <td>{m.mae === null ? '—' : formatNumber(m.mae, 1)}</td>
                  <td>{m.bias === null ? '—' : formatNumber(m.bias, 1)}</td>
                  <td>{m.baseline_mae === null ? '—' : formatNumber(m.baseline_mae, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WasteCard({ title, t, note }) {
  return (
    <section className="card" aria-label={title}>
      <h3>{title}</h3>
      {t.meals === 0 ? <Empty>No completed meals.</Empty> : (
        <dl className="facts">
          <dt>Days / meals</dt><dd>{t.days} / {t.meals}</dd>
          <dt>Leftover</dt><dd>{formatNumber(t.leftover_kg, 1)} kg</dd>
          <dt>Fixed-plan leftover</dt><dd>{formatNumber(t.static_plan_leftover_kg, 1)} kg</dd>
          <dt>Saved vs fixed plan</dt>
          <dd>{formatNumber(t.leftover_saved_kg, 1)} kg{t.leftover_saved_pct !== null && ` (${formatNumber(t.leftover_saved_pct, 1)}%)`}</dd>
          <dt>Shortfall (servings)</dt><dd>{formatNumber(t.shortfall)}</dd>
        </dl>
      )}
      {note && <p className="small muted">{note}</p>}
    </section>
  );
}

export default function Reports() {
  const acc = useResource((signal) => apiGet('/api/admin/reports/accuracy', { signal }), []);
  const waste = useResource((signal) => apiGet('/api/admin/reports/waste', { signal }), []);
  const missing = noRun(acc.error) || noRun(waste.error);
  const error = missing ? null : acc.error || waste.error;

  return (
    <>
      <h2 className="page-title">Reports</h2>
      <p className="small muted">
        How close the predictions were to the synthetic actuals, and how much food was left over compared with the
        fixed plan. MAE is the mean absolute error in servings per dish. The baseline is the dish’s recent average demand.
      </p>
      {(acc.loading || waste.loading) && <Loading />}
      <ErrorBox error={error} onRetry={() => { acc.reload(); waste.reload(); }} />
      {missing && <Empty>No simulation run yet. <Link to="/admin/simulation">Start one.</Link></Empty>}

      {acc.data && (
        <>
          <h3>Prediction accuracy</h3>
          {acc.data.models.length > 0 && (
            <p className="small muted">Model: {acc.data.models.map((m) => `${m.model_version} (trained on ${m.trained_on})`).join(', ')}</p>
          )}
          <div className="grid">
            <AccuracyTable kind="provisional" data={acc.data.provisional} />
            <AccuracyTable kind="final" data={acc.data.final} />
          </div>
        </>
      )}

      {waste.data && (
        <>
          <h3>Waste vs fixed plan</h3>
          <div className="grid">
            <WasteCard title="Learning period (Days 1–30)" t={waste.data.learning} note="Cooked with the fixed plan, so no saving is expected." />
            <WasteCard title="Prediction period (Day 31+)" t={waste.data.active} note="Final prediction × 1.05 when OK, otherwise the fixed plan." />
          </div>
        </>
      )}

      <section className="card" aria-label="Training export">
        <h3>Training-data export</h3>
        <p className="small">
          Download completed meals as CSV in the API contract’s training format (one row per dish per meal). This only
          exports data. Nothing is retrained automatically. Any retraining is a separate, manual ML step.
        </p>
        {missing ? <p className="small muted">Available once a simulation run exists.</p>
          : <a href="/api/admin/export/training.csv" download>Download training CSV</a>}
        <Notice tone="warn">This data is synthetic. Do not use a model trained on it for real cooking decisions.</Notice>
      </section>
      <SyntheticNote />
    </>
  );
}
