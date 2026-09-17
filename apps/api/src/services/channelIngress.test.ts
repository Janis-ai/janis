import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channels,
  conversations,
  messages,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { handleChannelMessage } from './channelIngress.js';
import { refreshConversationSummary } from '../lib/hostedAgent.js';
import { systemPrompt } from '../lib/hostedAgent.js';
import { enrichHandoff } from '../lib/handoff.js';
import { alerts } from '../db/schema.js';

const llm = { apiKey: 'k', baseUrl: 'https://llm.test', model: 'test-model' };
const llmResponse = (text: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200 },
  );

let db: Db;
let agent: typeof agents.$inferSelect;
let channel: typeof channels.$inferSelect;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'Bot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        webhookUrl: 'https://agent.test/hook',
      })
      .returning()
  )[0];
  channel = (
    await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: agent.id,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'PG1', access_token: 'tok' },
      })
      .returning()
  )[0];
});

afterEach(() => vi.unstubAllGlobals());

describe('handleChannelMessage dedup', () => {
  it('ignores the same platform message delivered via a second path', async () => {
    // profile fetch + webhook attempt both go through fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const msg = { objectId: 'PG1', senderId: 'PSID1', text: 'hi', messageId: 'mid.dup' };
    await handleChannelMessage(db, channel, msg);
    await handleChannelMessage(db, channel, msg); // legacy relay copy

    const [conv] = await db.select().from(conversations);
    const inbound = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(inbound).toHaveLength(1);
    expect((inbound[0].payload as { mid?: string }).mid).toBe('mid.dup');

    // the agent was invoked exactly once
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(1);
  });

  it('processes a different mid as a new message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await handleChannelMessage(db, channel, {
      objectId: 'PG1',
      senderId: 'PSID1',
      text: 'again',
      messageId: 'mid.other',
    });
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(2);
  });
});

describe('conversation memory', () => {
  const seedMessages = async (convId: string, count: number) => {
    const t = Date.now() - count * 60_000;
    for (let i = 0; i < count; i++) {
      await db.insert(messages).values({
        conversationId: convId,
        direction: i % 2 ? 'out' : 'in',
        text: `msg ${i}`,
        createdAt: new Date(t + i * 60_000),
      });
    }
  };

  it('does nothing for short conversations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(llmResponse('summary'));
    vi.stubGlobal('fetch', fetchMock);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'short-conv' })
      .returning();
    await seedMessages(conv.id, 5);
    const res = await refreshConversationSummary(db, conv, llm);
    expect(res.summary).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('summarizes messages older than the recent window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(llmResponse('Customer wanted a refund'));
    vi.stubGlobal('fetch', fetchMock);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'long-conv' })
      .returning();
    await seedMessages(conv.id, 25);

    const res = await refreshConversationSummary(db, conv, llm);
    expect(res.summary).toBe('Customer wanted a refund');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [updated] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(updated.agentSummary).toBe('Customer wanted a refund');
    expect(updated.summaryUpTo).not.toBeNull();

    // no new messages since the cursor — no extra LLM call
    const again = await refreshConversationSummary(db, updated, llm);
    expect(again.summary).toBe('Customer wanted a refund');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // the summary lands in the prompt as background
    expect(systemPrompt(agent, [], updated)).toContain('Customer wanted a refund');
  });

  it('folds only new messages on subsequent refreshes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(llmResponse('first summary'))
      .mockResolvedValueOnce(llmResponse('extended summary'));
    vi.stubGlobal('fetch', fetchMock);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'growing-conv' })
      .returning();
    await seedMessages(conv.id, 25);

    const first = await refreshConversationSummary(db, conv, llm);
    const [afterFirst] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));

    // more traffic beyond the window
    const base = afterFirst.summaryUpTo!.getTime() + 25 * 60_000;
    for (let i = 0; i < 10; i++) {
      await db.insert(messages).values({
        conversationId: conv.id,
        direction: 'in',
        text: `later ${i}`,
        createdAt: new Date(base + i * 60_000),
      });
    }
    const second = await refreshConversationSummary(db, afterFirst, llm);
    expect(second.summary).toBe('extended summary');
    expect(first.summary).toBe('first summary');

    // second call's payload includes the prior summary + only new messages
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain('first summary');
    // folds only messages between the old cursor and the new window edge:
    // msg5..msg14 — msg4 was already summarized, later* is in the window
    expect(prompt).toContain('msg 5');
    expect(prompt).not.toContain('msg 4');
    expect(prompt).not.toContain('later 0');
  });
});

describe('handoff brief', () => {
  it('summarizes the ask onto the note and the alert', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(llmResponse('Customer needs a refund for order #4213'));
    vi.stubGlobal('fetch', fetchMock);

    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'handoff-conv' })
      .returning();
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'can I get a refund?',
    });
    const [note] = await db
      .insert(messages)
      .values({
        conversationId: conv.id,
        direction: 'out',
        text: 'Handoff requested: agent signalled handoff',
        flags: { failure: false, help_requested: true, custom_alert: false },
      })
      .returning();
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'help_request', detail: 'agent signalled handoff' })
      .returning();

    const agentWithLlm = {
      ...agent,
      config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
    };
    await enrichHandoff(db, agentWithLlm, conv, note, alert.id, false, 'agent signalled handoff');

    const [updatedNote] = await db.select().from(messages).where(eq(messages.id, note.id));
    expect((updatedNote.payload as { summary?: string }).summary).toBe(
      'Customer needs a refund for order #4213',
    );
    const [updatedAlert] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(updatedAlert.detail).toBe(
      'agent signalled handoff — Customer needs a refund for order #4213',
    );
  });
});
