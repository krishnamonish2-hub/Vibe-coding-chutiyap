import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { apiGet } from './api/client.js';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';

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
  // Same strict readiness rule as the backend: status "ok" AND model_loaded (L1).
  const mlText = !ml.reachable ? 'not reachable'
    : ml.ready ? `ready (${ml.model_version})` : 'reachable, not ready';
  return (
    <table className="status">
      <tbody>
        <StatusRow label="Backend" ok text="ok" />
        <StatusRow label="Database" ok={health.database === 'ok'} text={health.database} />
        <StatusRow label="ML service" ok={ml.ready === true} text={mlText} />
      </tbody>
    </table>
  );
}

function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="topbar">
      <div>
        <h1>MessMind</h1>
        <p className="lede">Dish-wise meal planning and food-waste reduction prototype.</p>
      </div>
      {user && (
        <div className="who">
          <span>{user.email} · {user.role === 'admin' ? 'Admin' : `Student ${user.student_code}`}</span>
          <button type="button" className="secondary" onClick={logout}>Sign out</button>
        </div>
      )}
    </header>
  );
}

function Home() {
  const { user } = useAuth();
  return (
    <>
      <section className="card" aria-labelledby="welcome-heading">
        <h2 id="welcome-heading">Welcome</h2>
        <p>
          Signed in as <strong>{user.role === 'admin' ? 'administrator' : `demo student (${user.student_code})`}</strong>.
          {' '}The {user.role === 'admin' ? 'simulation and planning' : 'voting'} pages are added in later phases.
        </p>
      </section>
      <section aria-labelledby="status-heading">
        <h2 id="status-heading">System status</h2>
        <StatusPanel />
      </section>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="banner" role="note">
          Demonstration only: all data is synthetic and the prediction model was trained on synthetic data.
        </div>
        <main>
          <Header />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  );
}
