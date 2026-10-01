import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, desc, eq } from 'drizzle-orm';
import { BUILTIN_TOOLS, enabledBuiltins } from '../lib/builtinTools.js';
import { decidePendingAction } from '../lib/approvals.js';
import {
  agents,
  channelBindings,
  alertRules,
  channels,
  conversations,
  memberships,
  messages,
  pendingActions,
  users,
  workspaces,
} from '../db/schema.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';
import { setStripeClient } from '../lib/stripe.js';
import Stripe from 'stripe';
import type { Db } from '../db/client.js';

let db: Db;
let conciergeId: string;
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
const WS2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const USER2 = 'bbbbbbbb-0000-4000-8000-000000000005';
const CONV2 = 'cccccccc-0000-4000-8000-000000000006';
const WS3 = 'aaaaaaaa-0000-4000-8000-000000000007';
const USER3 = 'bbbbbbbb-0000-4000-8000-000000000008';
const CONV3 = 'cccccccc-0000-4000-8000-000000000009';
const USER4 = 'bbbbbbbb-0000-4000-8000-00000000000a';
const CONV4 = 'cccccccc-0000-4000-8000-00000000000b';

const siCalls: { id: string; method: string }[] = [];
const accountStatus = () => BUILTIN_TOOLS.find((b) => b.name === 'account_status')!;
const changePlan = () => BUILTIN_TOOLS.find((b) => b.name === 'change_plan')!;
const ctx = (convId: string, agent?: { id: string; workspaceId: string }) => ({
  db,
  convId,
  workspaceId: WS,
  agent,
});
// Concierge ctx — the parked action hangs off the concierge agent, not the
// visitor's agent the conversation row happens to name.
const cctx = (convId: string) => ctx(convId, { id: conciergeId, workspaceId: WS });
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  await db.insert(users).values({ id: USER, email: 'm@x.com', name: 'Mike' });
  await db.insert(workspaces).values({ id: WS, name: 'W1', plan: 'pro' });
  await db.insert(memberships).values({ userId: USER, workspaceId: WS, role: 'owner', acceptedAt: new Date() });
  const [agent] = await db.insert(agents).values({ workspaceId: WS, name: 'Bot' }).returning();
  const [concierge] = await db
    .insert(agents)
    .values({ workspaceId: WS, name: 'Concierge', hosted: true })
    .returning();
  conciergeId = concierge.id;
  await db.insert(conversations).values({ id: CONV, agentId: agent.id, externalId: 'v:test' });

  // free workspace the visitor administers — for checkout-link paths
  await db.insert(users).values({ id: USER2, email: 'a@x.com', name: 'Ann' });
  await db.insert(workspaces).values({ id: WS2, name: 'Free WS', plan: 'free' });
  await db
    .insert(memberships)
    .values({ userId: USER2, workspaceId: WS2, role: 'admin', acceptedAt: new Date() });
  const [agent2] = await db.insert(agents).values({ workspaceId: WS2, name: 'Bot2' }).returning();
  await db.insert(conversations).values({
    id: CONV2,
    agentId: agent2.id,
    externalId: 'v:test2',
    userProfile: { external_id: USER2, email: 'a@x.com', identity_verified: true },
  });
  // paid workspace with a live subscription — for swap/cancel paths
  await db.insert(users).values({ id: USER3, email: 'b@x.com', name: 'Bob' });
  await db.insert(workspaces).values({
    id: WS3,
    name: 'Paid WS',
    plan: 'starter',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
  });
  await db
    .insert(memberships)
    .values({ userId: USER3, workspaceId: WS3, role: 'admin', acceptedAt: new Date() });
  const [agent3] = await db.insert(agents).values({ workspaceId: WS3, name: 'Bot3' }).returning();
  await db.insert(conversations).values({
    id: CONV3,
    agentId: agent3.id,
    externalId: 'v:test3',
    userProfile: { external_id: USER3, email: 'b@x.com', identity_verified: true },
  });
  // member-only visitor — no admin rights anywhere
  await db.insert(users).values({ id: USER4, email: 'c@x.com', name: 'Cam' });
  await db
    .insert(memberships)
    .values({ userId: USER4, workspaceId: WS2, role: 'member', acceptedAt: new Date() });
  await db.insert(conversations).values({
    id: CONV4,
    agentId: agent2.id,
    externalId: 'v:test4',
    userProfile: { external_id: USER4, email: 'c@x.com', identity_verified: true },
  });
});

describe('account_status builtin', () => {
  it('gated to the operator workspace', () => {
    const prev = env.operatorWorkspaceId;
    env.operatorWorkspaceId = WS;
    expect(accountStatus().available(WS)).toBe(true);
    expect(accountStatus().available('other-ws')).toBe(false);
    expect(enabledBuiltins(['account_status'], WS).map((b) => b.name)).toEqual(['account_status']);
    expect(enabledBuiltins(['account_status'], 'other-ws')).toEqual([]);
    env.operatorWorkspaceId = prev;
  });

  it('returns signed_in: false when the visitor is not verified', async () => {
    const out = JSON.parse(await accountStatus().run({}, { db, convId: CONV, workspaceId: WS }));
    expect(out.signed_in).toBe(false);
  });

  it('resolves a verified user to their workspace and plan', async () => {
    await db
      .update(conversations)
      .set({
        userProfile: { external_id: USER, name: 'Mike', email: 'm@x.com', identity_verified: true },
      })
      .where(eq(conversations.id, CONV));
    const out = JSON.parse(await accountStatus().run({}, { db, convId: CONV, workspaceId: WS }));
    expect(out.signed_in).toBe(true);
    expect(out.email).toBe('m@x.com');
    // Bot + the concierge agent on the same test workspace.
    expect(out.workspaces).toEqual([{ name: 'W1', plan: 'Pro', agents: 2 }]);
  });
});

describe('change_plan builtin', () => {
  beforeAll(() => {
    env.operatorWorkspaceId = WS;
    env.stripeSecret = 'sk_test_fake';
    env.stripePrices = { free: '', starter: 'price_S', pro: 'price_P', scale: 'price_X' };
    env.stripeMeterPrices = {
      free: '',
      starter: 'price_MS',
      pro: 'price_MP',
      scale: 'price_MX',
      llm: 'price_LL',
    };
    // The Stripe client binds global fetch at construction — one dispatcher
    // stub installed before the first Stripe call covers every request.
    siCalls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((u: unknown, init?: RequestInit) => {
        const url = String(u);
        const method = init?.method ?? 'GET';
        if (url.includes('/v1/customers')) return Promise.resolve(jsonRes({ id: 'cus_new' }));
        if (url.includes('/v1/checkout/sessions')) {
          return Promise.resolve(
            jsonRes({ id: 'cs_x', url: 'https://checkout.stripe.com/pay/cs_x' }),
          );
        }
        if (url.includes('/v1/subscription_items/')) {
          siCalls.push({ id: url.split('/v1/subscription_items/')[1], method });
          return Promise.resolve(jsonRes({ id: 'si_x' }));
        }
        if (url.includes('/v1/prices/')) {
          // the target plan's metered price — resolves to the messages meter
          return Promise.resolve(jsonRes({ id: 'price_MP', recurring: { meter: 'mtr_msgs' } }));
        }
        if (url.includes('/v1/subscriptions/sub_1')) {
          if (method === 'GET') {
            return Promise.resolve(
              jsonRes({
                id: 'sub_1',
                items: {
                  data: [
                    { id: 'si_base', price: { id: 'price_S' } },
                    // an older-generation overage price — NOT in
                    // env.stripeMeterPrices; matched by meter id instead
                    {
                      id: 'si_meter',
                      price: { id: 'price_MS_OLD', recurring: { meter: 'mtr_msgs' } },
                    },
                    // the LLM item bills a different meter — never swapped
                    {
                      id: 'si_llm',
                      price: { id: 'price_LL_OLD', recurring: { meter: 'mtr_llm' } },
                    },
                  ],
                },
              }),
            );
          }
          return Promise.resolve(jsonRes({ id: 'sub_1' }));
        }
        return Promise.resolve(jsonRes({ error: { message: `unmocked ${method} ${url}` } }, 400));
      }),
    );
    // The default Stripe client uses node:http (unstubable) — inject a
    // fetch-backed client built AFTER the stub so requests hit the mock.
    setStripeClient(
      new Stripe('sk_test_fake', { httpClient: Stripe.createFetchHttpClient() }),
    );
  });

  it('gated to the operator workspace and Stripe being configured', () => {
    expect(changePlan().available(WS)).toBe(true);
    expect(changePlan().available('other-ws')).toBe(false);
    expect(enabledBuiltins(['change_plan'], WS).map((b) => b.name)).toEqual(['change_plan']);
  });

  it('rejects unknown plans', async () => {
    const out = JSON.parse(await changePlan().run({ plan: 'gold' }, ctx(CONV2)));
    expect(out.error).toContain('unknown plan');
  });

  it('requires the visitor to administer a workspace', async () => {
    const out = JSON.parse(await changePlan().run({ plan: 'pro' }, ctx(CONV4)));
    expect(out.error).toContain('admin');
  });

  it('no-ops when already on the plan', async () => {
    const out = JSON.parse(await changePlan().run({ plan: 'free' }, ctx(CONV2)));
    expect(out.changed).toBe(false);
  });

  it('free→paid returns a Stripe checkout link', async () => {
    const out = JSON.parse(await changePlan().run({ plan: 'pro' }, ctx(CONV2)));
    expect(out.checkout_url).toBe('https://checkout.stripe.com/pay/cs_x');
    // no subscription yet — the workspace stays on free until checkout completes
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, WS2));
    expect(w.plan).toBe('free');
  });

  it('paid→paid swaps the plan price in place and updates the workspace', async () => {
    const { bus } = await import('../lib/bus.js');
    const events: { type: string; data: unknown }[] = [];
    const off = bus.subscribe(WS3, (e) => events.push(e));
    const out = JSON.parse(
      await changePlan().run({ plan: 'pro', workspace: 'paid' }, ctx(CONV3)),
    );
    expect(out.changed).toBe(true);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, WS3));
    expect(w.plan).toBe('pro');
    // the old-generation overage item was matched by meter and swapped;
    // the LLM item (different meter) was left alone
    expect(siCalls.map((c) => c.id).sort()).toEqual(['si_base', 'si_meter']);
    // plan write notified the workspace's SSE subscribers
    expect(events).toContainEqual({ type: 'workspace', data: { id: WS3 } });
    off();
  });

  it('downgrade cancels the subscription at period end', async () => {
    const out = JSON.parse(
      await changePlan().run({ plan: 'free', workspace: 'paid' }, ctx(CONV3)),
    );
    expect(out.changed).toBe(true);
    expect(out.at_period_end).toBe(true);
  });

  it('asks which workspace when the visitor administers several', async () => {
    const [w4] = await db.insert(workspaces).values({ name: 'Second WS' }).returning();
    await db.insert(memberships).values({
      userId: USER3,
      workspaceId: w4.id,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const out = JSON.parse(await changePlan().run({ plan: 'pro' }, ctx(CONV3)));
    expect(out.error).toContain('Paid WS');
  });
});

describe('create_agent builtin', () => {
  const createAgent = () => BUILTIN_TOOLS.find((b) => b.name === 'create_agent')!;
  beforeAll(() => {
    env.operatorWorkspaceId = WS;
    env.webOrigin = 'https://app.janis.ai';
  });

  it('is gated to the operator workspace', () => {
    expect(createAgent().available(WS)).toBe(true);
    expect(createAgent().available('other-ws')).toBe(false);
    expect(enabledBuiltins(['create_agent'], WS).map((b) => b.name)).toEqual(['create_agent']);
  });

  it('rejects visitors who are not signed in', async () => {
    const [a] = await db.select().from(agents).where(eq(agents.workspaceId, WS)).limit(1);
    const [c] = await db
      .insert(conversations)
      .values({ agentId: a.id, externalId: 'v:anon' })
      .returning();
    const out = JSON.parse(await createAgent().run({ name: 'X' }, { db, convId: c.id, workspaceId: WS }));
    expect(out.error).toContain('signed-in');
  });

  it('rejects members without admin rights', async () => {
    const out = JSON.parse(
      await createAgent().run({ name: 'Nope Bot' }, ctx(CONV4)),
    );
    expect(out.error).toContain('admin');
  });

  it('creates a hosted agent + webchat channel in the visitor\'s workspace', async () => {
    const out = JSON.parse(
      await createAgent().run(
        { name: 'Acme Support', system_prompt: 'You answer Acme shipping questions.', greeting: 'Hi!' },
        ctx(CONV2),
      ),
    );
    expect(out.created).toBe(true);
    expect(out.url).toBe(`https://app.janis.ai/agents/${out.agent_id}`);
    const [agent] = await db.select().from(agents).where(eq(agents.id, out.agent_id));
    expect(agent.workspaceId).toBe(WS2); // visitor's workspace, not the concierge's
    expect(agent.hosted).toBe(true);
    const cfg = agent.config as { system_prompt?: string; greeting?: string };
    expect(cfg.system_prompt).toContain('shipping');
    expect(cfg.greeting).toBe('Hi!');
    const [chan] = await db
      .select()
      .from(channels)
      .where(eq(channels.agentId, agent.id))
      .limit(1);
    expect(chan.kind).toBe('webchat');
  });

  it('asks which workspace when the visitor administers several, honours the hint', async () => {
    const [w5] = await db.insert(workspaces).values({ name: 'Ann Second' }).returning();
    await db.insert(memberships).values({
      userId: USER2,
      workspaceId: w5.id,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const ambiguous = JSON.parse(await createAgent().run({ name: 'B' }, ctx(CONV2)));
    expect(ambiguous.error).toContain('Free WS');
    const picked = JSON.parse(
      await createAgent().run({ name: 'B2', workspace: 'ann second' }, ctx(CONV2)),
    );
    expect(picked.created).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, picked.agent_id));
    expect(agent.workspaceId).toBe(w5.id);
  });
});

describe('workspace_stats builtin', () => {
  const stats = () => BUILTIN_TOOLS.find((b) => b.name === 'workspace_stats')!;

  it('is gated to the operator workspace', () => {
    expect(stats().available(WS)).toBe(true);
    expect(stats().available('other-ws')).toBe(false);
  });

  it('rejects unsigned visitors', async () => {
    const [a] = await db.select().from(agents).where(eq(agents.workspaceId, WS)).limit(1);
    const [c] = await db
      .insert(conversations)
      .values({ agentId: a.id, externalId: 'v:anon2' })
      .returning();
    const out = JSON.parse(await stats().run({}, { db, convId: c.id, workspaceId: WS }));
    expect(out.error).toContain('signed-in');
  });

  it('asks which workspace when the visitor has several', async () => {
    const out = JSON.parse(await stats().run({}, ctx(CONV2)));
    expect(out.error).toContain('which workspace');
    expect(out.error).toContain('Free WS');
  });

  it('falls back to the workspace the visitor is viewing', async () => {
    await db
      .update(conversations)
      .set({
        userProfile: {
          external_id: USER2,
          email: 'a@x.com',
          identity_verified: true,
          metadata: { current_workspace: 'Free WS' },
        },
      })
      .where(eq(conversations.id, CONV2));
    const out = JSON.parse(await stats().run({}, ctx(CONV2)));
    expect(out.workspace).toBe('Free WS');
    expect(out).not.toHaveProperty('error');
  });

  it('computes stats scoped to the resolved workspace and honours the hint', async () => {
    // a conversation + one agent reply inside WS2
    const [a2] = await db.select().from(agents).where(eq(agents.workspaceId, WS2)).limit(1);
    const [c] = await db
      .insert(conversations)
      .values({ agentId: a2.id, externalId: 'cust:1' })
      .returning();
    await db.insert(messages).values([
      { conversationId: c.id, direction: 'in', text: 'hi' },
      { conversationId: c.id, direction: 'out', text: 'hello' },
    ]);
    const out = JSON.parse(await stats().run({ workspace: 'free' }, ctx(CONV2)));
    expect(out.workspace).toBe('Free WS');
    expect(out.conversations).toBeGreaterThanOrEqual(1);
    expect(out.contained).toBeGreaterThanOrEqual(1);
    expect(out.containment_rate).toBeGreaterThanOrEqual(0);
    // a member (not admin) can read stats — read-only tool
    const memberOut = JSON.parse(await stats().run({ workspace: 'free' }, ctx(CONV4)));
    expect(memberOut.workspace).toBe('Free WS');
  });
});

describe('debug_conversation builtin', () => {
  const dbg = () => BUILTIN_TOOLS.find((b) => b.name === 'debug_conversation')!;
  const DBG_CONV = 'dddddddd-0000-4000-8000-00000000000d';

  it('is gated to the operator workspace', () => {
    expect(dbg().available(WS)).toBe(true);
    expect(dbg().available('other-ws')).toBe(false);
  });

  it('scopes to the visitor\'s workspace — same id elsewhere is invisible', async () => {
    const out = JSON.parse(await dbg().run({ conversation: CONV, workspace: 'free' }, ctx(CONV2)));
    expect(out.error).toContain('no conversation');
  });

  it('reports an unanswered inbound on a healthy hosted agent', async () => {
    const [a2] = await db
      .insert(agents)
      .values({ workspaceId: WS2, name: 'Hosted Bot', hosted: true })
      .returning();
    const [chan] = await db
      .insert(channels)
      .values({ workspaceId: WS2, agentId: a2.id, kind: 'webchat', name: 'web', credentials: {} })
      .returning();
    await db.insert(conversations).values({
      id: DBG_CONV,
      agentId: a2.id,
      externalId: 'cust:angry',
      userProfile: { name: 'Ann Customer', email: 'ann@acme.com' },
      lastMessageAt: new Date(),
    });
    await db.insert(channelBindings).values({
      channelId: chan.id,
      conversationId: DBG_CONV,
      platformUserId: 'ann',
    });
    await db.insert(messages).values({
      conversationId: DBG_CONV,
      direction: 'in',
      text: 'where is my order?',
    });
    const out = JSON.parse(
      await dbg().run({ conversation: DBG_CONV, workspace: 'free' }, ctx(CONV2)),
    );
    expect(out.conversation_id).toBe(DBG_CONV);
    expect(out.findings.join(' ')).toContain('never got a reply');
    expect(out.findings.join(' ')).toContain('no LLM call ran');
  });

  it('finds conversations by customer email and diagnoses takeover', async () => {
    await db.update(conversations).set({ state: 'human', humanSince: new Date() }).where(eq(conversations.id, DBG_CONV));
    const out = JSON.parse(
      await dbg().run({ conversation: 'ann@acme.com', workspace: 'free' }, ctx(CONV2)),
    );
    expect(out.conversation_id).toBe(DBG_CONV);
    expect(out.verdict).toContain('human took over');
  });
});

describe('knowledge_gaps builtin', () => {
  const gapsTool = () => BUILTIN_TOOLS.find((b) => b.name === 'knowledge_gaps')!;
  let gapAgentId: string;

  it('is gated to the operator workspace', () => {
    expect(gapsTool().available(WS)).toBe(true);
    expect(gapsTool().available('other-ws')).toBe(false);
  });

  it('clusters recurring failed questions for the visitor\'s workspace', async () => {
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: WS2, name: 'Gap Bot', hosted: true })
      .returning();
    gapAgentId = a.id;
    const t0 = Date.now() - 3_600_000;
    for (const ext of ['g1', 'g2']) {
      const [cv] = await db
        .insert(conversations)
        .values({ agentId: a.id, externalId: `cust:${ext}` })
        .returning();
      await db.insert(messages).values([
        { conversationId: cv.id, direction: 'in', text: 'do you ship to Canada?', createdAt: new Date(t0) },
        { conversationId: cv.id, direction: 'out', text: 'Let me get a human.', flags: { help_requested: true }, createdAt: new Date(t0 + 60_000) },
        { conversationId: cv.id, direction: 'human', text: 'Yes — free shipping to Canada over $50.', createdAt: new Date(t0 + 120_000) },
      ]);
    }
    const out = JSON.parse(await gapsTool().run({ workspace: 'free' }, ctx(CONV2)));
    const mine = out.agents.find((r: { agent: string }) => r.agent === 'Gap Bot');
    expect(mine).toBeTruthy();
    expect(mine.gaps_url).toContain(gapAgentId);
    const gap = mine.gaps[0];
    expect(gap.times_failed).toBe(2);
    expect(gap.theme.toLowerCase()).toContain('ship');
    expect(gap.human_resolutions[0]).toContain('Canada');
  });

  it('hides dismissed clusters like the console does', async () => {
    await db
      .update(agents)
      .set({
        config: {
          dismissed_gaps: ['do you ship to canada?'],
          dismissed_gap_times: { 'do you ship to canada?': new Date().toISOString() },
        },
      })
      .where(eq(agents.id, gapAgentId));
    const out = JSON.parse(await gapsTool().run({ workspace: 'free', agent: 'gap' }, ctx(CONV2)));
    expect(out.gaps ?? []).toEqual([]);
  });

  it('a member can read gaps but cannot teach', async () => {
    const out = JSON.parse(await gapsTool().run({ workspace: 'free' }, ctx(CONV4)));
    expect(out.workspace).toBe('Free WS');
    const teach = () => BUILTIN_TOOLS.find((b) => b.name === 'teach_agent')!;
    const denied = JSON.parse(
      await teach().run({ workspace: 'free', agent: 'gap', entry: 'Shipping to Canada is free over $50.' }, ctx(CONV4)),
    );
    expect(denied.error).toContain('admin');
  });
});

describe('teach_agent builtin', () => {
  const teach = () => BUILTIN_TOOLS.find((b) => b.name === 'teach_agent')!;
  const apply = () => BUILTIN_TOOLS.find((b) => b.name === 'apply_knowledge')!;

  it('posts an approval card; approving applies the entry and marks gaps covered', async () => {
    // Repopulate the gaps cache (the dismissal test overwrote the config) —
    // detection still sees the cluster; dismissal only filters the output.
    const gapsTool = () => BUILTIN_TOOLS.find((b) => b.name === 'knowledge_gaps')!;
    await gapsTool().run({ workspace: 'free', agent: 'gap' }, ctx(CONV2));
    const out = await teach().run(
      { workspace: 'free', agent: 'gap bot', entry: 'We ship to Canada — free over $50.' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    // The parked action + the transcript card message it rides on.
    const [pa] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.conversationId, CONV2));
    expect(pa.toolName).toBe('apply_knowledge');
    expect((pa.tool as { builtin: string }).builtin).toBe('apply_knowledge');
    const [cardMsg] = await db.select().from(messages).where(eq(messages.id, pa.messageId!));
    const act = (
      cardMsg.payload as { action: { status: string; label: string; display: { entry: string } } }
    ).action;
    expect(act.status).toBe('pending');
    expect(act.label).toBe('Teach Gap Bot');
    expect(act.display.entry).toContain('Canada');
    // An identical proposal while pending doesn't stack a second card.
    const dupe = await teach().run(
      { workspace: 'free', agent: 'gap bot', entry: 'We ship to Canada — free over $50.' },
      cctx(CONV2),
    );
    expect(dupe).toContain('already awaiting');
    // Approve → the hidden executor runs the real write.
    const applied = JSON.parse(
      await apply().run(pa.args as Record<string, string>, { db, convId: CONV2, workspaceId: WS }),
    );
    expect(applied.ok).toBe(true);
    const [a] = await db.select().from(agents).where(eq(agents.name, 'Gap Bot'));
    const cfg = a.config as { knowledge?: string[]; gaps_cache?: { gaps: { added: boolean }[] } };
    expect(cfg.knowledge).toContain('We ship to Canada — free over $50.');
    // "ship, canada" shared words → jaccard ≥ 0.35 → cluster marked covered
    expect(cfg.gaps_cache?.gaps?.[0]?.added).toBe(true);
  });

  it('approve via decidePendingAction resolves the card with a friendly summary + Done line', async () => {
    const out = await teach().run(
      { workspace: 'free', agent: 'gap bot', entry: 'Refunds land within five working days.' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const [pa] = await db
      .select()
      .from(pendingActions)
      .where(and(eq(pendingActions.conversationId, CONV2), eq(pendingActions.status, 'pending')))
      .orderBy(desc(pendingActions.createdAt))
      .limit(1);

    const decided = await decidePendingAction(db, pa.id, { id: USER2, name: 'Ann' }, true);
    expect(decided).not.toBeNull();
    expect(decided).not.toBe('not-pending');

    // The card's result is the executor's human-readable summary — never
    // the raw JSON blob.
    const [card] = await db.select().from(messages).where(eq(messages.id, pa.messageId!));
    const act = (
      card.payload as { action: { status: string; decided_by: string; result: string } }
    ).action;
    expect(act.status).toBe('approved');
    expect(act.decided_by).toBe('Ann');
    expect(act.result).toContain('Added to Gap Bot');
    expect(act.result).not.toContain('{');

    // A deterministic confirmation lands in the thread — the Ask Janis
    // rail never sits on typing dots waiting for a resumed agent turn.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, CONV2))
      .orderBy(desc(messages.createdAt))
      .limit(5);
    const confirm = rows.find((r) => r.direction === 'out' && r.text.startsWith('Done —'));
    expect(confirm?.text).toContain('Refunds land within five working days.');
  });

  it('apply_knowledge dedupes; teach rejects non-hosted agents', async () => {
    const [gapBot] = await db.select().from(agents).where(eq(agents.name, 'Gap Bot'));
    const again = JSON.parse(
      await apply().run(
        { workspace_id: WS2, agent_id: gapBot.id, entry: 'We ship to Canada — free over $50.' },
        { db, convId: CONV2, workspaceId: WS },
      ),
    );
    expect(again.note).toContain('already exists');
    await db.insert(agents).values({ workspaceId: WS2, name: 'Webhook Bot', hosted: false });
    const bad = JSON.parse(
      await teach().run({ workspace: 'free', agent: 'webhook', entry: 'x' }, cctx(CONV2)),
    );
    expect(bad.error).toContain("isn't a hosted agent");
  });
});

describe('add_routing_rule builtin', () => {
  const addRule = () => BUILTIN_TOOLS.find((b) => b.name === 'add_routing_rule')!;
  const applyRule = () => BUILTIN_TOOLS.find((b) => b.name === 'apply_routing_rule')!;

  it('parks a keyword-rule card; approving writes the alert_rules row', async () => {
    const out = await addRule().run(
      {
        workspace: 'free',
        agent: 'bot2',
        kind: 'keyword',
        keywords: 'dumbass, refund',
        assign_to: 'ann',
      },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db.select().from(pendingActions).where(eq(pendingActions.conversationId, CONV2))
    ).find((p) => p.toolName === 'apply_routing_rule');
    expect(pa).toBeTruthy();
    const execArgs = pa!.args as { agent_id: string; kind: string; config: { keywords: string[]; assign_to: string } };
    expect(execArgs.kind).toBe('keyword');
    expect(execArgs.config.keywords).toEqual(['dumbass', 'refund']);
    expect(execArgs.config.assign_to).toBe(USER2); // 'ann' → Ann's id
    const applied = JSON.parse(
      await applyRule().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.ok).toBe(true);
    const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, applied.rule_id));
    expect(rule.kind).toBe('keyword');
    expect((rule.config as { assign_to: string }).assign_to).toBe(USER2);
  });

  it('rejects unknown teammates and auto_assign without a pool', async () => {
    const bad = JSON.parse(
      await addRule().run(
        { workspace: 'free', agent: 'bot2', kind: 'keyword', keywords: 'x', assign_to: 'nobody' },
        cctx(CONV2),
      ),
    );
    expect(bad.error).toContain("isn't a workspace member");
    const empty = JSON.parse(
      await addRule().run({ workspace: 'free', agent: 'bot2', kind: 'auto_assign' }, cctx(CONV2)),
    );
    expect(empty.error).toContain('assignees');
  });
});

describe('update_agent builtin', () => {
  const update = () => BUILTIN_TOOLS.find((b) => b.name === 'update_agent')!;
  const applyCfg = () => BUILTIN_TOOLS.find((b) => b.name === 'apply_agent_config')!;

  it('parks a config card; approving merges the allowlisted patch', async () => {
    const out = await update().run(
      { workspace: 'free', agent: 'bot2', csat_enabled: 'false', greeting: 'Hi there' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db.select().from(pendingActions).where(eq(pendingActions.conversationId, CONV2))
    ).find((p) => p.toolName === 'apply_agent_config');
    expect(pa).toBeTruthy();
    const applied = JSON.parse(
      await applyCfg().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.ok).toBe(true);
    const [a] = await db.select().from(agents).where(eq(agents.name, 'Bot2'));
    const cfg = a.config as { greeting?: string; csat?: { enabled?: boolean } };
    expect(cfg.greeting).toBe('Hi there');
    expect(cfg.csat?.enabled).toBe(false);
  });

  it('rename parks a card; approving updates agents.name', async () => {
    const out = await update().run(
      { workspace: 'free', agent: 'bot2', name: 'Renamed Bot' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_agent_config' && p.status === 'pending');
    expect((pa!.args as { rename?: string }).rename).toBe('Renamed Bot');
    const applied = JSON.parse(
      await applyCfg().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.summary).toBe('Renamed Bot2 to Renamed Bot.');
    const [a] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, (pa!.args as { agent_id: string }).agent_id));
    expect(a.name).toBe('Renamed Bot');
    // restore for later tests that look the agent up by name
    await db.update(agents).set({ name: 'Bot2' }).where(eq(agents.id, a.id));
  });

  it('accent + email_alerts park a card; approving writes channel creds and member prefs', async () => {
    const [bot2pre] = await db.select().from(agents).where(eq(agents.name, 'Bot2'));
    const [webChan] = await db
      .insert(channels)
      .values({
        workspaceId: WS2,
        agentId: bot2pre.id,
        kind: 'webchat',
        name: 'Web chat',
      })
      .returning();
    const out = await update().run(
      { workspace: 'free', agent: 'bot2', accent: '#635bff', email_alerts: 'true' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_agent_config' && p.status === 'pending');
    expect((pa!.args as { accent?: string }).accent).toBe('#635bff');
    const applied = JSON.parse(
      await applyCfg().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.ok).toBe(true);
    expect(applied.applied).toContain('accent');
    expect(applied.applied).toContain('email_alerts');
    const [chan] = await db.select().from(channels).where(eq(channels.id, webChan.id));
    expect(chan).toBeTruthy();
    expect((chan.credentials as { accent?: string }).accent).toBe('#635bff');
    const { agentMembers } = await import('../db/schema.js');
    const [mrow] = await db
      .select()
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, bot2pre.id), eq(agentMembers.userId, USER2)));
    expect((mrow.notifyPrefs as { email?: boolean }).email).toBe(true);
    // blank accent clears the creds key
    const cleared = JSON.parse(
      await applyCfg().run(
        { workspace_id: WS2, agent_id: bot2pre.id, accent: '' },
        { db, convId: CONV2, workspaceId: WS },
      ),
    );
    expect(cleared.ok).toBe(true);
    const [chan2] = await db.select().from(channels).where(eq(channels.id, webChan.id));
    expect((chan2.credentials as { accent?: string }).accent).toBeUndefined();
  });

  it('rejects a bad accent colour before parking', async () => {
    const bad = JSON.parse(
      await update().run({ workspace: 'free', agent: 'bot2', accent: 'blue!' }, cctx(CONV2)),
    );
    expect(bad.error).toContain('hex colour');
  });

  it('rejects empty patches and executor strips disallowed keys', async () => {
    const empty = JSON.parse(
      await update().run({ workspace: 'free', agent: 'bot2' }, cctx(CONV2)),
    );
    expect(empty.error).toContain('nothing to change');
    const [bot2] = await db.select().from(agents).where(eq(agents.name, 'Bot2'));
    const raw = await applyCfg().run(
      {
        workspace_id: WS2,
        agent_id: bot2.id,
        patch: { llm: { api_key: 'sk-stolen' }, builtin_tools: ['x'] },
      },
      { db, convId: CONV2, workspaceId: WS },
    );
    expect(raw).toContain('disallowed');
  });
});

describe('teach_from_conversation + assign_conversation builtins', () => {
  const teachFrom = () => BUILTIN_TOOLS.find((b) => b.name === 'teach_from_conversation')!;
  const assign = () => BUILTIN_TOOLS.find((b) => b.name === 'assign_conversation')!;
  const applyAssign = () => BUILTIN_TOOLS.find((b) => b.name === 'apply_assignment')!;
  let targetConv: string;

  it('read mode returns the transcript; entry mode parks a Teach card on the conv agent', async () => {
    // teach only applies to hosted agents — give WS2 one to rescue against
    const [hostBot] = await db
      .insert(agents)
      .values({ workspaceId: WS2, name: 'Host Bot', hosted: true })
      .returning();
    const [rescued] = await db
      .insert(conversations)
      .values({
        agentId: hostBot.id,
        externalId: 'cust:rescue@example.com',
        userProfile: { name: 'Rescue Customer', email: 'rescue@example.com' },
        state: 'active',
      })
      .returning();
    targetConv = rescued.id;
    await db.insert(messages).values([
      { conversationId: rescued.id, direction: 'in', text: 'do you ship to Norway?' },
      { conversationId: rescued.id, direction: 'human', text: 'Yes — Norway ships in 3-5 days.' },
    ]);
    const readRaw = await teachFrom().run(
      { workspace: 'free', conversation: 'rescue@example.com' },
      cctx(CONV2),
    );
    const read = JSON.parse(readRaw);
    expect(read.agent, readRaw).toBe('Host Bot');
    // same-timestamp test rows — assert content, not order
    expect(read.transcript.map((m: { dir: string }) => m.dir).sort()).toEqual(['customer', 'human']);
    expect(read.transcript.map((m: { text: string }) => m.text)).toContain(
      'Yes — Norway ships in 3-5 days.',
    );
    const out = await teachFrom().run(
      {
        workspace: 'free',
        conversation: 'rescue@example.com',
        entry: 'We ship to Norway — delivery takes 3-5 days.',
      },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_knowledge' && p.status === 'pending');
    expect((pa!.args as { agent_id: string }).agent_id).toBe(hostBot.id);
    const [cardMsg] = await db.select().from(messages).where(eq(messages.id, pa!.messageId!));
    const disp = (cardMsg.payload as { action: { display: { source?: string } } }).action.display;
    expect(disp.source).toContain('Rescue Customer');
  });

  it('assign_conversation parks a card; approving sets the assignee', async () => {
    const out = await assign().run(
      { workspace: 'free', conversation: 'rescue@example.com', assignee: 'me' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_assignment' && p.status === 'pending');
    expect((pa!.args as { assignee_id: string }).assignee_id).toBe(USER2);
    const applied = JSON.parse(
      await applyAssign().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.ok).toBe(true);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, targetConv));
    expect(conv.assigneeId).toBe(USER2);
    // Re-park on the same assignee is refused at the tool layer.
    const dupe = JSON.parse(
      await assign().run(
        { workspace: 'free', conversation: 'rescue@example.com', assignee: 'me' },
        cctx(CONV2),
      ),
    );
    expect(dupe.error).toContain('already assigned');
  });

  it('assign rejects an assignee outside the workspace', async () => {
    const bad = JSON.parse(
      await assign().run(
        { workspace: 'free', conversation: 'rescue@example.com', assignee: 'nobody' },
        cctx(CONV2),
      ),
    );
    expect(bad.error).toContain("isn't a member");
  });
});

describe('update_channel builtin', () => {
  const updateChan = () => BUILTIN_TOOLS.find((b) => b.name === 'update_channel')!;
  const applyChan = () => BUILTIN_TOOLS.find((b) => b.name === 'apply_channel')!;

  it('rename parks a card; approving updates channels.name', async () => {
    const [bot2] = await db.select().from(agents).where(eq(agents.name, 'Bot2'));
    const [ch] = await db
      .insert(channels)
      .values({ workspaceId: WS2, agentId: bot2.id, kind: 'webchat', name: 'Site widget' })
      .returning();

    const out = await updateChan().run(
      { workspace: 'free', channel: 'site widget', name: 'Acme Widget' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_channel' && p.status === 'pending');
    expect((pa!.args as { name?: string }).name).toBe('Acme Widget');
    expect((pa!.args as { channel_id?: string }).channel_id).toBe(ch.id);
    const applied = JSON.parse(
      await applyChan().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.summary).toBe('Renamed channel "Site widget" to "Acme Widget".');
    const [renamed] = await db.select().from(channels).where(eq(channels.id, ch.id));
    expect(renamed.name).toBe('Acme Widget');
  });

  it('title writes creds.title on webchat; rejects title on other kinds', async () => {
    const [bot2] = await db.select().from(agents).where(eq(agents.name, 'Bot2'));
    const [smsCh] = await db
      .insert(channels)
      .values({ workspaceId: WS2, agentId: bot2.id, kind: 'sms', name: 'Text line' })
      .returning();
    const bad = JSON.parse(
      await updateChan().run(
        { workspace: 'free', channel: 'text line', title: 'Nope' },
        cctx(CONV2),
      ),
    );
    expect(bad.error).toContain('webchat');

    const out = await updateChan().run(
      { workspace: 'free', channel: 'acme widget', title: 'Chat with Acme' },
      cctx(CONV2),
    );
    expect(out).toContain('action_card');
    const pa = (
      await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, CONV2))
        .orderBy(desc(pendingActions.createdAt))
    ).find((p) => p.toolName === 'apply_channel' && p.status === 'pending');
    const applied = JSON.parse(
      await applyChan().run(pa!.args as Record<string, unknown>, {
        db,
        convId: CONV2,
        workspaceId: WS,
      }),
    );
    expect(applied.ok).toBe(true);
    expect(applied.applied).toEqual(['title']);
    const [ch] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, (pa!.args as { channel_id: string }).channel_id));
    expect((ch.credentials as { title?: string }).title).toBe('Chat with Acme');
    void smsCh;
  });

  it('no-op args and unknown channels error without a card', async () => {
    const nothing = JSON.parse(
      await updateChan().run({ workspace: 'free', channel: 'acme widget' }, cctx(CONV2)),
    );
    expect(nothing.error).toContain('nothing to change');
    const missing = JSON.parse(
      await updateChan().run({ workspace: 'free', channel: 'zzzz', name: 'X' }, cctx(CONV2)),
    );
    expect(missing.error).toContain("didn't match");
  });
});
