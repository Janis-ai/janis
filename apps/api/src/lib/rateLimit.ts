import type { Context, MiddlewareHandler } from 'hono';

/**
 * Fixed-window in-memory rate limiter. Cloud Run is single-instance for now,
 * so per-process state is accurate; if that changes this still acts as a
 * per-instance ceiling rather than a correctness guarantee.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Extra key material (e.g. route name) so limits don't share buckets. */
  scope?: string;
  /** Only limit these HTTP methods (default: all). */
  methods?: string[];
  /** Override the client key (default: source IP). */
  key?: (c: Context) => string;
}

export function clientIp(c: Context): string {
  // Cloud Run / Cloudflare both append the client IP to x-forwarded-for
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max, scope = '', methods, key = clientIp } = opts;

  // Bound memory: sweep expired windows periodically
  let lastSweep = Date.now();
  const sweep = (now: number) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  };

  return async (c, next) => {
    if (methods && !methods.includes(c.req.method)) return next();
    const now = Date.now();
    sweep(now);
    const k = `${scope}:${key(c)}`;
    const b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      buckets.set(k, { count: 1, resetAt: now + windowMs });
    } else if (b.count >= max) {
      c.header('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests — slow down and retry.' }, 429);
    } else {
      b.count += 1;
    }
    await next();
  };
}
