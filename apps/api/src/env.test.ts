import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { env, oauthRedirectUri, requestOrigin, requestWebOrigin } from './env.js';

const app = new Hono();
app.get('/api-origin', (c) => c.text(requestOrigin(c)));
app.get('/web-origin', (c) => c.text(requestWebOrigin(c)));
app.get('/oauth', (c) => c.text(oauthRedirectUri(c, '/auth/google/callback', '')));
app.get('/oauth-pinned', (c) =>
  c.text(oauthRedirectUri(c, '/auth/google/callback', 'https://pinned.example/cb')),
);

describe('requestOrigin — API-facing (OAuth redirect_uri)', () => {
  it('derives from the allowlisted Host the request arrived on', async () => {
    const res = await app.request('/api-origin', {
      headers: { host: 'www.janis.ai' },
    });
    expect(await res.text()).toBe('https://www.janis.ai');
  });

  it('trusts x-forwarded-host over Host (CF worker stamps it)', async () => {
    const res = await app.request('/api-origin', {
      headers: { host: 'janis-api-696050206949.us-east1.run.app', 'x-forwarded-host': 'www.janis.ai' },
    });
    expect(await res.text()).toBe('https://www.janis.ai');
  });

  it('honors the second allowlisted host', async () => {
    const res = await app.request('/api-origin', {
      headers: { host: 'app.janis.ai' },
    });
    expect(await res.text()).toBe('https://app.janis.ai');
  });

  it('falls back to API_ORIGIN for non-app hosts (api., run.app, unknown)', async () => {
    for (const host of ['api.janis.ai', 'janis-api-696050206949.us-east1.run.app', 'evil.example.com']) {
      const res = await app.request('/api-origin', { headers: { host } });
      expect(await res.text()).toBe(env.apiOrigin);
    }
  });

  it('keeps localhost origins for dev OAuth', async () => {
    const res = await app.request('/api-origin', {
      headers: { host: 'localhost:8787' },
    });
    expect(await res.text()).toBe('http://localhost:8787');
  });
});

describe('requestWebOrigin — web-facing (post-auth landing)', () => {
  it('derives from allowlisted hosts', async () => {
    const res = await app.request('/web-origin', {
      headers: { host: 'www.janis.ai' },
    });
    expect(await res.text()).toBe('https://www.janis.ai');
  });

  it('falls back to WEB_ORIGIN on localhost — the Vite dev server is a separate origin', async () => {
    const res = await app.request('/web-origin', {
      headers: { host: 'localhost:8787' },
    });
    expect(await res.text()).toBe(env.webOrigin);
  });
});

describe('oauthRedirectUri', () => {
  it('builds the callback on the requesting host', async () => {
    const res = await app.request('/oauth', {
      headers: { host: 'www.janis.ai' },
    });
    expect(await res.text()).toBe('https://www.janis.ai/auth/google/callback');
  });

  it('an explicit env pin wins over the request host', async () => {
    const res = await app.request('/oauth-pinned', {
      headers: { host: 'www.janis.ai' },
    });
    expect(await res.text()).toBe('https://pinned.example/cb');
  });
});
