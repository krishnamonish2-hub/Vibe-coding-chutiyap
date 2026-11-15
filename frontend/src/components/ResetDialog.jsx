import { useEffect, useRef, useState } from 'react';

export const RESET_WORD = 'RESET';

// Reset confirmation (decision D6): the destructive button stays disabled until the admin types RESET exactly.
// The backend checks the same word again; this dialog only prevents accidents.
export default function ResetDialog({ open, onCancel, onConfirm, busy, error }) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;
  const ready = typed === RESET_WORD && !busy;
  return (
    <div className="dialog-backdrop" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <h2 id="reset-title">Reset the simulation?</h2>
        <p>
          This permanently deletes the current run: all simulated days, meals, votes, predictions and outcomes.
          Dishes, students and accounts are kept. The reset itself is recorded in the audit log.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm(typed); }}>
          <label htmlFor="reset-confirm">Type <code>{RESET_WORD}</code> to confirm</label>
          <input id="reset-confirm" ref={inputRef} autoComplete="off" value={typed}
            onChange={(e) => setTyped(e.target.value)} disabled={busy} />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="danger" disabled={!ready}>{busy ? 'Resetting…' : 'Reset simulation'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
