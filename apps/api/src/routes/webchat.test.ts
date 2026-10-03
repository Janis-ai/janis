import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, helpArticles, memberships, messages, sessions, slackInstallations, slackThreads, usageEvents, users, workspaces } from '../db/schema.js';
import { generateApiKey, sha256 } from '../lib/crypto.js';
import { markOperatorTyping } from '../lib/typingState.js';
import { takeover, humanReply } from '../services/takeover.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Stripe from 'stripe';
import { setStripeClient } from '../lib/stripe.js';

// env.ts reads process.env at import time — a truthy secret lets the
// setStripeClient seam intercept meter reporting (no real Stripe calls).
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
});

/** Captured billing.meterEvents.create calls for usage-report assertions. */
const meteredEvents: { event_name: string; payload: Record<string, string>; identifier?: string }[] = [];
const fakeStripe = {
  billing: {
    meterEvents: {
      create: async (p: (typeof meteredEvents)[number]) => {
        meteredEvents.push(p);
        return {};
      },
    },
  },
};
import { join } from 'node:path';

let db: Db;
let app: Hono;
let channelId: string;
let wsId: string;

const VISITOR_A = 'vis_aaaabbbbccccdddd';
const VISITOR_B = 'vis_eeeeffffgggghhhh';

const post = (text: string, visitor = VISITOR_A) =>
  app.request(`/chat/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitor, text }),
  });

const SUPPORT_CHANNEL_ID = 'c0ffee00-0000-4000-8000-0000000000c5';

beforeAll(async () => {
  // uploads land in a tmpdir, not the repo
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'janis-uploads-'));
  const { webchatRoutes } = await import('./webchat.js');
  setStripeClient(fakeStripe as unknown as Stripe);
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/chat', webchatRoutes(db)); // mounted like production

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'Support Bot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      webhookUrl: 'https://agent.test/hook',
    })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'webchat',
      name: 'Acme website',
      credentials: { greeting: 'Hey there!', dictation: true },
    })
    .returning();
  channelId = channel.id;
});

afterEach(() => vi.unstubAllGlobals());

describe('webchat widget endpoints', () => {
  it('bootstraps widget config without credentials', async () => {
    const res = await app.request(`/chat/${channelId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Acme website');
    expect(body.agent_name).toBe('Support Bot');
    expect(body.greeting).toBe('Hey there!');
    expect(body.credentials).toBeUndefined();
  });

  it('404s for unknown or non-webchat channel tokens', async () => {
    expect((await app.request('/chat/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const [meta] = await db
      .insert(channels)
      .values({
        workspaceId: (await db.select().from(workspaces))[0].id,
        agentId: (await db.select().from(agents))[0].id,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'p', access_token: 't' },
      })
      .returning();
    expect((await app.request(`/chat/${meta.id}`)).status).toBe(404);
  });

  it('passes theme through and honors hide_powered_by only on paid plans', async () => {
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    await db
      .update(channels)
      .set({
        credentials: {
          ...(ch.credentials as object),
          hide_powered_by: true,
          theme: 'dark',
        },
      })
      .where(eq(channels.id, channelId));
    // fixture workspace is on free — the flag is stripped, theme still sent
    let body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.theme).toBe('dark');
    expect(body.hide_powered_by).toBe(false);
    await db.update(workspaces).set({ plan: 'pro' }).where(eq(workspaces.id, wsId));
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.hide_powered_by).toBe(true);
    await db.update(workspaces).set({ plan: 'free' }).where(eq(workspaces.id, wsId));
    await db
      .update(channels)
      .set({ credentials: ch.credentials as object })
      .where(eq(channels.id, channelId));
  });

  it('help_url honours the agent domain override, then the workspace claim', async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.workspaceId, wsId));
    await db.insert(helpArticles).values({
      workspaceId: wsId,
      agentId: agent.id,
      title: 'Shipping FAQ',
      body: 'We ship worldwide.',
      status: 'published',
    });
    let body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toMatch(new RegExp(`/help/${agent.id}$`));
    expect(body.help_url).not.toContain('acme.test');

    await db
      .update(workspaces)
      .set({ config: { help_domain: 'help.acme.test' } })
      .where(eq(workspaces.id, wsId));
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBe(`https://help.acme.test/help/${agent.id}`);

    await db
      .update(agents)
      .set({ config: { help_domain: 'vip.acme.test' } })
      .where(eq(agents.id, agent.id));
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBe(`https://vip.acme.test/help/${agent.id}`);

    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
    await db.update(workspaces).set({ config: {} }).where(eq(workspaces.id, wsId));
  });

  it('help_url: external link overrides and works with no articles; show_help_link gates it', async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.workspaceId, wsId));
    // No published articles — the built-in centre stays hidden. (Earlier
    // tests may have published one; clear to assert the zero-state.)
    await db.delete(helpArticles).where(eq(helpArticles.agentId, agent.id));
    let body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBeNull();

    // Agent-level external link shows even with zero articles.
    await db
      .update(agents)
      .set({ config: { help_url: 'https://docs.acme.test' } })
      .where(eq(agents.id, agent.id));
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBe('https://docs.acme.test');

    // …and wins over the built-in centre when articles exist.
    await db.insert(helpArticles).values({
      workspaceId: wsId,
      agentId: agent.id,
      title: 'Shipping FAQ',
      body: 'We ship worldwide.',
      status: 'published',
    });
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBe('https://docs.acme.test');
    await db.delete(helpArticles).where(eq(helpArticles.agentId, agent.id));

    // The per-widget toggle hides the button entirely.
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    await db
      .update(channels)
      .set({ credentials: { ...(ch.credentials as object), show_help_link: false } })
      .where(eq(channels.id, channelId));
    body = await (await app.request(`/chat/${channelId}`)).json();
    expect(body.help_url).toBeNull();

    await db
      .update(channels)
      .set({ credentials: ch.credentials as object })
      .where(eq(channels.id, channelId));
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
  });

  it('ingests a visitor message into a conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const res = await post('hello from the website');
    expect(res.status).toBe(200);

    const [conv] = await db.select().from(conversations);
    expect(conv.externalId).toBe(`webchat:${VISITOR_A}`);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const body = await poll.json();
    expect(body.state).toBe('active');
    // greeting row first, then the inbound echo — the widget dedupes the
    // greeting against its bootstrap render via the `greeting` flag
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].greeting).toBe(true);
    expect(body.messages[1].text).toBe('hello from the website');
    expect(body.messages[1].direction).toBe('in');
    // internal payloads must never leak to the widget
    expect(body.messages[1].payload).toBeUndefined();
  });

  it('dedupes a retried POST by client_id — one stored message, echo carries the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VISITOR = 'vis_clientid000001';
    const send = () =>
      app.request(`/chat/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: VISITOR, text: 'same text twice', client_id: 'c-123' }),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR}`);
    const body = await poll.json();
    const inRows = body.messages.filter((m: { direction: string }) => m.direction === 'in');
    expect(inRows).toHaveLength(1);
    expect(inRows[0].client_id).toBe('c-123');
  });

  it('stores widget-tap context on the message payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VISITOR = 'vis_tapcontext00001';
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VISITOR,
        text: 'Choose Free',
        tap: true,
        tap_of: 'Free',
      }),
    });
    expect(res.status).toBe(200);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VISITOR}`));
    const convMsgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const stored = convMsgs.find((m) => m.direction === 'in' && m.text === 'Choose Free')!;
    expect((stored.payload as { tap?: boolean; tap_of?: string }).tap).toBe(true);
    expect((stored.payload as { tap?: boolean; tap_of?: string }).tap_of).toBe('Free');
  });

  it('isolates transcripts by visitor id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await post('a secret', VISITOR_B);
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`);
    const body = await poll.json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['Hey there!', 'a secret']);

    // visitor A can't see B's transcript and vice versa
    const a = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    expect((await a.json()).messages.map((m: { text: string }) => m.text)).toEqual([
      'Hey there!',
      'hello from the website',
    ]);
  });

  it('end archives the chat (CSAT queued); new starts a fresh bound thread', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VISITOR = 'vis_endchat0000001';
    await post('how do I reset my password?', VISITOR);
    await post('all sorted, thanks', VISITOR);

    const end = await app.request(`/chat/${channelId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR }),
    });
    expect(end.status).toBe(200);
    expect((await end.json()).state).toBe('archived');

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VISITOR}`));
    expect(conv.state).toBe('archived');
    expect(conv.archivedAt).not.toBeNull();
    // archive fires the CSAT prompt — it lands on the transcript for the
    // customer's next reply, and the resolve marker is flagged system-side
    const convMsgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(convMsgs.some((m) => (m.payload as { via?: string }).via === 'csat')).toBe(true);
    expect(convMsgs.some((m) => (m.flags as { resolved?: boolean }).resolved)).toBe(true);
    // the poll filters the resolve note — visitors see the CSAT ask, not plumbing
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR}`);
    const polled = await poll.json();
    expect(polled.state).toBe('archived');
    expect(polled.messages.every((m: { text: string }) => m.text !== 'Conversation resolved — customer ended the chat')).toBe(true);

    // a "new chat" re-points the binding at a fresh empty conversation
    const fresh = await app.request(`/chat/${channelId}/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR }),
    });
    expect((await fresh.json()).state).toBe('new');
    const poll2 = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR}`);
    const body2 = await poll2.json();
    expect(body2.messages).toEqual([]);
    // …while the archived thread keeps its transcript
    const stillThere = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(stillThere.length).toBeGreaterThanOrEqual(3);

    // /new is a no-op while a chat is open — no thread-splitting by accident
    await post('actually one more thing', VISITOR);
    const again = await app.request(`/chat/${channelId}/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR }),
    });
    expect((await again.json()).state).toBe('active');
  });

  it('returns messages from the cursor (inclusive — client dedupes by id)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const first = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const ts = (await first.json()).messages.at(-1).created_at;
    await post('second message');
    const second = await app.request(
      `/chat/${channelId}/messages?visitor_id=${VISITOR_A}&after=${encodeURIComponent(ts)}`,
    );
    const body = await second.json();
    expect(body.messages.at(-1).text).toBe('second message');
  });

  it('initial load returns the latest page; ?before= back-fills older', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VISITOR = 'vis_pagination001';
    await post('first', VISITOR);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VISITOR}`));
    const base = Date.now() + 1000;
    await db.insert(messages).values(
      Array.from({ length: 120 }, (_, i) => ({
        conversationId: conv.id,
        direction: 'in' as const,
        text: `m${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );

    const first = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR}`);
    const page1 = await first.json();
    expect(page1.messages).toHaveLength(100);
    expect(page1.has_more).toBe(true);
    // newest message lands in the first page — the visitor sees the tail,
    // not the ancient history, on open
    expect(page1.messages.at(-1).text).toBe('m119');
    expect(page1.messages[0].text).toBe('m20');

    const before = page1.messages[0].created_at;
    const second = await app.request(
      `/chat/${channelId}/messages?visitor_id=${VISITOR}&before=${encodeURIComponent(before)}`,
    );
    const page2 = await second.json();
    // 22 older rows: the greeting + m0..m19 + the original 'first' post
    expect(page2.messages).toHaveLength(22);
    expect(page2.has_more).toBe(false);
    expect(page2.messages.at(-1).text).toBe('m19');
    expect(page2.messages[0].text).toBe('Hey there!');
  });

  it('exposes operator typing state on the poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VIS = 'vis_typing00000001';
    await post('typing test', VIS);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    await markOperatorTyping(db, conv.id, 'Bob');
    const body = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json();
    expect(body.operator_typing).toEqual({ name: 'Bob' });
    // a conversation with no ping reports null, not a stale flag
    const quiet = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`)
    ).json();
    expect(quiet.operator_typing).toBeNull();
  });

  it('exposes agent-working state on the poll until a reply lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VIS = 'vis_agentwork00001';
    // dispatching message.user to the agent marks the conversation working
    await post('agent work test', VIS);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    const during = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json();
    expect(during.agent_typing).toBe(true);
    // the agent's stored reply ends the indicator
    const { processEvents } = await import('../services/ingest.js');
    const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId));
    await processEvents(db, agent, [
      { type: 'message_out', conversation_id: `webchat:${VIS}`, text: 'here you go' },
    ]);
    const after = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json();
    expect(after.agent_typing).toBe(false);
  });

  it('clears both typing flags when an operator reply lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
    const VIS = 'vis_opreply0000001';
    // dispatch marks the agent working; an operator mid-composition sets the
    // other flag — a stored human reply must end both, or the widget keeps
    // showing dots over a message that already arrived.
    await post('help me', VIS);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [op] = await db
      .insert(users)
      .values({ email: 'op@x.test', name: 'Op One' })
      .returning();
    await markOperatorTyping(db, conv.id, 'Op');
    await takeover(db, ws.id, conv.id, op);
    const mid = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json();
    expect(mid.agent_typing).toBe(true);
    expect(mid.operator_typing).toEqual({ name: 'Op' });
    await humanReply(db, ws.id, conv.id, op, 'on it');
    const after = await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json();
    expect(after.agent_typing).toBe(false);
    expect(after.operator_typing).toBeNull();
    expect(after.messages.at(-1).text).toBe('on it');
    expect(after.messages.at(-1).direction).toBe('human');
  });

  it('rejects malformed visitor ids and empty text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const bad = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: 'x', text: 'hi' }),
    });
    expect(bad.status).toBe(400);
    // valid format but no conversation yet → empty transcript
    const empty = await app.request(`/chat/${channelId}/messages?visitor_id=vis_unknown12`);
    const body = await empty.json();
    expect(body.messages).toEqual([]);
    expect(body.state).toBe('new');
    // malformed visitor id → 400
    expect(
      (await app.request(`/chat/${channelId}/messages?visitor_id=x`)).status,
    ).toBe(400);
  });

  it('accepts file uploads and attaches them to a message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const fd = new FormData();
    fd.append('visitor_id', VISITOR_A);
    fd.append('file', new File(['hello-bytes'], 'note.txt', { type: 'text/plain' }));
    const up = await app.request(`/chat/${channelId}/uploads`, { method: 'POST', body: fd });
    expect(up.status).toBe(201);
    const file = await up.json();
    expect(file.url).toMatch(/^\/uploads\//);

    // attachment-only message (no text) stores payload.attachments
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR_A, text: '', attachments: [file] }),
    });
    expect(res.status).toBe(200);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const msgs = (await poll.json()).messages;
    const last = msgs.at(-1);
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0].name).toBe('note.txt');
    // stored text is a readable fallback so the agent/console isn't blank
    expect(last.text).toContain('note.txt');
  });

  it('surfaces approval cards on internal test channels but never on embeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [agent] = await db.select().from(agents).limit(1);
    const [internalChannel] = await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Ask Janis',
        credentials: { internal: true },
      })
      .returning();

    const visitor = 'vis_internaltest99';
    await app.request(`/chat/${internalChannel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor, text: 'refund my order' }),
    });
    const first = await app.request(
      `/chat/${internalChannel.id}/messages?visitor_id=${visitor}`,
    );
    const convId = (await first.json()).conversation_id as string;
    expect(convId).toBeTruthy();

    // Mirrors requestToolApproval's row shape.
    await db.insert(messages).values([
      {
        conversationId: convId,
        direction: 'human',
        text: 'approval requested — stripe_create_refund',
        flags: { action_request: true },
        payload: {
          internal: true,
          event: 'approval requested',
          action: {
            id: 'act-1',
            tool: 'stripe_create_refund',
            args: { charge_id: 'ch_1' },
            status: 'pending',
          },
        },
      },
      {
        conversationId: convId,
        direction: 'human',
        text: 'operator-only note',
        payload: { internal: true },
      },
    ]);

    const poll = await app.request(
      `/chat/${internalChannel.id}/messages?visitor_id=${visitor}`,
    );
    const msgs = (await poll.json()).messages;
    const card = msgs.find((m: { action?: { tool?: string } }) => m.action?.tool);
    expect(card.action).toMatchObject({
      id: 'act-1',
      tool: 'stripe_create_refund',
      status: 'pending',
    });
    // internal rows without an action payload stay hidden even on test rails
    expect(msgs.some((m: { text: string }) => m.text === 'operator-only note')).toBe(false);

    // The same row shape on a public embed channel never leaks.
    await post('also refund mine', 'vis_embeddedchan1');
    const [extConv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'webchat:vis_embeddedchan1'))
      .limit(1);
    await db.insert(messages).values({
      conversationId: extConv.id,
      direction: 'human',
      text: 'approval requested — stripe_create_refund',
      flags: { action_request: true },
      payload: {
        internal: true,
        action: { id: 'act-2', tool: 'stripe_create_refund', args: {}, status: 'pending' },
      },
    });
    const extPoll = await app.request(
      `/chat/${channelId}/messages?visitor_id=vis_embeddedchan1`,
    );
    const extMsgs = (await extPoll.json()).messages;
    expect(extMsgs.some((m: { action?: unknown }) => m.action)).toBe(false);
  });

  // Regression: the test rail showed the visitor's first message above the
  // greeting. The transcript contract is greeting row first, so the rail's
  // echoed bubble (sorted by server timestamp once delivered) lands below it.
  it('stores the greeting before the first inbound on internal test channels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [agent] = await db.select().from(agents).limit(1);
    const [internalChannel] = await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Ask Janis',
        credentials: { internal: true },
      })
      .returning();

    const visitor = 'vis_greeting_order';
    await app.request(`/chat/${internalChannel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor, text: 'who are you?' }),
    });
    const res = await app.request(
      `/chat/${internalChannel.id}/messages?visitor_id=${visitor}`,
    );
    const msgs = (await res.json()).messages;
    expect(msgs[0].direction).toBe('out');
    expect(msgs[0].text).toBeTruthy(); // the greeting
    expect(msgs[1].direction).toBe('in');
    expect(msgs[1].text).toBe('who are you?');
  });

  // Regression: the poll filtered via:'greeting' rows on public channels and
  // the widget only drew its synthetic greeting on an empty transcript — a
  // reopened widget lost the greeting entirely.
  it('returns the stored greeting row flagged on public channels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const visitor = 'vis_greeting_public';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor, text: 'hey' }),
    });
    const res = await app.request(`/chat/${channelId}/messages?visitor_id=${visitor}`);
    const msgs = (await res.json()).messages;
    expect(msgs[0].direction).toBe('out');
    expect(msgs[0].text).toBe('Hey there!');
    expect(msgs[0].greeting).toBe(true);
    expect(msgs[1].text).toBe('hey');
  });

  it('rejects uploads with a bad visitor id and foreign attachment urls', async () => {
    const fd = new FormData();
    fd.append('visitor_id', 'x');
    fd.append('file', new File(['a'], 'a.txt'));
    expect((await app.request(`/chat/${channelId}/uploads`, { method: 'POST', body: fd })).status).toBe(400);

    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VISITOR_A,
        text: '',
        attachments: [{ name: 'evil', url: 'https://evil.test/f', type: 'text/plain', size: 1 }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('webchat authenticated identity', () => {
  const VISITOR_C = 'vis_ccccddeeeeffff00';
  const sign = (secret: string, u: { id?: string; email?: string; name?: string }) =>
    createHmac('sha256', secret)
      .update(`${u.id ?? ''}|${u.email ?? ''}|${u.name ?? ''}`)
      .digest('hex');
  const postWithUser = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ visitor_id: VISITOR_C, ...body }),
    });
  const profileOf = async () => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VISITOR_C}`))
      .limit(1);
    return (conv?.userProfile ?? {}) as Record<string, unknown>;
  };

  it('verifies HMAC-signed identity against the channel identity_secret', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await db
      .update(channels)
      .set({ credentials: { greeting: 'Hey there!', identity_secret: 'sek_test' } })
      .where(eq(channels.id, channelId));
    const user = { id: 'acct_42', email: 'sam@acme.test', name: 'Sam' };
    const res = await postWithUser({ text: 'hi', user: { ...user, sig: sign('sek_test', user) } });
    expect(res.status).toBe(200);
    const p = await profileOf();
    expect(p.external_id).toBe('acct_42');
    expect(p.email).toBe('sam@acme.test');
    expect(p.identity_verified).toBe(true);
  });

  it('treats unsigned and wrongly-signed claims as unverified (no external_id)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await postWithUser({
      text: 'unsigned',
      user: { id: 'evil_1', email: 'forged@x.test', name: 'Forged' },
    });
    let p = await profileOf();
    expect(p.identity_verified).toBe(false);
    // an unverified claim can update soft fields but never overwrite the
    // verified account id from the previous signed message
    expect(p.external_id).toBe('acct_42');
    expect(p.email).toBe('forged@x.test');

    await postWithUser({
      text: 'bad sig',
      user: { id: 'evil_2', email: 'forged@x.test', name: 'Forged', sig: 'deadbeef' },
    });
    p = await profileOf();
    expect(p.identity_verified).toBe(false);
    expect(p.external_id).toBe('acct_42');
  });

  it('identifies via the Janis session cookie on same-origin embeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@janis.test', name: 'Owner One' })
      .returning();
    await db.insert(memberships).values({
      userId: u.id,
      workspaceId: ws.id,
      role: 'admin',
      acceptedAt: new Date(),
    });
    await db.insert(sessions).values({
      id: sha256('tok-abc'),
      userId: u.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await postWithUser(
      { text: 'session hello' },
      { cookie: 'janis_session=tok-abc' },
    );
    expect(res.status).toBe(200);
    // session posts land on the user-keyed conversation, not the visitor's
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    const p = (conv?.userProfile ?? {}) as Record<string, unknown>;
    expect(p.external_id).toBe(u.id);
    expect(p.email).toBe('owner@janis.test');
    expect(p.identity_verified).toBe(true);
  });

  it('shows concierge approval cards only to the verified session viewer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const prev = process.env.JANIS_SUPPORT_CHANNEL_ID;
    process.env.JANIS_SUPPORT_CHANNEL_ID = channelId;
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'cards@janis.test', name: 'Cards' })
        .returning();
      await db.insert(sessions).values({
        id: sha256('tok-card'),
        userId: u.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      // park a card on the signed-in user's concierge thread
      await postWithUser({ text: 'hi' }, { cookie: 'janis_session=tok-card' });
      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, `webchat:u:${u.id}`))
        .limit(1);
      const cardPayload = {
        internal: true,
        action: { id: 'act_1', tool: 'teach_agent', status: 'pending', display: { Entry: 'x' } },
      };
      await db.insert(messages).values({
        conversationId: conv.id,
        direction: 'human',
        text: 'proposed card',
        payload: cardPayload,
      });
      const res = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_C}`, {
        headers: { cookie: 'janis_session=tok-card' },
      });
      const body = await res.json();
      const card = body.messages.find((m: { action?: { id: string } }) => m.action?.id === 'act_1');
      expect(card.action.tool).toBe('teach_agent');
      // the same internal row on an anonymous visitor's thread never renders
      await post('anon hello', 'vis_anon0123456789');
      const [anonConv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, 'webchat:vis_anon0123456789'))
        .limit(1);
      await db.insert(messages).values({
        conversationId: anonConv.id,
        direction: 'human',
        text: 'hidden card',
        payload: { ...cardPayload, action: { ...cardPayload.action, id: 'act_2' } },
      });
      const anon = await (
        await app.request(`/chat/${channelId}/messages?visitor_id=vis_anon0123456789`)
      ).json();
      expect(
        anon.messages.every((m: { action?: unknown }) => m.action === undefined),
      ).toBe(true);
      expect(anon.messages.some((m: { text: string }) => m.text === 'hidden card')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.JANIS_SUPPORT_CHANNEL_ID;
      else process.env.JANIS_SUPPORT_CHANNEL_ID = prev;
    }
  });

  it('stores the session user\'s avatar as the conversation picture_url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    await db.update(users).set({ avatarUrl: '/uploads/av-owner.png' }).where(eq(users.id, u.id));
    const res = await postWithUser(
      { text: 'avatar hello' },
      { cookie: 'janis_session=tok-abc' },
    );
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    expect((conv?.userProfile as Record<string, unknown>)?.picture_url).toBe('/uploads/av-owner.png');
    // and the avatar endpoint serves the upload row through fetchAvatar
    const { storeUpload } = await import('../lib/uploads.js');
    const { fetchAvatar } = await import('../lib/avatar.js');
    const stored = await storeUpload(db, {
      name: 'av-owner.png',
      type: 'image/png',
      data: Buffer.from('png-bytes'),
    });
    await db
      .update(users)
      .set({ avatarUrl: stored.url })
      .where(eq(users.id, u.id));
    await db
      .update(conversations)
      .set({ userProfile: { ...(conv!.userProfile as object), picture_url: stored.url } })
      .where(eq(conversations.id, conv!.id));
    const av = await fetchAvatar(db, { ...conv!, userProfile: { ...(conv!.userProfile as object), picture_url: stored.url } });
    expect(av?.type).toBe('image/png');
    expect(Buffer.from(av!.bytes).toString()).toBe('png-bytes');
  });

  it('binds a session user\'s conversation to the user, not the visitor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    // a session-verified post keys the conversation `u:{userId}` — the same
    // thread the console rail and site widget share for a logged-in user
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
      body: JSON.stringify({ visitor_id: VISITOR_A, text: 'console rail says hi' }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    expect(conv).toBeTruthy();

    // polling from a DIFFERENT visitor id with the same session → same thread,
    // and the poll itself adopts that visitor's anonymous thread ('a secret')
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`, {
      headers: { cookie: 'janis_session=tok-abc' },
    });
    const texts = ((await poll.json()).messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain('session hello');
    expect(texts).toContain('console rail says hi');
    expect(texts).toContain('a secret');

    // the adopted visitor thread is gone — anonymous polls start a fresh one
    const anon = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`);
    expect(((await anon.json()).messages as { text: string }[]).map((m) => m.text)).toEqual([]);
  });

  it('folds the visitor\'s anonymous thread into the user conversation on login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const VIS = 'vis_adopt0000000001';
    // anonymous thread first — a pre-login visitor conversation
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'asked before logging in' }),
    });
    // same browser logs in and posts — the visitor conv folds into the
    // existing u: thread rather than stranding the anonymous history
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
      body: JSON.stringify({ visitor_id: VIS, text: 'now logged in' }),
    });
    const orphans = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    expect(orphans).toEqual([]);
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`, {
      headers: { cookie: 'janis_session=tok-abc' },
    });
    const texts = ((await poll.json()).messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain('asked before logging in');
    expect(texts).toContain('now logged in');
  });

  it('gives session users on internal channels the console context pack', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const [a] = await db.select().from(agents).limit(1);
    // a second channel so the agents trait has something to list
    await db.insert(channels).values({
      workspaceId: ws.id, agentId: a.id, kind: 'email', name: 'support@',
      credentials: {},
    });
    const [internalChannel] = await db.insert(channels).values({
      workspaceId: ws.id, agentId: a.id, kind: 'webchat', name: 'Ask Janis',
      credentials: { internal: true },
    }).returning();
    const res = await app.request(`/chat/${internalChannel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
      body: JSON.stringify({
        visitor_id: 'vis_ctxpack00000001', text: 'where am i', page: '/reports',
      }),
    });
    expect(res.status).toBe(200);
    // internal channels namespace externalId per channel — the u: thread here
    // is the test rail's own conversation, not the public widget's
    const [conv] = await db.select().from(conversations)
      .where(eq(conversations.externalId, `webchat:test:${internalChannel.id}:u:${u.id}`)).limit(1);
    const meta = ((conv?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.current_workspace).toBe('Test');
    expect(meta.page).toBe('/reports');
    expect(String(meta.agents)).toContain('Support Bot');
    expect(String(meta.agents)).toContain('webchat');

    // a session user on a customer-facing embed gets no context pack — a
    // logged-in Janis operator chatting on a client's site must not leak their
    // workspace's agent inventory into that customer's conversation
    const [u2] = await db.insert(users)
      .values({ email: 'other@janis.test', name: 'Other User' }).returning();
    await db.insert(memberships).values({
      userId: u2.id, workspaceId: ws.id, role: 'member', acceptedAt: new Date(),
    });
    await db.insert(sessions).values({
      id: sha256('tok-other'), userId: u2.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res2 = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-other' },
      body: JSON.stringify({ visitor_id: 'vis_ctxpack00000002', text: 'hi', page: '/reports' }),
    });
    expect(res2.status).toBe(200);
    const [conv2] = await db.select().from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u2.id}`)).limit(1);
    const meta2 = ((conv2?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta2.agents).toBeUndefined();
    expect(meta2.current_workspace).toBeUndefined();
    expect(meta2.page).toBeUndefined();
  });

  it('includes the selected agent in the concierge context pack', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const [a] = await db.select().from(agents).limit(1);
    const [internalChannel] = await db.insert(channels).values({
      workspaceId: ws.id, agentId: a.id, kind: 'webchat', name: 'Ask Janis',
      credentials: { internal: true },
    }).returning();
    const post = (agent_id?: string) =>
      app.request(`/chat/${internalChannel.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
        body: JSON.stringify({ visitor_id: 'vis_ctxagent00001', text: 'hi', agent_id }),
      });
    expect((await post(a.id)).status).toBe(200);
    const [conv] = await db.select().from(conversations)
      .where(eq(conversations.externalId, `webchat:test:${internalChannel.id}:u:${u.id}`)).limit(1);
    const meta = ((conv?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.current_agent).toBe(a.name);
    // leaving the agent context clears the trait — traits merge per message,
    // so an unstamped key would otherwise outlive the selection
    expect((await post()).status).toBe(200);
    const [conv2] = await db.select().from(conversations)
      .where(eq(conversations.id, conv.id)).limit(1);
    const meta2 = ((conv2?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta2.current_agent).toBeFalsy();
    // an id outside the workspace never lands in the pack
    expect((await post('00000000-0000-0000-0000-000000000000')).status).toBe(200);
    const [conv3] = await db.select().from(conversations)
      .where(eq(conversations.id, conv.id)).limit(1);
    const meta3 = ((conv3?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta3.current_agent).toBeFalsy();
  });

  it('gives the context pack on the support channel (Ask Janis rail)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const [a] = await db.select().from(agents).limit(1);
    // Ask Janis posts through the support channel — a plain public webchat
    // channel (internal: false), matched by JANIS_SUPPORT_CHANNEL_ID
    await db.insert(channels).values({
      id: SUPPORT_CHANNEL_ID, workspaceId: ws.id, agentId: a.id,
      kind: 'webchat', name: 'Janis Agent', credentials: {},
    });
    // env.supportChannelId is snapshotted at module load — set the field
    // directly (the env var was never exported in the test process)
    const { env } = await import('../env.js');
    env.supportChannelId = SUPPORT_CHANNEL_ID;
    const res = await app.request(`/chat/${SUPPORT_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
      body: JSON.stringify({ visitor_id: 'vis_support0000001', text: 'hi', page: '/conversations' }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`)).limit(1);
    const meta = ((conv?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.current_workspace).toBe('Test');
    expect(meta.page).toBe('/conversations');
    expect(String(meta.agents)).toContain('Support Bot');
    // u: threads are shared across surfaces — a poll on the support channel
    // resolves the conversation even though its binding lives on the
    // channel that originally carried it.
    const poll = await app.request(
      `/chat/${SUPPORT_CHANNEL_ID}/messages?visitor_id=vis_support0000001`,
      { headers: { cookie: 'janis_session=tok-abc' } },
    );
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { messages: { text: string }[] };
    expect(body.messages.some((m) => m.text === 'hi')).toBe(true);
  });

  it('merges cleanly when both threads have a Slack thread link', async () => {
    // fresh Response per call — seeding an installation makes mirrorToSlack
    // hit fetch too, and a reused Response body can only be read once
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T1', botToken: 'xoxb-test' })
      .returning();
    // the user's u: thread already exists (session posts above) — give it a
    // Slack thread link, then give the anonymous thread one too: the merge
    // must keep the user's and drop the visitor's, not violate the unique
    // slack_threads.conversation_id constraint (regression: poll 500 loop)
    const [uConv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    const VIS = 'vis_slackmerge00001';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'anon while logged out' }),
    });
    const [vConv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    await db.insert(slackThreads).values({
      conversationId: uConv.id,
      installationId: inst.id,
      channelId: 'C1',
      ts: '111.222',
    });
    await db.insert(slackThreads).values({
      conversationId: vConv.id,
      installationId: inst.id,
      channelId: 'C1',
      ts: '333.444',
    });
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-abc' },
      body: JSON.stringify({ visitor_id: VIS, text: 'merged with slack threads' }),
    });
    expect(res.status).toBe(200);
    // a conversation can own many live Slack threads — the anonymous
    // visitor's thread repoints onto the merged conversation, nothing is
    // dropped
    const threads = await db.select().from(slackThreads);
    expect(threads).toHaveLength(2);
    expect(threads.every((t) => t.conversationId === uConv.id)).toBe(true);
    expect(threads.map((t) => t.ts).sort()).toEqual(['111.222', '333.444']);
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`, {
      headers: { cookie: 'janis_session=tok-abc' },
    });
    const texts = ((await poll.json()).messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain('anon while logged out');
    expect(texts).toContain('merged with slack threads');
    // let any in-flight Slack mirror finish under this test's stub, then
    // remove the install — later tests' single-use Response stubs break if
    // mirrorToSlack keeps firing
    await new Promise((r) => setTimeout(r, 50));
    await db.delete(slackThreads).where(eq(slackThreads.conversationId, uConv.id));
    await db.delete(slackInstallations).where(eq(slackInstallations.id, inst.id));
  });

  it('re-keys the visitor thread when no user conversation exists yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.select().from(workspaces).limit(1);
    const [u2] = await db
      .insert(users)
      .values({ email: 'second@janis.test', name: 'Second User' })
      .returning();
    await db.insert(memberships).values({
      userId: u2.id,
      workspaceId: ws.id,
      role: 'member',
      acceptedAt: new Date(),
    });
    await db.insert(sessions).values({
      id: sha256('tok-def'),
      userId: u2.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const VIS = 'vis_rekey0000000002';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'anon question' }),
    });
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'janis_session=tok-def' },
      body: JSON.stringify({ visitor_id: VIS, text: 'signed-in question' }),
    });
    // one conversation, re-keyed to the user, carrying the whole transcript
    const orphans = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    expect(orphans).toEqual([]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u2.id}`))
      .limit(1);
    expect(conv).toBeTruthy();
    const msgs = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msgs.map((m) => m.text)).toEqual(
      expect.arrayContaining(['anon question', 'signed-in question']),
    );
  });

  it('adopts threads carrying a verified claim to the user\'s email only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    // a thread whose email was HMAC-asserted by the host — verification the
    // user actually owns the address, so it folds into their u: thread
    const VIS = 'vis_email0000000004';
    const claim = { id: 'ext_other_device', email: 'owner@janis.test', name: 'Owner One' };
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VIS,
        text: 'from my other device',
        user: { ...claim, sig: sign('sek_test', claim) },
      }),
    });
    // a thread that merely TYPED the same email — unverified, must not merge
    const VIS2 = 'vis_claim0000000005';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VIS2,
        text: 'i am totally the owner',
        user: { email: 'owner@janis.test', name: 'Owner One' },
      }),
    });
    // session poll from yet another visitor id — the email-matched anonymous
    // thread still folds into the u: conversation
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`, {
      headers: { cookie: 'janis_session=tok-abc' },
    });
    const texts = ((await poll.json()).messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain('from my other device');
    expect(texts).not.toContain('i am totally the owner');
    const orphans = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    expect(orphans).toEqual([]);
    // the unverified claim keeps its own visitor thread
    const [stillAnon] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS2}`))
      .limit(1);
    expect(stillAnon).toBeTruthy();
    // sanity: still one user thread
    const userConvs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`));
    expect(userConvs).toHaveLength(1);
  });

  it('binds a signed claim for a real Janis user to the user conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    // what /identity vends on a cross-origin embed: a signed claim for the
    // logged-in Janis user — it must land on the same u: conversation
    const claim = { id: u.id, email: u.email, name: u.name, sig: '' };
    claim.sig = sign('sek_test', claim);
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR_B, text: 'claimed hello', user: claim }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    expect(conv).toBeTruthy();

    // the claim also resolves the transcript on polls — no session needed
    const q = new URLSearchParams({
      visitor_id: VISITOR_B,
      u_id: u.id, u_name: u.name, u_email: u.email, u_sig: claim.sig,
    });
    const poll = await app.request(`/chat/${channelId}/messages?${q}`);
    const texts = ((await poll.json()).messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain('console rail says hi');
    expect(texts).toContain('claimed hello');
  });

  it('keeps host-site (non-Janis) claims on the visitor conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const user = { id: 'acct_host_7', email: 'h@acme.test', name: 'Host User' };
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VISITOR_B,
        text: 'host claim hello',
        user: { ...user, sig: sign('sek_test', user) },
      }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VISITOR_B}`))
      .limit(1);
    expect(conv).toBeTruthy();
    // claim params on the poll still resolve the visitor transcript
    const q = new URLSearchParams({
      visitor_id: VISITOR_B,
      u_id: user.id, u_name: user.name, u_email: user.email,
      u_sig: sign('sek_test', user),
    });
    const poll = await app.request(`/chat/${channelId}/messages?${q}`);
    expect(((await poll.json()).messages as { text: string }[]).map((m) => m.text))
      .toContain('host claim hello');
  });

  it('identify endpoint updates an existing conversation profile', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    // VISITOR_C's thread was adopted into the u: conversation by the session
    // posts above — a fresh visitor exercises the host-claim identify path
    const VIS = 'vis_identify0000003';
    const user = { id: 'acct_99', email: 'late@acme.test', name: 'Late' };
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'pre-identify hello' }),
    });
    const res = await app.request(`/chat/${channelId}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VIS,
        user: { ...user, sig: sign('sek_test', user) },
      }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    const p = (conv?.userProfile ?? {}) as Record<string, unknown>;
    expect(p.external_id).toBe('acct_99');
    expect(p.email).toBe('late@acme.test');
    expect(p.identity_verified).toBe(true);
  });

  it('stores host-provided traits on the profile and merges them on identify', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VIS = 'vis_traits00000001';
    const user = { id: 'acct_traits', email: 't@acme.test', name: 'Traits' };
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VIS,
        text: 'hello with traits',
        user: { ...user, sig: sign('sek_test', user), traits: { plan: 'pro' } },
      }),
    });
    // identify can add or overwrite traits later — merged, not replaced
    await app.request(`/chat/${channelId}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VIS,
        user: { ...user, sig: sign('sek_test', user), traits: { company: 'Acme' } },
      }),
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    const meta = ((conv?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.plan).toBe('pro');
    expect(meta.company).toBe('Acme');
  });

  it('attaches workspace names as traits for session-identified Janis users', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:u:${u.id}`))
      .limit(1);
    const meta = ((conv?.userProfile as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.janis_account).toBe('yes');
    expect(meta.workspaces).toContain('Test');
  });
});

describe('webchat transcript polish', () => {
  it('returns the resolved participant so clients can detect thread switches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VIS = 'vis_particp0000001';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'hi' }),
    });
    const anon = await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`);
    expect((await anon.json()).participant).toBe(VIS);

    // a session-bound poll resolves to the user — the widget resets its
    // transcript and cursor when this value changes
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    const authed = await app.request(
      `/chat/${channelId}/messages?visitor_id=vis_p_other00000001`,
      { headers: { cookie: 'janis_session=tok-abc' } },
    );
    expect((await authed.json()).participant).toBe(`u:${u.id}`);
  });

  it('publishes a typing event to the workspace bus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const { bus } = await import('../lib/bus.js');
    const [ws] = await db.select().from(workspaces).limit(1);
    const VIS = 'vis_typing00000001';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'first' }),
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    const got = new Promise((resolve) => {
      const off = bus.subscribe(ws.id, (e) => {
        if (e.type === 'typing') {
          off();
          resolve(e.data);
        }
      });
    });
    const res = await app.request(`/chat/${channelId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS }),
    });
    expect(res.status).toBe(200);
    await expect(got).resolves.toMatchObject({ conversation_id: conv.id });

    // unknown channel 404s; a visitor with no thread is a quiet no-op
    expect(
      (
        await app.request('/chat/00000000-0000-0000-0000-000000000000/typing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitor_id: VIS }),
        })
      ).status,
    ).toBe(404);
    const noop = await app.request(`/chat/${channelId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: 'vis_noconvo0000000' }),
    });
    expect(noop.status).toBe(200);
  });

  it('attaches operator identity to human messages unless the operator opted out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@janis.test'));
    await db
      .update(users)
      .set({ displayName: 'Boss', avatarUrl: '/uploads/av.png' })
      .where(eq(users.id, u.id));
    const VIS = 'vis_operator0000001';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'q' }),
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'human',
      authorId: u.id,
      text: 'operator reply',
    });
    const poll = async () =>
      (await (await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)).json()) as {
        messages: { direction: string; text: string; author?: { name: string; avatar: string | null } }[];
      };

    // identity is per-operator now — display name + avatar surface whenever
    // the operator hasn't opted out (no channel-level switch)
    let body = await poll();
    let human = body.messages.find((m) => m.direction === 'human');
    expect(human?.text).toBe('operator reply');
    expect(human?.author).toEqual({ name: 'Boss', avatar: '/uploads/av.png' });

    // no display name → falls back to first name
    await db.update(users).set({ displayName: null }).where(eq(users.id, u.id));
    body = await poll();
    human = body.messages.find((m) => m.direction === 'human');
    expect(human?.author?.name).toBe('Owner');

    // per-operator opt-out — anonymous even though the channel shows identity
    await db.update(users).set({ showIdentity: false }).where(eq(users.id, u.id));
    body = await poll();
    human = body.messages.find((m) => m.direction === 'human');
    expect(human?.author).toBeUndefined();
    await db.update(users).set({ showIdentity: true }).where(eq(users.id, u.id));
  });

  it('internal notes (takeover/resume) never reach the visitor transcript', async () => {
    const VIS = 'vis_internal000001';
    await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VIS, text: 'hi' }),
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`))
      .limit(1);
    const [u] = await db.select().from(users).limit(1);
    // takeover/resume/operator notes all write payload.internal — the exact
    // shape takeover.ts stores, full account name included
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'human', authorId: u.id, text: 'Admin User took over', payload: { internal: true, event: 'takeover' } },
      { conversationId: conv.id, direction: 'human', authorId: u.id, text: 'Admin User (internal note): secret', payload: { internal: true, via: 'web' } },
      { conversationId: conv.id, direction: 'human', authorId: u.id, text: 'visible reply' },
    ]);
    const body = (await (
      await app.request(`/chat/${channelId}/messages?visitor_id=${VIS}`)
    ).json()) as { messages: { direction: string; text: string }[] };
    const human = body.messages.filter((m) => m.direction === 'human');
    expect(human.map((m) => m.text)).toEqual(['visible reply']);
  });
});

describe('dictation transcribe', () => {
  // Earlier tests rewrite channel credentials wholesale (identity_secret) —
  // re-assert the opt-in flag before these run.
  beforeAll(async () => {
    const [ch] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    await db
      .update(channels)
      .set({ credentials: { ...(ch.credentials as object), dictation: true } })
      .where(eq(channels.id, channelId));
  });

  const postAudio = (token: string, withFile = true) => {
    const fd = new FormData();
    if (withFile) fd.append('audio', new File(['fakeaudio'], 'dictation.webm', { type: 'audio/webm' }));
    return app.request(`/chat/${token}/transcribe`, { method: 'POST', body: fd });
  };

  it('forwards audio to OpenAI and returns the transcript', async () => {
    const prev = process.env.OPENAI_LLM_API_KEY;
    process.env.OPENAI_LLM_API_KEY = 'sk-test-stt';
    let seenAuth = '';
    let seenModel = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seenAuth = (init?.headers as Record<string, string>).Authorization;
        seenModel = (init?.body as FormData).get('model') as string;
        return new Response(JSON.stringify({ text: 'hello world', duration: 2.5 }));
      }),
    );
    try {
      const r = await postAudio(channelId);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ text: 'hello world' });
      expect(seenAuth).toBe('Bearer sk-test-stt');
      expect(seenModel).toBe('gpt-4o-mini-transcribe');
      const [u] = await db.select().from(usageEvents).where(eq(usageEvents.kind, 'stt_seconds'));
      expect(u.quantity).toBe(3); // 2.5s → ceil
      expect(u.costMicros).toBe(125); // 2.5s × 50µ/s
      expect(u.workspaceId).toBe(wsId);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_LLM_API_KEY;
      else process.env.OPENAI_LLM_API_KEY = prev;
    }
  });

  it('rejects a missing audio field and an unknown channel', async () => {
    process.env.OPENAI_LLM_API_KEY = 'sk-test-stt';
    expect((await postAudio(channelId, false)).status).toBe(400);
    // well-formed uuid that doesn't match a channel
    expect((await postAudio('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('prefers the Google metered account — native generateContent — when set', async () => {
    const prevG = process.env.GOOGLE_LLM_API_KEY;
    const prevO = process.env.OPENAI_LLM_API_KEY;
    process.env.GOOGLE_LLM_API_KEY = 'goog-test';
    process.env.OPENAI_LLM_API_KEY = 'sk-should-not-be-used';
    let seenUrl = '';
    let seenKey = '';
    let seenMime = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seenUrl = String(url);
        seenKey = (init?.headers as Record<string, string>)['x-goog-api-key'];
        const body = JSON.parse(String(init?.body)) as {
          contents: { parts: { inlineData?: { mimeType: string } }[] }[];
        };
        seenMime = body.contents[0].parts[0].inlineData?.mimeType ?? '';
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini transcript' }] } }] }),
        );
      }),
    );
    try {
      const r = await postAudio(channelId);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ text: 'gemini transcript' });
      expect(seenUrl).toContain(':generateContent');
      expect(seenKey).toBe('goog-test');
      expect(seenMime).toBe('audio/webm');
    } finally {
      if (prevG === undefined) delete process.env.GOOGLE_LLM_API_KEY;
      else process.env.GOOGLE_LLM_API_KEY = prevG;
      if (prevO === undefined) delete process.env.OPENAI_LLM_API_KEY;
      else process.env.OPENAI_LLM_API_KEY = prevO;
    }
  });

  it('503s when no transcription key is configured', async () => {
    const prevO = process.env.OPENAI_LLM_API_KEY;
    const prevG = process.env.GOOGLE_LLM_API_KEY;
    delete process.env.OPENAI_LLM_API_KEY;
    delete process.env.GOOGLE_LLM_API_KEY;
    try {
      expect((await postAudio(channelId)).status).toBe(503);
    } finally {
      if (prevO === undefined) delete process.env.OPENAI_LLM_API_KEY;
      else process.env.OPENAI_LLM_API_KEY = prevO;
      if (prevG === undefined) delete process.env.GOOGLE_LLM_API_KEY;
      else process.env.GOOGLE_LLM_API_KEY = prevG;
    }
  });

  it('403s and never calls STT when the channel has not enabled dictation', async () => {
    process.env.OPENAI_LLM_API_KEY = 'sk-test-stt';
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: (await db.select().from(agents))[0].id,
        kind: 'webchat',
        name: 'No mic',
        credentials: { greeting: 'hi' },
      })
      .returning();
    let sttCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        sttCalled = true;
        return new Response(JSON.stringify({ text: 'x', duration: 1 }));
      }),
    );
    try {
      const r = await postAudio(ch.id);
      expect(r.status).toBe(403);
      expect(sttCalled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await db.delete(channels).where(eq(channels.id, ch.id));
    }
  });

  it('reports stt_seconds to the Stripe meter with margin, idempotent by row id', async () => {
    process.env.OPENAI_LLM_API_KEY = 'sk-test-stt';
    await db
      .update(workspaces)
      .set({ stripeCustomerId: 'cus_test_stt' })
      .where(eq(workspaces.id, wsId));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ text: 'bill me', duration: 2.5 }))),
    );
    try {
      const before = meteredEvents.length;
      const prior = new Set(
        (await db.select({ id: usageEvents.id }).from(usageEvents)).map((u) => u.id),
      );
      const r = await postAudio(channelId);
      expect(r.status).toBe(200);
      // reportMeter is fire-and-forget — flush the microtask queue
      await new Promise((r2) => setTimeout(r2, 10));
      const ev = meteredEvents.slice(before).find((e) => e.event_name === 'janis.stt_micros');
      expect(ev).toBeDefined();
      // 2.5s → cost 125µ → billed 125 × 1.2 margin = 150 micro-USD
      expect(ev!.payload).toEqual({ stripe_customer_id: 'cus_test_stt', value: '150' });
      const rows = await db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.kind, 'stt_seconds'));
      const fresh = rows.filter((u) => !prior.has(u.id));
      expect(fresh).toHaveLength(1);
      expect(ev!.identifier).toBe(fresh[0].id);
    } finally {
      vi.unstubAllGlobals();
      await db
        .update(workspaces)
        .set({ stripeCustomerId: null })
        .where(eq(workspaces.id, wsId));
    }
  });

  it('honours the ?engine= A/B override — openai skips Gemini, gemini never falls back', async () => {
    process.env.GOOGLE_LLM_API_KEY = 'goog-test';
    process.env.OPENAI_LLM_API_KEY = 'sk-test-stt';
    const seenUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seenUrls.push(String(url));
        return new Response(JSON.stringify({ text: 'x', duration: 1 }));
      }),
    );
    try {
      const fd1 = new FormData();
      fd1.append('audio', new File(['fakeaudio'], 'd.webm', { type: 'audio/webm' }));
      const r1 = await app.request(`/chat/${channelId}/transcribe?engine=openai`, {
        method: 'POST',
        body: fd1,
      });
      expect(r1.status).toBe(200);
      expect(seenUrls[0]).toBe('https://api.openai.com/v1/audio/transcriptions');

      // engine=gemini forces Gemini — failure must not silently fall back
      seenUrls.length = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          seenUrls.push(String(url));
          return new Response('quota', { status: 429 });
        }),
      );
      const fd2 = new FormData();
      fd2.append('audio', new File(['fakeaudio'], 'd.webm', { type: 'audio/webm' }));
      const r2 = await app.request(`/chat/${channelId}/transcribe?engine=gemini`, {
        method: 'POST',
        body: fd2,
      });
      expect(r2.status).toBe(502);
      expect(seenUrls).toHaveLength(1);
      expect(seenUrls[0]).toContain('generativelanguage.googleapis.com');
    } finally {
      delete process.env.GOOGLE_LLM_API_KEY;
      delete process.env.OPENAI_LLM_API_KEY;
    }
  });

  it('exposes the dictation flag in the widget bootstrap', async () => {
    const body = (await (await app.request(`/chat/${channelId}`)).json()) as {
      dictation?: boolean;
    };
    expect(body.dictation).toBe(true);
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: (await db.select().from(agents))[0].id,
        kind: 'webchat',
        name: 'Mic off',
        credentials: {},
      })
      .returning();
    const off = (await (await app.request(`/chat/${ch.id}`)).json()) as {
      dictation?: boolean;
    };
    expect(off.dictation).toBe(false);
    await db.delete(channels).where(eq(channels.id, ch.id));
  });

  it('emits dictation_engine and 403s transcribe on browser-engine channels', async () => {
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: (await db.select().from(agents))[0].id,
        kind: 'webchat',
        name: 'Browser mic',
        credentials: { dictation: true, dictation_engine: 'browser' },
      })
      .returning();
    try {
      const body = (await (await app.request(`/chat/${ch.id}`)).json()) as {
        dictation?: boolean;
        dictation_engine?: string;
      };
      expect(body.dictation).toBe(true);
      expect(body.dictation_engine).toBe('browser');
      // A crafted POST must not burn the metered STT path on a free channel
      let called = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          called = true;
          return new Response(JSON.stringify({ text: 'x', duration: 1 }));
        }),
      );
      expect((await postAudio(ch.id)).status).toBe(403);
      expect(called).toBe(false);
    } finally {
      await db.delete(channels).where(eq(channels.id, ch.id));
      vi.unstubAllGlobals();
    }
    // Legacy channels (dictation on, engine never set) keep 'llm' — their
    // metered coverage is preserved.
    const legacy = (await (await app.request(`/chat/${channelId}`)).json()) as {
      dictation_engine?: string;
    };
    expect(legacy.dictation_engine).toBe('llm');
  });
});

describe('widget custom domain', () => {
  it('resolves a claimed host to its channel (and is not shadowed by /:token)', async () => {
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    await db
      .update(channels)
      .set({ credentials: { ...(ch.credentials as object), widget_domain: 'chat.acme.test' } })
      .where(eq(channels.id, channelId));
    try {
      const res = await app.request('/chat/by-domain?host=chat.acme.test');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ token: channelId, channel_name: 'Acme website', agent_name: 'Support Bot' });
    } finally {
      await db
        .update(channels)
        .set({ credentials: ch.credentials as never })
        .where(eq(channels.id, channelId));
    }
  });

  it('normalizes case/ports on ?host= and falls back to the Host header', async () => {
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    await db
      .update(channels)
      .set({ credentials: { ...(ch.credentials as object), widget_domain: 'chat.acme.test' } })
      .where(eq(channels.id, channelId));
    try {
      expect((await app.request('/chat/by-domain?host=CHAT.acme.TEST:443')).status).toBe(200);
      const res = await app.request('/chat/by-domain', {
        headers: { host: 'chat.acme.test' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).token).toBe(channelId);
    } finally {
      await db
        .update(channels)
        .set({ credentials: ch.credentials as never })
        .where(eq(channels.id, channelId));
    }
  });

  it('404s for unclaimed hosts and non-webchat claims', async () => {
    expect((await app.request('/chat/by-domain?host=nope.test')).status).toBe(404);
    const [meta] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: (await db.select({ id: agents.id }).from(agents))[0].id,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'p', access_token: 't', widget_domain: 'chat.meta.test' },
      })
      .returning();
    try {
      expect((await app.request('/chat/by-domain?host=chat.meta.test')).status).toBe(404);
    } finally {
      await db.delete(channels).where(eq(channels.id, meta.id));
    }
  });

  it('serves page mode for ?mode=full and the floating bubble otherwise', async () => {
    const full = await app.request(`/chat/${channelId}/page?mode=full`);
    expect(await full.text()).toContain('data-janis-page="1"');
    const normal = await app.request(`/chat/${channelId}/page`);
    const html = await normal.text();
    expect(html).toContain('data-janis-preview="1"');
    expect(html).not.toContain('data-janis-page');
  });
});

describe('inbound rate limiting', () => {
  it('throttles a single visitor at 20/min and isolates other visitors', async () => {
    const spammer = `spam_${Date.now().toString(36)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request(`/chat/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: spammer, text: `burst ${i}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await post('still fine')).status).toBe(200);
  });
});
