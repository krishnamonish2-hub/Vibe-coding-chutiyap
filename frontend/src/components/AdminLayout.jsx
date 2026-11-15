import { NavLink, Outlet } from 'react-router-dom';

const LINKS = [
  ['/admin', 'Dashboard', true],
  ['/admin/simulation', 'Simulation'],
  ['/admin/meals', 'Meals'],
  ['/admin/predictions', 'Predictions'],
  ['/admin/outcomes', 'Outcomes'],
  ['/admin/dishes', 'Dishes'],
];

// Admin navigation. Showing these links is not security: every /api/admin route checks the session and role.
export default function AdminLayout() {
  return (
    <>
      <nav className="admin-nav" aria-label="Admin">
        {LINKS.map(([to, label, end]) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : undefined)}>{label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
