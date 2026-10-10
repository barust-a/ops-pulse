import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Bodies, bodyAs, errorOf } from '../testing/http.js';
import { buildTestApp, incidentRecord } from '../testing/test-app.js';

const INCIDENTS = '/api/v1/incidents';

function manyIncidents(count: number) {
  return Array.from({ length: count }, (_, index) =>
    incidentRecord({
      number: `INC${String(10_001 + index).padStart(7, '0')}`,
      openedAt: new Date(Date.UTC(2026, 9, 9, 0, index)),
    }),
  );
}

describe('GET /api/v1/incidents', () => {
  it('answers UNAUTHENTICATED without a token', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get(INCIDENTS);
    expect(response.status).toBe(401);
  });

  it('pages the incidents of the last 30 days for a viewer', async () => {
    const { app, bearer } = buildTestApp({ incidents: manyIncidents(30) });
    const response = await request(app)
      .get(INCIDENTS)
      .query({ page: 2, pageSize: 25 })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    const body = bodyAs(Bodies.incidentPage, response);
    expect(body).toMatchObject({ page: 2, pageSize: 25, total: 30 });
    expect(body.items).toHaveLength(5);
  });

  it('serialises the contract Incident, with the SLA status at the current time', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get(INCIDENTS).set('Authorization', bearer('viewer'));
    expect(bodyAs(Bodies.incidentPage, response).items[0]).toEqual({
      number: 'INC0010001',
      shortDescription: 'Checkout latency above 2 s',
      priority: 2,
      state: 'in_progress',
      category: 'software',
      service: 'payments',
      assignmentGroup: 'Payments Ops',
      openedAt: '2026-10-09T08:00:00.000Z',
      resolvedAt: null,
      slaDueAt: '2026-10-09T16:00:00.000Z',
      slaBreached: true,
      causedByChange: null,
    });
  });

  it.each([
    [{ pageSize: 101 }, 'pageSize'],
    [{ page: 0 }, 'page'],
    [{ priority: 5 }, 'priority'],
    [{ service: 'mainframe' }, 'service'],
    [{ sort: 'shortDescription' }, 'sort'],
    [{ from: '2026-13-01' }, 'from'],
  ])('rejects the query %o with VALIDATION_FAILED on %s', async (query, path) => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get(INCIDENTS).query(query).set('Authorization', bearer('viewer'));
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    expect(errorOf(response).details).toEqual([expect.objectContaining({ location: 'query', path })]);
  });

  it('rejects a range that ends before it starts', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .get(INCIDENTS)
      .query({ from: '2026-10-05', to: '2026-10-01' })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/incidents/:number', () => {
  it('returns one incident', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get(`${INCIDENTS}/INC0010001`).set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(bodyAs(Bodies.incident, response).number).toBe('INC0010001');
  });

  it('answers NOT_FOUND for an unknown number', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get(`${INCIDENTS}/INC0099999`).set('Authorization', bearer('viewer'));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Incident INC0099999 not found' },
    });
  });

  it('rejects a malformed number', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get(`${INCIDENTS}/42`).set('Authorization', bearer('viewer'));
    expect(response.status).toBe(400);
    expect(errorOf(response).details?.[0]).toMatchObject({ location: 'params', path: 'number' });
  });
});

describe('POST /api/v1/incidents', () => {
  const body = {
    shortDescription: 'Login page returns 502',
    priority: 1,
    category: 'software',
    service: 'identity',
    assignmentGroup: 'Service Desk',
  };

  it('is FORBIDDEN to a viewer', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).post(INCIDENTS).send(body).set('Authorization', bearer('viewer'));
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
  });

  it('opens a new incident for an analyst, due by its priority target', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).post(INCIDENTS).send(body).set('Authorization', bearer('analyst'));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      ...body,
      state: 'new',
      openedAt: '2026-10-10T12:00:00.000Z',
      slaDueAt: '2026-10-10T16:00:00.000Z',
      resolvedAt: null,
      slaBreached: false,
    });
    expect(bodyAs(Bodies.incident, response).number).toMatch(/^INC\d{7}$/);
  });

  it('rejects an unknown assignment group', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .post(INCIDENTS)
      .send({ ...body, assignmentGroup: 'Nobody' })
      .set('Authorization', bearer('admin'));
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toEqual([
      expect.objectContaining({ location: 'body', path: 'assignmentGroup' }),
    ]);
  });

  it('rejects unknown fields', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .post(INCIDENTS)
      .send({ ...body, state: 'closed' })
      .set('Authorization', bearer('analyst'));
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/v1/incidents/:number', () => {
  it('resolves an incident and stamps the resolution time', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .patch(`${INCIDENTS}/INC0010001`)
      .send({ state: 'resolved' })
      .set('Authorization', bearer('analyst'));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: 'resolved', resolvedAt: '2026-10-10T12:00:00.000Z' });
  });

  it('rejects an empty patch', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .patch(`${INCIDENTS}/INC0010001`)
      .send({})
      .set('Authorization', bearer('analyst'));
    expect(response.status).toBe(400);
  });

  it('is FORBIDDEN to a viewer', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .patch(`${INCIDENTS}/INC0010001`)
      .send({ priority: 1 })
      .set('Authorization', bearer('viewer'));
    expect(response.status).toBe(403);
  });

  it('answers NOT_FOUND for an unknown number', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app)
      .patch(`${INCIDENTS}/INC0099999`)
      .send({ priority: 1 })
      .set('Authorization', bearer('admin'));
    expect(response.status).toBe(404);
  });
});
