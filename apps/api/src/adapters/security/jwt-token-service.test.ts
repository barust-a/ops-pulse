import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { createJwtTokenService } from './jwt-token-service.js';

const SECRET = 'test-only-secret-with-at-least-32-characters';
const NOW_S = 1_791_000_000;

function encode(part: object): string {
  return Buffer.from(JSON.stringify(part)).toString('base64url');
}

function service(nowS = NOW_S) {
  return createJwtTokenService({ secret: SECRET, ttlSeconds: 3600, clock: () => new Date(nowS * 1000) });
}

describe('createJwtTokenService', () => {
  it('verifies the claims of a token it issued', () => {
    const tokens = service();
    const token = tokens.issue({ userId: 7, role: 'analyst' });
    expect(tokens.verify(token)).toEqual({ userId: 7, role: 'analyst' });
  });

  it('signs with HS256 for the ops-pulse issuer and web audience, with an expiry', () => {
    const token = service().issue({ userId: 7, role: 'viewer' });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    expect(decoded?.payload).toMatchObject({
      iss: 'ops-pulse',
      aud: 'ops-pulse-web',
      sub: '7',
      exp: NOW_S + 3600,
    });
  });

  it('rejects an expired token', () => {
    const token = service().issue({ userId: 7, role: 'viewer' });
    expect(service(NOW_S + 3601).verify(token)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const forged = jwt.sign({ role: 'admin' }, 'another-secret-with-at-least-32-characters', {
      algorithm: 'HS256',
      issuer: 'ops-pulse',
      audience: 'ops-pulse-web',
      subject: '1',
    });
    expect(service().verify(forged)).toBeNull();
  });

  it('rejects a token for another audience', () => {
    const other = jwt.sign({ role: 'admin' }, SECRET, {
      algorithm: 'HS256',
      issuer: 'ops-pulse',
      audience: 'someone-else',
      subject: '1',
    });
    expect(service().verify(other)).toBeNull();
  });

  it('rejects an unsigned token', () => {
    const claims = { sub: '1', role: 'admin', iss: 'ops-pulse', aud: 'ops-pulse-web' };
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
    expect(service().verify(unsigned)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(service().verify('not-a-jwt')).toBeNull();
  });
});
