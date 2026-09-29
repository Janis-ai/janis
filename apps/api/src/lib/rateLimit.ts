import type { Context, MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * Fixed-window in-memory rate limiter — a per-instance ceiling. With
 * --max-instances > 1 the effective limit is max × instance count, which is
 * fine for the generous webhook/read ceilings. For strict or per-resource
 * limits where correctness matters (login, chat writes, uploads), use
 * dbRateLimit — it counts in Postgres so the cap holds across instances.
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

/**
 * Postgres-backed fixed-window limiter — correct across Cloud Run instances
 * and IP rotation when keyed on a resource (e.g. the channel token) rather
 * than the client IP. The single upsert serializes concurrent increments on
 * the bucket row, so counts are exact. Fails OPEN on a DB error: a limiter
 * hiccup shouldn't take down public endpoints (and those requests will fail
 * on the same DB error downstream anyway).
 */
export function dbRateLimit(db: Db, opts: RateLimitOptions): MiddlewareHandler {
  const { windowMs, max, scope = '', methods, key = clientIp } = opts;
  return async (c, next) => {
    if (methods && !methods.includes(c.req.method)) return next();
    const now = Date.now();
    const resetAt = new Date(Math.floor(now / windowMs) * windowMs + windowMs);
    const k = `${scope}:${key(c)}`;
    try {
      const res = await db.execute(sql`
        insert into rate_limits (key, count, reset_at)
        values (${k}, 1, ${resetAt.toISOString()})
        on conflict (key) do update set
          count = case when rate_limits.reset_at <= now()
                    then 1 else rate_limits.count + 1 end,
          reset_at = case when rate_limits.reset_at <= now()
                       then ${resetAt.toISOString()} else rate_limits.reset_at end
        returning count, reset_at
      `);
      // postgres.js returns the rows array directly; PGlite returns {rows}.
      const resRows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) as
        | { count: number; reset_at: string | Date }[]
        | undefined;
      const row = resRows?.[0];
      if (row && row.count > max) {
        const retryAfter = Math.max(
          1,
          Math.ceil((new Date(row.reset_at).getTime() - now) / 1000),
        );
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: 'Too many requests — slow down and retry.' }, 429);
      }
    } catch (err) {
      console.error('rate limit check failed (failing open):', err);
    }
    await next();
  };
}
