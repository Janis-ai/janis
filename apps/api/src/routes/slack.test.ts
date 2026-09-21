import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { slackPublicRoutes } from './slack.js';
import { env } from '../env.js';

let app: Hono;
const SECRET = 'test-signing-secret';

beforeAll(async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/slack', slackPublicRoutes(db));
  env.slackSigningSecret = SECRET;
  env.legacySlackInteractionsUrl = 'https://legacy-slack.test/slack/receive';
});

beforeEach(() => vi.unstubAllGlobals());

function signedPost(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return app.request('/slack/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

describe('interactions fan-out', () => {
  it('forwards non-janis payloads verbatim to wordhop-slack and relays the response', async () => {
    const payload = JSON.stringify({
      type: 'dialog_submission',
      callback_id: 'training_dialog',
      user: { id: 'U1' },
      team: { id: 'T1' },
    });
    const raw = `payload=${encodeURIComponent(payload)}`;

    const fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ errors: [{ name: 'x', error: 'bad' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ errors: [{ name: 'x', error: 'bad' }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://legacy-slack.test/slack/receive');
    expect(init?.body).toBe(raw); // verbatim — signature still validates downstream
  });

  it('forwards legacy-format interactive_message payloads too', async () => {
    const payload = JSON.stringify({
      type: 'interactive_message',
      callback_id: 'followup_yes',
      actions: [{ name: 'yes', value: '1' }],
      user: { id: 'U1' },
    });
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles janis_* block_actions itself — no forward', async () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U_NOBODY' },
      actions: [{ action_id: 'janis_takeover', value: '00000000-0000-0000-0000-000000000000' }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acks instead of forwarding when no legacy URL is configured', async () => {
    const saved = env.legacySlackInteractionsUrl;
    env.legacySlackInteractionsUrl = '';
    try {
      const payload = JSON.stringify({ type: 'dialog_submission', user: { id: 'U1' } });
      const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      env.legacySlackInteractionsUrl = saved;
    }
  });

  it('acks when the legacy endpoint is unreachable', async () => {
    const payload = JSON.stringify({ type: 'dialog_submission', user: { id: 'U1' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
