import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { BUILTIN_TOOLS, enabledBuiltins } from '../lib/builtinTools.js';
import { agents, conversations, memberships, users, workspaces } from '../db/schema.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';
import { setStripeClient } from '../lib/stripe.js';
import Stripe from 'stripe';
import type { Db } from '../db/client.js';

let db: Db;
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
const ctx = (convId: string) => ({ db, convId, workspaceId: WS });
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
    expect(out.workspaces).toEqual([{ name: 'W1', plan: 'Pro', agents: 1 }]);
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
    const out = JSON.parse(
      await changePlan().run({ plan: 'pro', workspace: 'paid' }, ctx(CONV3)),
    );
    expect(out.changed).toBe(true);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, WS3));
    expect(w.plan).toBe('pro');
    // the old-generation overage item was matched by meter and swapped;
    // the LLM item (different meter) was left alone
    expect(siCalls.map((c) => c.id).sort()).toEqual(['si_base', 'si_meter']);
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
