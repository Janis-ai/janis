import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  alerts,
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
import { openAlertOnce } from './alerts.js';
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

  const openApprovalAlerts = (convId: string) =>
    db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.conversationId, convId),
          eq(alerts.type, 'approval_request'),
          eq(alerts.status, 'open'),
        ),
      );

  it('flags the conversation needs_human and opens an approval alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-flag');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o6' });

    const [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('needs_human');

    const open = await openApprovalAlerts(conv.id);
    expect(open).toHaveLength(1);
    expect(open[0].detail).toMatch(/refund_order/);
  });

  it('keeps a single alert across multiple pending actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-multi');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o7' });
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o8' });
    expect(await openApprovalAlerts(conv.id)).toHaveLength(1);
  });

  it('deciding the last pending action resolves the alert and unflags the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-resolve');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o9' });
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));

    await decidePendingAction(db, action.id, admin, false);

    expect(await openApprovalAlerts(conv.id)).toHaveLength(0);
    const [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('active');
  });

  it('keeps the alert and flag while another action is still pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-part');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o10' });
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o11' });
    const [first] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id))
      .limit(1);

    await decidePendingAction(db, first.id, admin, false);

    expect(await openApprovalAlerts(conv.id)).toHaveLength(1);
    const [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('needs_human');
  });

  it('stays needs_human after decide when another alert is still open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-both');
    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o12' });
    await db.insert(alerts).values({
      conversationId: conv.id,
      type: 'help_request',
      detail: 'customer asked for a human',
    });
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));

    await decidePendingAction(db, action.id, admin, false);

    expect(await openApprovalAlerts(conv.id)).toHaveLength(0);
    const [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('needs_human');
  });

  it('openAlertOnce is idempotent — a concurrent second open returns the same alert', async () => {
    const conv = await makeConv('c-alert-once');
    const first = await openAlertOnce(db, {
      conversationId: conv.id,
      type: 'keyword',
      detail: 'first',
    });
    const second = await openAlertOnce(db, {
      conversationId: conv.id,
      type: 'keyword',
      detail: 'second',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.alert?.id).toBe(first.alert.id);
    // a different type on the same conversation still opens
    const other = await openAlertOnce(db, {
      conversationId: conv.id,
      type: 'inactivity',
      detail: 'other',
    });
    expect(other.created).toBe(true);
  });

  it('does not steal a human-owned conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const conv = await makeConv('c-approval-owned');
    await db
      .update(conversations)
      .set({ state: 'human' })
      .where(eq(conversations.id, conv.id));

    await requestToolApproval(db, agent, conv.id, GATED, { order_id: 'o13' });
    let [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('human');
    expect(await openApprovalAlerts(conv.id)).toHaveLength(1);

    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, conv.id));
    await decidePendingAction(db, action.id, admin, false);
    [fresh] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('human');
  });
});
