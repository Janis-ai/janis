import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, campaignSends, campaigns, channels, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { campaignRoutes } from './campaigns.js';

let app: Hono;
let db: Db;
let adminCookie: string;
let memberCookie: string;
let channelId: string;

async function seedSession(userId: string) {
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  return `janis_session=${token}`;
}

const mkCampaign = async (status: string, opts: { scheduledAt?: Date } = {}) => {
  const [c] = await db
    .insert(campaigns)
    .values({
      workspaceId: wsId,
      channelId,
      name: `Camp ${status}`,
      text: 'hi',
      status,
      scheduledAt: opts.scheduledAt,
    })
    .returning();
  return c;
};
let wsId: string;

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(`/api/campaigns${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/campaigns', campaignRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({ email: 'a@x.c', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  const [member] = await db
    .insert(users)
    .values({ email: 'm@x.c', name: 'Member', passwordHash: await hashPassword('password123') })
    .returning();
  await db.insert(memberships).values([
    { userId: admin.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() },
    { userId: member.id, workspaceId: ws.id, role: 'member', acceptedAt: new Date() },
  ]);
  adminCookie = await seedSession(admin.id);
  memberCookie = await seedSession(member.id);
  const [agent] = await db.insert(agents).values({ workspaceId: ws.id, name: 'Bot' }).returning();
  const [chan] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'email', name: 'Mail', credentials: {} })
    .returning();
  channelId = chan.id;
});

const statusOf = async (id: string) =>
  (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]?.status;

describe('campaign list scoping', () => {
  it('?agent_id= returns only campaigns sent through that agent\'s channels', async () => {
    const [agent2] = await db.insert(agents).values({ workspaceId: wsId, name: 'Bot2' }).returning();
    const [ch2] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: agent2.id, kind: 'email', name: 'Mail2', credentials: {} })
      .returning();
    const marker = `ag-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(campaigns).values([
      { workspaceId: wsId, channelId, name: `${marker} a`, text: 'hi', status: 'draft' },
      { workspaceId: wsId, channelId: ch2.id, name: `${marker} b`, text: 'hi', status: 'draft' },
    ]);
    const res = await call('GET', `?agent_id=${agent2.id}`, adminCookie);
    const body = (await res.json()) as { campaigns: { name: string }[] };
    const names = body.campaigns.map((c) => c.name);
    expect(names).toContain(`${marker} b`);
    expect(names).not.toContain(`${marker} a`);
  });
});

describe('campaign status transitions', () => {
  it('pause sets paused — regression: the shared helper used to set sending', async () => {
    const c = await mkCampaign('scheduled', { scheduledAt: new Date(Date.now() + 86_400_000) });
    const res = await call('POST', `/${c.id}/pause`, adminCookie);
    expect(res.status).toBe(200);
    expect(await statusOf(c.id)).toBe('paused');
  });

  it('cancel sets cancelled and stamps pending sends skipped', async () => {
    const c = await mkCampaign('sending');
    await db.insert(campaignSends).values([
      { campaignId: c.id, workspaceId: wsId, channelId, recipient: 'a@x.com' },
      { campaignId: c.id, workspaceId: wsId, channelId, recipient: 'b@x.com', status: 'sent' },
    ]);
    const res = await call('POST', `/${c.id}/cancel`, adminCookie);
    expect(res.status).toBe(200);
    expect(await statusOf(c.id)).toBe('cancelled');
    const rows = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, c.id));
    expect(rows.map((r) => r.status).sort()).toEqual(['sent', 'skipped_cancelled']);
  });

  it('resume on a still-future schedule goes back to scheduled', async () => {
    const c = await mkCampaign('paused', { scheduledAt: new Date(Date.now() + 86_400_000) });
    await call('POST', `/${c.id}/resume`, adminCookie);
    expect(await statusOf(c.id)).toBe('scheduled');
  });

  it('resume on an elapsed schedule goes to sending', async () => {
    const c = await mkCampaign('paused', { scheduledAt: new Date(Date.now() - 86_400_000) });
    await call('POST', `/${c.id}/resume`, adminCookie);
    expect(await statusOf(c.id)).toBe('sending');
  });

  it('members cannot transition campaigns', async () => {
    const c = await mkCampaign('sending');
    const res = await call('POST', `/${c.id}/pause`, memberCookie);
    expect(res.status).toBe(403);
    expect(await statusOf(c.id)).toBe('sending');
  });
});

describe('campaign delete', () => {
  it('deletes a sending campaign and its send rows', async () => {
    const c = await mkCampaign('sending');
    await db.insert(campaignSends).values([
      { campaignId: c.id, workspaceId: wsId, channelId, recipient: 'x@x.com', status: 'sent' },
      { campaignId: c.id, workspaceId: wsId, channelId, recipient: 'y@x.com' },
    ]);
    const res = await call('DELETE', `/${c.id}`, adminCookie);
    expect(res.status).toBe(200);
    expect(await statusOf(c.id)).toBeUndefined();
    const rows = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, c.id));
    expect(rows).toHaveLength(0);
  });

  it('deletes a done campaign too', async () => {
    const c = await mkCampaign('done');
    const res = await call('DELETE', `/${c.id}`, adminCookie);
    expect(res.status).toBe(200);
    expect(await statusOf(c.id)).toBeUndefined();
  });
});
