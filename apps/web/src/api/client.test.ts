import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { apiPath, errorBody, server } from '../test/handlers';
import { ApiError } from './apiError';
import { createApiClient, type ApiClientOptions } from './client';
import { fetchIncidents } from './endpoints';

function makeClient(overrides: Partial<ApiClientOptions> = {}) {
  const onUnauthorized = vi.fn();
  const client = createApiClient({ getToken: () => 'jwt-123', onUnauthorized, ...overrides });
  return { client, onUnauthorized };
}

const PingSchema = z.object({ pong: z.boolean() });

/** A server that never answers: the request only ends when its signal aborts. */
function hangingFetch(_url: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('createApiClient', () => {
  it('sends the bearer token and returns the parsed body', async () => {
    let authorization: string | null = null;
    server.use(
      http.get(apiPath('/ping'), ({ request }) => {
        authorization = request.headers.get('Authorization');
        return HttpResponse.json({ pong: true });
      }),
    );
    const { client } = makeClient();

    await expect(client.request({ path: '/ping', schema: PingSchema })).resolves.toEqual({
      pong: true,
    });
    expect(authorization).toBe('Bearer jwt-123');
  });

  it('omits the Authorization header when there is no token', async () => {
    let hasAuthorization = true;
    server.use(
      http.get(apiPath('/ping'), ({ request }) => {
        hasAuthorization = request.headers.has('Authorization');
        return HttpResponse.json({ pong: true });
      }),
    );
    const { client } = makeClient({ getToken: () => null });

    await client.request({ path: '/ping', schema: PingSchema });

    expect(hasAuthorization).toBe(false);
  });

  it('maps the contract error shape to a typed ApiError', async () => {
    server.use(
      http.post(apiPath('/incidents'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'bad body',
              details: [{ path: 'priority' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { client } = makeClient();

    const error = await rejectionOf(
      client.request({ method: 'POST', path: '/incidents', body: {}, schema: PingSchema }),
    );

    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'bad body',
      details: [{ path: 'priority' }],
    });
  });

  it('derives the code from the status when the body is not the contract shape', async () => {
    server.use(http.get(apiPath('/ping'), () => new HttpResponse('nope', { status: 403 })));
    const { client } = makeClient();

    const error = await rejectionOf(client.request({ path: '/ping', schema: PingSchema }));

    expect(error.code).toBe('FORBIDDEN');
  });

  it('calls onUnauthorized on a 401', async () => {
    server.use(
      http.get(apiPath('/ping'), () =>
        HttpResponse.json(errorBody('UNAUTHENTICATED', 'expired'), { status: 401 }),
      ),
    );
    const { client, onUnauthorized } = makeClient();

    const error = await rejectionOf(client.request({ path: '/ping', schema: PingSchema }));

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects a payload that does not match the schema', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    server.use(
      http.get(apiPath('/incidents'), () =>
        HttpResponse.json({ items: [{ number: 42 }], page: 1, pageSize: 25, total: 1 }),
      ),
    );
    const { client } = makeClient();

    const error = await rejectionOf(
      fetchIncidents(client, {
        from: '2026-09-10',
        to: '2026-10-10',
        page: 1,
        pageSize: 25,
        sort: '-openedAt',
      }),
    );

    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('serialises the query and skips empty values', async () => {
    let search = '';
    server.use(
      http.get(apiPath('/ping'), ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ pong: true });
      }),
    );
    const { client } = makeClient();

    await client.request({
      path: '/ping',
      query: { service: 'crm', priority: 2, state: null, q: '', page: undefined },
      schema: PingSchema,
    });

    expect(search).toBe('?service=crm&priority=2');
  });

  it('fails with TIMEOUT when the server does not answer in time', async () => {
    const { client } = makeClient({ fetchFn: hangingFetch, timeoutMs: 5 });

    const error = await rejectionOf(client.request({ path: '/ping', schema: PingSchema }));

    expect(error.code).toBe('TIMEOUT');
  });

  it('fails with ABORTED when the caller cancels', async () => {
    server.use(http.get(apiPath('/ping'), () => HttpResponse.json({ pong: true })));
    const controller = new AbortController();
    controller.abort();
    const { client } = makeClient();

    const error = await rejectionOf(
      client.request({ path: '/ping', schema: PingSchema, signal: controller.signal }),
    );

    expect(error.code).toBe('ABORTED');
  });
});
