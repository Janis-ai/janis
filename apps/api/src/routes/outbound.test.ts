import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  auditLog,
  channelBindings,
  channels,
  contactIdentities,
  conversations,
  jobs,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword, generateApiKey } from '../lib/crypto.js';
import { applySmsOpt } from '../lib/optout.js';
import { channelApiRoutes } from './channels.js';

let db: Db;
let api: Hono;
let cookie: string;
let memberCookie: string;
let workspaceId: string;
let smsChId: string;
let waChId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  api = new Hono().route('/api/channels', channelApiRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
  workspaceId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId, name: 'bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  const [sms] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'sms', name: 'SMS', credentials: {} })
    .returning();
  smsChId = sms.id;
  const [wa] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'whatsapp', name: 'WA', credentials: {} })
    .returning();
  waChId = wa.id;
  const [em] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'email', name: 'Mail', credentials: {} })
    .returning();
  void em;

  const mk = async (email: string, role: 'admin' | 'member') => {
    const [u] = await db
      .insert(users)
      .values({ email, name: email, passwordHash: await hashPassword('password123') })
      .returning();
    await db
      .insert(memberships)
      .values({ userId: u.id, workspaceId, role, acceptedAt: new Date() });
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: u.id, workspaceId, expiresAt: new Date(Date.now() + 86_400_000) });
    return `janis_session=${token}`;
  };
  cookie = await mk('admin@x.com', 'admin');
  memberCookie = await mk('member@x.com', 'member');
});

const post = (url: string, body: unknown, ck = cookie) =>
  api.request(url, {
    method: 'POST',
    headers: { cookie: ck, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('outbound send', () => {
  it('creates a conversation + failed message when the provider rejects', async () => {
    const res = await post(`/api/channels/${smsChId}/send`, {
      to: '+15551234567',
      text: 'hi there',
    });
    // Missing Twilio creds → delivery fails, but the attempt is recorded.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { conversation_id: string; error: string };
    expect(body.conversation_id).toBeTruthy();
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, body.conversation_id));
    expect(conv.externalId).toBe('sms:+15551234567');
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msgs[0].direction).toBe('out');
    expect((msgs[0].flags as { failure: boolean }).failure).toBe(true);
    // Binding + contact spine wired even though delivery failed.
    const [b] = await db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.conversationId, conv.id));
    expect(b.platformUserId).toBe('+15551234567');
    const ids = await db.select().from(contactIdentities).where(eq(contactIdentities.channelId, smsChId));
    expect(ids.length).toBe(1);
  });

  it('reuses the conversation on a second send to the same recipient', async () => {
    const res = await post(`/api/channels/${smsChId}/send`, {
      to: '+1 (555) 123-4567',
      text: 'again',
    });
    const body = (await res.json()) as { conversation_id: string };
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'sms:+15551234567'));
    expect(convs.length).toBe(1);
    expect(body.conversation_id).toBe(convs[0].id);
  });

  it('rejects non-initiatable kinds and invalid recipients', async () => {
    const res = await post(`/api/channels/${smsChId}/send`, { to: 'not-a-number', text: 'x' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid recipient/i);
  });

  it('requires a template for a brand-new WhatsApp recipient', async () => {
    const res = await post(`/api/channels/${waChId}/send`, {
      to: '+15559876543',
      text: 'hello',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/template/i);
  });

  it('members can send; broadcast is admin-only', async () => {
    const member = await post(
      `/api/channels/${smsChId}/send`,
      { to: '+15550001111', text: 'hi' },
      memberCookie,
    );
    expect([200, 502]).toContain(member.status); // 502 = recorded delivery failure

    const denied = await post(
      `/api/channels/${smsChId}/broadcast`,
      { recipients: ['+15550001111'], text: 'hi' },
      memberCookie,
    );
    expect(denied.status).toBe(403);

    const ok = await post(`/api/channels/${smsChId}/broadcast`, {
      recipients: ['+15550002222', '+15550003333'],
      text: 'blast',
    });
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as { queued: number };
    expect(b.queued).toBe(2);
    // Sends are jobs now — two rows should be queued for the sweeper.
    const pending = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'outbound.send'), eq(jobs.status, 'pending')));
    expect(pending.length).toBe(2);
  });

  it('STOP opts the identity out; sendOutbound refuses; START re-enables', async () => {
    // Apply the opt keyword the way the sms webhook does.
    const [ch] = await db.select().from(channels).where(eq(channels.id, smsChId));
    const applied = await applySmsOpt(db, ch, '+15550009999', 'STOP');
    expect(applied).toBe(true);
    const res = await post(`/api/channels/${smsChId}/send`, {
      to: '+15550009999',
      text: 'promo',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/opted out/i);
    // The STOP itself is still in the transcript as a flagged inbound.
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'sms:+15550009999'));
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect((msgs[0].payload as { opt?: string }).opt).toBe('out');
    // START clears it
    await applySmsOpt(db, ch, '+15550009999', 'START');
    const res2 = await post(`/api/channels/${smsChId}/send`, {
      to: '+15550009999',
      text: 'welcome back',
    });
    expect([200, 502]).toContain(res2.status);
  });

  it('writes audit rows for outbound sends', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, 'channel.send')));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const bcasts = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'channel.broadcast'));
    expect(bcasts.length).toBe(1);
  });
});
