import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors.js';

// What express.json() throws for a body it cannot read (malformed JSON, too large, bad charset).
const BodyParserErrorSchema = z.object({
  type: z.string(),
  status: z.number().int().min(400).max(499),
});

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (BodyParserErrorSchema.safeParse(error).success) {
    return new HttpError('VALIDATION_FAILED', 'Malformed request body');
  }
  return new HttpError('INTERNAL', 'Internal server error');
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

/**
 * Answers every error with the contract shape. Unexpected errors are logged once, here, with the
 * request id, and reach the client only as INTERNAL: no message, no stack trace.
 */
// eslint-disable-next-line no-restricted-syntax -- Express spots an error handler by its 4 params.
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const httpError = toHttpError(error);
  if (httpError.status >= 500) req.log.error({ err: error }, 'request failed');
  res.status(httpError.status).json(httpError.toResponse());
};
