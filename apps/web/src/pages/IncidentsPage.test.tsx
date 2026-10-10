import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { analystUser, incident, viewerUser } from '../test/fixtures';
import { apiPath, server } from '../test/handlers';
import { renderApp } from '../test/renderApp';

/** Records the query string of every GET /incidents. */
function recordIncidentQueries(total = 60): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(apiPath('/incidents'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params);
      return HttpResponse.json({
        items: [incident()],
        page: Number(params.get('page')),
        pageSize: 25,
        total,
      });
    }),
  );
  return queries;
}

function lastQuery(queries: URLSearchParams[]): Record<string, string> {
  const last = queries.at(-1);
  if (last === undefined) throw new Error('no request was made');
  return Object.fromEntries(last);
}

describe('IncidentsPage', () => {
  it('requests the first page, most recent first, over the last 30 days', async () => {
    const queries = recordIncidentQueries();
    renderApp({ path: '/incidents', user: viewerUser });

    expect(await screen.findByRole('button', { name: 'INC0010001' })).toBeInTheDocument();
    expect(lastQuery(queries)).toEqual({
      from: '2026-09-11',
      to: '2026-10-10',
      page: '1',
      pageSize: '25',
      sort: '-openedAt',
    });
  });

  it('turns every filter, the search and the sort into query parameters', async () => {
    const queries = recordIncidentQueries();
    const { user } = renderApp({ path: '/incidents', user: viewerUser });
    await screen.findByRole('button', { name: 'INC0010001' });

    await user.click(screen.getByRole('radio', { name: '7 jours' }));
    await user.selectOptions(screen.getByLabelText('Service'), 'payments');
    await user.selectOptions(screen.getByLabelText('Priorité'), '1');
    await user.selectOptions(screen.getByLabelText('État'), 'on_hold');
    await user.type(screen.getByRole('searchbox', { name: 'Recherche' }), 'VPN');
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));
    await user.click(screen.getByRole('button', { name: 'Trier par Priorité' }));
    await screen.findByRole('button', { name: 'INC0010001' });

    expect(lastQuery(queries)).toEqual({
      from: '2026-10-04',
      to: '2026-10-10',
      service: 'payments',
      priority: '1',
      state: 'on_hold',
      q: 'VPN',
      page: '1',
      pageSize: '25',
      sort: '-priority',
    });
  });

  it('paginates server-side and restarts at page 1 when a filter changes', async () => {
    const queries = recordIncidentQueries(60);
    const { user } = renderApp({ path: '/incidents', user: viewerUser });
    await screen.findByText('Page 1 sur 3 · 60 résultats');

    await user.click(screen.getByRole('button', { name: 'Page suivante' }));
    expect(await screen.findByText('Page 2 sur 3 · 60 résultats')).toBeInTheDocument();
    expect(lastQuery(queries).page).toBe('2');

    await user.selectOptions(screen.getByLabelText('État'), 'new');
    await screen.findByText('Page 1 sur 3 · 60 résultats');
    expect(lastQuery(queries)).toMatchObject({ page: '1', state: 'new' });
  });

  it('opens the detail panel on row click', async () => {
    const { user } = renderApp({ path: '/incidents', user: viewerUser });

    await user.click(await screen.findByRole('button', { name: 'INC0010001' }));

    const panel = screen.getByRole('complementary', { name: 'Incident INC0010001' });
    expect(panel).toHaveTextContent('Payments L2');
    expect(panel).toHaveTextContent('CHG0030007');
  });

  it('hides the write controls from a viewer', async () => {
    const { user } = renderApp({ path: '/incidents', user: viewerUser });

    await user.click(await screen.findByRole('button', { name: 'INC0010001' }));

    expect(screen.queryByRole('button', { name: 'Nouvel incident' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mettre à jour' })).not.toBeInTheDocument();
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
  });

  it('lets an analyst change the state of an incident (PATCH)', async () => {
    let patch: unknown = null;
    server.use(
      http.patch(apiPath('/incidents/INC0010001'), async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json(incident({ state: 'resolved' }));
      }),
    );
    const { user } = renderApp({ path: '/incidents', user: analystUser });
    await user.click(await screen.findByRole('button', { name: 'INC0010001' }));
    const panel = screen.getByRole('complementary', { name: 'Incident INC0010001' });

    await user.selectOptions(within(panel).getByLabelText('État'), 'resolved');
    await user.click(within(panel).getByRole('button', { name: 'Mettre à jour' }));

    expect(await screen.findByText('Incident mis à jour.')).toBeInTheDocument();
    expect(patch).toEqual({ state: 'resolved' });
  });

  it('lets an analyst declare an incident (POST), validating the form first', async () => {
    let created: unknown = null;
    server.use(
      http.post(apiPath('/incidents'), async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(incident({ number: 'INC0010999', state: 'new' }), { status: 201 });
      }),
    );
    const { user } = renderApp({ path: '/incidents', user: analystUser });
    await user.click(await screen.findByRole('button', { name: 'Nouvel incident' }));
    const form = screen.getByRole('complementary', { name: 'Déclarer un incident' });

    await user.click(within(form).getByRole('button', { name: 'Créer l’incident' }));
    expect(within(form).getByLabelText('Description courte')).toHaveAccessibleDescription(
      'Entre 5 et 160 caractères.',
    );
    expect(created).toBeNull();

    await user.type(within(form).getByLabelText('Description courte'), 'VPN inaccessible');
    await user.selectOptions(within(form).getByLabelText('Priorité'), '2');
    await user.selectOptions(within(form).getByLabelText('Service'), 'network');
    await user.type(within(form).getByLabelText('Catégorie'), 'network');
    await user.type(within(form).getByLabelText('Groupe d’affectation'), 'Network L2');
    await user.click(within(form).getByRole('button', { name: 'Créer l’incident' }));

    expect(await screen.findByText('Incident INC0010999 créé.')).toBeInTheDocument();
    expect(created).toEqual({
      shortDescription: 'VPN inaccessible',
      priority: 2,
      category: 'network',
      service: 'network',
      assignmentGroup: 'Network L2',
    });
  });
});
