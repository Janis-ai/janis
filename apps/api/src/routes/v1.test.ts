import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, workspaces } from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { v1Routes } from './v1.js';

let app: Hono;
let db: Db;
let apiKey: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/v1', v1Routes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const generated = generateApiKey();
  apiKey = generated.key;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: generated.hash, apiKeyPreview: generated.preview })
    .returning();
  agentId = agent.id;
});

const get = (headers: Record<string, string>) => app.request('/v1/config', { headers });

describe('v1 agent auth', () => {
  it('accepts Bearer auth', async () => {
    expect((await get({ Authorization: `Bearer ${apiKey}` })).status).toBe(200);
  });

  it('accepts a bare Authorization key', async () => {
    expect((await get({ Authorization: apiKey })).status).toBe(200);
  });

  it('accepts X-API-KEY (Zapier API-key auth default)', async () => {
    expect((await get({ 'X-API-KEY': apiKey })).status).toBe(200);
  });

  it('rejects missing and wrong keys', async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ 'X-API-KEY': 'nope' })).status).toBe(401);
  });
});

const authed = () => ({ Authorization: `Bearer ${apiKey}` });

describe('v1 integration surface', () => {
  it('/me identifies the agent', async () => {
    const res = await app.request('/v1/me', { headers: authed() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(agentId);
    expect(body.name).toBe('Bot');
  });

  it('reply/escalate/resume drive the conversation lifecycle', async () => {
    // seed a conversation via the existing ingest path
    await app.request('/v1/events', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'message_in', conversation_id: 'c-1', text: 'hi' }] }),
    });

    const reply = await app.request('/v1/conversations/c-1/reply', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello back' }),
    });
    expect(reply.status).toBe(200);

    const esc = await app.request('/v1/conversations/c-1/escalate', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'vip' }),
    });
    expect(esc.status).toBe(200);
    expect((await esc.json()).state).toBe('needs_human');

    const res = await app.request('/v1/conversations/c-1/resume', {
      method: 'POST',
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('active');

    const done = await app.request('/v1/conversations/c-1/resolve', {
      method: 'POST',
      headers: authed(),
    });
    expect(done.status).toBe(200);
    expect((await done.json()).state).toBe('archived');
  });

  it('lists conversations newest-first with state filter', async () => {
    await app.request('/v1/events', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'message_in', conversation_id: 'c-2', text: 'two' }] }),
    });
    const res = await app.request('/v1/conversations', { headers: authed() });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list[0].external_id).toBe('c-2');

    const filtered = await app.request('/v1/conversations?state=archived', { headers: authed() });
    const archived = await filtered.json();
    expect(archived.every((r: { state: string }) => r.state === 'archived')).toBe(true);
    expect(archived.some((r: { external_id: string }) => r.external_id === 'c-1')).toBe(true);
  });

  it('404s actions on an unknown conversation', async () => {
    for (const p of ['reply', 'escalate', 'resume', 'resolve']) {
      const res = await app.request(`/v1/conversations/nope/${p}`, {
        method: 'POST',
        headers: { ...authed(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      });
      expect(res.status).toBe(404);
    }
  });

  it('/send rejects when the agent has no outbound channel, 400s unknown channel', async () => {
    const res = await app.request('/v1/send', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+15551234567', text: 'hi' }),
    });
    expect(res.status).toBe(400);

    // email channel with no provider creds — find-or-create still records the attempt
    const [conv] = await db.select().from(conversations).limit(1);
    expect(conv).toBeTruthy();
    await db.insert(channels).values({
      workspaceId: (
        await db.select({ workspaceId: agents.workspaceId }).from(agents).limit(1)
      )[0].workspaceId,
      agentId,
      kind: 'webchat',
      name: 'Chat',
      credentials: {},
    });
    const res2 = await app.request('/v1/send', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+15551234567', text: 'hi' }),
    });
    // webchat isn't outbound-capable and is the only channel → normalized-reject
    expect([400, 502]).toContain(res2.status);
  });

  it('/channels lists the agent channels with an outbound flag', async () => {
    const res = await app.request('/v1/channels', { headers: authed() });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('webchat');
    expect(list[0].outbound).toBe(false);
  });

  it('/hooks registers, lists, and deletes a subscription', async () => {
    const created = await app.request('/v1/hooks', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_url: 'https://hooks.example.test/catch/abc',
        event: 'conversation_resolved',
      }),
    });
    expect(created.status).toBe(201);
    const hook = await created.json();
    expect(hook.event).toBe('conversation_resolved');

    const list = await app.request('/v1/hooks', { headers: authed() });
    expect((await list.json()).some((h: { id: string }) => h.id === hook.id)).toBe(true);

    const del = await app.request(`/v1/hooks/${hook.id}`, { method: 'DELETE', headers: authed() });
    expect(del.status).toBe(200);
    const again = await app.request(`/v1/hooks/${hook.id}`, { method: 'DELETE', headers: authed() });
    expect(again.status).toBe(404);
  });

  it('/hooks rejects a bad event and a non-URL target', async () => {
    for (const body of [
      { target_url: 'not-a-url', event: 'new_conversation' },
      { target_url: 'https://x.test', event: 'bogus' },
    ]) {
      const res = await app.request('/v1/hooks', {
        method: 'POST',
        headers: { ...authed(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});
