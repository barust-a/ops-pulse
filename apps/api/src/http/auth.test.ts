import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Bodies, bodyAs, errorOf } from '../testing/http.js';
import { buildTestApp, TEST_PASSWORD } from '../testing/test-app.js';

const LOGIN = '/api/v1/auth/login';

describe('POST /api/v1/auth/login', () => {
  it('returns a token and the user for valid credentials, the email matched case-insensitively', async () => {
    const { app, tokens } = buildTestApp();
    const response = await request(app)
      .post(LOGIN)
      .send({ email: 'Analyst@Ops-Pulse.test', password: TEST_PASSWORD });
    expect(response.status).toBe(200);
    const body = bodyAs(Bodies.login, response);
    expect(body.user).toEqual({ id: 2, email: 'analyst@ops-pulse.test', role: 'analyst' });
    expect(tokens.verify(body.token)).toEqual({ userId: 2, role: 'analyst' });
  });

  it('rejects a wrong password with UNAUTHENTICATED', async () => {
    const { app } = buildTestApp();
    const response = await request(app)
      .post(LOGIN)
      .send({ email: 'analyst@ops-pulse.test', password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password' },
    });
  });

  it('answers an unknown email exactly like a wrong password', async () => {
    const { app } = buildTestApp();
    const response = await request(app)
      .post(LOGIN)
      .send({ email: 'nobody@ops-pulse.test', password: TEST_PASSWORD });
    expect(response.status).toBe(401);
    expect(errorOf(response).message).toBe('Invalid email or password');
  });

  it('lists every invalid field in VALIDATION_FAILED details', async () => {
    const { app } = buildTestApp();
    const response = await request(app).post(LOGIN).send({ email: 'not-an-email' });
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    expect(errorOf(response).details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: 'body', path: 'email' }),
        expect.objectContaining({ location: 'body', path: 'password' }),
      ]),
    );
  });

  it('allows 5 attempts per minute and per IP, then answers RATE_LIMITED', async () => {
    const { app } = buildTestApp();
    function attempt() {
      return request(app).post(LOGIN).send({ email: 'x@ops-pulse.test', password: 'x' });
    }
    for (let index = 0; index < 5; index++) {
      const response = await attempt();
      expect(response.status).toBe(401);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the authenticated user', async () => {
    const { app, bearer } = buildTestApp();
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', bearer('viewer'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 3, email: 'viewer@ops-pulse.test', role: 'viewer' });
  });

  it('answers UNAUTHENTICATED without a token', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('answers UNAUTHENTICATED for an invalid token', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer abc.def.ghi');
    expect(response.status).toBe(401);
  });

  it('answers UNAUTHENTICATED when the account behind a valid token is gone', async () => {
    const { app, tokens } = buildTestApp();
    const token = tokens.issue({ userId: 999, role: 'admin' });
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(401);
  });
});

describe('GET /api/v1/auth/saml/metadata', () => {
  it('is NOT_FOUND while SAML is disabled', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/api/v1/auth/saml/metadata');
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('serves the service-provider metadata when SAML is enabled', async () => {
    const { app } = buildTestApp({
      saml: {
        enabled: true,
        issuer: 'urn:ops-pulse:sp',
        entryPoint: 'https://idp.example.test/sso',
        idpCert: 'MIIC-test-cert',
        callbackUrl: 'https://ops.example.test/api/v1/auth/saml/acs?a=1&b=2',
      },
    });
    const response = await request(app).get('/api/v1/auth/saml/metadata');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/samlmetadata+xml');
    expect(response.text).toContain('entityID="urn:ops-pulse:sp"');
    expect(response.text).toContain('Location="https://ops.example.test/api/v1/auth/saml/acs?a=1&amp;b=2"');
  });
});
