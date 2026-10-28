import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
import { resumeAfterDecision, runHostedEvent } from './hostedAgent.js';

let db: Db;
let wsId: string;

const fetchMock = vi.fn();
const llmCfg = {
  llm: { api_key: 'k', base_url: 'https://llm.example', model: 'm' },
};

const llmReply = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );

const llmRequests = () =>
  fetchMock.mock.calls
    .map((c) => JSON.parse((c[1] as { body: string }).body as string) as {
      messages?: { role: string; content: unknown }[];
    })
    .filter((b) => Array.isArray(b.messages));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  wsId = ws.id;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(llmReply('Done — order #1005 is cancelled.'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const makeAgent = async () =>
  (
    await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'T', hosted: true, config: llmCfg })
      .returning()
  )[0];

// The post-approval transcript: the customer's ask was answered by the
// agent's own "sent for approval" line, then the decision landed as an
// internal action_result note.
const makeConv = async (agentId: string, state = 'active') => {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, externalId: 'webchat:u1', state })
    .returning();
  const base = Date.now() - 60_000;
  const seed = [
    { direction: 'in', text: 'please cancel order 1005' },
    {
      direction: 'human',
      text: 'approval requested — shopify_cancel_order',
      flags: { action_request: true },
      payload: { internal: true, event: 'approval requested' },
    },
    {
      direction: 'out',
      text: "I've sent this to a teammate for approval — hang tight.",
    },
    {
      direction: 'human',
      text: 'teammate approved and ran shopify_cancel_order — order #1005 cancelled',
      flags: { action_result: true },
      payload: { internal: true, event: 'action approved' },
    },
  ];
  for (const [i, m] of seed.entries()) {
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: m.direction,
      text: m.text,
      flags: m.flags ?? {},
      payload: m.payload ?? {},
      createdAt: new Date(base + i * 60_000),
    });
  }
  return conv;
};

const outMessages = async (convId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, convId))).filter(
    (m) => m.direction === 'out',
  );

describe('resumeAfterDecision', () => {
  it('runHostedEvent with the old synthetic message.user shape no-ops (the gate this bypasses)', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id);

    await runHostedEvent(db, agent, {
      type: 'message.user',
      conversation_id: conv.externalId,
      janis_conversation_id: conv.id,
      timestamp: new Date().toISOString(),
    });

    // The newest inbound is already covered by the "sent for approval" out —
    // newestInboundIsPending is false and the run exits without replying.
    expect(await outMessages(conv.id)).toHaveLength(1);
  });

  it('replies to the customer with the decision context in the prompt', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id);

    await resumeAfterDecision(db, agent, conv.id);

    const outs = await outMessages(conv.id);
    expect(outs).toHaveLength(2);
    expect(outs[1].text).toBe('Done — order #1005 is cancelled.');

    const req = llmRequests().find((r) =>
      r.messages!.some(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('Resuming after a teammate decision'),
      ),
    );
    expect(req).toBeDefined();
    expect(
      req!.messages!.some(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('teammate approved and ran shopify_cancel_order'),
      ),
    ).toBe(true);
  });

  it('stays silent when a human owns the conversation', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id, 'human');

    await resumeAfterDecision(db, agent, conv.id);

    expect(await outMessages(conv.id)).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
