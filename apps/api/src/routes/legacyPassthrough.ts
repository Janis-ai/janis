import type { Context } from 'hono';
import { env } from '../env.js';
import { clientKeyOf } from './legacyApi.js';

/**
 * Legacy passthrough — covers the wordhopapi mount-table entries that have
 * no Postgres-side equivalent and that external callers (bot-platform JSON
 * configs, old dashboard API calls, smooch/azure relays) still hit on
 * janis.ai / www.janis.ai:
 *
 *   /bot_subscriptions /report /report_messages /report_summary
 *   /report_users /report_emails /prior /log /add_bot /update_bot
 *   /add_email /archive_channel /send_chat_response /intents
 *   /get_longterm_access_token /update_bot_messenger
 *   /update_bot_socket_id /subscribe /smooch /azure
 *
 * Unlike the /api/v1 + /messenger surfaces this is a pure relay — upstream's
 * response is authoritative, nothing is stored locally. Each call logs the
 * path so Cloud Logging doubles as the who's-still-legacy ledger.
 */
export const LEGACY_PASSTHROUGH_PREFIXES = [
  '/bot_subscriptions',
  '/report',
  '/report_messages',
  '/report_summary',
  '/report_users',
  '/report_emails',
  '/prior',
  '/log',
  '/add_bot',
  '/update_bot',
  '/add_email',
  '/archive_channel',
  '/send_chat_response',
  '/intents',
  '/get_longterm_access_token',
  '/update_bot_messenger',
  '/update_bot_socket_id',
  '/subscribe',
  '/smooch',
  '/azure',
];

const REQ_STRIP = /^(host|connection|content-length|cf-|x-forwarded|keep-alive|te|trailer|upgrade|transfer-encoding)/i;
const RES_STRIP = /^(connection|content-length|content-encoding|keep-alive|te|trailer|transfer-encoding|upgrade)$/i;

export async function legacyPassthrough(c: Context): Promise<Response> {
  if (!env.legacyApiUrl) return c.json({ error: 'not found' }, 404);
  const method = c.req.raw.method;
  const body = method === 'GET' || method === 'HEAD' ? null : await c.req.text();
  const headers = new Headers();
  c.req.raw.headers.forEach((v, k) => {
    if (!REQ_STRIP.test(k)) headers.set(k, v);
  });
  // upstream middleware reads clientkey from the header — inject it when the
  // caller carried the key in body/query instead (same fix as /api/v1)
  const key = clientKeyOf(c, body);
  if (key && !headers.has('clientkey')) headers.set('clientkey', key);
  const url = new URL(c.req.url);
  console.log(`legacy-passthrough ${method} ${url.pathname} key=${key ? key.slice(0, 8) : '-'}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let upstream: Response;
  try {
    upstream = await fetch(`${env.legacyApiUrl}${url.pathname}${url.search}`, {
      method,
      headers,
      body: body ?? undefined,
      signal: ctrl.signal,
      redirect: 'manual',
    });
  } catch (err) {
    console.warn('legacy passthrough failed', url.pathname, (err as Error).message);
    return c.json({ error: 'legacy upstream unavailable' }, 502);
  } finally {
    clearTimeout(t);
  }
  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!RES_STRIP.test(k) && k.toLowerCase() !== 'set-cookie') resHeaders.set(k, v);
  });
  for (const sc of upstream.headers.getSetCookie?.() ?? []) {
    resHeaders.append('set-cookie', sc);
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
