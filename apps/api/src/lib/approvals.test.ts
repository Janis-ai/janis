import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  conversations,
  memberships,
  messages,
  pendingActions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, hashPassword } from './crypto.js';
import { processEvents } from '../services/ingest.js';
import { decidePendingAction, requestToolApproval } from './approvals.js';
import type { ToolDef } from './toolExec.js';

let db: Db;
let agent: typeof agents.$inferSelect;
let admin: typeof users.$inferSelect;

const GATED: ToolDef = {
  name: 'refund_order',
  description: 'refund it',
  method: 'POST',
  approval: true,
  url: 'http://localhost:9/api/refund',
  params: { order_id: 'id' },
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  admin = (
    await db
      .insert(users)
      .values({ email: 'a@b.c', name: 'Op', passwordHash: await hashPassword('password123') })
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

afterEach(() => vi.unstubAllGlobals());

async function makeConv(externalId: string) {
  await processEvents(db, agent, [{ type: 'message_in', conversation_id: externalId, text: 'hi' }]);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, externalId));
  return conv;
}

describe('gated tool approvals', () => {
  it('parks the call as a pending action with a transcript card — no HTTP fired', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const conv = await makeConv('c-approval-park');
    const out = await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o1' });
    expect(out).toMatch(/pending_approval/);
    expect(fetchMock).not.toHaveBeenCalled();

    const [action] = await db.select().from(pendingActions);
    expect(action.status).toBe('pending');
    expect(action.toolName).toBe('refund_order');

    const [card] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, action.messageId!));
    expect((card.payload as { action?: { status: string } }).action?.status).toBe('pending');
  });

  it('dedupes an identical pending call', async () => {
    const conv = await makeConv('c-approval-dup');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o2' });
    const out = await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o2' });
    expect(out).toMatch(/already awaiting/);
    const rows = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));
    expect(rows).toHaveLength(1);
  });

  it('approve executes the tool and resolves the card', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"re_1"}'));
    vi.stubGlobal('fetch', fetchMock);
    const conv = await makeConv('c-approval-yes');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o3' });
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));

    const decided = await decidePendingAction(db, action.id, admin, true);
    expect(decided).not.toBeNull();
    expect(decided === 'not-pending').toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9/api/refund');

    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, action.id));
    expect(row.status).toBe('approved');
    expect(row.result).toBe('{"id":"re_1"}');
    expect(row.decidedById).toBe(admin.id);

    const [card] = await db.select().from(messages).where(eq(messages.id, action.messageId!));
    const act = (card.payload as { action: { status: string; decided_by: string } }).action;
    expect(act.status).toBe('approved');
    expect(act.decided_by).toBe('Op');

    const [note] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect((note.flags as { action_result?: boolean }).action_result).toBe(true);
  });

  it('deny does not execute and marks the action denied', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const conv = await makeConv('c-approval-no');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o4' });
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));

    const decided = await decidePendingAction(db, action.id, admin, false);
    expect(decided).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, action.id));
    expect(row.status).toBe('denied');
  });

  it('rejects a second decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-twice');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o5' });
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));
    await decidePendingAction(db, action.id, admin, false);
    expect(await decidePendingAction(db, action.id, admin, true)).toBe('not-pending');
  });
});
