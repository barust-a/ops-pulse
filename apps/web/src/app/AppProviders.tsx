import type { ReactNode } from 'react';

import { AuthProvider } from '../state/auth/AuthContext';
import type { SessionStore } from '../state/auth/sessionStore';
import { FiltersProvider } from '../state/filters/FiltersContext';

interface AppProvidersProps {
  readonly session: SessionStore;
  readonly children: ReactNode;
  readonly clock?: () => Date;
}

/**
 * App-wide state: auth (session + API client) and the shared filters. Redux Toolkit would slot in
 * here, behind the same hooks, if the shared state outgrows two reducers.
 */
export function AppProviders({ session, children, clock }: AppProvidersProps) {
  return (
    <AuthProvider session={session}>
      <FiltersProvider clock={clock}>{children}</FiltersProvider>
    </AuthProvider>
  );
}
