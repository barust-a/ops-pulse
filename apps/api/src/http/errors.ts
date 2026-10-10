import { z } from 'zod';

const ApiErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

const ErrorDetailSchema = z.object({
  location: z.enum(['body', 'query', 'params']),
  path: z.string(),
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

/** The contract error shape, used by every non-2xx JSON response. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.array(ErrorDetailSchema).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** An expected failure, translated to its status and the contract error shape by errorHandler. */
export class HttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = STATUS_BY_CODE[code];
  }

  toResponse(): ErrorResponse {
    const error = { code: this.code, message: this.message };
    return { error: this.details === undefined ? error : { ...error, details: this.details } };
  }
}
