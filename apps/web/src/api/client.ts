import type { z } from 'zod';

import { ApiError, type ApiErrorCode } from './apiError';
import { ErrorBodySchema } from './schemas';

type QueryValue = string | number | null | undefined;
type QueryParams = Readonly<Record<string, QueryValue>>;

interface ApiRequest<T> {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly query?: QueryParams;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  request<T>(request: ApiRequest<T>): Promise<T>;
}

export interface ApiClientOptions {
  /** Read on every request, so a login or logout applies to the next call. */
  readonly getToken: () => string | null;
  /** Called on any 401: the session is gone or was never valid. */
  readonly onUnauthorized: () => void;
  readonly baseUrl?: string;
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const CODE_BY_STATUS: Readonly<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

function buildUrl(origin: string, path: string, query: QueryParams = {}): URL {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError({
      code: 'INVALID_RESPONSE',
      message: 'Response body is not JSON',
      status: response.status,
      cause: error,
    });
  }
}

async function toHttpError(response: Response): Promise<ApiError> {
  const body = await readJson(response).catch(() => null);
  const parsed = ErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError({ code, message, status: response.status, details: details ?? [] });
  }
  return new ApiError({
    code: CODE_BY_STATUS[response.status] ?? 'INTERNAL',
    message: response.statusText || `HTTP ${String(response.status)}`,
    status: response.status,
  });
}

function toTransportError(
  error: unknown,
  signals: { readonly caller?: AbortSignal; readonly timeout: AbortSignal },
): ApiError {
  if (signals.caller?.aborted === true) {
    return new ApiError({ code: 'ABORTED', message: 'Request aborted', cause: error });
  }
  if (signals.timeout.aborted) {
    return new ApiError({ code: 'TIMEOUT', message: 'Request timed out', cause: error });
  }
  return new ApiError({ code: 'NETWORK', message: 'Network failure', cause: error });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  function headersFor(hasBody: boolean): Headers {
    const headers = new Headers({ Accept: 'application/json' });
    if (hasBody) headers.set('Content-Type', 'application/json');
    const token = options.getToken();
    if (token !== null) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function send(apiRequest: ApiRequest<unknown>): Promise<Response> {
    const origin = options.origin ?? globalThis.location.origin;
    const url = buildUrl(origin, `${baseUrl}${apiRequest.path}`, apiRequest.query);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = apiRequest.signal ? AbortSignal.any([apiRequest.signal, timeout]) : timeout;
    const hasBody = apiRequest.body !== undefined;
    try {
      return await fetchFn(url, {
        method: apiRequest.method ?? 'GET',
        headers: headersFor(hasBody),
        body: hasBody ? JSON.stringify(apiRequest.body) : undefined,
        signal,
      });
    } catch (error) {
      throw toTransportError(error, { caller: apiRequest.signal, timeout });
    }
  }

  async function request<T>(apiRequest: ApiRequest<T>): Promise<T> {
    const response = await send(apiRequest);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized();
      throw await toHttpError(response);
    }
    const parsed = apiRequest.schema.safeParse(await readJson(response));
    if (!parsed.success) {
      // Logged once here, where the contract drift is detected; callers only see the typed error.
      console.warn(`Contract mismatch on ${apiRequest.path}`, parsed.error.issues);
      throw new ApiError({
        code: 'INVALID_RESPONSE',
        message: `Unexpected response shape for ${apiRequest.path}`,
        status: response.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return { request };
}
