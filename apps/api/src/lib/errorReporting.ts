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
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
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
