import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
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
import { env } from '../env.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret';

const CLIENT_KEY = 'test-client-key';

let db: Db;
let app: Hono;
let channel: typeof channels.$inferSelect;

const entry = (id: string, messaging: unknown[] = [], standby: unknown[] = []) =>
  JSON.stringify({ object: 'page', entry: [{ id, messaging, standby }] });
const userMsg = (text: string, mid = 'mid.1', sender = 'PSID1') => ({
  sender: { id: sender },
  recipient: { id: 'PGLEG' },
  timestamp: 1,
  message: { mid, text },
});
const echo = (text: string, appId: number | undefined, mid = 'echo.1', user = 'PSID1') => ({
  sender: { id: 'PGLEG' },
  recipient: { id: user },
  timestamp: 1,
  message: { mid, is_echo: true, text, ...(appId != null ? { app_id: appId } : {}) },
});
const postWebhook = (b: string) =>
  app.request('/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
const postFallback = (flavor: string, body: Record<string, unknown>) =>
  app.request(`/client/${CLIENT_KEY}/${flavor}/fallback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// A real RSA key so the JWT signer works; fetch is stubbed so it never leaves the box.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const saPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const dfV2 = (fulfillmentMessages: unknown[], extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      queryResult: {
        fulfillmentMessages,
        intent: { name: 'projects/p/agent/intents/i1', displayName: 'welcome' },
        ...extra,
      },
    }),
    { status: 200 },
  );

function stubFetches(dfImpl?: () => Response) {
  return vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com'))
      return new Response(JSON.stringify({ access_token: 'goog-tok', expires_in: 3600 }), { status: 200 });
    if (u.includes('dialogflow.googleapis.com') && u.includes('knowledgeBases'))
      return new Response('{}', { status: 200 });
    if (u.includes('dialogflow.googleapis.com') && u.includes(':detectIntent'))
      return dfImpl ? dfImpl() : dfV2([{ text: { text: ['hi from df'] } }]);
    if (u.includes('dialogflow.googleapis.com') && u.includes('/contexts/janis'))
      return new Response('{}', { status: init?.method === 'DELETE' ? 200 : 404 });
    if (u.includes('graph.facebook.com')) return new Response('{}', { status: 200 });
    if (u.includes('api.manychat.com')) return new Response('{}', { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

const dfCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((c) => String(c[0]).includes(':detectIntent'));
const manychatCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((c) => String(c[0]).includes('api.manychat.com'));

const convByUser = async (user = 'PSID1') => {
  const [conv] = await db.select().from(conversations).where(eq(conversations.externalId, `messenger:${user}`));
  return conv;
};
const msgsFor = async (convId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, convId));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'T' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'LegacyBot',
      hosted: true,
      config: {
        engine: 'monitor',
        dialogflow: { project: 'test-proj', lang: 'en' },
        legacy: { client_key: CLIENT_KEY, code_lang: 'chatfuel' },
        greeting_enabled: false,
      },
      metadata: { legacy_client_key: CLIENT_KEY },
    })
    .returning();
  await db.insert(agentSecrets).values({
    workspaceId: ws.id,
    agentId: agent.id,
    name: 'DIALOGFLOW_SA_JSON',
    valueEnc: encryptSecret(JSON.stringify({ client_email: 'bot@test.iam.gserviceaccount.com', private_key: saPem })),
  });
  channel = (
    await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: agent.id,
        kind: 'messenger',
        name: 'LegacyPage',
        credentials: {
          via: 'legacy',
          page_id: 'PGLEG',
          access_token: 'tok',
          takeover_from_page_inbox: true,
          secondary_receiver_id: '1678638095724206',
        },
      })
      .returning()
  )[0];

  env.metaVerifyToken = 'test-verify';
  env.metaAppId = '1242623579085955';
  const { legacyWebhookRoutes } = await import('./legacy.js');
  app = legacyWebhookRoutes(db) as Hono;
});

beforeEach(() => vi.unstubAllGlobals());

describe('GET /webhook verify', () => {
  it('echoes the challenge for the correct token, rejects others', async () => {
    const okRes = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=CH');
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe('CH');
    const bad = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CH');
    expect(bad.status).toBe(403);
  });
});

describe('POST /webhook echoes', () => {
  it('records a bot-platform echo as an agent reply, no takeover', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    // need a conv first — ingest a user message on standby
    await postWebhook(entry('PGLEG', [], [userMsg('hi', 'mid.u1')]));
    const conv = await convByUser();
    expect(conv.state).toBe('active');

    // Chatfuel (app_id 1741778729635214-ish) replies → transcript 'out'
    await postWebhook(entry('PGLEG', [], [echo('bot says hi', 1741778729635214, 'echo.b1')]));
    const msgs = await msgsFor(conv.id);
    const botMsg = msgs.find((m) => m.direction === 'out' && m.text === 'bot says hi');
    expect(botMsg).toBeDefined();
    expect((botMsg!.payload as { via?: string }).via).toBe('bot_echo');
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active'); // no takeover
  });

  it('page-inbox echoes (null / 263902037430900 / janis app) pause the bot', async () => {
    vi.stubGlobal('fetch', stubFetches());
    const conv = await convByUser();
    for (const appId of [undefined, 263902037430900, 1242623579085955]) {
      await db.update(conversations).set({ state: 'active', humanSince: null, tags: [] }).where(eq(conversations.id, conv.id));
      await postWebhook(entry('PGLEG', [echo('human here', appId, `echo.h${appId}`)], []));
      const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
      expect(after.state).toBe('human');
      expect(after.tags).toContain('page-inbox-takeover');
    }
  });
});

describe('POST /client/:key/chatfuel/fallback', () => {
  it('answers with chatfuel-format messages from DF', async () => {
    vi.stubGlobal('fetch', stubFetches());
    // clear the page-inbox pause left by the echo tests
    const prev = await convByUser();
    if (prev) {
      await db.update(conversations).set({ state: 'active', humanSince: null, tags: [] }).where(eq(conversations.id, prev.id));
    }
    const res = await postFallback('chatfuel', {
      'messenger user id': 'PSID1',
      'user input': 'do you ship to PR?',
      'dfContext': 'ordering, vip',
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { messages: { text?: string }[] };
    expect(j.messages[0].text).toBe('hi from df');

    // inbound + outbound transcript entries
    const conv = await convByUser();
    const msgs = await msgsFor(conv.id);
    expect(msgs.some((m) => m.direction === 'in' && m.text === 'do you ship to PR?')).toBe(true);
    expect(msgs.some((m) => m.direction === 'out' && m.text === 'hi from df')).toBe(true);

    // DF got the contexts: janis + the two named ones, session = user id
    const dfBody = JSON.parse((dfCalls(vi.mocked(fetch)).at(-1)![1] as RequestInit).body as string);
    expect(dfBody.queryInput.text.text).toBe('do you ship to PR?');
    const ctxNames = (dfBody.queryParams.contexts as { name: string }[]).map((c) => c.name);
    expect(ctxNames.some((n) => n.endsWith('/contexts/janis'))).toBe(true);
    expect(ctxNames.some((n) => n.endsWith('/contexts/ordering'))).toBe(true);
    expect(ctxNames.some((n) => n.endsWith('/contexts/vip'))).toBe(true);
  });

  it('returns empty messages while a human owns the conversation', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    const conv = await convByUser();
    await db.update(conversations).set({ state: 'human', humanSince: new Date(), tags: [] }).where(eq(conversations.id, conv.id));

    const res = await postFallback('chatfuel', { 'messenger user id': 'PSID1', 'user input': 'hello?' });
    const j = (await res.json()) as { messages: unknown[] };
    expect(j.messages).toEqual([]);
    // inbound still logged for the transcript
    const msgs = await msgsFor(conv.id);
    expect(msgs.some((m) => m.direction === 'in' && m.text === 'hello?')).toBe(true);
  });

  it('auto-resumes a page-inbox pause after the takeover timeout', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    const conv = await convByUser();
    const stale = new Date(Date.now() - 10 * 60_000);
    await db
      .update(conversations)
      .set({ state: 'human', humanSince: stale, tags: ['page-inbox-takeover'] })
      .where(eq(conversations.id, conv.id));

    const res = await postFallback('chatfuel', { 'messenger user id': 'PSID1', 'user input': 'back yet?' });
    const j = (await res.json()) as { messages: { text?: string }[] };
    expect(j.messages[0]?.text).toBe('hi from df');
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active');
  });

  it('fires a handoff + pause on a takeover action', async () => {
    vi.stubGlobal('fetch', stubFetches(() =>
      dfV2([{ text: { text: ['connecting you'] } }], {
        action: 'takeover',
        parameters: {},
        intent: { name: 'projects/p/agent/intents/i9', displayName: 'handover' },
      }),
    ));
    const res = await postFallback('chatfuel', { 'messenger user id': 'PSID2', 'user input': 'human please' });
    const j = (await res.json()) as { messages: { text?: string }[] };
    expect(j.messages[0]?.text).toBe('connecting you');
    const conv = await convByUser('PSID2');
    expect(conv.state).toBe('human');
  });
});

describe('POST /client/:key/manychat/fallback', () => {
  it('returns v2 content and pushes via the manychat token', async () => {
    const fetchMock = stubFetches();
    vi.stubGlobal('fetch', fetchMock);
    await db
      .update(channels)
      .set({ credentials: { ...(channel.credentials as object), manychat_token: 'mc-tok' } })
      .where(eq(channels.id, channel.id));

    const res = await postFallback('manychat', {
      id: '998877',
      last_input_text: 'mc hello',
      custom_fields: { 'user input': 'mc hello', city: 'Ponce' },
      tags: [{ name: 'vip' }],
    });
    const j = (await res.json()) as { version: string; content: { messages: { type: string; text?: string }[] } };
    expect(j.version).toBe('v2');
    expect(j.content.messages[0].text).toBe('hi from df');
    // server-side sendContent fired with the subscriber id
    const sc = manychatCalls(fetchMock).find((c) => String(c[0]).includes('sendContent'));
    expect(sc).toBeDefined();
    expect(String((sc![1] as RequestInit).body)).toContain('"subscriber_id":"998877"');
    // contexts carried the tag + custom field
    const dfBody = JSON.parse((dfCalls(fetchMock).at(-1)![1] as RequestInit).body as string);
    const ctxNames = (dfBody.queryParams.contexts as { name: string }[]).map((c) => c.name);
    expect(ctxNames.some((n) => n.endsWith('/contexts/vip'))).toBe(true);
  });
});

describe('misc', () => {
  it('ignores webhooks for pages we do not own', async () => {
    const res = await postWebhook(entry('OTHERPAGE', [userMsg('hi', 'mid.x')]));
    expect(res.status).toBe(200);
    expect(await db.select().from(conversations).where(eq(conversations.externalId, 'messenger:PSID9'))).toHaveLength(0);
  });

  it('stores the manychat app token', async () => {
    const res = await app.request(`/client/${CLIENT_KEY}/manychat/app-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_token: 'tok-xyz' }),
    });
    expect(res.status).toBe(200);
    const [ch] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((ch.credentials as { manychat_token?: string }).manychat_token).toBe('tok-xyz');
  });
});
