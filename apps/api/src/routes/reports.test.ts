import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaignSends,
  campaigns,
  channels,
  conversations,
  memberships,
  messages,
  sessions,
  usageEvents,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { reportRoutes } from './reports.js';

let app: Hono;
let db: Db;
let cookie: string;
let wsId: string;
let agentId: string;

const j = (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/reports', reportRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Rep', plan: 'pro' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({ email: 'r@b.c', name: 'R', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: admin.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;

  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  agentId = agent.id;
  const [chan] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'sms', name: 'SMS', credentials: {} })
    .returning();

  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'sms:1', intent: 'shipping' })
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, direction: 'in', text: 'where is it' },
    { conversationId: conv.id, direction: 'out', text: 'on its way' },
  ]);
  const period = new Date().toISOString().slice(0, 7);
  await db.insert(usageEvents).values({
    workspaceId: ws.id,
    agentId: agent.id,
    conversationId: conv.id,
    kind: 'llm_tokens',
    period,
    promptTokens: 500,
    completionTokens: 100,
    costMicros: 2_500_000, // $2.50
  });
  const [camp] = await db
    .insert(campaigns)
    .values({ workspaceId: ws.id, channelId: chan.id, name: 'Blast', text: 'hi' })
    .returning();
  await db.insert(campaignSends).values({
    campaignId: camp.id,
    workspaceId: ws.id,
    channelId: chan.id,
    recipient: '+1555',
    status: 'sent',
    sentAt: new Date(),
  });
});

describe('GET /api/reports/volume', () => {
  it('returns daily conversation + message buckets', async () => {
    const res = await app.request('/api/reports/volume?days=30', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: { date: string; conversations: number; in: number; out: number; human: number }[] };
    const today = new Date().toISOString().slice(0, 10);
    const bucket = body.series.find((d) => d.date === today);
    expect(bucket?.conversations).toBe(1);
    expect(bucket?.in).toBe(1);
    expect(bucket?.out).toBe(1);
  });
});

describe('GET /api/reports/usage', () => {
  it('returns plan + period rollups', async () => {
    const res = await app.request('/api/reports/usage', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { key: string; included_messages: number };
      messages_used: number;
      current: { llm_prompt_tokens: number; llm_cost_usd: number };
    };
    expect(body.plan.key).toBe('pro');
    expect(body.plan.included_messages).toBe(20_000);
    expect(body.messages_used).toBe(2);
    expect(body.current.llm_prompt_tokens).toBe(500);
    expect(body.current.llm_cost_usd).toBe(2.5);
  });
});

describe('GET /api/reports/export', () => {
  it('streams conversations CSV', async () => {
    const res = await app.request('/api/reports/export?kind=conversations', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('id,created_at,state');
    expect(lines[1]).toContain('shipping');
  });

  it('streams campaign_sends CSV', async () => {
    const res = await app.request('/api/reports/export?kind=campaign_sends', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Blast');
    expect(text).toContain('+1555');
  });
});

describe('GET /api/reports/timeline', () => {
  it('splits resolved convs ai-vs-human and reports speed', async () => {
    const now = Date.now();
    // A: answered by the agent, archived → ai_resolved + FRT sample
    const [a] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'tl:a', createdAt: new Date(now - 3600_000), archivedAt: new Date(now - 600_000), state: 'archived' })
      .returning();
    await db.insert(messages).values([
      { conversationId: a.id, direction: 'in', text: 'q', createdAt: new Date(now - 3600_000) },
      { conversationId: a.id, direction: 'out', text: 'a', createdAt: new Date(now - 3540_000) },
    ]);
    // B: answered by a human, archived → human_resolved
    const [b] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'tl:b', createdAt: new Date(now - 1800_000), archivedAt: new Date(now - 60_000), state: 'archived' })
      .returning();
    await db.insert(messages).values([
      { conversationId: b.id, direction: 'in', text: 'q', createdAt: new Date(now - 1800_000) },
      { conversationId: b.id, direction: 'human', text: 'on it', createdAt: new Date(now - 1740_000) },
    ]);
    // C: open → counts in opened only
    await db.insert(conversations).values({ agentId, externalId: 'tl:c' });

    const res = await app.request('/api/reports/timeline?days=30', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      opened: number;
      resolved: number;
      ai_resolved: number;
      human_resolved: number;
      deflection_rate: number | null;
      median_frt_min: number | null;
      median_resolution_min: number | null;
      series: { date: string; opened: number; resolutions: number; ai_resolved: number; human_resolved: number }[];
    };
    // fixture conv (shipping, unarchived) + B + C opened today; A opened an
    // hour ago — could roll to yesterday's bucket, so only assert resolved.
    expect(body.opened).toBe(4);
    expect(body.resolved).toBe(2);
    expect(body.ai_resolved).toBe(1);
    expect(body.human_resolved).toBe(1);
    expect(body.deflection_rate).toBe(50);
    expect(body.median_frt_min).not.toBeNull();
    expect(body.median_resolution_min).not.toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    const bucket = body.series.find((d) => d.date === today);
    expect(bucket?.resolutions).toBe(2);
    expect(bucket?.ai_resolved).toBe(1);
    expect(bucket?.human_resolved).toBe(1);
  });
});

describe('report date ranges', () => {
  it('?from/&to bounds the window; out-of-range rows are excluded', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await app.request(`/api/reports/intents?from=${today}&to=${today}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intents: { intent: string; count: number }[] };
    const shipping = body.intents.find((i) => i.intent === 'shipping');
    expect(shipping?.count).toBeGreaterThan(0);

    // a window ending yesterday sees nothing created today
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const res2 = await app.request(`/api/reports/intents?from=${past}&to=${yesterday}`, {
      headers: { Cookie: cookie },
    });
    const body2 = (await res2.json()) as { intents: { intent: string }[] };
    expect(body2.intents.find((i) => i.intent === 'shipping')).toBeUndefined();
  });
});

describe('GET /api/reports/campaigns', () => {
  it('aggregates sends, replies and conversions per campaign', async () => {
    const res = await app.request('/api/reports/campaigns?days=30', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { sent: number; replied: number; converted: number };
      campaigns: { name: string; sent: number; reply_rate: number | null }[];
    };
    const blast = body.campaigns.find((c) => c.name === 'Blast');
    expect(blast?.sent).toBe(1);
    expect(body.totals.sent).toBe(1);
  });
});
