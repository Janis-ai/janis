import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  conversations,
  helpArticles,
  usageEvents,
  workspaces,
} from '../db/schema.js';
import { markViewing } from './presence.js';
import { acquireLock } from '../services/sweeper.js';
import { bus } from './bus.js';
import { busEvents, sweeperLocks } from '../db/schema.js';
import { parseCsv } from '../routes/agents.js';
import { classifyIntent } from './intent.js';
import { recordVoiceUsage } from './usage.js';
import { fireEventWebhook } from './eventWebhook.js';
import { helpPublicRoutes } from '../routes/helpCenter.js';

let db: Db;
let wsId: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  wsId = ws.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: wsId, name: 'Bot' })
    .returning();
  agentId = agent.id;
});

describe('presence', () => {
  it('tracks viewers per conversation and reports set changes', async () => {
    const { users } = schema;
    const [u1, u2] = await db
      .insert(users)
      .values([
        { email: 'ann@t.dev', name: 'Ann' },
        { email: 'bob@t.dev', name: 'Bob' },
      ])
      .returning();
    const [c1, c2] = await db
      .insert(conversations)
      .values([
        { agentId, externalId: 'e1' },
        { agentId, externalId: 'e2' },
      ])
      .returning();
    expect((await markViewing(db, c1.id, u1.id, 'Ann')).viewers).toEqual([{ id: u1.id, name: 'Ann' }]);
    expect((await markViewing(db, c1.id, u1.id, 'Ann')).changed).toBe(false); // re-heartbeat
    const third = await markViewing(db, c1.id, u2.id, 'Bob');
    expect(third.changed).toBe(true);
    expect(third.viewers.map((v) => v.id).sort()).toEqual([u1.id, u2.id].sort());
    expect((await markViewing(db, c2.id, u1.id, 'Ann')).viewers).toHaveLength(1); // per-conv isolation
  });
});

describe('parseCsv', () => {
  it('parses plain and quoted rows', () => {
    const rows = parseCsv('name,prompt,expectation\nrefund,"I want my money back", "hand off"');
    expect(rows[1]).toEqual(['refund', 'I want my money back', 'hand off']);
  });
  it('handles escaped quotes and CRLF', () => {
    const rows = parseCsv('a,"say ""hi""",x\r\nb,y,z');
    expect(rows).toEqual([
      ['a', 'say "hi"', 'x'],
      ['b', 'y', 'z'],
    ]);
  });
});

describe('classifyIntent', () => {
  it('returns a taxonomy label from the LLM', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Billing' } }] }),
        { status: 200 },
      ),
    );
    const out = await classifyIntent(
      { apiKey: 'k', baseUrl: 'https://llm.test/v1', model: 'm', byok: false },
      'where is my invoice',
      ['billing', 'shipping', 'other'],
    );
    expect(out).toBe('billing');
    spy.mockRestore();
  });
  it('returns null without a key — never blocks the pipeline', async () => {
    const out = await classifyIntent(
      { apiKey: '', baseUrl: 'x', model: 'm', byok: true },
      'hi',
      ['billing'],
    );
    expect(out).toBeNull();
  });
});

describe('recordVoiceUsage', () => {
  it('meters hosted call seconds once per CallSid', async () => {
    await recordVoiceUsage(db, { workspaceId: wsId, agentId, seconds: 120, callSid: 'CA1' });
    await recordVoiceUsage(db, { workspaceId: wsId, agentId, seconds: 120, callSid: 'CA1' });
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.externalId, 'voice:CA1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('voice_seconds');
    expect(rows[0].quantity).toBe(120);
    expect(rows[0].costMicros).toBeGreaterThan(0);
  });
  it('ignores zero-second calls', async () => {
    await recordVoiceUsage(db, { workspaceId: wsId, agentId, seconds: 0, callSid: 'CA0' });
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.externalId, 'voice:CA0'));
    expect(rows).toHaveLength(0);
  });
});

describe('fireEventWebhook', () => {
  it('posts the event envelope to the workspace hook', async () => {
    await db
      .update(workspaces)
      .set({ config: { event_webhook_url: 'https://hooks.test/catch/1' } })
      .where(eq(workspaces.id, wsId));
    let posted: unknown = null;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_u, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    fireEventWebhook(db, wsId, 'message_in', { conversation_id: 'c1', text: 'hi' });
    await vi.waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ event: 'message_in', conversation_id: 'c1', text: 'hi' });
    spy.mockRestore();
  });
});

describe('public help center', () => {
  it('serves only published articles, unauthenticated', async () => {
    const app = new Hono().route('/api/help', helpPublicRoutes(db));
    await db.insert(helpArticles).values([
      { workspaceId: wsId, agentId, title: 'Returns', category: 'Orders', body: 'Send it back in 30 days.', status: 'published' },
      { workspaceId: wsId, agentId, title: 'Secret draft', category: 'Orders', body: 'internal', status: 'draft' },
    ]);
    const list = await (await app.request(`/api/help/${agentId}`)).json();
    expect(list.agent_name).toBe('Bot');
    expect(list.categories).toHaveLength(1);
    expect(list.categories[0].articles).toHaveLength(1);
    expect(list.categories[0].articles[0].title).toBe('Returns');

    const article = await (await app.request(list.categories[0].articles[0].url ?? `/api/help/${agentId}/${list.categories[0].articles[0].id}`)).json();
    expect(article.article.body).toBe('Send it back in 30 days.');

    // drafts never leak, even by direct id
    const draft = await db.select().from(helpArticles).where(eq(helpArticles.title, 'Secret draft'));
    const res = await app.request(`/api/help/${agentId}/${draft[0].id}`);
    expect(res.status).toBe(404);
  });

  it('searches, resolves slugs, and serves domain lookups', async () => {
    const app = new Hono().route('/api/help', helpPublicRoutes(db));
    const [a] = await db
      .insert(helpArticles)
      .values({
        workspaceId: wsId,
        agentId,
        title: 'Tracking a shipment',
        slug: 'tracking-a-shipment',
        category: 'Shipping',
        body: 'Your tracking link is on the order confirmation email.',
        status: 'published',
      })
      .returning();

    // slug resolves like an id
    const bySlug = await app.request(`/api/help/${agentId}/tracking-a-shipment`);
    expect(bySlug.status).toBe(200);
    expect((await bySlug.json()).article.id).toBe(a.id);

    // search filters title/body
    const hit = await (await app.request(`/api/help/${agentId}?q=tracking`)).json();
    expect(hit.categories.flatMap((g) => g.articles).some((s) => s.id === a.id)).toBe(true);
    const miss = await (await app.request(`/api/help/${agentId}?q=zzznotfound`)).json();
    expect(miss.categories.flatMap((g) => g.articles)).toHaveLength(0);

    // domain resolution — claim help.acme.test on this workspace
    await db.update(workspaces).set({ config: { help_domain: 'help.acme.test' } }).where(eq(workspaces.id, wsId));
    const dom = await (await app.request('/api/help/domain?host=help.acme.test')).json();
    expect(dom.agents.some((x) => x.id === agentId)).toBe(true);
    const bad = await app.request('/api/help/domain?host=unknown.example');
    expect(bad.status).toBe(404);
    await db.update(workspaces).set({ config: {} }).where(eq(workspaces.id, wsId));
  });
});

describe('conversations.intent column', () => {
  it('persists a classified intent', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'x:1', state: 'active' })
      .returning();
    await db.update(conversations).set({ intent: 'billing' }).where(eq(conversations.id, conv.id));
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.intent).toBe('billing');
  });
});

describe('multi-instance', () => {
  it('leader lock: first holder wins, expiry releases', async () => {
    const name = `t-${Date.now()}`;
    expect(await acquireLock(db, name, 60_000, 'inst-a')).toBe(true);
    expect(await acquireLock(db, name, 60_000, 'inst-b')).toBe(false); // held
    expect(await acquireLock(db, name, 60_000, 'inst-a')).toBe(true); // renew
    await db
      .update(sweeperLocks)
      .set({ expiresAt: new Date(0) })
      .where(eq(sweeperLocks.name, name));
    expect(await acquireLock(db, name, 60_000, 'inst-b')).toBe(true); // expired → b takes it
  });

  it('bus relays foreign-origin rows and skips its own', async () => {
    bus.attachDb(db);
    const received: unknown[] = [];
    const unsub = bus.subscribe(wsId, (e) => received.push(e));
    // foreign instance's event — delivered via the tailer
    await db.insert(busEvents).values({
      workspaceId: wsId,
      origin: 'other-instance',
      event: { type: 'presence', data: { conversation_id: 'x', viewers: [] } },
    });
    // our own publish — lands locally, row skipped by tailer on next pass
    bus.publish(wsId, { type: 'presence', data: { conversation_id: 'y', viewers: [] } });
    await new Promise((r) => setTimeout(r, 800));
    unsub();
    const types = received.map((e) => (e as { data: { conversation_id: string } }).data.conversation_id);
    expect(types).toContain('x'); // relayed
    expect(types).toContain('y'); // local
    expect(types.filter((t) => t === 'y')).toHaveLength(1); // no echo
  });
});
