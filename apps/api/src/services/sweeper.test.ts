import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, users, workspaces } from '../db/schema.js';
import { generateApiKey, hashPassword } from '../lib/crypto.js';
import { processEvents } from './ingest.js';
import { takeover, humanReply, agentSend } from './takeover.js';
import { sweepAutoResume } from './sweeper.js';

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
});
