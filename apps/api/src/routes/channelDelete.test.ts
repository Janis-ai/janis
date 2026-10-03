import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaigns,
  channels,
  contactIdentities,
  contacts,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { eq } from 'drizzle-orm';

const { channelApiRoutes } = await import('./channels.js');

let db: Db;
let app: Hono;
let cookie: string;
let wsId: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/channels', channelApiRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
  wsId = ws.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  agentId = agent.id;
  const [u] = await db
    .insert(users)
    .values({ email: 'a@a.a', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db.insert(sessions).values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;
});

const mkChannel = (name: string, kind: 'webchat' | 'email' = 'webchat') =>
  db.insert(channels).values({ workspaceId: wsId, agentId, kind, name, credentials: {} }).returning();

const del = (id: string) =>
  app.fetch(
    new Request(`http://t/api/channels/${id}`, { method: 'DELETE', headers: { cookie } }),
  );

describe('channel delete', () => {
  it('deletes a channel with contact identities + bindings', async () => {
    const [ch] = await mkChannel('with-identity');
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, name: 'C', email: 'c@c.c' })
      .returning();
    await db.insert(contactIdentities).values({
      contactId: contact.id,
      channelId: ch.id,
      platformUserId: 'user-1',
    });
    const res = await del(ch.id);
    expect(res.status).toBe(200);
    expect((await db.select().from(channels).where(eq(channels.id, ch.id))).length).toBe(0);
    expect(
      (await db.select().from(contactIdentities).where(eq(contactIdentities.channelId, ch.id)))
        .length,
    ).toBe(0);
  });

  it('409s when a campaign sends through the channel', async () => {
    const [ch] = await mkChannel('with-campaign', 'email');
    await db.insert(campaigns).values({
      workspaceId: wsId,
      channelId: ch.id,
      name: 'blast',
      text: 'hi',
      status: 'draft',
    });
    const res = await del(ch.id);
    expect(res.status).toBe(409);
    // channel survives
    expect((await db.select().from(channels).where(eq(channels.id, ch.id))).length).toBe(1);
  });

  it('deletes once the campaign is gone', async () => {
    const [ch] = await mkChannel('freed', 'email');
    const [camp] = await db
      .insert(campaigns)
      .values({ workspaceId: wsId, channelId: ch.id, name: 'b', text: 'x', status: 'draft' })
      .returning();
    expect((await del(ch.id)).status).toBe(409);
    await db.delete(campaigns).where(eq(campaigns.id, camp.id));
    expect((await del(ch.id)).status).toBe(200);
  });

  it('voice channel delete cascades identities on sms siblings', async () => {
    // minimal: an sms channel cloned off a voice number
    const [voice] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId,
        kind: 'voice',
        name: 'v',
        credentials: { phone_number: '+15551234', hosted: true },
      })
      .returning();
    const [sms] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId, kind: 'sms', name: 's', credentials: { phone_number: '+15551234' } })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, name: 'C2', phone: '+15550001' })
      .returning();
    await db.insert(contactIdentities).values({
      contactId: contact.id,
      channelId: sms.id,
      platformUserId: '+15550001',
    });
    const res = await del(voice.id);
    expect(res.status).toBe(200);
    expect((await db.select().from(channels).where(eq(channels.id, sms.id))).length).toBe(0);
    expect(
      (await db.select().from(contactIdentities).where(eq(contactIdentities.channelId, sms.id)))
        .length,
    ).toBe(0);
  });
});
