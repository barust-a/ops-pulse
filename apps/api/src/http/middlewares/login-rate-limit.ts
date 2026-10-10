import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { HttpError } from '../errors.js';

/**
 * 5 login attempts per minute and per client IP (contract, "Security baseline"). Each app gets
 * its own in-memory store: fine for one API instance; several replicas would share a Redis store.
 */
export function loginRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new HttpError('RATE_LIMITED', 'Too many login attempts: retry in a minute'));
    },
  });
}
