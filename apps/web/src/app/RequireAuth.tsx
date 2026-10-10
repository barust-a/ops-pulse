import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../state/auth/AuthContext';

/** Route guard: anonymous visitors go to /login, which sends them back here once signed in. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
