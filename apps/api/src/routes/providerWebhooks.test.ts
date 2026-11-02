import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agentConnections,
  agents,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { encryptSecret } from '../lib/secrets.js';
import { providerWebhookRoutes } from './providerWebhooks.js';

let db: Db;
let app: ReturnType<typeof providerWebhookRoutes>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = providerWebhookRoutes(db);
});

let seedN = 0;
const seed = async (provider: string, creds: object) => {
  const n = ++seedN;
  const [ws] = await db.insert(workspaces).values({ name: `W-${provider}-${n}` }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'A', apiKeyHash: `h${n}`, apiKeyPreview: `p${n}`, hosted: true })
    .returning();
  const [conn] = await db
    .insert(agentConnections)
    .values({
      agentId: agent.id,
      workspaceId: ws.id,
      provider,
      label: 'x',
      credentialsEnc: encryptSecret(JSON.stringify(creds)),
    })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: `webchat:test:${agent.id}` })
    .returning();
  await db.insert(messages).values({
    conversationId: conv.id,
    direction: 'out',
    text: 'done',
    payload: {
      inspector: {
        tools: [
          {
            name: 'linear_create_issue',
            result: '{"data":{"issueCreate":{"issue":{"identifier":"JAN-9"}}}}',
          },
        ],
      },
    },
  });
  return { ws, agent, conn, conv };
};

describe('linear webhook → ticket-closed note', () => {
  it('rejects a bad signature and posts once on a real terminal transition', async () => {
    const { conn, conv } = await seed('linear', { webhook_secret: 'sec' });
    const body = JSON.stringify({
      type: 'Issue',
      action: 'update',
      updatedFrom: { stateId: 's1' },
      data: { identifier: 'JAN-9', title: 'Broken checkout', state: { name: 'Done', type: 'completed' } },
    });
    const sign = (b: string, s: string) =>
      createHmac('sha256', s).update(b).digest('hex');

    const bad = await app.request(`/linear/${conn.agentId}`, {
      method: 'POST',
      headers: { 'linear-signature': sign(body, 'wrong') },
      body,
    });
    expect(bad.status).toBe(401);

    const ok = await app.request(`/linear/${conn.agentId}`, {
      method: 'POST',
      headers: { 'linear-signature': sign(body, 'sec') },
      body,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).posted).toBe(1);

    const notes = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const note = notes.find((m) => (m.payload as { closed_ticket?: string }).closed_ticket === 'JAN-9');
    expect(note?.text).toContain('JAN-9');
    expect(note?.text).toContain('Done');
    // customer-visible — not an internal annotation
    expect((note?.payload as { internal?: boolean }).internal).toBeUndefined();

    // a repeat delivery dedupes on closed_ticket
    const again = await app.request(`/linear/${conn.agentId}`, {
      method: 'POST',
      headers: { 'linear-signature': sign(body, 'sec') },
      body,
    });
    expect((await again.json()).posted).toBe(0);
  });

  it('skips non-terminal updates', async () => {
    const { conn } = await seed('linear', { webhook_secret: 'sec2' });
    const body = JSON.stringify({
      type: 'Issue',
      action: 'update',
      updatedFrom: { title: 'x' },
      data: { identifier: 'JAN-9', title: 't', state: { name: 'Done', type: 'completed' } },
    });
    const res = await app.request(`/linear/${conn.agentId}`, {
      method: 'POST',
      headers: { 'linear-signature': createHmac('sha256', 'sec2').update(body).digest('hex') },
      body,
    });
    expect((await res.json()).skipped).toBe(true);
  });
});

describe('jira webhook → ticket-closed note', () => {
  it('verifies the URL token and posts on statusCategory=done', async () => {
    const { conn, conv } = await seed('jira', { webhook_secret: 'tok' });
    const body = {
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'JAN-9',
        fields: { summary: 'x', status: { name: 'Done', statusCategory: { key: 'done' } } },
      },
      changelog: { items: [{ field: 'status' }] },
    };
    const bad = await app.request(`/jira/${conn.agentId}/nope`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(bad.status).toBe(401);

    const ok = await app.request(`/jira/${conn.agentId}/tok`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect((await ok.json()).posted).toBe(1);
    const notes = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(notes.some((m) => (m.payload as { closed_ticket?: string }).closed_ticket === 'JAN-9')).toBe(true);
  });
});
