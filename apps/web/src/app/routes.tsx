import { lazy } from 'react';
import type { RouteObject } from 'react-router';

import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { AppLayout } from './AppLayout';
import { RequireAuth } from './RequireAuth';

// Each section is its own chunk: the login page loads without ECharts, and ECharts lands in a
// shared chunk the browser caches across sections.
const OverviewPage = lazy(async () => {
  const module = await import('../pages/OverviewPage');
  return { default: module.OverviewPage };
});
const IncidentsPage = lazy(async () => {
  const module = await import('../pages/IncidentsPage');
  return { default: module.IncidentsPage };
});
const ChangesPage = lazy(async () => {
  const module = await import('../pages/ChangesPage');
  return { default: module.ChangesPage };
});

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'incidents', element: <IncidentsPage /> },
          { path: 'changes', element: <ChangesPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
