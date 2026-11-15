import { useState } from 'react';

import { apiGet, apiPut } from '../../api/client.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/StateViews.jsx';
import { useResource } from '../../hooks/useResource.js';
import { MEAL_LABEL, formatSimTime } from '../../lib/format.js';

// One meal whose voting window is open: choose dishes ("Eating", at least one) or "Not eating". The backend checks the
// window (voting closes 30 minutes before serving, simulated time) and the menu again.
function VoteForm({ meal, onSaved }) {
  const mine = meal.my_response;
  const [choice, setChoice] = useState(mine?.response ?? 'eating');
  const [dishes, setDishes] = useState(new Set(mine?.dish_ids ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const toggle = (id) => {
    const next = new Set(dishes);
    if (next.has(id)) next.delete(id); else next.add(id);
    setDishes(next);
  };

  async function submit(e) {
    e.preventDefault();
    setError(null); setSaved(false);
    if (choice === 'eating' && dishes.size === 0) { setError('Choose at least one dish, or select “Not eating”.'); return; }
    setBusy(true);
    try {
      const body = choice === 'eating'
        ? { response: 'eating', dish_ids: meal.menu.map((d) => d.dish_id).filter((id) => dishes.has(id)) }
        : { response: 'not_eating' };
      await apiPut(`/api/student/meals/${meal.meal_id}/response`, body);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err.code === 'voting_closed' ? 'Voting for this meal has closed.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={`meal-${meal.meal_id}`}>
      <h3 id={`meal-${meal.meal_id}`}>Day {meal.day} · {MEAL_LABEL[meal.meal_type]}</h3>
      <p className="small muted">Served {formatSimTime(meal.serve_at)} · voting closes {formatSimTime(meal.voting_closes_at)} (simulated time)</p>
      {mine && (
        <p className="small">
          Your current answer: <Badge tone={mine.response === 'eating' ? 'ok' : 'neutral'}>
            {mine.response === 'eating' ? 'Eating' : 'Not eating'}</Badge>
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset className="plain">
          <legend className="visually-hidden">Will you eat this meal?</legend>
          <label className="inline-check">
            <input type="radio" name={`choice-${meal.meal_id}`} value="eating" checked={choice === 'eating'}
              onChange={() => setChoice('eating')} /> I will eat — these dishes:
          </label>
          <div className="dish-choices" aria-label="Dishes">
            {meal.menu.map((d) => (
              <label key={d.dish_id} className="inline-check">
                <input type="checkbox" checked={dishes.has(d.dish_id)} disabled={choice !== 'eating'}
                  onChange={() => toggle(d.dish_id)} /> {d.display_name}{d.is_veg ? '' : ' (non-veg)'}
              </label>
            ))}
          </div>
          <label className="inline-check">
            <input type="radio" name={`choice-${meal.meal_id}`} value="not_eating" checked={choice === 'not_eating'}
              onChange={() => setChoice('not_eating')} /> Not eating
          </label>
        </fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        {saved && <p className="small" role="status">Saved. You can change it until voting closes.</p>}
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : mine ? 'Update answer' : 'Submit answer'}</button>
      </form>
    </section>
  );
}

export default function StudentMeals() {
  const res = useResource((signal) => apiGet('/api/student/meals/upcoming', { signal }), [], { pollMs: 10000 });
  return (
    <>
      <h2 className="page-title">Meals open for voting</h2>
      <p className="small muted">
        Tell the mess what you plan to eat. Saying “Not eating” also helps: it counts as an answer. Voting closes 30
        minutes before each meal. Times follow the demonstration’s simulated clock.
      </p>
      {res.loading && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      {res.data && res.data.meals.length === 0 && (
        <Empty>{res.data.sim_now ? 'No meal is open for voting right now.' : 'The demonstration has not started yet.'}</Empty>
      )}
      {res.data?.meals.map((m) => <VoteForm key={`${m.meal_id}:${m.my_response?.responded_at ?? ''}`} meal={m} onSaved={res.reload} />)}
    </>
  );
}
