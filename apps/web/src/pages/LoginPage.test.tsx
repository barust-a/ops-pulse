import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiPath, errorBody, server } from '../test/handlers';
import { renderApp } from '../test/renderApp';

describe('LoginPage', () => {
  it('redirects an anonymous visitor to /login, then back after signing in', async () => {
    let body: unknown = null;
    server.use(
      http.post(apiPath('/auth/login'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          token: 'jwt',
          user: { id: 2, email: 'analyst@ops-pulse.test', role: 'analyst' },
        });
      }),
    );
    const { user, router } = renderApp({ path: '/incidents' });

    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Adresse e-mail'), 'analyst@ops-pulse.test');
    await user.type(screen.getByLabelText('Mot de passe'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Incidents' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/incidents');
    expect(body).toEqual({ email: 'analyst@ops-pulse.test', password: 'secret-pw' });
  });

  it('validates the fields before calling the API', async () => {
    const { user } = renderApp({ path: '/login' });

    await user.type(await screen.findByLabelText('Adresse e-mail'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(screen.getByLabelText('Adresse e-mail')).toHaveAccessibleDescription(
      'Saisissez une adresse e-mail valide.',
    );
    expect(screen.getByLabelText('Mot de passe')).toHaveAccessibleDescription(
      'Saisissez votre mot de passe.',
    );
  });

  it('shows a message when the credentials are rejected', async () => {
    server.use(
      http.post(apiPath('/auth/login'), () =>
        HttpResponse.json(errorBody('UNAUTHENTICATED', 'bad credentials'), { status: 401 }),
      ),
    );
    const { user } = renderApp({ path: '/login' });

    await user.type(await screen.findByLabelText('Adresse e-mail'), 'viewer@ops-pulse.test');
    await user.type(screen.getByLabelText('Mot de passe'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou mot de passe incorrect.');
  });

  it('lists the demo accounts without any password', async () => {
    renderApp({ path: '/login' });

    const hint = await screen.findByRole('complementary', { name: 'Comptes de démonstration' });
    expect(hint).toHaveTextContent('admin@ops-pulse.test');
    expect(hint).toHaveTextContent('viewer@ops-pulse.test');
    expect(hint).toHaveTextContent('Mot de passe dans le README.');
    expect(hint).not.toHaveTextContent('OpsPulse');
  });
});
