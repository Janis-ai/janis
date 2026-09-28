import { beforeAll, describe, expect, it } from 'vitest';
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
