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
  alerts,
  conversations,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { bus } from '../lib/bus.js';
import { alertRoutes } from './alerts.js';
import { conversationRoutes } from './conversations.js';

let db: Db;
let app: Hono;
let cookie: string;
let wsId: string;
let convId: string;
let otherWsAlertId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/alerts', alertRoutes(db))
    .route('/api/conversations', conversationRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  wsId = ws.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'c1' })
    .returning();
  convId = conv.id;

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

  // an alert in a DIFFERENT workspace — must be invisible to this session
  const [ws2] = await db.insert(workspaces).values({ name: 'W2' }).returning();
  const [a2] = await db
    .insert(agents)
    .values({ workspaceId: ws2.id, name: 'b2', apiKeyHash: 'h2', apiKeyPreview: 'p2' })
    .returning();
  const [c2] = await db
    .insert(conversations)
    .values({ agentId: a2.id, externalId: 'x' })
    .returning();
  const [al2] = await db
    .insert(alerts)
    .values({ conversationId: c2.id, type: 'custom', status: 'open' })
    .returning();
  otherWsAlertId = al2.id;
});

const openCount = async () => {
  const res = await app.fetch(new Request('http://t/api/conversations', { headers: { cookie } }));
  const body = (await res.json()) as { conversations: { id: string; open_alert_count: number }[] };
  return body.conversations.find((c) => c.id === convId)?.open_alert_count;
};

describe('POST /alerts/:id/status', () => {
  it('resolves an open alert and drops open_alert_count', async () => {
    const [al] = await db
      .insert(alerts)
      .values({ conversationId: convId, type: 'handoff_offer', status: 'open' })
      .returning();
    expect(await openCount()).toBe(1);

    const res = await app.fetch(
      new Request(`http://t/api/alerts/${al.id}/status`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).alert.status).toBe('resolved');
    expect((await db.select().from(alerts).where(eq(alerts.id, al.id)))[0].status).toBe('resolved');
    expect(await openCount()).toBe(0);
  });

  it('publishes a bus alert event so other clients clear the dot', async () => {
    const seen: unknown[] = [];
    const off = bus.subscribe(wsId, (e) => seen.push(e));
    const [al] = await db
      .insert(alerts)
      .values({ conversationId: convId, type: 'keyword', status: 'open' })
      .returning();
    try {
      const res = await app.fetch(
        new Request(`http://t/api/alerts/${al.id}/status`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'resolved' }),
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      off();
    }
    const evt = seen.find(
      (e) => (e as { type: string; data: { id: string } }).data?.id === al.id,
    ) as { type: string; data: { status: string } } | undefined;
    expect(evt?.type).toBe('alert');
    expect(evt?.data.status).toBe('resolved');
  });

  it('404s on another workspace\u2019s alert', async () => {
    const res = await app.fetch(
      new Request(`http://t/api/alerts/${otherWsAlertId}/status`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      }),
    );
    expect(res.status).toBe(404);
    // untouched
    expect(
      (await db.select().from(alerts).where(eq(alerts.id, otherWsAlertId)))[0].status,
    ).toBe('open');
  });
});
