import type { Request } from 'express';
import type { z } from 'zod';

import type { ErrorDetail } from './errors.js';
import { HttpError } from './errors.js';

type Location = ErrorDetail['location'];

function parseOrReject<T>(schema: z.ZodType<T>, value: unknown, location: Location): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    location,
    path: issue.path.join('.'),
    message: issue.message,
  }));
  throw new HttpError('VALIDATION_FAILED', 'Request validation failed', details);
}

// Each handler validates its input first, through these: Express 5 forwards the thrown
// VALIDATION_FAILED to errorHandler, and the handler continues with fully typed values.

export function validBody<T>(schema: z.ZodType<T>, req: Request): T {
  return parseOrReject(schema, req.body, 'body');
}

export function validQuery<T>(schema: z.ZodType<T>, req: Request): T {
  return parseOrReject(schema, req.query, 'query');
}

export function validParams<T>(schema: z.ZodType<T>, req: Request): T {
  return parseOrReject(schema, req.params, 'params');
}
