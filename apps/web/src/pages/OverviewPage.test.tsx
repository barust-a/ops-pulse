import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { fakeEcharts } from '../test/fakeEcharts';
import { analystUser } from '../test/fixtures';
import { apiPath, errorBody, server } from '../test/handlers';
import { renderApp } from '../test/renderApp';

describe('OverviewPage', () => {
  it('renders the six KPI tiles from the summary', async () => {
    renderApp({ user: analystUser });

    const tiles = await screen.findByRole('list', { name: 'Vue d’ensemble' });
    const items = within(tiles).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent('Incidents ouverts42');
    expect(items[1]).toHaveTextContent('MTTR3 h 25 min');
    expect(items[3]).toHaveTextContent(/Taux de dépassement SLA12,5\s%/);
    expect(items[5]).toHaveTextContent('Anomalies détectées3');
  });

  it('draws the four charts with a text alternative', async () => {
    renderApp({ user: analystUser });

    expect(
      await screen.findByRole('img', { name: /Courbes du nombre d’incidents par jour/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /par priorité/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Carte de chaleur/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /taux d’échec des changements/ })).toBeInTheDocument();
    expect(fakeEcharts.charts).toHaveLength(4);
    expect(screen.getByRole('table', { name: /incidents par service/ })).toBeInTheDocument();
  });

  it('asks for the last 30 days by default, and the chosen service', async () => {
    const queries: string[] = [];
    server.use(
      http.get(apiPath('/kpis/summary'), ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({
          openIncidents: 1,
          mttrMinutes: 1,
          p90ResolutionMinutes: 1,
          slaBreachRate: 0,
          changeFailureRate: 0,
          anomalies: 0,
        });
      }),
    );
    const { user } = renderApp({ user: analystUser });
    await screen.findByRole('list', { name: 'Vue d’ensemble' });

    await user.selectOptions(screen.getByLabelText('Service'), 'crm');
    await screen.findByRole('list', { name: 'Vue d’ensemble' });

    expect(queries).toEqual(['?from=2026-09-11&to=2026-10-10', '?from=2026-09-11&to=2026-10-10&service=crm']);
  });

  it('shows the empty state when Dataiku has not produced KPIs yet', async () => {
    server.use(http.get(apiPath('/kpis/daily'), () => HttpResponse.json({ items: [] })));

    renderApp({ user: analystUser });

    expect(
      await screen.findByText('Aucune donnée KPI — lancez le flow Dataiku'),
    ).toBeInTheDocument();
  });

  it('shows the error state and recovers on retry', async () => {
    let calls = 0;
    server.use(
      http.get(apiPath('/kpis/heatmap'), () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(errorBody('INTERNAL', 'boom'), { status: 500 });
        }
        return HttpResponse.json({ items: [] });
      }),
    );
    const { user } = renderApp({ user: analystUser });

    expect(await screen.findByRole('alert')).toHaveTextContent('Erreur interne du serveur.');
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByRole('list', { name: 'Vue d’ensemble' })).toBeInTheDocument();
  });
});
