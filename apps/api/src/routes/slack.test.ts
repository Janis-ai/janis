import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, slackInstallations, slackThreads, users, workspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateApiKey } from '../lib/crypto.js';
import { slackPublicRoutes } from './slack.js';
import { env } from '../env.js';

let app: Hono;
let db: Db;
const SECRET = 'test-signing-secret';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/slack', slackPublicRoutes(db));
  env.slackSigningSecret = SECRET;
  env.legacySlackInteractionsUrl = 'https://legacy-slack.test/slack/receive';
});

beforeEach(() => vi.unstubAllGlobals());

function signedPost(body: string, path = '/slack/interactions') {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return app.request(path, {
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

describe('slash commands', () => {
  let convId: string;

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'WS' }).returning();
    const [admin] = await db
      .insert(users)
      .values({ workspaceId: ws.id, email: 'op@x.c', name: 'Op', role: 'admin' })
      .returning();
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'cmd-conv' })
      .returning();
    convId = conv.id;
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_NEW', botToken: 'xoxb-test', installerUserId: admin.id })
      .returning();
    await db
      .insert(slackThreads)
      .values({ conversationId: conv.id, installationId: inst.id, channelId: 'CALERT', ts: '1.0' });
  });

  const command = (body: Record<string, string>) =>
    signedPost(new URLSearchParams(body).toString(), '/slack/commands');

  it('/pause takes over the most recent conversation in the channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{"ok":false}'))));
    const res = await command({ command: '/pause', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toContain('paused');
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    expect(conv.pauseMinutes).toBeNull(); // no arg → agent default
  });

  it('/pause forever pins the takeover', async () => {
    const res = await command({ command: '/pause', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: 'forever' });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    expect(conv.pauseMinutes).toBe(-1);
  });

  it('/resume releases it', async () => {
    const res = await command({ command: '/resume', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('active');
    expect(conv.pauseMinutes).toBeNull();
  });

  it('forwards to legacy when the channel has no mapped conversations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await command({ command: '/pause', channel_id: 'C_LEGACY', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === 'https://legacy-slack.test/slack/receive')).toBe(true);
  });

  it('forwards unknown teams to legacy', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await command({ command: '/pause', channel_id: 'C1', team_id: 'T_UNKNOWN', user_id: 'U1', text: '' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});
