import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { bodyAs, errorOf } from '../testing/http.js';
import { ALLOWED_ORIGIN, buildTestApp } from '../testing/test-app.js';

describe('GET /api/v1/health', () => {
  it('reports the API and database up, with the version', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up', version: '0.0.0-test' });
  });

  it('reports the database down without failing the probe', async () => {
    const { app, database } = buildTestApp();
    database.up = false;
    const response = await request(app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', db: 'down' });
  });
});

describe('cross-cutting HTTP behaviour', () => {
  it('answers an unknown route with the NOT_FOUND error shape', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/nope');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/v1/nope' },
    });
  });

  it('hides the cause of an unexpected failure behind INTERNAL, without a stack trace', async () => {
    const { app, bearer } = buildTestApp({
      overrides: {
        changes: {
          list() {
            return Promise.reject(new Error('connection reset by peer at db.internal:5432'));
          },
        },
      },
    });
    const response = await request(app).get('/api/v1/changes').set('Authorization', bearer('viewer'));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    expect(response.text).not.toContain('db.internal');
    expect(response.text).not.toMatch(/at .*\.ts/);
  });

  it('answers malformed JSON with VALIDATION_FAILED', async () => {
    const { app } = buildTestApp();
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
  });

  it('echoes a well-formed request id and generates one otherwise', async () => {
    const { app } = buildTestApp();
    const echoed = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123');
    expect(echoed.headers['x-request-id']).toBe('abc-123');
    const generated = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id!');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets the helmet security headers', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS for an origin on the allow-list only', async () => {
    const { app } = buildTestApp();
    const allowed = await request(app).get('/api/v1/health').set('Origin', ALLOWED_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const denied = await request(app).get('/api/v1/health').set('Origin', 'https://evil.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API documentation', () => {
  it('serves an OpenAPI 3.1 document describing every route', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/openapi.json');
    expect(response.status).toBe(200);
    const document = bodyAs(
      z.object({ openapi: z.string(), paths: z.record(z.string(), z.unknown()) }),
      response,
    );
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/auth/login',
        '/auth/me',
        '/auth/saml/metadata',
        '/incidents',
        '/incidents/{number}',
        '/changes',
        '/kpis/summary',
        '/kpis/daily',
        '/kpis/by-priority',
        '/kpis/heatmap',
        '/kpis/change-outcomes',
      ]),
    );
  });

  it('serves the Swagger UI', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/docs/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('swagger-ui');
  });
});
