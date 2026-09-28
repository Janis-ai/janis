import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channelBindings,
  channels,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { voiceRoutes } from './voice.js';
import { voiceDeliver } from '../lib/voiceBridge.js';
import { env } from '../env.js';

// env.ts reads process.env at import time — hoist so hosted voice is
// "configured" before any module in this file's graph loads.
vi.hoisted(() => {
  process.env.TWILIO_ACCOUNT_SID = 'ACmaster';
  process.env.TWILIO_AUTH_TOKEN = 'mastertoken';
});

const AUTH_TOKEN = 'testtwilioauthtoken';
const ORIGIN = env.apiOrigin;

let db: Db;
let app: Hono;
let channel: typeof channels.$inferSelect;

/** Twilio signature: base64 HMAC-SHA1 of url + sorted post params. */
function sign(path: string, params: Record<string, string>): string {
  const url = `${ORIGIN}${path}`;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

function post(path: string, params: Record<string, string>, badSig = false) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': badSig ? 'bogus' : sign(path, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function convForCaller(caller: string) {
  const [b] = await db
    .select({ conv: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(eq(channelBindings.platformUserId, caller))
    .limit(1);
  return b?.conv;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/voice', voiceRoutes(db, { replyWaitMs: 60 }));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  [channel] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'voice',
      name: 'Support line',
      credentials: {
        twilio_account_sid: 'AC123',
        twilio_auth_token: AUTH_TOKEN,
        phone_number: '+15550001111',
        forward_to: '+15559998888',
        greeting: 'Thanks for calling Acme.',
      },
    })
    .returning();
});

describe('Twilio voice webhooks', () => {
  it('answers an incoming call with greeting + speech Gather', async () => {
    const path = `/voice/${channel.id}/incoming`;
    const res = await post(path, { CallSid: 'CA1', From: '+15551112222', To: '+15550001111' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('Thanks for calling Acme.');
    expect(xml).toContain(`<Gather input="speech" action="/voice/${channel.id}/turn"`);
  });

  it('rejects a bad signature', async () => {
    const res = await post(
      `/voice/${channel.id}/incoming`,
      { CallSid: 'CA2', From: '+15551112222' },
      true,
    );
    expect(res.status).toBe(403);
  });

  it('rejects an unknown channel', async () => {
    const path = `/voice/${crypto.randomUUID()}/incoming`;
    const res = await post(path, { CallSid: 'CA3', From: '+15551112222' });
    expect(res.status).toBe(403);
  });

  it('stores transcribed speech as an inbound message on the caller conversation', async () => {
    const path = `/voice/${channel.id}/turn`;
    const res = await post(path, {
      CallSid: 'CA4',
      From: '+15553334444',
      SpeechResult: 'where is my order',
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    // no hosted agent — waits replyWaitMs then polls again
    expect(xml).toContain('One moment');
    expect(xml).toContain(`<Redirect method="POST">/voice/${channel.id}/turn?r=1</Redirect>`);

    const conv = await convForCaller('+15553334444');
    expect(conv).toBeTruthy();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id));
    expect(msgs.some((m) => m.direction === 'in' && m.text === 'where is my order')).toBe(true);
  });

  it('speaks a queued agent reply and re-gathers', async () => {
    const conv = (await convForCaller('+15553334444'))!;
    voiceDeliver(conv.id, 'Your order ships Tuesday.');
    const res = await post(`/voice/${channel.id}/turn`, {
      CallSid: 'CA4',
      From: '+15553334444',
    });
    const xml = await res.text();
    expect(xml).toContain('Your order ships Tuesday.');
    expect(xml).toContain('<Gather');
  });

  it('bridges to the forward-to number when a human owns the conversation', async () => {
    const conv = (await convForCaller('+15553334444'))!;
    await db.update(conversations).set({ state: 'human' }).where(eq(conversations.id, conv.id));
    const res = await post(`/voice/${channel.id}/turn`, {
      CallSid: 'CA4',
      From: '+15553334444',
    });
    const xml = await res.text();
    expect(xml).toContain('<Dial>+15559998888</Dial>');
    await db.update(conversations).set({ state: 'active' }).where(eq(conversations.id, conv.id));
  });

  it('hangs up politely after too many silent polls', async () => {
    const res = await post(`/voice/${channel.id}/turn?r=5`, {
      CallSid: 'CA4',
      From: '+15553334444',
    });
    const xml = await res.text();
    expect(xml).toContain('<Hangup/>');
  });
});

describe('hosted voice provisioning', () => {
  let api: Hono;
  let cookie: string;
  let agentId: string;
  const calls: { url: string; method: string; params: Record<string, string> }[] = [];

  beforeAll(async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACmaster';
    process.env.TWILIO_AUTH_TOKEN = 'mastertoken';
    const { channelApiRoutes } = await import('./channels.js');
    const { sessions, users, memberships } = await import('../db/schema.js');
    const { generateSessionToken, hashPassword } = await import('../lib/crypto.js');
    api = new Hono().route('/api/channels', channelApiRoutes(db));

    const [ws] = await db.select().from(workspaces).limit(1);
    const [agent] = await db.select().from(agents).limit(1);
    agentId = agent.id;
    const [u] = await db
      .insert(users)
      .values({ email: 'v@v.c', name: 'V', passwordHash: await hashPassword('password123') })
      .returning();
    await db
      .insert(memberships)
      .values({ userId: u.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) });
    cookie = `janis_session=${token}`;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const params = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? '')).entries(),
      );
      calls.push({ url, method: init?.method ?? 'GET', params });
      if (url.endsWith('/Accounts.json') && init?.method === 'POST') {
        return Response.json({ sid: 'ACsub1', auth_token: 'subtoken1' });
      }
      if (url.includes('/IncomingPhoneNumbers.json')) {
        return Response.json({ sid: 'PN1', phone_number: params.PhoneNumber });
      }
      return Response.json({}, { status: 404 });
    });
  });

  it('provisions a subaccount + number with webhooks prewired', async () => {
    const res = await api.request('/api/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        kind: 'voice',
        name: 'Voice line',
        agent_id: agentId,
        hosted: true,
        phone_number: '+15550101010',
      }),
    });
    expect(res.status).toBe(201);
    const { channel: ch } = (await res.json()) as { channel: { id: string; meta: { phone_number?: string } } };
    expect(ch.meta.phone_number).toBe('+15550101010');

    const buy = calls.find((x) => x.url.includes('IncomingPhoneNumbers'));
    expect(buy?.params.VoiceUrl).toBe(`${ORIGIN}/voice/${ch.id}/incoming`);
    expect(buy?.params.StatusCallback).toBe(`${ORIGIN}/voice/${ch.id}/status`);

    const [row] = await db.select().from(channels).where(eq(channels.id, ch.id));
    const creds = row.credentials as Record<string, unknown>;
    expect(creds.hosted).toBe(true);
    expect(creds.twilio_account_sid).toBe('ACsub1');
    expect(creds.twilio_auth_token).toBe('subtoken1');
    expect(creds.twilio_number_sid).toBe('PN1');
  });
});
