import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';

import type { User } from '../api/schemas';
import { AppProviders } from '../app/AppProviders';
import { routes } from '../app/routes';
import { createSessionStore } from '../state/auth/sessionStore';
import { TODAY } from './fixtures';

interface RenderAppOptions {
  readonly path?: string;
  /** Signed in as this user; anonymous when omitted. */
  readonly user?: User;
}

/** The whole app (real routes, providers and API client) on an in-memory router. */
export function renderApp({ path = '/', user }: RenderAppOptions = {}) {
  const session = createSessionStore(sessionStorage);
  if (user !== undefined) session.save({ token: 'test-token', user });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <AppProviders session={session} clock={() => TODAY}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...view, router, session, user: userEvent.setup() };
}
