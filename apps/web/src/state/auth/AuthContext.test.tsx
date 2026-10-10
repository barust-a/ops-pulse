import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { fetchIncidents } from '../../api/endpoints';
import { analystUser } from '../../test/fixtures';
import { apiPath, errorBody, server } from '../../test/handlers';
import { AuthProvider, useApiClient, useAuth } from './AuthContext';
import { createSessionStore } from './sessionStore';

/** Shows the auth state and exposes login, logout and an authenticated request as buttons. */
function AuthProbe() {
  const { state, login, logout } = useAuth();
  const client = useApiClient();
  return (
    <>
      <p>{state.status === 'authenticated' ? `${state.user.email} (${state.user.role})` : 'anonymous'}</p>
      <button type="button" onClick={() => void login({ email: analystUser.email, password: 'pw' })}>
        login
      </button>
      <button type="button" onClick={logout}>
        logout
      </button>
      <button
        type="button"
        onClick={() =>
          void fetchIncidents(client, {
            from: '2026-10-01',
            to: '2026-10-10',
            page: 1,
            pageSize: 25,
            sort: '-openedAt',
          }).catch(() => undefined)
        }
      >
        load
      </button>
    </>
  );
}

function renderProbe() {
  const session = createSessionStore(sessionStorage);
  render(
    <AuthProvider session={session}>
      <AuthProbe />
    </AuthProvider>,
  );
  return { session, user: userEvent.setup() };
}

describe('AuthProvider', () => {
  it('logs in, keeps the session in sessionStorage, then logs out', async () => {
    const { session, user } = renderProbe();
    expect(screen.getByText('anonymous')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('analyst@ops-pulse.test (analyst)')).toBeInTheDocument();
    expect(createSessionStore(sessionStorage).read()?.token).toBe('test-token');

    await user.click(screen.getByRole('button', { name: 'logout' }));

    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(session.read()).toBeNull();
  });

  it('restores the session saved before a reload', () => {
    createSessionStore(sessionStorage).save({ token: 'jwt', user: analystUser });

    renderProbe();

    expect(screen.getByText('analyst@ops-pulse.test (analyst)')).toBeInTheDocument();
  });

  it('sends the stored token and logs out when the API answers 401', async () => {
    createSessionStore(sessionStorage).save({ token: 'expired-jwt', user: analystUser });
    let authorization: string | null = null;
    server.use(
      http.get(apiPath('/incidents'), ({ request }) => {
        authorization = request.headers.get('Authorization');
        return HttpResponse.json(errorBody('UNAUTHENTICATED', 'expired'), { status: 401 });
      }),
    );
    const { user } = renderProbe();

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'load' }));
    });

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(authorization).toBe('Bearer expired-jwt');
    expect(sessionStorage).toHaveLength(0);
  });
});
