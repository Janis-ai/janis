import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alerts, conversations, memberships, messages, sessions, users, workspaces } from '../db/schema.js';
import { generateApiKey, generateSessionToken, hashPassword } from '../lib/crypto.js';
import { conversationRoutes } from './conversations.js';
import { viewRoutes } from './views.js';
import { takeover } from '../services/takeover.js';

let app: Hono;
let db: Db;
let adminCookie: string;
let memberCookie: string;
let agent: typeof agents.$inferSelect;
let wsId: string;

async function seedSession(userId: string) {
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  return `janis_session=${token}`;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/conversations', conversationRoutes(db))
    .route('/api/views', viewRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({
      email: 'admin@x.c',
      name: 'Admin',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  const [member] = await db
    .insert(users)
    .values({
      email: 'member@x.c',
      name: 'Member',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  await db.insert(memberships).values([
    { userId: admin.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() },
    { userId: member.id, workspaceId: ws.id, role: 'member', acceptedAt: new Date() },
  ]);
  adminCookie = await seedSession(admin.id);
  memberCookie = await seedSession(member.id);

  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning()
  )[0];
});

async function makeConversation(externalId: string) {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId })
    .returning();
  return conv;
}

const post = (path: string, cookie: string, body: unknown) =>
  app.request(`/api/conversations${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('internal notes', () => {
  it('stores an internal note without changing state or reaching the customer', async () => {
    const conv = await makeConversation('note-conv');
    const res = await post(`/${conv.id}/note`, adminCookie, { text: 'checking with billing' });
    expect(res.status).toBe(201);
    const { message } = await res.json();
    expect(message.direction).toBe('human');
    expect(message.payload.internal).toBe(true);

    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active'); // note did not take over
    expect(after.lastMessagePreview).toContain('🔒');
  });

  it('does not reset the auto-resume clock during a takeover', async () => {
    const conv = await makeConversation('note-takeover');
    const [admin] = await db.select().from(users).where(eq(users.email, 'admin@x.c'));
    await takeover(db, wsId, conv.id, admin);
    const staleSince = new Date(Date.now() - 20 * 60_000);
    await db
      .update(conversations)
      .set({ humanSince: staleSince })
      .where(eq(conversations.id, conv.id));

    const res = await post(`/${conv.id}/note`, adminCookie, { text: 'still investigating' });
    expect(res.status).toBe(201);
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.humanSince!.getTime()).toBe(staleSince.getTime());
  });

  it('is open to members too', async () => {
    const conv = await makeConversation('note-member');
    const res = await post(`/${conv.id}/note`, memberCookie, { text: 'anyone home?' });
    expect(res.status).toBe(201);
  });
});

describe('teach', () => {
  it('admin teach appends to agent knowledge and records a note', async () => {
    const conv = await makeConversation('teach-conv');
    const res = await post(`/${conv.id}/teach`, adminCookie, {
      text: 'Refunds over $50 need manager approval',
    });
    expect(res.status).toBe(201);
    const { knowledge_count } = await res.json();
    expect(knowledge_count).toBe(1);

    const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((after.config as { knowledge: string[] }).knowledge).toContain(
      'Refunds over $50 need manager approval',
    );

    const [note] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(note.payload.internal).toBe(true);
    expect(note.payload.teach).toBe(true);
  });

  it('members cannot teach', async () => {
    const conv = await makeConversation('teach-denied');
    const res = await post(`/${conv.id}/teach`, memberCookie, { text: 'should not learn this' });
    expect(res.status).toBe(403);
    const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((after.config as { knowledge: string[] }).knowledge).not.toContain(
      'should not learn this',
    );
  });
});

describe('signal filters', () => {
  const list = (state: string, cookie = adminCookie) =>
    app
      .request(`/api/conversations?state=${state}`, { headers: { cookie } })
      .then((r) => r.json())
      .then((b: { conversations: { id: string }[] }) => b.conversations.map((c) => c.id));

  it('handoff_offer filters to conversations with an open handoff-offer alert', async () => {
    const offered = await makeConversation('offered');
    const plain = await makeConversation('plain');
    await db
      .insert(alerts)
      .values({ conversationId: offered.id, type: 'handoff_offer' });
    // a resolved offer shouldn't count
    const stale = await makeConversation('stale');
    await db
      .insert(alerts)
      .values({ conversationId: stale.id, type: 'handoff_offer', status: 'resolved' });

    expect(await list('handoff_offer')).toContain(offered.id);
    expect(await list('handoff_offer')).not.toContain(plain.id);
    expect(await list('handoff_offer')).not.toContain(stale.id);
  });

  it('failure filters to conversations with an open failure alert', async () => {
    const failing = await makeConversation('failing');
    await db.insert(alerts).values({ conversationId: failing.id, type: 'failure' });
    expect(await list('failure')).toContain(failing.id);
    expect(await list('failure')).not.toContain((await makeConversation('fine')).id);
  });

  it('overdue filters to needs_human conversations waiting past the agent SLA', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    // agent has no sla_minutes configured → default 15m, so an hour-old handoff
    // alert on a needs_human conversation counts as overdue
    const stale = await makeConversation('overdue-stale');
    await db
      .update(conversations)
      .set({ state: 'needs_human' })
      .where(eq(conversations.id, stale.id));
    await db
      .insert(alerts)
      .values({ conversationId: stale.id, type: 'help_request', createdAt: hourAgo });

    // open alert, but inside the SLA window
    const fresh = await makeConversation('overdue-fresh');
    await db
      .update(conversations)
      .set({ state: 'needs_human' })
      .where(eq(conversations.id, fresh.id));
    await db.insert(alerts).values({ conversationId: fresh.id, type: 'help_request' });

    // old alert, but the conversation was claimed/archived — no longer waiting
    const handled = await makeConversation('overdue-handled');
    await db
      .insert(alerts)
      .values({ conversationId: handled.id, type: 'help_request', createdAt: hourAgo });

    const ids = await list('overdue');
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(handled.id);
  });
});

describe('message windows', () => {
  const get = (path: string, cookie = adminCookie) =>
    app.request(`/api/conversations${path}`, { headers: { cookie } });

  it('?around returns a window centered on the target', async () => {
    const conv = await makeConversation('around-conv');
    const t0 = Date.now() - 200 * 60_000;
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const [m] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: i % 2 ? 'out' : 'in',
          text: `m${i}`,
          createdAt: new Date(t0 + i * 60_000),
        })
        .returning();
      ids.push(m.id);
    }
    const res = await get(`/${conv.id}/messages?around=${ids[100]}`);
    expect(res.status).toBe(200);
    const d = await res.json();
    const texts = d.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain('m100');
    expect(texts[0]).toBe('m40');
    expect(texts[texts.length - 1]).toBe('m159');
    expect(d.has_more).toBe(true);
    expect(d.has_more_after).toBe(true);
  });

  it('?after pages forward toward the tail', async () => {
    const conv = await makeConversation('after-conv');
    const t0 = Date.now() - 50 * 60_000;
    for (let i = 0; i < 50; i++) {
      await db.insert(messages).values({
        conversationId: conv.id,
        direction: 'in',
        text: `a${i}`,
        createdAt: new Date(t0 + i * 60_000),
      });
    }
    const res = await get(`/${conv.id}/messages?after=${encodeURIComponent(new Date(t0 + 39 * 60_000).toISOString())}`);
    const d = await res.json();
    expect(d.messages.map((m: { text: string }) => m.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `a${40 + i}`),
    );
    expect(d.has_more).toBe(false);
  });

  it('?around 404s for a message in another conversation', async () => {
    const conv = await makeConversation('around-404');
    const [m] = await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'x' })
      .returning();
    const other = await makeConversation('around-other');
    const res = await get(`/${other.id}/messages?around=${m.id}`);
    expect(res.status).toBe(404);
  });
});

describe('snooze', () => {
  const patch = (id: string, body: unknown) =>
    app.request(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify(body),
    });
  const listIds = (qs = '') =>
    app
      .request(`/api/conversations${qs}`, { headers: { cookie: adminCookie } })
      .then((r) => r.json())
      .then((b: { conversations: { id: string }[] }) => b.conversations.map((c) => c.id));

  it('PATCH snoozed_until hides from the default list and shows in the snoozed view', async () => {
    const conv = await makeConversation('snooze-me');
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await patch(conv.id, { snoozed_until: until });
    expect(res.status).toBe(200);
    const { conversation } = await res.json();
    expect(conversation.snoozed_until).toBe(until);

    expect(await listIds()).not.toContain(conv.id);
    expect(await listIds('?state=snoozed')).toContain(conv.id);
  });

  it('an expired snooze reappears in the default list', async () => {
    const conv = await makeConversation('snooze-expired');
    await db
      .update(conversations)
      .set({ snoozedUntil: new Date(Date.now() - 60_000) })
      .where(eq(conversations.id, conv.id));
    expect(await listIds()).toContain(conv.id);
    expect(await listIds('?state=snoozed')).not.toContain(conv.id);
  });

  it('snoozed conversations are excluded from unread and state views too', async () => {
    const conv = await makeConversation('snooze-unread');
    await db
      .update(conversations)
      .set({ isUnread: true, snoozedUntil: new Date(Date.now() + 3600_000) })
      .where(eq(conversations.id, conv.id));
    expect(await listIds('?state=unread')).not.toContain(conv.id);
    expect(await listIds('?state=active')).not.toContain(conv.id);
    expect(await listIds('?state=snoozed')).toContain(conv.id);
  });

  it('PATCH snoozed_until: null unsnoozes', async () => {
    const conv = await makeConversation('snooze-clear');
    await patch(conv.id, { snoozed_until: new Date(Date.now() + 3600_000).toISOString() });
    expect(await listIds()).not.toContain(conv.id);
    await patch(conv.id, { snoozed_until: null });
    expect(await listIds()).toContain(conv.id);
  });

  it('archived stays visible in the archived view even while snoozed', async () => {
    const conv = await makeConversation('snooze-archived');
    await db
      .update(conversations)
      .set({ state: 'archived', snoozedUntil: new Date(Date.now() + 3600_000) })
      .where(eq(conversations.id, conv.id));
    expect(await listIds('?state=archived')).toContain(conv.id);
    expect(await listIds()).not.toContain(conv.id);
  });
});

describe('bulk actions', () => {
  const bulk = (body: unknown) =>
    post('/bulk', adminCookie, body);

  it('archives, marks read, stars and tags in one call', async () => {
    const a = await makeConversation('bulk-a');
    const b = await makeConversation('bulk-b');
    await db
      .update(conversations)
      .set({ isUnread: true })
      .where(inArray(conversations.id, [a.id, b.id]));

    const res = await bulk({ ids: [a.id, b.id], action: 'archive' });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(2);
    const rows = await db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, [a.id, b.id]));
    expect(rows.every((r) => r.state === 'archived' && r.archivedAt)).toBe(true);

    await bulk({ ids: [a.id, b.id], action: 'mark_read' });
    await bulk({ ids: [a.id, b.id], action: 'star' });
    await bulk({ ids: [a.id, b.id], action: 'tag', tag: 'vip' });
    const after = await db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, [a.id, b.id]));
    for (const r of after) {
      expect(r.isUnread).toBe(false);
      expect(r.isStarred).toBe(true);
      expect(r.tags).toContain('vip');
    }
  });

  it('tag adds without duplicating and untag removes', async () => {
    const a = await makeConversation('bulk-tag');
    await bulk({ ids: [a.id], action: 'tag', tag: 'vip' });
    await bulk({ ids: [a.id], action: 'tag', tag: 'vip' });
    let [r] = await db.select().from(conversations).where(eq(conversations.id, a.id));
    expect(r.tags).toEqual(['vip']);
    await bulk({ ids: [a.id], action: 'untag', tag: 'vip' });
    [r] = await db.select().from(conversations).where(eq(conversations.id, a.id));
    expect(r.tags).toEqual([]);
  });

  it('rejects other workspaces\' conversations and bad input', async () => {
    const [otherWs] = await db.insert(workspaces).values({ name: 'Other' }).returning();
    const [otherAgent] = await db
      .insert(agents)
      .values({ workspaceId: otherWs.id, name: 'OtherBot' })
      .returning();
    const [stranger] = await db
      .insert(conversations)
      .values({ agentId: otherAgent.id, externalId: 'stranger' })
      .returning();

    const res = await bulk({ ids: [stranger.id], action: 'archive' });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(0);
    const [still] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, stranger.id));
    expect(still.state).toBe('active');

    expect((await bulk({ ids: [], action: 'archive' })).status).toBe(400);
    expect((await bulk({ ids: ['not-a-uuid'], action: 'archive' })).status).toBe(400);
    const conv = await makeConversation('bulk-tagreq');
    expect((await bulk({ ids: [conv.id], action: 'tag' })).status).toBe(400);
  });
});

describe('pagination', () => {
  const getPage = (qs: string) =>
    app
      .request(`/api/conversations?${qs}`, { headers: { cookie: adminCookie } })
      .then((r) => r.json());

  it('pages through the list with a stable cursor, newest first', async () => {
    // isolate: archived so the shared seeded threads don't pollute the page
    const ids: string[] = [];
    const t0 = Date.now() - 100_000;
    for (let i = 0; i < 5; i++) {
      const c = await makeConversation(`paged-${i}`);
      await db
        .update(conversations)
        .set({ state: 'archived', lastMessageAt: new Date(t0 + i * 1000) })
        .where(eq(conversations.id, c.id));
      ids.push(c.id);
    }
    // newest first
    const expected = [...ids].reverse();

    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 12; page++) {
      const d = await getPage(
        `state=archived&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const pageIds = (d.conversations as { id: string }[])
        .map((c) => c.id)
        .filter((id) => expected.includes(id));
      seen.push(...pageIds);
      cursor = d.next_cursor ?? '';
      if (seen.length >= 5 || !d.has_more) break;
    }
    expect(seen).toEqual(expected);

    // invalid cursor shape is rejected, not silently ignored
    const bad = await app.request('/api/conversations?cursor=garbage', {
      headers: { cookie: adminCookie },
    });
    expect(bad.status).toBe(400);
  });
});

describe('saved views', () => {
  it('creates, lists and deletes per-user views', async () => {
    const res = await app.request('/api/views', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        name: 'My overdue',
        filters: { state: 'overdue', assignee: 'me', tab: 'attention' },
      }),
    });
    expect(res.status).toBe(201);
    const { view } = await res.json();
    expect(view.filters.state).toBe('overdue');

    const list = await app.request('/api/views', { headers: { cookie: adminCookie } });
    const { views } = await list.json();
    expect(views.some((v: { id: string }) => v.id === view.id)).toBe(true);

    // members have their own view set — admin's view is invisible to them
    const memberList = await app.request('/api/views', { headers: { cookie: memberCookie } });
    const { views: memberViews } = await memberList.json();
    expect(memberViews.some((v: { id: string }) => v.id === view.id)).toBe(false);
    expect((await memberList.status) === 200).toBe(true);

    // and can't delete it either
    expect(
      (
        await app.request(`/api/views/${view.id}`, {
          method: 'DELETE',
          headers: { cookie: memberCookie },
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await app.request(`/api/views/${view.id}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200);
  });
});
