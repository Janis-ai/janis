import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alerts, conversations, users, workspaces } from '../db/schema.js';
import { generateApiKey, hashPassword } from '../lib/crypto.js';
import { processEvents } from './ingest.js';
import { takeover, humanReply, agentSend } from './takeover.js';
import { sweepAutoResume, sweepSla } from './sweeper.js';

let db: Db;
let agent: typeof agents.$inferSelect;
let admin: typeof users.$inferSelect;

const MIN = 60_000;

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
      .values({
        workspaceId: ws.id,
        name: 'Bot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        autoResumeMinutes: 30,
      })
      .returning()
  )[0];
});

async function makeConversation(externalId: string) {
  await processEvents(db, agent, [
    { type: 'message_in', conversation_id: externalId, text: 'hi' },
  ]);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, externalId));
  return conv;
}

async function backdateHumanSince(id: string, msAgo: number) {
  await db
    .update(conversations)
    .set({ humanSince: new Date(Date.now() - msAgo) })
    .where(eq(conversations.id, id));
}

describe('sweepAutoResume', () => {
  it('resumes a human takeover idle past auto_resume_minutes', async () => {
    const conv = await makeConversation('ar-idle');
    await takeover(db, admin.workspaceId, conv.id, admin);
    await backdateHumanSince(conv.id, 31 * MIN);

    expect(await sweepAutoResume(db)).toBe(1);

    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active');
    expect(after.humanSince).toBeNull();
    expect(after.assigneeId).toBeNull();
  });

  it('keeps a takeover under the threshold', async () => {
    const conv = await makeConversation('ar-fresh');
    await takeover(db, admin.workspaceId, conv.id, admin);
    await backdateHumanSince(conv.id, 5 * MIN);

    expect(await sweepAutoResume(db)).toBe(0);

    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('human');
  });

  it('human reply resets the auto-resume clock', async () => {
    const conv = await makeConversation('ar-reply');
    await takeover(db, admin.workspaceId, conv.id, admin);
    await backdateHumanSince(conv.id, 60 * MIN); // would resume if clock were stale

    await humanReply(db, admin.workspaceId, conv.id, admin, 'still here');

    expect(await sweepAutoResume(db)).toBe(0);
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('human');
    expect(after.humanSince!.getTime()).toBeGreaterThan(Date.now() - MIN);
  });

  it('send-via-agent resets the clock while in human mode', async () => {
    const conv = await makeConversation('ar-agentsend');
    await takeover(db, admin.workspaceId, conv.id, admin);
    await backdateHumanSince(conv.id, 60 * MIN);

    await agentSend(db, admin.workspaceId, conv.id, admin, 'agent says hi');

    expect(await sweepAutoResume(db)).toBe(0);
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('human');
  });

  it('does not touch active or needs_human conversations', async () => {
    const conv = await makeConversation('ar-active');
    await db
      .update(conversations)
      .set({ state: 'needs_human' })
      .where(eq(conversations.id, conv.id));

    expect(await sweepAutoResume(db)).toBe(0);
  });

  it('warns inside the lead window, once, then resumes on expiry', async () => {
    const conv = await makeConversation('ar-warn');
    await takeover(db, admin.workspaceId, conv.id, admin);
    // 30m window, warn lead = 60s → warned once humanSince is older than 29m
    await backdateHumanSince(conv.id, 29.5 * MIN);

    expect(await sweepAutoResume(db)).toBe(0); // warned, not resumed
    const [warned] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(warned.state).toBe('human');
    expect(warned.resumeWarnedAt).not.toBeNull();

    // second sweep in the same window does not re-stamp the warning
    const stamp = warned.resumeWarnedAt!.getTime();
    await sweepAutoResume(db);
    const [still] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(still.resumeWarnedAt!.getTime()).toBe(stamp);

    // past expiry → resumed, warning cleared
    await backdateHumanSince(conv.id, 31 * MIN);
    expect(await sweepAutoResume(db)).toBe(1);
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active');
    expect(after.resumeWarnedAt).toBeNull();
  });

  it('re-arms the warning after new human activity extends the window', async () => {
    const conv = await makeConversation('ar-rearm');
    await takeover(db, admin.workspaceId, conv.id, admin);
    await backdateHumanSince(conv.id, 29.5 * MIN);
    await sweepAutoResume(db);
    const [first] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(first.resumeWarnedAt).not.toBeNull();

    // operator replies → clock resets; simulate the *new* window reaching its
    // warn point: resumeWarnedAt must be older than humanSince (warning issued
    // before the last human activity = stale)
    await humanReply(db, admin.workspaceId, conv.id, admin, 'one more thing');
    await db
      .update(conversations)
      .set({
        humanSince: new Date(Date.now() - 29.5 * MIN),
        resumeWarnedAt: new Date(Date.now() - 29.6 * MIN),
      })
      .where(eq(conversations.id, conv.id));
    await sweepAutoResume(db);
    const [second] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(second.state).toBe('human');
    expect(second.resumeWarnedAt!.getTime()).toBeGreaterThan(
      first.resumeWarnedAt!.getTime(),
    );
  });
});

describe('sweepSla', () => {
  it('re-alerts an unclaimed handoff past the SLA, deduped per window', async () => {
    const slaAgent = (
      await db
        .insert(agents)
        .values({
          workspaceId: admin.workspaceId,
          name: 'SLA Bot',
          apiKeyHash: generateApiKey().hash,
          apiKeyPreview: 'sla',
          config: { sla_minutes: 10 },
        })
        .returning()
    )[0];
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: slaAgent.id, externalId: 'sla-conv', state: 'needs_human' })
      .returning();
    await db.insert(alerts).values({
      conversationId: conv.id,
      type: 'help_request',
      detail: 'needs help',
      createdAt: new Date(Date.now() - 20 * MIN), // handoff 20m ago, SLA 10m
    });

    expect(await sweepSla(db)).toBe(1); // breaches → one sla alert
    expect(await sweepSla(db)).toBe(0); // deduped inside the same window

    const slaAlerts = await db.select().from(alerts).where(eq(alerts.type, 'sla'));
    expect(slaAlerts).toHaveLength(1);
    expect(slaAlerts[0].detail).toContain('SLA 10m');
  });

  it('ignores conversations still inside the SLA window', async () => {
    const slaAgent = (
      await db.select().from(agents).where(eq(agents.name, 'SLA Bot'))
    )[0];
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: slaAgent.id, externalId: 'sla-fresh', state: 'needs_human' })
      .returning();
    await db.insert(alerts).values({
      conversationId: conv.id,
      type: 'help_request',
      createdAt: new Date(), // just now — inside the 10m window
    });
    expect(await sweepSla(db)).toBe(0);
  });
});

describe('auto_assign', () => {
  it('assigns a fresh handoff to the least-loaded teammate', async () => {
    const assignAgent = (
      await db
        .insert(agents)
        .values({
          workspaceId: admin.workspaceId,
          name: 'Assign Bot',
          apiKeyHash: generateApiKey().hash,
          apiKeyPreview: 'asg',
          config: { auto_assign: true },
        })
        .returning()
    )[0];
    await processEvents(db, assignAgent, [
      { type: 'handoff_request', conversation_id: 'assign-conv', reason: 'stuck' },
    ]);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'assign-conv'));
    expect(conv.state).toBe('needs_human');
    expect(conv.assigneeId).toBe(admin.id); // only member → gets it
  });
});
