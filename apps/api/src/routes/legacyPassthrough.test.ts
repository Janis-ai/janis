import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret';

let app: Hono;

beforeAll(async () => {
  const { env } = await import('../env.js');
  env.legacyApiUrl = 'https://legacy.test';
  const { LEGACY_PASSTHROUGH_PREFIXES, legacyPassthrough } = await import(
    './legacyPassthrough.js'
  );
  app = new Hono();
  for (const p of LEGACY_PASSTHROUGH_PREFIXES) {
    app.all(p, legacyPassthrough);
    app.all(`${p}/*`, legacyPassthrough);
  }
});

beforeEach(() => vi.unstubAllGlobals());

const upstream = (res = new Response('{"ok":true}', { status: 200 })) =>
  vi.fn().mockImplementation(async () => res);

describe('legacy passthrough', () => {
  it('relays method, path, query and body verbatim; upstream status wins', async () => {
    const fetchMock = upstream(
      new Response('{"intents":[]}', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/intents?foo=bar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ intents: [] });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe('https://legacy.test/intents?foo=bar');
    expect(call[1]?.method).toBe('POST');
    expect(String(call[1]?.body)).toBe('{"a":1}');
  });

  it('covers every mounted legacy prefix', async () => {
    const fetchMock = upstream();
    vi.stubGlobal('fetch', fetchMock);
    const { LEGACY_PASSTHROUGH_PREFIXES } = await import('./legacyPassthrough.js');
    for (const p of LEGACY_PASSTHROUGH_PREFIXES) {
      const res = await app.request(p, { method: 'GET' });
      expect(res.status, p).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(LEGACY_PASSTHROUGH_PREFIXES.length);
  });

  it('injects clientkey header when the key rides in the body', async () => {
    const fetchMock = upstream();
    vi.stubGlobal('fetch', fetchMock);
    await app.request('/send_chat_response', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_key: 'ck-secret-123', text: 'hi' }),
    });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('clientkey')).toBe('ck-secret-123');
  });

  it('forwards cookies and set-cookie for dashboard session calls', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      const h = new Headers({ 'content-type': 'text/html' });
      h.append('set-cookie', 'sess=abc; Path=/');
      h.append('set-cookie', 'other=def; Path=/');
      return new Response('<html></html>', { status: 200, headers: h });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/report/summary', {
      headers: { cookie: 'sess=abc' },
    });
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('cookie')).toBe('sess=abc');
    expect(res.headers.getSetCookie()).toEqual(['sess=abc; Path=/', 'other=def; Path=/']);
  });

  it('does not follow upstream redirects', async () => {
    vi.stubGlobal(
      'fetch',
      upstream(new Response('', { status: 302, headers: { location: 'https://legacy.test/login' } })),
    );
    const res = await app.request('/report', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://legacy.test/login');
  });

  it('502s when upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const res = await app.request('/subscribe', { method: 'POST', body: 'x=1' });
    expect(res.status).toBe(502);
  });
});
