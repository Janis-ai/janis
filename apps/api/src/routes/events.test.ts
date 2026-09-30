import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaignSends,
  campaigns,
  channels,
  conversionEvents,
  contacts,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { eventRoutes } from './events.js';

let db: Db;
let app: Hono;
let wsId: string;
let sendId: string;
let contactId: string;
const TOKEN = 'test-event-token-abc';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/events', eventRoutes(db));

  const [ws] = await db
    .insert(workspaces)
    .values({ name: 'Test', config: { event_token: TOKEN } })
    .returning();
  wsId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'email', name: 'Mail', credentials: {} })
    .returning();
  const [camp] = await db
    .insert(campaigns)
    .values({
      workspaceId: ws.id,
      channelId: channel.id,
      name: 'Launch',
      text: 'hi',
      status: 'sending',
      goal: 'purchase',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ workspaceId: ws.id, email: 'buyer@shop.test' })
    .returning();
  contactId = contact.id;
  const [send] = await db
    .insert(campaignSends)
    .values({
      workspaceId: ws.id,
      campaignId: camp.id,
      contactId: contact.id,
      channelId: channel.id,
      recipient: 'buyer@shop.test',
      status: 'sent',
      sentAt: new Date(),
    })
    .returning();
  sendId = send.id;
});

const post = (token: string, body: unknown) =>
  app.request(`/events/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('conversion events', () => {
  it('404s unknown tokens without leaking anything', async () => {
    const res = await post('nope', { event: 'purchase', email: 'buyer@shop.test' });
    expect(res.status).toBe(404);
  });

  it('records the event and attributes it to the contact’s last campaign send', async () => {
    const res = await post(TOKEN, {
      event: 'purchase',
      email: 'buyer@shop.test',
      value_cents: 9900,
      source: 'shopify',
    });
    expect(res.status).toBe(200);

    const events = await db
      .select()
      .from(conversionEvents)
      .where(eq(conversionEvents.workspaceId, wsId));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('purchase');
    expect(events[0].valueCents).toBe(9900);
    expect(events[0].campaignSendId).toBe(sendId);
    expect(events[0].contactId).toBe(contactId);

    const [send] = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.id, sendId));
    expect(send.convertedAt).toBeTruthy();
  });

  it('creates the contact for an unknown address and leaves attribution null', async () => {
    const res = await post(TOKEN, { event: 'signup', email: 'new@lead.test' });
    expect(res.status).toBe(200);
    const events = await db
      .select()
      .from(conversionEvents)
      .where(eq(conversionEvents.event, 'signup'));
    expect(events).toHaveLength(1);
    expect(events[0].campaignSendId).toBeNull();
    const [c] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, 'new@lead.test'));
    expect(c).toBeTruthy(); // upserted — the conversion identified a new lead
  });

  it('rejects a body with no identity', async () => {
    const res = await post(TOKEN, { event: 'purchase' });
    expect(res.status).toBe(400);
  });
});
