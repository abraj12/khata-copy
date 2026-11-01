/**
 * Typed Application Error Structure
 * Ensures consistent HTTP status codes, structured error codes, and safe client messages.
 */
export class AppError extends Error {
  public status: number;
  public code: string;
  public candidates?: unknown[];

  constructor(message: string, status: number = 400, code?: string, candidates?: unknown[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code =
      code ||
      (status === 400
        ? 'VALIDATION_ERROR'
        : status === 401
        ? 'UNAUTHORIZED'
        : status === 403
        ? 'FORBIDDEN'
        : status === 404
        ? 'NOT_FOUND'
        : status === 409
        ? 'CONFLICT'
        : status === 429
        ? 'TOO_MANY_REQUESTS'
        : 'INTERNAL_SERVER_ERROR');
    this.candidates = candidates;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
