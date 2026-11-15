import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext.jsx';

// Shows children only to a signed-in user with one of `roles` (any role when omitted).
// This is for navigation only; the backend checks the session and role on every request.
export default function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    return <p className="error" role="alert">You do not have access to this page.</p>;
  }
  return children;
}
