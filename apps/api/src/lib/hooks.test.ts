import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, hookSubscriptions, webhookDeliveries, workspaces } from '../db/schema.js';
import { generateApiKey } from './crypto.js';
import { emitHookEvent } from './hooks.js';
import { sweepHostedStalls, sweepWebhookRetries } from './webhooks.js';
import { handleChannelMessage } from '../services/channelIngress.js';

let db: Db;
let agentId: string; // hosted — hook pushes must still deliver as plain HTTP
let wsId: string;

const fetchMock = vi.fn();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'Bot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      hosted: true,
    })
    .returning();
  agentId = agent.id;
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{"status":"success"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await db.delete(hookSubscriptions);
  await db.delete(webhookDeliveries);
});

async function makeConv() {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, externalId: `webchat:test:${crypto.randomUUID()}` })
    .returning();
  return conv;
}

async function deliveries() {
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.agentId, agentId));
}

describe('emitHookEvent', () => {
  it('enqueues one durable delivery per matching subscription and pushes unsigned', async () => {
    await db.insert(hookSubscriptions).values([
      { agentId, event: 'new_conversation', targetUrl: 'https://hooks.example.com/a' },
      { agentId, event: 'new_conversation', targetUrl: 'https://hooks.example.com/b' },
      { agentId, event: 'conversation_resolved', targetUrl: 'https://hooks.example.com/other' },
    ]);
    const conv = await makeConv();

    await emitHookEvent(db, agentId, 'new_conversation', conv);
    // the push attempt is voided inside deliverHookPush — let it settle
    await vi.waitFor(async () => {
      const rows = await deliveries();
      expect(rows.filter((r) => r.status === 'delivered')).toHaveLength(2);
    });

    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.type).toBe('hook:new_conversation');
      expect(r.status).toBe('delivered');
      expect(r.attempts).toBe(1);
    }
    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(['https://hooks.example.com/a', 'https://hooks.example.com/b']);
    const req = fetchMock.mock.calls[0][1];
    expect(req.headers['x-janis-signature']).toBeUndefined();
    const body = JSON.parse(req.body);
    expect(body.id).toBe(conv.id);
    expect(body.external_id).toBe(conv.externalId);
  });

  it('leaves a pending retryable row when the catch URL errors, then retries', async () => {
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    await db
      .insert(hookSubscriptions)
      .values({ agentId, event: 'new_conversation', targetUrl: 'https://hooks.example.com/dead' });
    const conv = await makeConv();

    await emitHookEvent(db, agentId, 'new_conversation', conv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(new Response('gone', { status: 500 }));
    await vi.waitFor(async () => {
      const [r] = await deliveries();
      expect(r?.attempts).toBe(1);
    });
    const [row] = await deliveries();
    expect(row.status).toBe('pending');
    expect(row.lastError).toBe('HTTP 500');
    expect(row.nextAttemptAt).not.toBeNull();

    // first retry fires on the in-process 1s timer
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"status":"success"}', { status: 200 })),
    );
    await vi.waitFor(
      async () => {
        const [r] = await deliveries();
        expect(r.status).toBe('delivered');
      },
      { timeout: 5_000 },
    );
    const [done] = await deliveries();
    expect(done.attempts).toBe(2);
  });
});

describe('channel-ingress creates', () => {
  // Regression: handleChannelMessage inserts the conversation row itself, so
  // processEvents' isNew emit never fires for channel conversations —
  // new_conversation hooks must emit at the create site instead.
  it('emits new_conversation when ingress creates the conversation', async () => {
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'PG1', access_token: 'tok' },
      })
      .returning();
    await db.insert(hookSubscriptions).values({
      agentId,
      event: 'new_conversation',
      targetUrl: 'https://hooks.example.com/ingress',
    });

    await handleChannelMessage(db, ch, {
      objectId: 'PG1',
      senderId: 'PSID-HOOK',
      text: 'hi there',
      messageId: `mid.${crypto.randomUUID()}`,
    });

    await vi.waitFor(async () => {
      const rows = await deliveries();
      expect(
        rows.some((r) => r.type === 'hook:new_conversation' && r.status === 'delivered'),
      ).toBe(true);
    });
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://hooks.example.com/ingress');
    // the push went out after the inbound message landed — the payload
    // carries the first message's preview, not the null creation snapshot
    const hookCall = fetchMock.mock.calls.find((c) => c[0] === 'https://hooks.example.com/ingress');
    const body = JSON.parse(hookCall![1].body as string);
    expect(body.last_message_preview).toBe('hi there');
    expect(body.last_message_at).toBeTruthy();
  });
});

describe('sweeps', () => {
  it('sweepWebhookRetries reclaims a wedged hook push on a hosted agent', async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"success"}', { status: 200 }));
    const old = new Date(Date.now() - 60_000);
    const [d] = await db
      .insert(webhookDeliveries)
      .values({
        agentId,
        type: 'hook:new_conversation',
        targetUrl: 'https://hooks.example.com/wedged',
        payload: { id: 'conv-1' },
        status: 'pending',
        createdAt: old,
      })
      .returning();

    await sweepWebhookRetries(db);
    await vi.waitFor(async () => {
      const [r] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, d.id));
      expect(r.status).toBe('delivered');
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.example.com/wedged');
  });

  it('sweepWebhookRetries still skips hosted agent-run deliveries', async () => {
    const old = new Date(Date.now() - 60_000);
    const [d] = await db
      .insert(webhookDeliveries)
      .values({
        agentId, // hosted, no target_url → an in-process agent run, not a push
        type: 'message.user',
        payload: { type: 'message.user' },
        status: 'pending',
        createdAt: old,
      })
      .returning();

    await sweepWebhookRetries(db);
    const [r] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, d.id));
    expect(r.status).toBe('pending');
  });

  it('sweepHostedStalls leaves hook pushes to the retry sweeper', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const [d] = await db
      .insert(webhookDeliveries)
      .values({
        agentId,
        type: 'hook:conversation_resolved',
        targetUrl: 'https://hooks.example.com/stall',
        payload: { id: 'conv-2' },
        status: 'pending',
        createdAt: old,
      })
      .returning();

    await sweepHostedStalls(db);
    const [r] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, d.id));
    expect(r.status).toBe('pending'); // untouched — not marked 'stalled non-message'
  });
});
