# ADR-0004: JWT authentication now, SAML 2.0 single sign-on behind a feature flag

**Date**: 2026-10-10
**Status**: accepted
**Deciders**: Alexandre Barusta (lead developer), security officer, identity team

## Context

SupervIT v1 stores unsalted MD5 passwords and uses a PHP session cookie without `Secure` or
`HttpOnly`. The target must be secure from the first release; the mission mentions JWT, bcrypt and
"SAML 2.0 si requis". The corporate IdP onboarding (metadata exchange, attribute mapping, change
request on the IdP side) takes weeks and must not block the first deliveries.

## Decision

Ship local accounts with bcrypt (cost 12) and short-lived JWT access tokens (HS256, `iss`, `aud`,
`exp`, default 1 h, role claim) in v0.1. Prepare SAML 2.0 as a service provider behind
`SAML_ENABLED` (default `false`): the SP metadata endpoint `/api/v1/auth/saml/metadata` exists and
returns 404 while the flag is off; after a successful assertion the API issues the same JWT, so the
rest of the system does not change.

## Alternatives Considered

### Alternative 1: Server-side sessions with an `HttpOnly` cookie
- **Pros**: revocable instantly; token not readable by scripts.
- **Cons**: needs a session store shared by API replicas; CSRF protection required.
- **Why not**: stateless JWT with a short TTL fits the stateless API and the strict CSP; revisit
  with a refresh-token cookie if longer sessions are required.

### Alternative 2: SAML only, from day one
- **Pros**: no local passwords at all.
- **Cons**: blocks every environment (dev, CI, demo) on the IdP; no fallback when the IdP is down.
- **Why not**: the flag lets SSO arrive when the IdP is ready, without rework.

### Alternative 3: OpenID Connect
- **Pros**: modern, JSON-based.
- **Cons**: the corporate IdP exposes SAML 2.0 for internal applications.
- **Why not**: follow the IdP's standard; the JWT issued afterwards hides the protocol anyway.

## Consequences

### Positive
- No password stored in a reversible or fast hash; login brute force limited to 5/min/IP.
- SSO can be switched on per environment by configuration.

### Negative
- A JWT cannot be revoked before `exp`: the TTL stays short, and rotating `JWT_SECRET` logs
  everyone out (documented in [maintenance](../ops/maintenance.md#rotating-the-jwt-secret)).
- The token lives in `sessionStorage`: the strict CSP is the main XSS mitigation.

### Risks
- HS256 shares one secret between issuer and verifier: acceptable with a single API; move to
  RS256/ES256 if another service must verify tokens.
