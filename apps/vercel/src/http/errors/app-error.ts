import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'ORIGIN_REQUIRED'
  | 'ORIGIN_FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}
