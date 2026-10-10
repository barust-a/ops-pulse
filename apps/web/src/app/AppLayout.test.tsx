import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { analystUser } from '../test/fixtures';
import { renderApp } from '../test/renderApp';

describe('AppLayout', () => {
  it('shows the user, their role badge and the navigation', async () => {
    renderApp({ user: analystUser });

    const account = await screen.findByRole('region', { name: 'Compte' });
    expect(account).toHaveTextContent('analyst@ops-pulse.test');
    expect(account).toHaveTextContent('Analyste');
    expect(screen.getByRole('link', { name: 'Vue d’ensemble' })).toHaveAttribute('aria-current', 'page');
  });

  it('navigates between sections', async () => {
    const { user } = renderApp({ user: analystUser });

    await user.click(await screen.findByRole('link', { name: 'Changements' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Changements' })).toBeInTheDocument();
  });

  it('logs out back to the login page', async () => {
    const { user, router } = renderApp({ user: analystUser });

    await user.click(await screen.findByRole('button', { name: 'Se déconnecter' }));

    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(sessionStorage).toHaveLength(0);
  });

  it('shows a not-found page for unknown paths', async () => {
    renderApp({ path: '/nowhere', user: analystUser });

    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
  });
});
