import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { apiGet, apiPost } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading, Notice, SyntheticNote } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import {
  MEAL_STATUS_LABEL, PREDICTION_STATUS_LABEL, formatNumber, formatSimTime, mealTitle, reasonLabel,
} from '../../lib/format.js';

const KIND_LABEL = { provisional: 'Provisional (T-4h)', final: 'Final (T-30m)' };
const TONE = { ok: 'ok', unavailable: 'warn', error: 'bad' };

function PredictionSection({ meal, kind, attempts, dishes, onRetried }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const current = attempts.find((a) => a.is_current);
  const names = new Map(dishes.map((d) => [d.dish_id, d.display_name]));

  async function retry() {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await apiPost(`/api/admin/meals/${meal.id}/predictions/${kind}/retry`, {});
      setResult(res);
      onRetried();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={`${kind}-heading`}>
      <h3 id={`${kind}-heading`}>{KIND_LABEL[kind]}</h3>
      {!current && <Empty>Not scheduled yet{kind === 'provisional' ? ' (runs at T-4h).' : ' (runs at the T-30m voting cutoff).'}</Empty>}
      {current && (
        <>
          <p className="badge-group">
            <Badge tone={TONE[current.status] ?? 'neutral'}>{PREDICTION_STATUS_LABEL[current.status] ?? current.status}</Badge>
            {current.reason && <span>{reasonLabel(current.reason)}</span>}
            {current.http_status && current.status !== 'ok' && <span className="small muted">HTTP {current.http_status}</span>}
          </p>
          {kind === 'provisional' && current.status === 'ok' && (
            <Notice tone="warn">Voting was still open: counts are partial, so this is likely an under-estimate.</Notice>
          )}
          {kind === 'final' && current.status === 'ok' && <p className="small muted">Counts frozen at the voting cutoff.</p>}
          {current.status !== 'ok' && (
            <p className="small">
              No prediction is used for this {kind === 'final' ? 'meal; the kitchen uses the fixed plan' : 'step'}.
              {' '}<button type="button" onClick={retry} disabled={busy}>{busy ? 'Retrying…' : `Retry ${kind} prediction`}</button>
            </p>
          )}
          {result && (
            <p className="small" role="status">
              Retry attempt {result.attempt}: {PREDICTION_STATUS_LABEL[result.status] ?? result.status}.{' '}
              {result.applies_to_kitchen ? 'The kitchen will use this prediction.'
                : kind === 'final' && result.status === 'ok' ? 'Recorded only: the meal was already cooked with the fixed plan.' : ''}
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}

          {current.status === 'ok' && current.items.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <caption className="small muted">Model {current.model_version} · trained on {current.trained_on}</caption>
                <thead><tr><th>Dish</th><th>Taps sent</th><th>Predicted consumers</th><th>Warnings</th></tr></thead>
                <tbody>
                  {current.items.map((i) => (
                    <tr key={i.dish_id}>
                      <td>{names.get(i.dish_id) ?? i.dish_id}</td>
                      <td>{formatNumber(i.interested_taps)}</td>
                      <td>{formatNumber(i.predicted_consumers)}</td>
                      <td className="small">{i.warnings.length ? i.warnings.join(', ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details>
            <summary>All attempts ({attempts.length})</summary>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>#</th><th>Status</th><th>Reason</th><th>Responses sent</th><th>Simulated time</th><th>Recorded at</th></tr></thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.attempt}{a.is_current ? ' (current)' : ''}</td>
                      <td>{PREDICTION_STATUS_LABEL[a.status] ?? a.status}</td>
                      <td>{reasonLabel(a.reason) || '—'}{a.http_status && a.status !== 'ok' ? ` · HTTP ${a.http_status}` : ''}</td>
                      <td>{formatNumber(a.total_responses)}</td>
                      <td>{formatSimTime(a.sim_at)}</td>
                      <td className="small">{a.wall_at ? new Date(a.wall_at).toISOString().replace('T', ' ').slice(0, 19) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function OutcomesSection({ meal, dishes, finalOk }) {
  if (meal.status !== 'completed') {
    return (
      <section className="card"><h3>Outcomes</h3>
        <Empty>Outcomes are recorded when the meal completes (serve time + 45 min).</Empty></section>
    );
  }
  return (
    <section className="card" aria-labelledby="outcomes-heading">
      <h3 id="outcomes-heading">Outcomes</h3>
      <p className="small">
        Headcount {formatNumber(meal.headcount)} ·{' '}
        {meal.phase === 'active' && finalOk
          ? 'Prepared from the final prediction × 1.05.'
          : `Prepared with the fixed plan${meal.phase === 'active' ? ' (no successful final prediction)' : ' (learning period)'}.`}
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Dish</th><th>Prepared</th><th>Fixed plan</th><th>Actual</th><th>Leftover kg</th><th>Fixed-plan leftover kg</th><th>Shortfall</th><th>Rating</th></tr>
          </thead>
          <tbody>
            {dishes.map((d) => (
              <tr key={d.dish_id}>
                <td>{d.display_name}{d.source === 'admin' && <> <Badge tone="warn">edited</Badge></>}</td>
                <td>{formatNumber(d.prepared_servings)}</td>
                <td>{formatNumber(d.static_plan_servings)}</td>
                <td>{formatNumber(d.actual_consumers)}</td>
                <td>{formatNumber(d.leftover_kg, 1)}</td>
                <td>{formatNumber(d.static_plan_leftover_kg, 1)}</td>
                <td>{d.shortfall_servings > 0 ? <Badge tone="bad">{d.shortfall_servings}</Badge> : '0'}</td>
                <td>{formatNumber(d.avg_rating, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function MealDetail() {
  const { id } = useParams();
  const res = useResource((signal) => apiGet(`/api/admin/meals/${encodeURIComponent(id)}`, { signal }), [id]);
  const d = res.data;

  return (
    <>
      <p><Link to={d ? `/admin/meals?day=${d.meal.day}` : '/admin/meals'}>‹ Back to meals</Link></p>
      {res.loading && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      {d && (
        <>
          <h2 className="page-title">{mealTitle(d.meal)}</h2>
          <section className="card">
            <p className="badge-group">
              <Badge tone={d.meal.phase === 'active' ? 'info' : 'neutral'}>{d.meal.phase === 'active' ? 'Predictions active' : 'Learning period'}</Badge>
              <Badge tone={d.meal.status === 'completed' ? 'ok' : 'neutral'}>{MEAL_STATUS_LABEL[d.meal.status] ?? d.meal.status}</Badge>
            </p>
            <dl className="facts">
              <dt>Serve</dt><dd>{formatSimTime(d.meal.serve_at)}</dd>
              <dt>Voting</dt><dd>{formatSimTime(d.meal.voting_opens_at)} → {formatSimTime(d.meal.voting_closes_at)}</dd>
              <dt>Responses at T-4h</dt><dd>{formatNumber(d.meal.prov_total_responses)} ({formatNumber(d.meal.prov_not_eating)} not eating)</dd>
              <dt>Responses at cutoff</dt><dd>{formatNumber(d.meal.final_total_responses)} ({formatNumber(d.meal.final_not_eating)} not eating)</dd>
            </dl>
            <div className="table-wrap">
              <table className="data">
                <caption className="small muted">Menu — the model always receives the fixed ML name, never the display name.</caption>
                <thead><tr><th>ID</th><th>Display name</th><th>ML name</th><th>Category</th><th>Taps at T-4h</th><th>Taps at cutoff</th></tr></thead>
                <tbody>
                  {d.dishes.map((m) => (
                    <tr key={m.dish_id}>
                      <td>{m.dish_id}</td><td>{m.display_name}</td><td className="muted">{m.ml_dish_name}</td><td>{m.category}</td>
                      <td>{formatNumber(m.prov_taps)}</td><td>{formatNumber(m.final_taps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <h2>Predictions</h2>
          {d.meal.phase === 'learning'
            ? <Empty>Learning period (Days 1–30): this meal is never sent to the ML service.</Empty>
            : (
              <div className="grid">
                {['provisional', 'final'].map((kind) => (
                  <PredictionSection key={kind} meal={d.meal} kind={kind} dishes={d.dishes} onRetried={res.reload}
                    attempts={d.predictions.filter((p) => p.kind === kind)} />
                ))}
              </div>
            )}

          <OutcomesSection meal={d.meal} dishes={d.dishes}
            finalOk={d.predictions.some((p) => p.kind === 'final' && p.is_current && p.status === 'ok')} />
          <SyntheticNote />
        </>
      )}
    </>
  );
}
