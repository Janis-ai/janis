import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Hono } from 'hono';
import * as schema from '../db/schema.js';
import {
  agents,
  agentSecrets,
  channels,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { encryptSecret } from '../lib/secrets.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret';

const CLIENT_KEY = 'sdk-client-key';
const PSID = 'PSID-SDK-1';

let db: Db;
let app: Hono;
let conv: typeof conversations.$inferSelect;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const saPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const rawbody = (pageId: string) =>
  JSON.stringify({
    object: 'page',
    entry: [{ id: pageId, messaging: [{ sender: { id: PSID }, message: { text: 'x' } }] }],
  });

const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      clientkey: CLIENT_KEY,
      platform: 'messenger',
      ...headers,
    },
    body: JSON.stringify(body),
  });

function stubFetches() {
  return vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com'))
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (u.includes('dialogflow.googleapis.com') && u.includes('knowledgeBases'))
      return new Response('{}', { status: 200 });
    if (u.includes('dialogflow.googleapis.com') && u.includes(':detectIntent'))
      return new Response(
        JSON.stringify({
          responseId: 'r1',
          queryResult: {
            queryText: 'hi',
            fulfillmentText: 'df says hi',
            fulfillmentMessages: [{ text: { text: ['df says hi'] } }],
            intent: { name: 'projects/p/agent/intents/i1', displayName: 'welcome' },
          },
        }),
        { status: 200 },
      );
    return new Response('{}', { status: init?.method === 'DELETE' ? 200 : 404 });
  });
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'SdkBot',
      hosted: false, // self-hosted — the SDK logs transcripts; we never dispatch
      config: { engine: 'monitor', dialogflow: { project: 'test-proj', lang: 'en' } },
      metadata: {
        legacy_client_key: CLIENT_KEY,
        legacy_stripe: { subscription_id: 'sub_test_fake' }, // Stripe fetch fails → fail-open allow
      },
    })
    .returning();
  await db.insert(agentSecrets).values({
    workspaceId: ws.id,
    agentId: agent.id,
    name: 'DIALOGFLOW_SA_JSON',
    valueEnc: encryptSecret(
      JSON.stringify({ client_email: 'bot@test.iam.gserviceaccount.com', private_key: saPem }),
    ),
  });
  await db.insert(channels).values({
    workspaceId: ws.id,
    agentId: agent.id,
    kind: 'messenger',
    name: 'SdkPage',
    credentials: { page_id: 'PGSDK', access_token: 'tok' },
  });

  const { legacyApiRoutes } = await import('./legacyApi.js');
  app = legacyApiRoutes(db) as Hono;
});

beforeEach(() => vi.unstubAllGlobals());

describe('legacy /api/v1 SDK endpoints', () => {
  it('stores inbound and returns channel state', async () => {
    vi.stubGlobal('fetch', stubFetches());
    const res = await post('/in', {
      text: 'hello there',
      channel: PSID,
      user: PSID,
      mid: 'mid.in.1',
      rawbody: rawbody('PGSDK'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: false, id: PSID });

    [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, `messenger:${PSID}`));
    expect(conv).toBeTruthy();
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.map((m) => m.direction)).toEqual(['in']);
    expect(msgs[0].text).toBe('hello there');
  });

  it('stores outbound without re-delivering to the page', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('/out', {
      text: 'bot reply',
      channel: PSID,
      user: PSID,
      mid: 'mid.out.1',
      rawbody: rawbody('PGSDK'),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');

    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    const out = msgs.filter((m) => m.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('bot reply');
    // never touches graph.facebook.com — the self-hosted bot already sent it
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('graph.facebook.com'))).toBe(false);
  });

  it('detectintent header returns the v1-shaped reply array', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post(
      '/in',
      { text: 'what time', channel: 'PSID-DI', user: 'PSID-DI', mid: 'mid.di.1' },
      { detectintent: '1' },
    );
    expect(res.status).toBe(200);
    const arr = (await res.json()) as { reply?: string }[];
    expect(arr).toHaveLength(1);
    const reply = JSON.parse(arr[0].reply!);
    expect(reply.result.fulfillment.speech).toBe('df says hi');
    expect(reply.result.metadata.intentName).toBe('welcome');
  });

  it('refuses unknown client keys and stores nothing', async () => {
    vi.stubGlobal('fetch', stubFetches());
    const res = await app.request('/in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', clientkey: 'bogus' },
      body: JSON.stringify({ text: 'x', channel: 'P9' }),
    });
    expect(await res.json()).toEqual({ error: 'no subscription found' });
    const [none] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'messenger:P9'));
    expect(none).toBeUndefined();
  });

  it('reports paused when a human owns the conversation', async () => {
    vi.stubGlobal('fetch', stubFetches());
    await db.update(conversations).set({ state: 'human' }).where(eq(conversations.id, conv.id));
    const res = await post('/in', { text: 'anyone?', channel: PSID, user: PSID, mid: 'mid.in.2' });
    expect(await res.json()).toEqual({ paused: true, id: PSID });
  });

  it('update_bot_socket_id stores the socket on the agent', async () => {
    vi.stubGlobal('fetch', stubFetches());
    const res = await post('/update_bot_socket_id', { socket_id: 'sock123' });
    expect(res.status).toBe(200);
    const [a] = await db.select().from(agents).where(eq(agents.name, 'SdkBot'));
    expect((a.metadata as { legacy_socket_id?: string }).legacy_socket_id).toBe('sock123');
  });

  it('operator replies reach a socket-registered bot via POST /send', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    const { deliverToChannel } = await import('../lib/channels.js');
    await deliverToChannel(db, conv.id, 'operator says hi');
    const send = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('wordhop-socket-server.herokuapp.com/send'),
    );
    expect(send).toBeTruthy();
    const body = JSON.parse(String(send![1]?.body));
    expect(body.socket_id).toBe('sock123');
    expect(body.message_type).toBe('chat response');
    expect(body.message.text).toBe('operator says hi');
    expect(body.recipient.id).toBe(PSID);
    // and NOT via graph.facebook.com — socket is the delivery path
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('graph.facebook.com'))).toBe(
      false,
    );
  });
});
