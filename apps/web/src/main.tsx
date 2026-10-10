import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { AppProviders } from './app/AppProviders';
import { routes } from './app/routes';
import { createSessionStore } from './state/auth/sessionStore';

// Composition root: the only place that touches browser globals to wire the app together.
const container = document.querySelector('#root');
if (container === null) throw new Error('index.html must contain <div id="root">');

const router = createBrowserRouter(routes);
const session = createSessionStore(globalThis.sessionStorage);

createRoot(container).render(
  <StrictMode>
    <AppProviders session={session}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
