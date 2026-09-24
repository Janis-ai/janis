import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import type { IngestEvent } from '@janis/shared';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alertRules, alerts, conversations, memberships, messages, users, workspaces } from '../db/schema.js';
import { generateApiKey, hashPassword } from '../lib/crypto.js';
import { processEvents } from './ingest.js';
import { takeover, humanReply, resume } from './takeover.js';
import { saveUserProfile } from '../lib/hostedAgent.js';
import { invalidateCapCache, messagesInPeriod } from '../lib/plans.js';

let db: Db;
let agent: typeof agents.$inferSelect;
let admin: typeof users.$inferSelect;

beforeAll(async () => {
  const client = new PGlite(); // in-memory
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  admin = (
    await db
      .insert(users)
      .values({
        email: 'a@b.c',
        name: 'A',
        passwordHash: await hashPassword('password123'),
      })
      .returning()
  )[0];
  await db.insert(memberships).values({
    userId: admin.id,
    workspaceId: ws.id,
    role: 'admin',
    acceptedAt: new Date(),
  });
  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning()
  )[0];
});

describe('processEvents', () => {
  it('creates a conversation and messages', async () => {
    const results = await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'c1', text: 'hello' },
      { type: 'message_out', conversation_id: 'c1', text: 'hi there' },
    ]);
    expect(results[0].conversation_state).toBe('active');
    expect(results[0].paused).toBe(false);

    const msgs = await db.select().from(messages).where(eq(messages.conversationId, results[0] ? (await db.select().from(conversations))[0].id : ''));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].direction).toBe('in');
    expect(msgs[1].direction).toBe('out');
  });

  it('handoff_request escalates to needs_human with an alert', async () => {
    const results = await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c2', reason: 'stuck' },
    ]);
    expect(results[0].conversation_state).toBe('needs_human');
    expect(results[0].alert_ids).toHaveLength(1);
  });

  it('handoff_request replies to the customer every time until takeover', async () => {
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c5', reason: 'stuck' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c5'));
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    const notice = msgs.find((m) => m.text?.includes('human teammate'));
    expect(notice?.direction).toBe('out');

    // second handoff while already needs_human → customer still gets a reply
    // (repeat wording), but the alert stays deduped
    const again = await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c5', reason: 'stuck again' },
    ]);
    expect(again[0].alert_ids).toHaveLength(0);
    const msgs2 = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs2.filter((m) => m.text?.includes('human teammate'))).toHaveLength(2);
    expect(msgs2.some((m) => m.text?.includes('still on the way'))).toBe(true);
    const openAlerts = await db
      .select()
      .from(alerts)
      .where(eq(alerts.conversationId, conv.id));
    expect(openAlerts).toHaveLength(1);

    // once a human takes over, handoff requests no longer reply
    await takeover(db, agent.workspaceId, conv.id, admin);
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c5', reason: 'post-takeover' },
    ]);
    const msgs3 = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs3.filter((m) => m.text?.includes('human teammate'))).toHaveLength(2);
  });

  it('handoff_cancelled drops needs_human back to active and resolves open alerts', async () => {
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'cc1', reason: 'stuck' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'cc1'));
    expect(conv.state).toBe('needs_human');

    const results = await processEvents(db, agent, [
      { type: 'handoff_cancelled', conversation_id: 'cc1', reason: 'customer said no thanks' },
    ]);
    expect(results[0].conversation_state).toBe('active');
    const open = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.conversationId, conv.id), eq(alerts.status, 'open')));
    expect(open).toHaveLength(0);
  });

  it('handoff_cancelled never releases a human takeover', async () => {
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'cc2', reason: 'stuck' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'cc2'));
    await takeover(db, agent.workspaceId, conv.id, admin);

    const results = await processEvents(db, agent, [
      { type: 'handoff_cancelled', conversation_id: 'cc2', reason: 'customer said no thanks' },
    ]);
    expect(results[0].conversation_state).toBe('human');
  });

  it('re-alerts on a repeat handoff once the open alert is 5+ min old', async () => {
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c6', reason: 'stuck' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c6'));

    // repeat inside the window → deduped: alert keeps its original timestamp
    const [alert] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'help_request')));
    const original = alert.createdAt;
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c6', reason: 'still stuck' },
    ]);
    const [stillDeduped] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(stillDeduped.createdAt.getTime()).toBe(original.getTime());

    // age the open alert past the re-alert threshold
    const stale = new Date(Date.now() - 6 * 60_000);
    await db.update(alerts).set({ createdAt: stale }).where(eq(alerts.id, alert.id));

    // repeat after the window → fresh channel post path: the alert's age is
    // bumped so subsequent repeats re-alert at most once per window
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c6', reason: 'stuck, ignored' },
    ]);
    const [bumped] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(bumped.createdAt.getTime()).toBeGreaterThan(stale.getTime() + 60_000);
    expect(bumped.detail).toContain('ignored');
    const all = await db
      .select()
      .from(alerts)
      .where(eq(alerts.conversationId, conv.id));
    expect(all).toHaveLength(1);
  });

  it('handoff notice respects config override and opt-out', async () => {
    const custom = await db
      .update(agents)
      .set({ config: { handoff_message: 'A person will join shortly.' } })
      .where(eq(agents.id, agent.id))
      .returning();
    await processEvents(db, custom[0], [
      { type: 'handoff_request', conversation_id: 'c6', reason: 'x' },
    ]);
    const [conv6] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c6'));
    const msgs6 = await db.select().from(messages).where(eq(messages.conversationId, conv6.id));
    expect(msgs6.some((m) => m.text === 'A person will join shortly.')).toBe(true);

    const off = await db
      .update(agents)
      .set({ config: { handoff_message: '' } })
      .where(eq(agents.id, agent.id))
      .returning();
    await processEvents(db, off[0], [
      { type: 'handoff_request', conversation_id: 'c7', reason: 'x' },
    ]);
    const [conv7] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c7'));
    const msgs7 = await db.select().from(messages).where(eq(messages.conversationId, conv7.id));
    // internal note still stored, but no user-facing notice (via: handoff)
    expect(msgs7.some((m) => (m.payload as { via?: string })?.via === 'handoff')).toBe(false);

    // restore default for other tests
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
  });

  it('merges event.user into the stored profile instead of replacing it', async () => {
    await processEvents(db, agent, [
      {
        type: 'message_in',
        conversation_id: 'c8',
        text: 'hi',
        user: { id: 'u1', name: 'Jane', email: 'jane@x.com', channel: 'instagram' },
      },
    ]);
    // sparse update — only carries name; email/channel must survive
    await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'c8', text: 'again', user: { id: 'u1', name: 'Janet' } },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c8'));
    const p = conv.userProfile as Record<string, unknown>;
    expect(p.name).toBe('Janet');
    expect(p.email).toBe('jane@x.com');
    expect(p.channel).toBe('instagram');
  });

  it('fires keyword rules on inbound text', async () => {
    await db.insert(alertRules).values({
      agentId: agent.id,
      kind: 'keyword',
      config: { enabled: true, keywords: ['lawyer'] },
    });
    const results = await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'c3', text: 'I am calling my lawyer' },
    ]);
    expect(results[0].alert_ids).toHaveLength(1);
  });
});

describe('takeover lifecycle', () => {
  it('takeover → reply → resume transitions state and stores human message', async () => {
    const [r] = await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c4' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c4'));
    void r;

    const taken = await takeover(db, agent.workspaceId, conv.id, admin);
    expect(taken.state).toBe('human');

    // agent sees paused=true on next ingest
    const results = await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'c4', text: 'anyone there?' },
    ]);
    expect(results[0].paused).toBe(true);

    const { message: msg } = await humanReply(db, agent.workspaceId, conv.id, admin, 'I am here');
    expect(msg.direction).toBe('human');

    const resumed = await resume(db, agent.workspaceId, conv.id, admin);
    expect(resumed.state).toBe('active');
  });

  it('save_user_profile tool stores customer-supplied details', async () => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c8'));
    const ctx = { db, convId: conv.id, workspaceId: agent.workspaceId };
    expect(await saveUserProfile(ctx, { email: 'not-an-email' })).toContain('error');
    expect(await saveUserProfile(ctx, {})).toContain('error');
    expect(await saveUserProfile(ctx, { email: 'real@x.com', name: 'Jane R' })).toBe(
      'saved: name, email',
    );
    const [updated] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    const p = updated.userProfile as Record<string, unknown>;
    expect(p.email).toBe('real@x.com');
    expect(p.name).toBe('Jane R');
    expect(p.channel).toBe('instagram'); // earlier fields preserved
  });

  it('rejects reply without takeover', async () => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c1'));
    await expect(humanReply(db, agent.workspaceId, conv.id, admin, 'hi')).rejects.toThrow(
      'take over',
    );
  });
});

describe('hard cap', () => {
  it('drops inbound messages without storing once the free-plan cap is hit', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'capped' })
      .returning();
    // fill the period to the free-plan limit
    const [ws] = await db.select().from(workspaces);
    const included = 250;
    const already = await messagesInPeriod(db, ws.id);
    await db.insert(messages).values(
      Array.from({ length: included - already }, () => ({
        conversationId: conv.id,
        direction: 'in' as const,
        text: 'filler',
      })),
    );
    invalidateCapCache(ws.id); // earlier tests cached this workspace's uncapped status

    const results = await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'capped', text: 'should not store' },
    ]);
    expect(results).toHaveLength(0);
    const stored = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.text, 'should not store')));
    expect(stored).toHaveLength(0);

    // agent-side events still record (audit trail)
    const out = await processEvents(db, agent, [
      { type: 'failure', conversation_id: 'capped', text: 'still stored' },
    ]);
    expect(out).toHaveLength(1);
    const note = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.text, 'still stored')));
    expect(note).toHaveLength(1);
  });
});
