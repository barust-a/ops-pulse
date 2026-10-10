import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const BASE = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
};

describe('loadConfig', () => {
  it('applies the contract defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      jwtSecret: BASE.JWT_SECRET,
      jwtTtlSeconds: 3600,
      corsOrigins: ['http://localhost:5173'],
      port: 3000,
      logLevel: 'info',
      saml: { enabled: false },
    });
  });

  it('splits the CORS allow-list and trims each origin', () => {
    const config = loadConfig({ ...BASE, CORS_ORIGIN: 'https://a.test, https://b.test' });
    expect(config.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses a JWT secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('refuses a missing database URL', () => {
    expect(() => loadConfig({ JWT_SECRET: BASE.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('requires the SAML settings once SAML is enabled', () => {
    expect(() => loadConfig({ ...BASE, SAML_ENABLED: 'true' })).toThrow(/SAML_ISSUER/);
  });

  it('reads the SAML settings when SAML is enabled', () => {
    const config = loadConfig({
      ...BASE,
      SAML_ENABLED: 'true',
      SAML_ISSUER: 'urn:ops-pulse:sp',
      SAML_ENTRY_POINT: 'https://idp.example.test/sso',
      SAML_IDP_CERT: 'MIIC-test-cert',
      SAML_CALLBACK_URL: 'https://ops-pulse.example.test/api/v1/auth/saml/acs',
    });
    expect(config.saml).toEqual({
      enabled: true,
      issuer: 'urn:ops-pulse:sp',
      entryPoint: 'https://idp.example.test/sso',
      idpCert: 'MIIC-test-cert',
      callbackUrl: 'https://ops-pulse.example.test/api/v1/auth/saml/acs',
    });
  });

  it('treats empty values as unset, as a copied .env.example leaves them', () => {
    expect(loadConfig({ ...BASE, LOG_LEVEL: '', SAML_ENABLED: '' }).logLevel).toBe('info');
  });
});
