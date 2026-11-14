import { useEffect, useState } from 'react';

import { apiGet } from './api/client.js';

const REFRESH_MS = 10000;

function useHealth() {
  const [state, setState] = useState({ loading: true, health: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const health = await apiGet('/api/health', { signal: controller.signal });
        setState({ loading: false, health, error: null });
      } catch (err) {
        if (err.name !== 'AbortError') setState({ loading: false, health: null, error: err.message });
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return state;
}

function StatusRow({ label, ok, text }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td><span className={`dot ${ok ? 'dot-ok' : 'dot-bad'}`} aria-hidden="true" /> {text}</td>
    </tr>
  );
}

function StatusPanel() {
  const { loading, health, error } = useHealth();
  if (loading) return <p>Checking services…</p>;
  if (error) return <p className="error">Backend: {error}</p>;
  const { ml } = health;
  const mlText = !ml.reachable ? 'not reachable'
    : ml.model_loaded ? `model loaded (${ml.model_version})` : 'reachable, model not loaded';
  return (
    <table className="status">
      <tbody>
        <StatusRow label="Backend" ok text="ok" />
        <StatusRow label="Database" ok={health.database === 'ok'} text={health.database} />
        <StatusRow label="ML service" ok={ml.reachable && ml.model_loaded} text={mlText} />
      </tbody>
    </table>
  );
}

export default function App() {
  return (
    <>
      <div className="banner" role="note">
        Demonstration only: all data is synthetic and the prediction model was trained on synthetic data.
      </div>
      <main>
        <h1>MessMind</h1>
        <p className="lede">Dish-wise meal planning and food-waste reduction prototype.</p>
        <section aria-labelledby="status-heading">
          <h2 id="status-heading">System status</h2>
          <StatusPanel />
        </section>
      </main>
    </>
  );
}
