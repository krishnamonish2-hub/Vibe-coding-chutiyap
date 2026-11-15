import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import AdminLayout from './components/AdminLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import StudentLayout from './components/StudentLayout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Dishes from './pages/admin/Dishes.jsx';
import MealDetail from './pages/admin/MealDetail.jsx';
import Meals from './pages/admin/Meals.jsx';
import Outcomes from './pages/admin/Outcomes.jsx';
import Predictions from './pages/admin/Predictions.jsx';
import Simulation from './pages/admin/Simulation.jsx';
import StudentMeals from './pages/student/StudentMeals.jsx';
import StudentResponses from './pages/student/StudentResponses.jsx';

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

// Signed-in landing page: each role goes to its own area.
function Home() {
  const { user } = useAuth();
  return <Navigate to={user.role === 'admin' ? '/admin' : '/student'} replace />;
}

// Routes without the router, so tests can render them inside a MemoryRouter.
export function AppRoutes() {
  return (
    <AuthProvider>
      <div className="banner" role="note">
        Demonstration only: all data is synthetic and the prediction model was trained on synthetic data.
      </div>
      <main>
        <Header />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          {/* Admin area: hidden from other roles here, and enforced by every /api/admin route on the server. */}
          <Route path="/admin" element={<ProtectedRoute roles={['admin']}><AdminLayout /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="simulation" element={<Simulation />} />
            <Route path="meals" element={<Meals />} />
            <Route path="meals/:id" element={<MealDetail />} />
            <Route path="predictions" element={<Predictions />} />
            <Route path="outcomes" element={<Outcomes />} />
            <Route path="dishes" element={<Dishes />} />
          </Route>
          {/* Student area (demo student S0001); enforced by every /api/student route on the server. */}
          <Route path="/student" element={<ProtectedRoute roles={['student']}><StudentLayout /></ProtectedRoute>}>
            <Route index element={<StudentMeals />} />
            <Route path="responses" element={<StudentResponses />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
