import type { RequestHandler, Response } from 'express';

import type { Role } from '../../domain/roles.js';
import { hasRole } from '../../domain/roles.js';
import type { AccessClaims, TokenService } from '../../ports/security.js';
import { AccessClaimsSchema } from '../../ports/security.js';
import { HttpError } from '../errors.js';

const BEARER = /^Bearer (\S+)$/i;

/** Rejects a request without a valid bearer token; otherwise records its claims on res.locals. */
export function authenticate(tokens: TokenService): RequestHandler {
  return (req, res, next) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const claims = token === undefined ? null : tokens.verify(token);
    if (claims === null) throw new HttpError('UNAUTHENTICATED', 'Missing or invalid bearer token');
    res.locals.claims = claims;
    next();
  };
}

/** The claims authenticate() recorded; throws (a wiring bug) when it did not run first. */
export function claimsOf(res: Response): AccessClaims {
  return AccessClaimsSchema.parse(res.locals.claims);
}

export function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (!hasRole(claimsOf(res).role, role)) {
      throw new HttpError('FORBIDDEN', `This action needs the ${role} role`);
    }
    next();
  };
}
