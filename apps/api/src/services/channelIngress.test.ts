import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channelBindings,
  channels,
  conversations,
  messages,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { adoptVisitorConversation, handleChannelMessage } from './channelIngress.js';
import { refreshConversationSummary, runHostedEvent } from '../lib/hostedAgent.js';
import { systemPrompt } from '../lib/hostedAgent.js';
import { enrichHandoff } from '../lib/handoff.js';
import { agentWidgets, alerts } from '../db/schema.js';

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

    // postback: true — a Get Started tap still opens with the greeting
    const msg = {
      objectId: 'PG1',
      senderId: 'PSID1',
      text: 'Get Started',
      messageId: 'mid.dup',
      postback: true,
    };
    await handleChannelMessage(db, channel, msg);
    await handleChannelMessage(db, channel, msg); // legacy relay copy

    const [conv] = await db.select().from(conversations);
    const all = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    const inbound = all.filter((m) => m.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect((inbound[0].payload as { mid?: string }).mid).toBe('mid.dup');
    // the greeting is stored once on creation — the redelivery doesn't repeat it
    const greetings = all.filter(
      (m) => m.direction === 'out' && (m.payload as { via?: string })?.via === 'greeting',
    );
    expect(greetings).toHaveLength(1);

    // the agent was invoked exactly once
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(1);
  });

  it('skips the greeting when a typed message opens the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await handleChannelMessage(db, channel, {
      objectId: 'PG1',
      senderId: 'PSID-TYPED',
      text: 'hi',
      messageId: 'mid.typed',
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'messenger:PSID-TYPED'));
    const all = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(
      all.filter(
        (m) => m.direction === 'out' && (m.payload as { via?: string })?.via === 'greeting',
      ),
    ).toHaveLength(0);
    // the inbound still lands and the agent still fires
    expect(all.some((m) => m.direction === 'in' && m.text === 'hi')).toBe(true);
    const deliveries = (await db.select().from(webhookDeliveries)).filter(
      (d) => (d.payload as { janis_conversation_id?: string }).janis_conversation_id === conv.id,
    );
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
    // count only this conversation — other tests in this file dispatch too
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'messenger:PSID1'));
    const deliveries = (await db.select().from(webhookDeliveries)).filter(
      (d) => (d.payload as { janis_conversation_id?: string }).janis_conversation_id === conv.id,
    );
    expect(deliveries).toHaveLength(2);
  });
});

describe('orphaned conversation reattach', () => {
  it('reattaches when a conversation exists for the externalId but the binding is gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    // conversation exists (agent+externalId) but its channel_binding row is
    // missing — e.g. the channel was deleted and re-created. The insert path
    // would violate conversations_agent_external; the fix must reattach.
    const { channelBindings } = await import('../db/schema.js');
    const msg = { objectId: 'PG1', senderId: 'PSID-ORPHAN', text: 'first', messageId: 'mid.o1' };
    await handleChannelMessage(db, channel, msg);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'messenger:PSID-ORPHAN'));
    await db.delete(channelBindings).where(eq(channelBindings.conversationId, conv.id));

    // second message must not throw a duplicate-key
    await handleChannelMessage(db, channel, { ...msg, text: 'second', messageId: 'mid.o2' });
    const all = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(all.filter((m) => m.direction === 'in').map((m) => m.text)).toEqual(['first', 'second']);
  });
});

describe('archived conversations', () => {
  it('still dispatches to the agent — archive is inbox organization, not a mute', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:PSID-ARCH', state: 'archived' })
      .returning();
    await db
      .insert(channelBindings)
      .values({ channelId: channel.id, conversationId: conv.id, platformUserId: 'PSID-ARCH' });
    await handleChannelMessage(db, channel, {
      objectId: 'PG1',
      senderId: 'PSID-ARCH',
      text: 'still there?',
      messageId: 'mid.arch',
    });
    // other tests in this file dispatch too — count this conversation's
    const deliveries = (await db.select().from(webhookDeliveries)).filter(
      (d) => (d.payload as { janis_conversation_id?: string }).janis_conversation_id === conv.id,
    );
    expect(deliveries).toHaveLength(1);
    // stays archived — the visitor was answered, the thread just stays hidden
    const [fresh] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(fresh.state).toBe('archived');
  });
});

describe('internal test channels', () => {
  it('namespaces externalId so an operator test thread never collides with their visitor thread', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [ws] = await db.insert(workspaces).values({ name: 'NS' }).returning();
    const { hash, preview } = generateApiKey();
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'NsBot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [real] = await db
      .insert(channels)
      .values({ workspaceId: ws.id, agentId: a.id, kind: 'webchat', name: 'Site', credentials: {} })
      .returning();
    const [test] = await db
      .insert(channels)
      .values({ workspaceId: ws.id, agentId: a.id, kind: 'webchat', name: 'Test', credentials: { internal: true } })
      .returning();

    // Same signed-in operator, same agent, two channels — before namespacing
    // both resolved to `webchat:u:<id>` and the second insert died on
    // conversations_agent_external (surfaced as "Not delivered" in the rail).
    const user = { id: 'user-ns-1', name: 'Op', verified: true, via: 'session' as const };
    await handleChannelMessage(db, real, { objectId: '', senderId: 'vis-ns', text: 'hi', user });
    await handleChannelMessage(db, test, { objectId: '', senderId: 'vis-ns', text: 'test ping', user });

    const convs = await db.select().from(conversations).where(eq(conversations.agentId, a.id));
    expect(convs.map((c) => c.externalId).sort()).toEqual([
      `webchat:test:${test.id}:u:user-ns-1`,
      'webchat:u:user-ns-1',
    ]);
  });
});

describe('hard cap', () => {
  it('drops capped inbound before storage, alerting once per conversation', async () => {
    // Fresh workspace so the 60s cap cache from other tests can't interfere.
    const [ws] = await db.insert(workspaces).values({ name: 'Capped' }).returning();
    const { hash, preview } = generateApiKey();
    const [cappedAgent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'CappedBot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [cappedChannel] = await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: cappedAgent.id,
        kind: 'messenger',
        name: 'CappedPage',
        credentials: { page_id: 'PGC', access_token: 'tok' },
      })
      .returning();

    // Fill the free plan (250 included messages) on an existing conversation.
    const [seedConv] = await db
      .insert(conversations)
      .values({ agentId: cappedAgent.id, externalId: 'seed' })
      .returning();
    for (let i = 0; i < 250; i++) {
      await db.insert(messages).values({
        conversationId: seedConv.id,
        direction: 'in',
        text: `seed ${i}`,
      });
    }

    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = { objectId: 'PGC', senderId: 'PSID-CAPPED', text: 'hello?' };
    await handleChannelMessage(db, cappedChannel, msg);
    await handleChannelMessage(db, cappedChannel, msg); // repeat — still silent

    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, cappedAgent.id));
    const inbound = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convs.find((c) => c.externalId === 'messenger:PSID-CAPPED')!.id));
    expect(inbound).toHaveLength(0); // nothing transcribed
    expect(fetchMock).not.toHaveBeenCalled(); // no profile fetch, no webhook

    const capAlerts = await db
      .select()
      .from(alerts)
      .where(eq(alerts.conversationId, convs.find((c) => c.externalId === 'messenger:PSID-CAPPED')!.id));
    expect(capAlerts).toHaveLength(1);
    expect(capAlerts[0].detail).toContain('Message cap reached');
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

describe('hosted handoff offers', () => {
  const offerEvent = (convId: string, externalId: string) =>
    ({
      type: 'message.user',
      conversation_id: externalId,
      janis_conversation_id: convId,
      text: 'hmm',
    }) as Parameters<typeof runHostedEvent>[2];

  it('offers once — a repeat [OFFER_HUMAN] in the same conversation is suppressed', async () => {
    // fresh Response per call — a resolvedValue singleton reads as
    // "Body has already been read" on the second LLM fetch
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(llmResponse('Want me to get a human?\n[OFFER_HUMAN]')),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { hash, preview } = generateApiKey();
    const [hosted] = await db
      .insert(agents)
      .values({
        workspaceId: agent.workspaceId,
        name: 'Hosted',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        hosted: true,
        config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: hosted.id, externalId: 'ext-offer-1' })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'hmm' });

    const offers = () =>
      db
        .select()
        .from(alerts)
        .where(eq(alerts.conversationId, conv.id))
        .then((rows) => rows.filter((a) => a.type === 'handoff_offer'));
    // skip internal notes (the offer alert line is also direction 'out')
    const lastOut = () =>
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .then((rows) =>
          rows
            .filter(
              (m) =>
                m.direction === 'out' &&
                !(m.flags as { handoff_offer?: boolean } | null)?.handoff_offer,
            )
            .at(-1),
        );

    // first offer — alert + the get-a-human buttons
    await runHostedEvent(db, hosted, offerEvent(conv.id, 'ext-offer-1'));
    expect(await offers()).toHaveLength(1);
    expect(
      ((await lastOut())?.payload as { quick_replies?: unknown[] })?.quick_replies,
    ).toEqual(['Yes, get a human', 'No thanks']);

    // decline → the offer resolves; model offers AGAIN on the next turn
    await db
      .update(alerts)
      .set({ status: 'resolved' })
      .where(eq(alerts.conversationId, conv.id));
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'still nope' });
    await runHostedEvent(db, hosted, offerEvent(conv.id, 'ext-offer-1'));

    // reply still goes out — but no second alert, no re-rendered buttons
    expect(await offers()).toHaveLength(1);
    expect(
      ((await lastOut())?.payload as { quick_replies?: unknown[] })?.quick_replies,
    ).toBeUndefined();
  });

  it('a widget-only reply delivers the widget instead of escalating', async () => {
    // Regression: "show me your plans" made the concierge emit a bare WIDGET
    // line — extraction left empty text and the reply path read it as
    // "no LLM configured or empty reply" → spurious handoff to a human.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          llmResponse('WIDGET: {"type":"options","title":"Pick a plan","items":[{"label":"Starter"},{"label":"Pro"}]}'),
        ),
      ),
    );
    const { hash, preview } = generateApiKey();
    const [hosted] = await db
      .insert(agents)
      .values({
        workspaceId: agent.workspaceId,
        name: 'WidgetBot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        hosted: true,
        config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: hosted.id, externalId: 'ext-widget-only' })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'show me your plans' });

    await runHostedEvent(db, hosted, {
      type: 'message.user',
      conversation_id: 'ext-widget-only',
      janis_conversation_id: conv.id,
      text: 'show me your plans',
    } as Parameters<typeof runHostedEvent>[2]);

    const out = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .then((rows) => rows.filter((m) => m.direction === 'out'));
    const widgetMsg = out.find(
      (m) => ((m.payload as { widgets?: unknown[] })?.widgets?.length ?? 0) > 0,
    );
    expect(widgetMsg?.text).toBe('Here you go:');
    expect(
      (widgetMsg?.payload as { widgets?: { type: string }[] }).widgets[0].type,
    ).toBe('options');
    // no escalation was raised — the widget WAS the answer
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).not.toBe('needs_human');
  });

  it('an unbacked action claim regenerates instead of shipping the lie', async () => {
    // Prod incident: a "Choose Free" card tap produced "I've set your plan
    // to Free" with zero tool calls — the claim guard must catch it.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          llmResponse("Done — I've set your plan to Free. It will take effect on your next billing cycle."),
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          llmResponse("I can't change plans from this chat — you can switch under Settings → Billing, or I can flag this for the team."),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { hash, preview } = generateApiKey();
    const [hosted] = await db
      .insert(agents)
      .values({
        workspaceId: agent.workspaceId,
        name: 'ClaimBot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        hosted: true,
        config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: hosted.id, externalId: 'ext-claim-1' })
      .returning();
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'Choose Free',
      payload: { tap: true, tap_of: 'Free' },
    });

    await runHostedEvent(db, hosted, {
      type: 'message.user',
      conversation_id: 'ext-claim-1',
      janis_conversation_id: conv.id,
      text: 'Choose Free',
    } as Parameters<typeof runHostedEvent>[2]);

    // the claim draft triggered a second completion
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const out = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .then((rows) => rows.filter((m) => m.direction === 'out').at(-1));
    expect(out?.text).toContain("can't change plans");
    expect(out?.text).not.toContain('set your plan');
  });

  it('a WIDGET_REF line resolves to the saved component verbatim', async () => {
    // Predictability: the model picks the moment, the saved spec is the
    // content — "show me your plans" renders the same carousel every time.
    const plansSpec = {
      type: 'cards' as const,
      items: [
        { title: 'Free', price: '$0/mo', select_label: 'Choose Free' },
        { title: 'Pro', price: '$99/mo', select_label: 'Choose Pro' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(llmResponse('Here are our plans!\nWIDGET_REF: Pricing Table')),
      ),
    );
    const { hash, preview } = generateApiKey();
    const [hosted] = await db
      .insert(agents)
      .values({
        workspaceId: agent.workspaceId,
        name: 'RefBot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        hosted: true,
        config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
      })
      .returning();
    await db.insert(agentWidgets).values({
      agentId: hosted.id,
      name: 'pricing-table',
      spec: plansSpec,
    });
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: hosted.id, externalId: 'ext-widget-ref' })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'show me your plans' });

    await runHostedEvent(db, hosted, {
      type: 'message.user',
      conversation_id: 'ext-widget-ref',
      janis_conversation_id: conv.id,
      text: 'show me your plans',
    } as Parameters<typeof runHostedEvent>[2]);

    const out = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .then((rows) => rows.filter((m) => m.direction === 'out'));
    const widgetMsg = out.find(
      (m) => ((m.payload as { widgets?: unknown[] })?.widgets?.length ?? 0) > 0,
    );
    expect(widgetMsg?.text).toBe('Here are our plans!');
    expect(
      (widgetMsg?.payload as { widgets?: unknown[] }).widgets[0],
    ).toMatchObject(plansSpec);
  });
});

describe('cross-channel externalId collisions', () => {
  it('a legacy internal test thread does not shadow a real channel — it gets re-keyed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [internalCh] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Test — Bot',
        credentials: { internal: true },
      })
      .returning();
    const [realCh] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble',
        credentials: {},
      })
      .returning();
    // Pre-namespacing test thread: bound to the internal channel but
    // carrying the plain kind:participant externalId.
    const user = { id: 'u-real-1', verified: true, via: 'session' as const };
    const [legacy] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:u:u-real-1', userProfile: {} })
      .returning();
    await db.insert(channelBindings).values({
      channelId: internalCh.id,
      conversationId: legacy.id,
      platformUserId: 'u:u-real-1',
    });

    await handleChannelMessage(db, realCh, {
      objectId: '',
      senderId: 'previewvisitor1',
      text: 'hi',
      user,
    });

    // The legacy thread was re-keyed to its test-scoped externalId…
    const [rekeyed] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, legacy.id));
    expect(rekeyed.externalId).toBe(`webchat:test:${internalCh.id}:u:u-real-1`);

    // …and the real channel got its own conversation + binding, so its
    // poll sees the echo instead of reporting a false "not delivered".
    const [fresh] = await db
      .select({ binding: channelBindings, conversation: conversations })
      .from(channelBindings)
      .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
      .where(eq(channelBindings.channelId, realCh.id));
    expect(fresh.conversation.externalId).toBe('webchat:u:u-real-1');
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, fresh.conversation.id));
    expect(stored.some((m) => m.direction === 'in' && m.text === 'hi')).toBe(true);
  });

  it('a u: thread bound to a sibling channel stays unified — writes land in the shared conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [chA] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble A',
        credentials: {},
      })
      .returning();
    const [chB] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble B',
        credentials: {},
      })
      .returning();
    const [convA] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:u:u-live-1', userProfile: {} })
      .returning();
    await db.insert(channelBindings).values({
      channelId: chA.id,
      conversationId: convA.id,
      platformUserId: 'u:u-live-1',
    });

    await handleChannelMessage(db, chB, {
      objectId: '',
      senderId: 'visitor2',
      text: 'hello from B',
      user: { id: 'u-live-1', verified: true, via: 'session' as const },
    });

    // u: participants share one thread per agent+kind across surfaces — the
    // write lands in A's conversation; B's poll resolves it via externalId.
    const inA = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convA.id));
    expect(inA.some((m) => m.text === 'hello from B')).toBe(true);
  });

  it('gives an anonymous visitor their own thread when their id is bound to a sibling channel', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    const [chA] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble A',
        credentials: {},
      })
      .returning();
    const [chB] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble B',
        credentials: {},
      })
      .returning();
    const [convA] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:vis_same', userProfile: {} })
      .returning();
    await db.insert(channelBindings).values({
      channelId: chA.id,
      conversationId: convA.id,
      platformUserId: 'vis_same',
    });

    await handleChannelMessage(db, chB, {
      objectId: '',
      senderId: 'vis_same',
      text: 'hello from B',
    });

    // Channel B must not write into A's thread — it gets its own conv under
    // a channel-scoped externalId, with a binding its poll can find.
    const inA = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convA.id));
    expect(inA.some((m) => m.text === 'hello from B')).toBe(false);
    const [bBinding] = await db
      .select({ conversation: conversations })
      .from(channelBindings)
      .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
      .where(eq(channelBindings.channelId, chB.id));
    expect(bBinding.conversation.externalId).toBe(`webchat:vis_same#ch:${chB.id}`);
    const inB = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, bBinding.conversation.id));
    expect(inB.some((m) => m.text === 'hello from B')).toBe(true);
  });

  it('adopts a visitor thread into the u: conversation bound to a sibling channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const [agent] = await db.select().from(agents).limit(1);
    const [chA] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble A',
        credentials: {},
      })
      .returning();
    const [chB] = await db
      .insert(channels)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        kind: 'webchat',
        name: 'Bubble B',
        credentials: {},
      })
      .returning();
    // The user's shared thread lives on channel A; their anonymous browser
    // thread lives on B. Signing in on B must fold the visitor conv into
    // the shared one — re-keying would violate the externalId constraint.
    const [uConv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:u:u-adopt-1', userProfile: {} })
      .returning();
    await db.insert(channelBindings).values({
      channelId: chA.id,
      conversationId: uConv.id,
      platformUserId: 'u:u-adopt-1',
    });
    const [vConv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:vis_adopt', userProfile: {} })
      .returning();
    await db.insert(channelBindings).values({
      channelId: chB.id,
      conversationId: vConv.id,
      platformUserId: 'vis_adopt',
    });
    await db.insert(messages).values({
      conversationId: vConv.id,
      direction: 'in',
      text: 'anon question on B',
    });

    await adoptVisitorConversation(db, chB, 'u:u-adopt-1', 'vis_adopt');

    const folded = await db.select().from(messages).where(eq(messages.conversationId, uConv.id));
    expect(folded.some((m) => m.text === 'anon question on B')).toBe(true);
    const gone = await db.select().from(conversations).where(eq(conversations.id, vConv.id));
    expect(gone).toHaveLength(0);
  });
});
