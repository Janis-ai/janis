import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  agentTests,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import {
  checkPromptConflicts,
  escalationOf,
  replayContextFor,
  runAgentTest,
  transcriptTurns,
  type ReplayContext,
  type TestTurn,
} from './agentTests.js';

let db: Db;
let wsId: string;

const fetchMock = vi.fn();
const llmCfg = {
  llm: { api_key: 'k', base_url: 'https://llm.example', model: 'm' },
};

const llmReply = (body: object) =>
  new Response(JSON.stringify({ choices: [{ message: body }], usage: {} }), { status: 200 });

const toolCall = (id: string, name: string, args: string) => ({
  id,
  function: { name, arguments: args },
});

const makeAgent = async (config: Record<string, unknown> = llmCfg) => {
  const [a] = await db
    .insert(agents)
    .values({ workspaceId: wsId, name: 'T', hosted: true, config })
    .returning();
  return a;
};

const makeConv = async (agentId: string, userProfile?: Record<string, unknown>) => {
  const [conv] = await db
    .insert(conversations)
    .values({
      agentId,
      externalId: 'webchat:u1',
      state: 'active',
      ...(userProfile ? { userProfile } : {}),
    })
    .returning();
  return conv;
};

const ORDER_RESULT = '{"order":{"id":1005,"status":"paid","fulfillment":"shipped"}}';
const ORDER_KEY = 'get_order::{"order":"1005"}';

const replayCtx = (over: Partial<ReplayContext> = {}): ReplayContext => ({
  v: 1,
  captured_at: new Date().toISOString(),
  profile: { email: 'sam@x.com', identity_verified: true, channel: 'webchat' },
  external_id: 'webchat:u1',
  agent_summary: null,
  identity: { emails: ['sam@x.com'], ids: [], operator: false },
  calls: [{ key: ORDER_KEY, result: ORDER_RESULT, outcome: 'ran' }],
  ...over,
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  wsId = ws.id;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('replayContextFor', () => {
  it('snapshots the reply message’s stored calls + the verified identity + profile', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id, {
      email: 'sam@x.com',
      identity_verified: true,
      channel: 'webchat',
    });
    const [reply] = await db
      .insert(messages)
      .values({
        conversationId: conv.id,
        direction: 'out',
        text: 'Order 1005 has shipped.',
        payload: {
          inspector: {
            model: 'm',
            tools: [
              {
                name: 'get_order',
                key: ORDER_KEY,
                result: ORDER_RESULT,
                outcome: 'ran',
                args: { order: '1005' },
              },
              // pre-hydration / simulated entries carry no key+result — skipped
              { name: 'other_call', outcome: 'simulated' },
            ],
          },
        },
      })
      .returning();

    const rc = await replayContextFor(db, conv, wsId, reply.id);
    expect(rc.calls).toEqual([{ key: ORDER_KEY, result: ORDER_RESULT, outcome: 'ran' }]);
    expect(rc.identity.emails).toContain('sam@x.com');
    expect(rc.profile).toMatchObject({ email: 'sam@x.com' });
    expect(rc.external_id).toBe('webchat:u1');
  });
});

describe('runAgentTest hydration', () => {
  const orderTool = {
    name: 'get_order',
    description: 'look up an order',
    method: 'GET' as const,
    url: 'https://shop.example/orders',
    identity: true,
  };

  it('replays the stored result for a captured call instead of a simulated success', async () => {
    const agent = await makeAgent({ ...llmCfg, tools: [orderTool] });
    const conv = await makeConv(agent.id);
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'order status',
        turns: [{ role: 'customer', text: 'where is order 1005?' }] as never,
        expectation: 'reports the order shipped',
        sourceConversationId: conv.id,
        replayContext: replayCtx() as never,
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(llmReply({ tool_calls: [toolCall('c1', 'get_order', '{"order":"1005"}')] }))
      .mockResolvedValueOnce(llmReply({ content: 'Order 1005 is paid and has shipped.' }))
      .mockResolvedValueOnce(llmReply({ content: '{"pass":true,"reason":"states shipped"}' }));

    const r = await runAgentTest(db, agent, test);
    expect(r.passed).toBe(true);
    expect(r.tools[0]).toMatchObject({ name: 'get_order', outcome: 'ran' });

    // The model saw the captured result body, not "simulated:" boilerplate.
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toBe(ORDER_RESULT);

    // Nothing left the LLM endpoint — hydration replays, it never executes.
    expect(
      fetchMock.mock.calls.every((c) => String(c[0]).startsWith('https://llm.example')),
    ).toBe(true);
  });

  it('gates identity-bound calls on the snapshot’s verified emails, like live', async () => {
    const agent = await makeAgent({ ...llmCfg, tools: [orderTool] });
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'drifted email',
        turns: [{ role: 'customer', text: 'orders for mallory@evil.com' }] as never,
        expectation: 'refuses the unverified address',
        replayContext: replayCtx() as never,
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(
        llmReply({ tool_calls: [toolCall('c1', 'get_order', '{"email":"mallory@evil.com"}')] }),
      )
      .mockResolvedValueOnce(llmReply({ content: 'I can’t look that up — let me get a human.' }))
      .mockResolvedValueOnce(llmReply({ content: '{"pass":true,"reason":"blocked"}' }));

    const r = await runAgentTest(db, agent, test);
    expect(r.tools[0].outcome).toBe('failed');
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('identity check');
    expect(
      fetchMock.mock.calls.every((c) => String(c[0]).startsWith('https://llm.example')),
    ).toBe(true);
  });

  it('keeps simulating everything for tests saved without a snapshot', async () => {
    const agent = await makeAgent({ ...llmCfg, tools: [orderTool] });
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'bare test',
        turns: [{ role: 'customer', text: 'where is order 1005?' }] as never,
        expectation: '',
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(llmReply({ tool_calls: [toolCall('c1', 'get_order', '{"order":"1005"}')] }))
      .mockResolvedValueOnce(llmReply({ content: 'Let me check.' }));

    const r = await runAgentTest(db, agent, test);
    expect(r.tools[0].outcome).toBe('simulated');
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('simulated:');
    // no expectation → run stops before the judge call
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the live conversation for tests without a snapshot', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id, { email: 'live@x.com', channel: 'webchat' });
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'live conv fallback',
        turns: [{ role: 'customer', text: 'hi' }] as never,
        expectation: '',
        sourceConversationId: conv.id,
      })
      .returning();

    fetchMock.mockResolvedValueOnce(llmReply({ content: 'hello' }));
    const r = await runAgentTest(db, agent, test);
    expect(r.reply).toBe('hello');
    const round1 = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const sys = round1.messages.find((m: { role: string }) => m.role === 'system');
    expect(sys.content).toContain('live@x.com');
  });
});

describe('transcriptTurns', () => {
  it('drops internal audit lines — assignment/status/SLA notes never become turns', async () => {
    const agent = await makeAgent();
    const conv = await makeConv(agent.id);
    const t0 = Date.now();
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'help me', createdAt: new Date(t0) },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'Assigned to Mike (handoff_request rule)',
        payload: { internal: true },
        createdAt: new Date(t0 + 1),
      },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'SLA breach — unclaimed for 2m (SLA 1m)',
        payload: { internal: true },
        createdAt: new Date(t0 + 2),
      },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'Handoff requested: agent signalled handoff',
        flags: { help_requested: true },
        createdAt: new Date(t0 + 3),
      },
      { conversationId: conv.id, direction: 'human', text: 'hi, Mike here', createdAt: new Date(t0 + 4) },
      { conversationId: conv.id, direction: 'in', text: 'still there?', createdAt: new Date(t0 + 5) },
    ]);
    const turns = await transcriptTurns(db, conv.id);
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      'customer:help me',
      'agent:(passed to a human teammate)',
      'agent:(human operator) hi, Mike here',
      'customer:still there?',
    ]);
  });
});

describe('escalationOf', () => {
  it('reads needs_human + humanSpoke + pendingOffer from marker turns', () => {
    const esc = escalationOf([
      { role: 'customer', text: 'refund please' },
      { role: 'agent', text: '(passed to a human teammate)' },
      { role: 'agent', text: '(human operator) hi, Mike here' },
      { role: 'customer', text: 'still there?' },
    ]);
    expect(esc).toEqual({
      needsHuman: true,
      pendingOffer: false,
      offerMade: false,
      humanSpoke: true,
    });
  });

  it('marks a pending offer only when the trigger answers it', () => {
    const pending = escalationOf([
      { role: 'customer', text: 'this is broken' },
      { role: 'agent', text: '(a human teammate was offered)' },
      { role: 'customer', text: 'yes please' },
    ]);
    expect(pending).toMatchObject({ pendingOffer: true, offerMade: true, needsHuman: false });
    // an offer followed by more exchange already resolved — not pending
    const resolved = escalationOf([
      { role: 'agent', text: '(a human teammate was offered)' },
      { role: 'customer', text: 'no thanks' },
      { role: 'agent', text: 'ok, back to it' },
      { role: 'customer', text: 'where is my order' },
    ]);
    expect(resolved).toMatchObject({ pendingOffer: false, offerMade: true });
  });
});

describe('runAgentTest escalation context', () => {
  const escalatedTurns: TestTurn[] = [
    { role: 'customer', text: 'i want a refund' },
    { role: 'agent', text: '(passed to a human teammate)' },
    { role: 'agent', text: '(human operator) looking into it' },
    { role: 'customer', text: 'still there? need an update' },
  ];

  it('prompts a re-ping in an escalated thread with the already-notified line + human-operator note', async () => {
    const agent = await makeAgent();
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 're-ping',
        turns: escalatedTurns as never,
        expectation: 'acknowledges the wait without inventing an ETA',
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(
        llmReply({ content: 'A teammate has been notified and will join shortly.' }),
      )
      .mockResolvedValueOnce(llmReply({ content: 'Hi, Sarah here — picking this up now.' }))
      .mockResolvedValueOnce(llmReply({ content: '{"pass":true,"reason":"reassures"}' }));

    const r = await runAgentTest(db, agent, test);
    const sys = JSON.parse(fetchMock.mock.calls[0][1].body as string).messages.find(
      (m: { role: string }) => m.role === 'system',
    );
    expect(sys.content).toContain('already been notified');
    expect(sys.content).toContain('human operator');
    expect(r.humanReply).toBe('Hi, Sarah here — picking this up now.');
    // The judge saw the simulated teammate as context, not the reply.
    const judgeMsgs = JSON.stringify(
      JSON.parse(fetchMock.mock.calls[2][1].body as string).messages,
    );
    expect(judgeMsgs).toContain('simulated human');
    expect(r.passed).toBe(true);
  });

  it('simulates the teammate after a fresh [HANDOFF] reply', async () => {
    const agent = await makeAgent();
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'explicit ask',
        turns: [{ role: 'customer', text: 'get me a human' }] as never,
        expectation: 'hands off to a human',
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(
        llmReply({ content: 'Of course — getting a human now. [HANDOFF]' }),
      )
      .mockResolvedValueOnce(llmReply({ content: 'Hi, Mike here — I can take it from here.' }))
      .mockResolvedValueOnce(llmReply({ content: '{"pass":true,"reason":"escalated"}' }));

    const r = await runAgentTest(db, agent, test);
    expect(r.control).toBe('handoff');
    expect(r.humanReply).toBe('Hi, Mike here — I can take it from here.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not simulate a teammate when nothing escalated', async () => {
    const agent = await makeAgent();
    const [test] = await db
      .insert(agentTests)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        name: 'plain',
        turns: [{ role: 'customer', text: 'what are your hours?' }] as never,
        expectation: 'answers the hours question',
      })
      .returning();

    fetchMock
      .mockResolvedValueOnce(llmReply({ content: 'We are open 9 to 5.' }))
      .mockResolvedValueOnce(llmReply({ content: '{"pass":true,"reason":"answers"}' }));

    const r = await runAgentTest(db, agent, test);
    expect(r.humanReply).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('checkPromptConflicts', () => {
  it('sends instructions + knowledge + procedures and parses the conflict list', async () => {
    const agent = await makeAgent({
      ...llmCfg,
      system_prompt: 'Flag for a human whenever the customer asks for one.',
      knowledge: ['Manual intervention requests → send the user to sign in via the Copilot.'],
      procedures: [
        { name: 'refunds', when: 'refund asked', steps: ['verify order', 'call refund_order'] },
      ],
    });
    fetchMock.mockResolvedValueOnce(
      llmReply({
        content:
          '[{"a":"flag for a human when the customer asks","b":"manual intervention → sign in via Copilot","when":"a visitor asks for a person","fix":"scope the sign-in rule to account actions like refunds"}]',
      }),
    );
    const conflicts = await checkPromptConflicts(db, agent, {
      instructions: 'Flag for a human whenever the customer asks for one.',
    });
    expect(conflicts).toEqual([
      {
        a: 'flag for a human when the customer asks',
        b: 'manual intervention → sign in via Copilot',
        when: 'a visitor asks for a person',
        fix: 'scope the sign-in rule to account actions like refunds',
      },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(userMsg).toContain('sign in via the Copilot'); // knowledge note audited too
    expect(userMsg).toContain('refunds'); // procedures audited
    expect(userMsg).not.toContain('Built-in persona'); // authored prompt wins
  });

  it('uses the built-in persona when the agent has no authored instructions', async () => {
    const agent = await makeAgent();
    fetchMock.mockResolvedValueOnce(llmReply({ content: '[]' }));
    const conflicts = await checkPromptConflicts(db, agent);
    expect(conflicts).toEqual([]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages.find((m: { role: string }) => m.role === 'user').content).toContain(
      'Built-in persona',
    );
  });
});
