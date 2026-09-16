import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { IngestEvent } from '@janis/shared';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alertRules, alerts, conversations, messages, users, workspaces } from '../db/schema.js';
import { generateApiKey, hashPassword } from '../lib/crypto.js';
import { processEvents } from './ingest.js';
import { takeover, humanReply, resume } from './takeover.js';

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
        workspaceId: ws.id,
        email: 'a@b.c',
        name: 'A',
        role: 'admin',
        passwordHash: await hashPassword('password123'),
      })
      .returning()
  )[0];
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

  it('handoff_request stores a user-facing notice, once', async () => {
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

    // second handoff while already needs_human → no duplicate notice
    await processEvents(db, agent, [
      { type: 'handoff_request', conversation_id: 'c5', reason: 'stuck again' },
    ]);
    const msgs2 = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs2.filter((m) => m.text?.includes('human teammate'))).toHaveLength(1);
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

    const taken = await takeover(db, admin.workspaceId, conv.id, admin);
    expect(taken.state).toBe('human');

    // agent sees paused=true on next ingest
    const results = await processEvents(db, agent, [
      { type: 'message_in', conversation_id: 'c4', text: 'anyone there?' },
    ]);
    expect(results[0].paused).toBe(true);

    const msg = await humanReply(db, admin.workspaceId, conv.id, admin, 'I am here');
    expect(msg.direction).toBe('human');

    const resumed = await resume(db, admin.workspaceId, conv.id, admin);
    expect(resumed.state).toBe('active');
  });

  it('rejects reply without takeover', async () => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'c1'));
    await expect(humanReply(db, admin.workspaceId, conv.id, admin, 'hi')).rejects.toThrow(
      'take over',
    );
  });
});
