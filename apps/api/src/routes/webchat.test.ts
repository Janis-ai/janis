import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, memberships, messages, sessions, slackInstallations, slackThreads, users, workspaces } from '../db/schema.js';
import { generateApiKey, sha256 } from '../lib/crypto.js';
import { markOperatorTyping } from '../lib/typingState.js';
import { takeover, humanReply } from '../services/takeover.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Db;
let app: Hono;
let channelId: string;

const VISITOR_A = 'vis_aaaabbbbccccdddd';
const VISITOR_B = 'vis_eeeeffffgggghhhh';

const post = (text: string, visitor = VISITOR_A) =>
  app.request(`/chat/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitor, text }),
  });

beforeAll(async () => {
  // uploads land in a tmpdir, not the repo
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'janis-uploads-'));
  const { webchatRoutes } = await import('./webchat.js');
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/chat', webchatRoutes(db)); // mounted like production

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
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
      credentials: { greeting: 'Hey there!' },
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

  it('ingests a visitor message into a conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const res = await post('hello from the website');
    expect(res.status).toBe(200);

    const [conv] = await db.select().from(conversations);
    expect(conv.externalId).toBe(`webchat:${VISITOR_A}`);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const body = await poll.json();
    expect(body.state).toBe('active');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('hello from the website');
    expect(body.messages[0].direction).toBe('in');
    // internal payloads must never leak to the widget
    expect(body.messages[0].payload).toBeUndefined();
  });

  it('isolates transcripts by visitor id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await post('a secret', VISITOR_B);
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`);
    const body = await poll.json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['a secret']);

    // visitor A can't see B's transcript and vice versa
    const a = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    expect((await a.json()).messages.map((m: { text: string }) => m.text)).toEqual([
      'hello from the website',
    ]);
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
    // 21 older rows: m0..m19 + the original 'first' post
    expect(page2.messages).toHaveLength(21);
    expect(page2.has_more).toBe(false);
    expect(page2.messages.at(-1).text).toBe('m19');
    expect(page2.messages[0].text).toBe('first');
  });

  it('exposes operator typing state on the poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const VIS = 'vis_typing00000001';
    await post('typing test', VIS);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `webchat:${VIS}`));
    markOperatorTyping(conv.id, 'Bob');
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
    markOperatorTyping(conv.id, 'Op');
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
