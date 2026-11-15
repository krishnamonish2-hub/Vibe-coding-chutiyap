import { apiGet } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { MEAL_LABEL, formatSimTime } from '../../lib/format.js';

export default function StudentResponses() {
  const res = useResource((signal) => apiGet('/api/student/meals/responses', { signal }), []);
  const list = res.data?.responses ?? [];
  return (
    <>
      <h2 className="page-title">My responses</h2>
      {res.loading && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      {res.data && list.length === 0 && <Empty>You have not answered for any meal yet.</Empty>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Meal</th><th>Served</th><th>Answer</th><th>Dishes</th><th>Answered</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.meal_id}>
                  <td>Day {r.day} · {MEAL_LABEL[r.meal_type]}</td>
                  <td>{formatSimTime(r.serve_at)}</td>
                  <td><Badge tone={r.response === 'eating' ? 'ok' : 'neutral'}>{r.response === 'eating' ? 'Eating' : 'Not eating'}</Badge>
                    {r.can_change && <span className="small muted"> · can still change</span>}</td>
                  <td>{r.dishes.length ? r.dishes.map((d) => d.display_name).join(', ') : '—'}</td>
                  <td className="small">{formatSimTime(r.responded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Simulated times. All data in this demonstration is synthetic.</p>
    </>
  );
}
