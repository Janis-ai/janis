import type { Context } from 'hono';

/**
 * Structured error logging for Cloud Logging + Error Reporting.
 * Error Reporting groups log entries whose jsonPayload.message contains a
 * stack trace, so we log the raw stack as the message.
 * Never log request bodies — messages and secrets stay out of logs.
 */
export function reportError(err: unknown, c?: Context) {
  const entry: Record<string, unknown> = {
    severity: 'ERROR',
    // drizzle wraps driver failures ("Failed query: …") with the real
    // PostgresError on .cause — the wrapper alone hides the actual code.
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    ...(err instanceof Error && err.cause instanceof Error
      ? { cause: err.cause.stack ?? err.cause.message }
      : {}),
  };
  if (c) {
    entry.context = {
      httpRequest: {
        method: c.req.method,
        url: c.req.url,
        userAgent: c.req.header('user-agent') ?? '',
        responseStatusCode: 500,
      },
    };
  }
  console.error(JSON.stringify(entry));
}

/**
 * True when the error is Postgres rejecting malformed input
 * (invalid_text_representation, SQLSTATE 22P02) — the signature of a
 * non-UUID/garbage id reaching a typed column. drizzle wraps driver errors
 * as DrizzleQueryError, so walk the cause chain. Callers map it to 404: a
 * lookup param Postgres can't even parse can never match a row.
 */
export function isPgInputSyntaxError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: string }).code === '22P02') return true;
  }
  return false;
}
