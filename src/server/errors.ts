/** The linked account must be reconnected by the user; retrying won't help. */
export class AuthError extends Error {
  constructor(
    readonly accountId: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** YouTube quota (or upload limit) exhausted; resume after `resumeAt`. */
export class QuotaError extends Error {
  constructor(
    message: string,
    readonly resumeAt: Date,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

/** Transient failure (network, 5xx, throttling). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/** Failure that won't go away by retrying (missing file, rejected video…). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** Not a failure: run the same job again at `runAt` without counting an attempt. */
export class RescheduleSignal extends Error {
  constructor(
    readonly runAt: Date,
    /** Replaces the job payload, e.g. to carry a poll counter. */
    readonly payload?: Record<string, unknown>,
  ) {
    super("reschedule");
    this.name = "RescheduleSignal";
  }
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Errors whose type already tells the job runner what to do. */
export function isClassifiedError(error: unknown): boolean {
  return (
    error instanceof AuthError ||
    error instanceof QuotaError ||
    error instanceof RetryableError ||
    error instanceof PermanentError ||
    error instanceof RescheduleSignal
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
