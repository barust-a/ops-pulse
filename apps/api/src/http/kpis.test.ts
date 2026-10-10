import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { DailyKpi } from '../domain/kpi.js';
import { Bodies, bodyAs } from '../testing/http.js';
import { buildTestApp, changeRecord, incidentRecord } from '../testing/test-app.js';

function daily(overrides: Partial<DailyKpi>): DailyKpi {
  return {
    day: '2026-10-01',
    service: 'payments',
    incidentCount: 10,
    resolvedCount: 8,
    mttrMinutes: 120,
    p90ResolutionMinutes: 300,
    slaBreachRate: 0.1,
    changeCount: 2,
    changeFailureRate: 0.5,
    incidentZscore: 0.4,
    isAnomaly: false,
    ...overrides,
  };
}

describe('GET /api/v1/kpis/summary', () => {
  it('aggregates the Dataiku daily rows of the range, with the live open count', async () => {
    const { app, bearer } = buildTestApp({
      daily: [
        daily({ day: '2026-10-01', resolvedCount: 1, mttrMinutes: 100, isAnomaly: true }),
        daily({ day: '2026-10-02', resolvedCount: 3, mttrMinutes: 20 }),
        daily({ day: '2026-08-01', resolvedCount: 100, mttrMinutes: 9999 }),
      ],
      incidents: [
        incidentRecord(),
        incidentRecord({
          number: 'INC0010002',
          state: 'resolved',
          openedAt: new Date('2026-10-05T08:00:00.000Z'),
          resolvedAt: new Date('2026-10-05T09:30:00.000Z'),
        }),
      ],
    });
    const response = await request(app)
      .get('/api/v1/kpis/summary')
      .query({ from: '2026-10-01', to: '2026-10-10' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      openIncidents: 1,
      mttrMinutes: 40,
      p90ResolutionMinutes: 90,
      slaBreachRate: 0.1,
      changeFailureRate: 0.5,
      anomalies: 1,
    });
  });

  it('answers zeros, not an error, while Dataiku has not computed the range', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get('/api/v1/kpis/summary').set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(bodyAs(Bodies.kpiSummary, response)).toMatchObject({ mttrMinutes: 0, anomalies: 0 });
  });
});

describe('GET /api/v1/kpis/daily', () => {
  it('lists the daily rows of one service', async () => {
    const { app, bearer } = buildTestApp({
      daily: [daily({ service: 'payments' }), daily({ service: 'crm' })],
    });
    const response = await request(app)
      .get('/api/v1/kpis/daily')
      .query({ from: '2026-10-01', to: '2026-10-01', service: 'crm' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(bodyAs(Bodies.dailyKpis, response).items).toEqual([daily({ service: 'crm' })]);
  });
});

describe('GET /api/v1/kpis/by-priority and /kpis/heatmap', () => {
  it('returns one item per priority', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get('/api/v1/kpis/by-priority').set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    const { items } = bodyAs(Bodies.priorityKpis, response);
    expect(items.map((item) => item.priority)).toEqual([1, 2, 3, 4]);
  });

  it('returns the full weekday × hour grid', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get('/api/v1/kpis/heatmap').set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(bodyAs(Bodies.heatmap, response).items).toHaveLength(7 * 24);
  });

  it('rejects an unknown query parameter', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .get('/api/v1/kpis/heatmap')
      .query({ service: 'crm' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/kpis/change-outcomes', () => {
  it('counts the changes closed in the range per service and close code', async () => {
    const { app, bearer } = buildTestApp({
      changes: [
        changeRecord(),
        changeRecord({ number: 'CHG0030002', closeCode: 'backed_out' }),
        changeRecord({ number: 'CHG0030003', service: 'crm' }),
        changeRecord({ number: 'CHG0030004', state: 'cancelled', closeCode: null }),
        changeRecord({ number: 'CHG0030005', closedAt: new Date('2026-07-01T10:00:00.000Z') }),
      ],
    });
    const response = await request(app)
      .get('/api/v1/kpis/change-outcomes')
      .query({ from: '2026-10-01', to: '2026-10-10' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(bodyAs(Bodies.changeOutcomes, response).items).toEqual([
      { service: 'crm', closeCode: 'successful', count: 1 },
      { service: 'payments', closeCode: 'backed_out', count: 1 },
      { service: 'payments', closeCode: 'successful', count: 1 },
    ]);
  });
});

describe('GET /api/v1/changes', () => {
  it('pages the changes, serialised as the contract Change', async () => {
    const { app, bearer } = buildTestApp({ changes: [changeRecord(), changeRecord({ number: 'CHG0030002', type: 'emergency' })] });
    const response = await request(app)
      .get('/api/v1/changes')
      .query({ type: 'emergency' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          number: 'CHG0030002',
          shortDescription: 'Rotate TLS certificates on the payment gateway',
          type: 'emergency',
          risk: 'moderate',
          state: 'closed',
          closeCode: 'successful',
          service: 'payments',
          plannedStart: '2026-10-08T20:00:00.000Z',
          plannedEnd: '2026-10-08T22:00:00.000Z',
          closedAt: '2026-10-08T22:10:00.000Z',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
    });
  });
});
