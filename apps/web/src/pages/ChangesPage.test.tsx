import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { change, changeOutcomes, viewerUser } from '../test/fixtures';
import { apiPath, server } from '../test/handlers';
import { renderApp } from '../test/renderApp';

/** Records the query of every GET /changes and GET /kpis/change-outcomes. */
function recordQueries() {
  const changes: Record<string, string>[] = [];
  const outcomes: Record<string, string>[] = [];
  server.use(
    http.get(apiPath('/changes'), ({ request }) => {
      changes.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json({ items: [change()], page: 1, pageSize: 25, total: 1 });
    }),
    http.get(apiPath('/kpis/change-outcomes'), ({ request }) => {
      outcomes.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json({ items: changeOutcomes });
    }),
  );
  return { changes, outcomes };
}

describe('ChangesPage', () => {
  it('lists changes and filters the table server-side', async () => {
    const { changes } = recordQueries();
    const { user } = renderApp({ path: '/changes', user: viewerUser });
    expect(await screen.findByText('CHG0030007')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Type'), 'emergency');
    await screen.findByText('CHG0030007');

    expect(changes.at(-1)).toMatchObject({ type: 'emergency', page: '1', pageSize: '25' });
    expect(changes.every((query) => query.state !== 'closed' || query.pageSize !== '100')).toBe(true);
  });

  it('charts close codes from the change-outcomes aggregate over the period', async () => {
    const { outcomes } = recordQueries();
    renderApp({ path: '/changes', user: viewerUser });

    expect(await screen.findByRole('img', { name: /codes de clôture/ })).toBeInTheDocument();
    expect(outcomes).toEqual([{ from: '2026-09-11', to: '2026-10-10' }]);
    const summary = screen.getByRole('table', { name: /codes de clôture par service/ });
    expect(summary).toHaveTextContent('network7');
    expect(summary).toHaveTextContent('crm4');
  });

  it('keeps only the selected service in the chart', async () => {
    const { outcomes } = recordQueries();
    const { user } = renderApp({ path: '/changes', user: viewerUser });
    await screen.findByRole('img', { name: /codes de clôture/ });

    await user.selectOptions(screen.getByLabelText('Service'), 'crm');

    const summary = await screen.findByRole('table', { name: /codes de clôture par service/ });
    expect(summary).toHaveTextContent('crm');
    expect(summary).not.toHaveTextContent('network');
    expect(outcomes).toHaveLength(1);
  });
});
