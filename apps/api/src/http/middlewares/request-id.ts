import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// A caller-supplied id (from nginx or the SPA) is kept only when it is short and inert, so it
// cannot inject anything into logs or headers.
const ACCEPTED_ID = /^[\w-]{1,128}$/;

/**
 * pino-http's genReqId: reuses the caller's X-Request-Id or creates one, and returns it in the
 * response so a user can quote it and an operator can find every log line of the request.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && ACCEPTED_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
