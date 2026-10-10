import type { ERROR_CODES } from './schemas';

/** Contract codes, plus the failures the client detects itself before any server answer. */
export type ApiErrorCode =
  (typeof ERROR_CODES)[number] | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'INVALID_RESPONSE';

interface ApiErrorInit {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly details?: readonly unknown[];
  readonly cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly details: readonly unknown[];

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details ?? [];
  }
}

/** Anything a request rejected with, as an ApiError: the UI only ever handles that one type. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({ code: 'NETWORK', message: 'Unexpected failure', cause: error });
}
