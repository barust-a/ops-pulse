import { createContext, use, useReducer, useState, type ReactNode } from 'react';

import { createApiClient, type ApiClient } from '../../api/client';
import { login as loginRequest } from '../../api/endpoints';
import type { LoginBody, User } from '../../api/schemas';
import { anonymous, authReducer, type AuthState } from './authReducer';
import type { SessionStore } from './sessionStore';

interface AuthContextValue {
  readonly state: AuthState;
  /** Rejects with an ApiError the login form turns into a message. */
  readonly login: (credentials: LoginBody) => Promise<void>;
  readonly logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ApiClientContext = createContext<ApiClient | null>(null);

interface AuthProviderProps {
  readonly session: SessionStore;
  readonly children: ReactNode;
  readonly timeoutMs?: number;
}

function initialState(session: SessionStore): AuthState {
  const stored = session.read();
  if (stored === null) return anonymous;
  return { status: 'authenticated', token: stored.token, user: stored.user };
}

/**
 * Owns the session and the API client built on it: every request reads the current token, and
 * any 401 ends the session, which sends protected routes back to /login.
 */
export function AuthProvider({ session, children, timeoutMs }: AuthProviderProps) {
  const [state, dispatch] = useReducer(authReducer, session, initialState);
  const [client] = useState(() =>
    createApiClient({
      timeoutMs,
      getToken: () => session.read()?.token ?? null,
      onUnauthorized: () => {
        session.clear();
        dispatch({ type: 'loggedOut' });
      },
    }),
  );

  async function login(credentials: LoginBody): Promise<void> {
    const { token, user } = await loginRequest(client, credentials);
    session.save({ token, user });
    dispatch({ type: 'loggedIn', token, user });
  }

  function logout(): void {
    session.clear();
    dispatch({ type: 'loggedOut' });
  }

  return (
    <AuthContext value={{ state, login, logout }}>
      <ApiClientContext value={client}>{children}</ApiClientContext>
    </AuthContext>
  );
}

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

export function useApiClient(): ApiClient {
  const client = use(ApiClientContext);
  if (client === null) throw new Error('useApiClient must be used inside <AuthProvider>');
  return client;
}

/** The signed-in user, for components that only render behind the route guard. */
export function useCurrentUser(): User {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('useCurrentUser needs a signed-in user');
  return state.user;
}
