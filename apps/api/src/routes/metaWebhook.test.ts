import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, workspaces } from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';

const SECRET = 'webhook-test-secret';
const RELAY_URL = 'https://legacy.test/messenger/webhook';
const LEGACY_PAGE = '112299316820834';
const NEW_PAGE = '999900001';
const ONLY_PAGE = '999900002';
const UNOWNED_PAGE = '999900003';

let db: Db;
let app: Hono;
let relayed: { body: string; sig?: string }[];

const post = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  return app.request('/channels/meta/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
};

// A delivery parseMetaWebhook reduces to zero messages — the shape that used
// to die at the msg-level relay gate.
const echoBatch = (pageId: string) => ({
  object: 'page',
  entry: [
    {
      id: pageId,
      messaging: [
        {
          sender: { id: pageId },
          recipient: { id: 'user-1' },
          timestamp: Date.now(),
          message: {
            mid: 'm_echo1',
            is_echo: true,
            app_id: 1678638095724206,
            text: 'bot reply',
          },
        },
      ],
    },
  ],
});

beforeAll(async () => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_LEGACY_WEBHOOK_URL = RELAY_URL;
  const { channelWebhookRoutes } = await import('./channels.js');
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/channels', channelWebhookRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  const mkAgent = (metadata?: Record<string, unknown>) => {
    const { hash, preview } = generateApiKey();
    return db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'B',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        ...(metadata ? { metadata } : {}),
      })
      .returning();
  };
  const mkPageChannel = async (pageId: string, agentId: string) =>
    db.insert(channels).values({
      workspaceId: ws.id,
      agentId,
      kind: 'messenger',
      name: `p-${pageId}`,
      credentials: { page_id: pageId, access_token: 't' },
    });

  const [legacy] = await mkAgent({ legacy_client_key: 'legacy-key-1' });
  await mkPageChannel(LEGACY_PAGE, legacy.id);
  const [fresh] = await mkAgent();
  await mkPageChannel(NEW_PAGE, fresh.id);
  const [only] = await mkAgent({ legacy_client_key: 'k', janis_only: true });
  await mkPageChannel(ONLY_PAGE, only.id);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === RELAY_URL) {
        relayed.push({
          body: String(init?.body ?? ''),
          sig: (init?.headers as Record<string, string> | undefined)?.[
            'x-hub-signature-256'
          ],
        });
      }
      return new Response('ok', { status: 200 });
    }),
  );
});

beforeEach(() => {
  relayed = [];
});

describe('meta webhook → legacy relay', () => {
  it('forwards an echo-only batch for a legacy-owned page, verbatim', async () => {
    const body = echoBatch(LEGACY_PAGE);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].body).toBe(JSON.stringify(body));
    expect(relayed[0].sig).toBe(
      'sha256=' +
        createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex'),
    );
  });

  it('forwards a batch for a page nobody owns', async () => {
    const res = await post(echoBatch(UNOWNED_PAGE));
    expect(res.status).toBe(200);
    expect(relayed).toHaveLength(1);
  });

  it('does not forward for a new-Janis-only page', async () => {
    const res = await post(echoBatch(NEW_PAGE));
    expect(res.status).toBe(200);
    expect(relayed).toHaveLength(0);
  });

  it('does not forward for a janis_only page', async () => {
    const res = await post(echoBatch(ONLY_PAGE));
    expect(res.status).toBe(200);
    expect(relayed).toHaveLength(0);
  });

  it('still forwards ordinary inbound on a legacy page', async () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: LEGACY_PAGE,
          messaging: [
            {
              sender: { id: 'user-9' },
              recipient: { id: LEGACY_PAGE },
              timestamp: Date.now(),
              message: { mid: 'm_in1', text: 'hello' },
            },
          ],
        },
      ],
    };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(relayed).toHaveLength(1);
  });
});
