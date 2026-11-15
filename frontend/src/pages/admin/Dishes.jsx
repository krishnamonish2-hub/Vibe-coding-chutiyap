import { useState } from 'react';

import { apiGet, apiPatch } from '../../api/client.js';
import { ErrorBox, Loading, Notice } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';

// Dish catalogue. Only the display name can be edited (R-08); the dish ID and the ML name are fixed. The backend
// enforces this too (400 for id/ml_dish_name, 409 for a name already used).
function DishRow({ dish, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(dish.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    const name = value.trim();
    if (!name) { setError('Enter a name.'); return; }
    if (name.length > 100) { setError('Use at most 100 characters.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiPatch(`/api/admin/dishes/${dish.id}`, { display_name: name });
      setEditing(false);
      onSaved(res.dish);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{dish.id}</td>
      <td>
        {editing ? (
          <form className="row" onSubmit={save}>
            <label className="visually-hidden" htmlFor={`name-${dish.id}`}>Display name for {dish.id}</label>
            <input id={`name-${dish.id}`} value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} disabled={busy} />
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => { setEditing(false); setValue(dish.display_name); setError(null); }}>Cancel</button>
          </form>
        ) : (
          <span className="row">
            <span>{dish.display_name}</span>
            <button type="button" className="link" onClick={() => setEditing(true)} aria-label={`Rename ${dish.display_name}`}>Rename</button>
          </span>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </td>
      <td className="muted" title="Fixed: the exact name the ML model was trained on">{dish.ml_dish_name}</td>
      <td>{dish.category}</td>
      <td>{dish.is_veg ? 'Veg' : 'Non-veg'}</td>
    </tr>
  );
}

export default function Dishes() {
  const res = useResource((signal) => apiGet('/api/admin/dishes', { signal }), []);
  const [saved, setSaved] = useState(null);

  return (
    <>
      <h2 className="page-title">Dishes</h2>
      <p className="small muted">
        Renaming changes only what admins and students see. The dish ID and the ML name never change, and the model always
        receives the ML name. Display names must be unique (ignoring upper/lower case). Every rename is audited.
      </p>
      {res.loading && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      {saved && <Notice tone="ok">Renamed {saved.id} to “{saved.display_name}”.</Notice>}
      {res.data && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>ID</th><th>Display name</th><th>ML name (fixed)</th><th>Category</th><th>Type</th></tr></thead>
            <tbody>
              {res.data.dishes.map((d) => (
                <DishRow key={`${d.id}:${d.display_name}`} dish={d} onSaved={(dish) => { setSaved(dish); res.reload(); }} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
