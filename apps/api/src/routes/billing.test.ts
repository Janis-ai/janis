import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { billingRoutes, stripeWebhookRoutes } from './billing.js';
import { setStripeClient } from '../lib/stripe.js';

// env.ts reads process.env at import time — webhook secret must exist before
// the billing module graph loads.
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

let db: Db;
let api: Hono;
let webhook: Hono;
let cookie: string;
let childCookie: string;
let parentId: string;
let childId: string;
let agentId: string;

/** Recorded Stripe calls — assert what the connect flow actually sent. */
const stripeCalls: { method: string; params: unknown; opts?: unknown }[] = [];
const fake = {
  accounts: {
    create: async (params: unknown) => {
      stripeCalls.push({ method: 'accounts.create', params });
      return { id: 'acct_agency1', charges_enabled: false };
    },
    retrieve: async () => ({ id: 'acct_agency1', charges_enabled: true }),
  },
  accountLinks: {
    create: async (params: unknown) => {
      stripeCalls.push({ method: 'accountLinks.create', params });
      return { url: 'https://connect.stripe.test/onboard' };
    },
  },
  products: {
    create: async (params: unknown, opts?: unknown) => {
      stripeCalls.push({ method: 'products.create', params, opts });
      return { id: 'prod_retail1' };
    },
  },
  prices: {
    create: async (params: unknown, opts?: unknown) => {
      stripeCalls.push({ method: 'prices.create', params, opts });
      return { id: `price_${(params as { unit_amount: number }).unit_amount}` };
    },
  },
  checkout: {
    sessions: {
      create: async (params: unknown, opts?: unknown) => {
        stripeCalls.push({ method: 'checkout.sessions.create', params, opts });
        return { id: 'cs_1', url: 'https://checkout.stripe.test/x' };
      },
    },
  },
  subscriptions: {
    retrieve: async () => ({ id: 'sub_conn1', items: { data: [{ id: 'si_1' }] } }),
    update: async (id: string, params: unknown, opts?: unknown) => {
      stripeCalls.push({ method: 'subscriptions.update', params, opts });
      return { id };
    },
    list: async () => ({ data: [] }),
  },
  customers: {
    retrieve: async () => ({ id: 'cus_1' }),
    create: async () => ({ id: 'cus_1' }),
  },
  billingPortal: { sessions: { create: async () => ({ url: 'https://portal.test' }) } },
  webhooks: {
    constructEvent: (body: string) => JSON.parse(body),
  },
};

async function fireWebhook(event: Record<string, unknown>) {
  return webhook.request('/', {
    method: 'POST',
    headers: { 'stripe-signature': 'test' },
    body: JSON.stringify(event),
  });
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  setStripeClient(fake as unknown as Stripe);
  api = new Hono().route('/api/billing', billingRoutes(db));
  webhook = new Hono().route('/', stripeWebhookRoutes(db));

  const [parent] = await db
    .insert(workspaces)
    .values({ name: 'Agency', plan: 'pro' })
    .returning();
  parentId = parent.id;
  const [child] = await db
    .insert(workspaces)
    .values({ name: 'Client Co', plan: 'free', parentWorkspaceId: parent.id })
    .returning();
  childId = child.id;
  const { generateApiKey } = await import('../lib/crypto.js');
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: childId, name: 'Client bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  agentId = agent.id;
  const [u] = await db
    .insert(users)
    .values({ email: 'a@a.a', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  // Admin on the parent; the child session uses a second user below.
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: parentId, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, workspaceId: parentId, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;

  // A second admin session scoped to the client workspace
  const [cu] = await db
    .insert(users)
    .values({ email: 'c@c.c', name: 'Client', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: cu.id, workspaceId: childId, role: 'admin', acceptedAt: new Date() });
  const ct = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id: ct.id, userId: cu.id, workspaceId: childId, expiresAt: new Date(Date.now() + 86_400_000) });
  childCookie = `janis_session=${ct.token}`;
});

describe('agency connect', () => {
  it('creates an Express account and returns an onboarding link', async () => {
    const res = await api.request('/api/billing/connect', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain('stripe');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, parentId));
    expect(ws.stripeConnectId).toBe('acct_agency1');
    const link = stripeCalls.find((x) => x.method === 'accountLinks.create');
    expect((link?.params as { account: string }).account).toBe('acct_agency1');
  });

  it('account.updated webhook flips charges_enabled', async () => {
    const res = await fireWebhook({
      type: 'account.updated',
      account: 'acct_agency1',
      data: { object: { id: 'acct_agency1', charges_enabled: true } },
    });
    expect(res.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, parentId));
    expect(ws.connectChargesEnabled).toBe(true);
  });

  it('rejects retail below the wholesale floor', async () => {
    const res = await api.request('/api/billing/agency-pricing', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ retail: { starter: 100 } }), // $1 < $29 wholesale
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('wholesale');
  });

  it('creates retail prices on the connected account', async () => {
    const res = await api.request('/api/billing/agency-pricing', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ retail: { starter: 4900, pro: 14900 } }),
    });
    expect(res.status).toBe(200);
    const priceCall = stripeCalls.find((x) => x.method === 'prices.create');
    expect((priceCall?.opts as { stripeAccount: string }).stripeAccount).toBe('acct_agency1');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, parentId));
    const pricing = ws.agencyPricing as Record<string, { price_id: string; retail_cents: number }>;
    expect(pricing.starter.retail_cents).toBe(4900);
    expect(pricing.starter.price_id).toBe('price_4900');
  });

  it('client checkout runs on the agency account with the wholesale fee', async () => {
    const res = await api.request('/api/billing/checkout', {
      method: 'POST',
      headers: { cookie: childCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    expect(res.status).toBe(200);
    const call = stripeCalls.find((x) => x.method === 'checkout.sessions.create');
    expect((call?.opts as { stripeAccount: string }).stripeAccount).toBe('acct_agency1');
    const sub = (call?.params as {
      subscription_data: { application_fee_percent: number };
      metadata: { plan: string };
    }).subscription_data;
    // wholesale 2900 / retail 4900 → Janis keeps ~59.18% of each invoice
    expect(sub.application_fee_percent).toBeCloseTo(59.18, 2);
    const meta = (call?.params as { metadata: { workspace_id: string } }).metadata;
    expect(meta.workspace_id).toBe(childId);
  });

  it('connect checkout webhook sets the child plan + connect ids', async () => {
    const res = await fireWebhook({
      type: 'checkout.session.completed',
      account: 'acct_agency1',
      data: {
        object: {
          customer: 'cus_conn1',
          subscription: 'sub_conn1',
          metadata: { workspace_id: childId, plan: 'starter' },
        },
      },
    });
    expect(res.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    expect(ws.plan).toBe('starter');
    expect(ws.connectCustomerId).toBe('cus_conn1');
    expect(ws.connectSubscriptionId).toBe('sub_conn1');
    // and the plan no longer rides on the parent's
    const { effectivePlanKey } = await import('../lib/plans.js');
    expect(await effectivePlanKey(db, childId)).toBe('starter');
  });

  it('swaps the price in place when a billed client changes plan', async () => {
    await api.request('/api/billing/agency-pricing', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ retail: { pro: 14900 } }),
    });
    const res = await api.request('/api/billing/checkout', {
      method: 'POST',
      headers: { cookie: childCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    expect(res.status).toBe(200);
    const upd = stripeCalls.find((x) => x.method === 'subscriptions.update');
    expect((upd?.opts as { stripeAccount: string }).stripeAccount).toBe('acct_agency1');
    expect(
      (upd?.params as { items: { price: string }[] }).items[0].price,
    ).toBe('price_14900');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    expect(ws.plan).toBe('pro');
  });

  it('subscription.deleted on the connected account frees the child', async () => {
    const res = await fireWebhook({
      type: 'customer.subscription.deleted',
      account: 'acct_agency1',
      data: { object: { id: 'sub_conn1', customer: 'cus_conn1', metadata: { plan: 'pro' } } },
    });
    expect(res.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    expect(ws.plan).toBe('free');
    expect(ws.connectSubscriptionId).toBeNull();
    // parent coverage resumes once the client sub is gone
    const { effectivePlanKey } = await import('../lib/plans.js');
    expect(await effectivePlanKey(db, childId)).toBe('pro');
  });
});
