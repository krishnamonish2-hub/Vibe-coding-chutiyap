import { Link } from 'react-router-dom';

import { PREDICTION_STATUS_LABEL, reasonLabel } from '../lib/format.js';

export function Loading({ label = 'Loading…' }) {
  return <p className="muted" role="status">{label}</p>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  const unauth = error.status === 401;
  return (
    <div className="notice notice-bad" role="alert">
      <strong>{unauth ? 'Your session has ended.' : 'Something went wrong.'}</strong>{' '}
      {unauth ? <Link to="/login">Sign in again</Link> : (error.message || 'Request failed')}
      {onRetry && !unauth && <> {' '}<button type="button" className="link" onClick={onRetry}>Try again</button></>}
    </div>
  );
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

export function Notice({ tone = 'info', children }) {
  return <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{children}</div>;
}

export function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

const STATUS_TONE = { ok: 'ok', unavailable: 'warn', error: 'bad' };

// Current prediction of one kind: { status, reason, attempts } or null.
export function PredictionBadge({ prediction, phase }) {
  if (phase === 'learning') return <Badge tone="neutral" title="Days 1–30 never call the ML service">Learning</Badge>;
  if (!prediction) return <Badge tone="neutral">Not yet</Badge>;
  const label = PREDICTION_STATUS_LABEL[prediction.status] ?? prediction.status;
  const reason = reasonLabel(prediction.reason);
  return (
    <span className="badge-group">
      <Badge tone={STATUS_TONE[prediction.status] ?? 'neutral'} title={reason || undefined}>{label}</Badge>
      {reason && <span className="small muted">{reason}</span>}
      {prediction.attempts > 1 && <span className="small muted">{prediction.attempts} attempts</span>}
    </span>
  );
}

export function SyntheticNote() {
  return <p className="small muted">All values are synthetic. Predictions come from a model trained on synthetic data.</p>;
}
