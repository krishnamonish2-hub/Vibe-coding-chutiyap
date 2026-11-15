import { NavLink, Outlet } from 'react-router-dom';

// Student navigation (the demo student is linked to synthetic student S0001). The backend checks the student role on
// every /api/student route.
export default function StudentLayout() {
  return (
    <>
      <nav className="admin-nav" aria-label="Student">
        <NavLink to="/student" end className={({ isActive }) => (isActive ? 'active' : undefined)}>Vote</NavLink>
        <NavLink to="/student/responses" className={({ isActive }) => (isActive ? 'active' : undefined)}>My responses</NavLink>
      </nav>
      <Outlet />
    </>
  );
}
