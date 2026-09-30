import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaignSends,
  campaigns,
  channelBindings,
  channels,
  contacts,
  conversations,
  messages,
  suppressions,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { smsRoutes } from './sms.js';
import { sendChannelMessage } from '../lib/channels.js';
import { env } from '../env.js';

const AUTH_TOKEN = 'testtwilioauthtoken';
const ORIGIN = env.apiOrigin;

let db: Db;
let app: Hono;
let channel: typeof channels.$inferSelect;
let wsId: string;
let agentId: string;

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
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, caller),
      ),
    )
    .limit(1);
  return b?.conv;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/sms', smsRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  agentId = agent.id;
  [channel] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'sms',
      name: 'SMS line',
      credentials: {
        twilio_account_sid: 'AC123',
        twilio_auth_token: AUTH_TOKEN,
        phone_number: '+15550001111',
      },
    })
    .returning();
});

describe('Twilio SMS webhooks', () => {
  it('rejects a bad signature', async () => {
    const res = await post(
      `/sms/${channel.id}`,
      { MessageSid: 'SM1', From: '+15551112222', To: '+15550001111', Body: 'hi' },
      true,
    );
    expect(res.status).toBe(401);
  });

  it('rejects an unknown channel', async () => {
    const res = await post(`/sms/${crypto.randomUUID()}`, {
      MessageSid: 'SM2',
      From: '+15551112222',
      Body: 'hi',
    });
    expect(res.status).toBe(404);
  });

  it('stores an inbound text as a conversation + message keyed on the caller', async () => {
    const res = await post(`/sms/${channel.id}`, {
      MessageSid: 'SM3',
      From: '+15553334444',
      To: '+15550001111',
      Body: 'where is my order',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Response>');

    const conv = await convForCaller('+15553334444');
    expect(conv).toBeTruthy();
    expect(conv!.agentId).toBe(agentId);
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id));
    expect(msgs.some((m) => m.direction === 'in' && m.text === 'where is my order')).toBe(true);
  });

  it('reuses the same conversation for repeat texts from one caller', async () => {
    await post(`/sms/${channel.id}`, {
      MessageSid: 'SM4',
      From: '+15553334444',
      To: '+15550001111',
      Body: 'and also my refund',
    });
    const convs = await db
      .select()
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.channelId, channel.id),
          eq(channelBindings.platformUserId, '+15553334444'),
        ),
      );
    expect(convs).toHaveLength(1);
  });

  it('dedups a retried webhook by MessageSid', async () => {
    const params = {
      MessageSid: 'SM-DUP',
      From: '+15553334444',
      To: '+15550001111',
      Body: 'did you get this twice',
    };
    await post(`/sms/${channel.id}`, params);
    await post(`/sms/${channel.id}`, params);
    const conv = await convForCaller('+15553334444');
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id));
    expect(rows.filter((m) => m.text === 'did you get this twice')).toHaveLength(1);
  });
});

describe('outbound SMS', () => {
  it('posts to the Twilio Messages API with the channel number', async () => {
    const calls: { url: string; params: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        params: Object.fromEntries(new URLSearchParams(String(init?.body ?? '')).entries()),
      });
      return Response.json({ sid: 'SM-sent-1' });
    });
    const r = await sendChannelMessage(channel, '+15553334444', 'your order ships Tuesday');
    expect(r?.mid).toBe('SM-sent-1');
    expect(r?.error).toBeNull();
    expect(calls[0].url).toContain('/Accounts/AC123/Messages.json');
    expect(calls[0].params.From).toBe('+15550001111');
    expect(calls[0].params.To).toBe('+15553334444');
    expect(calls[0].params.Body).toBe('your order ships Tuesday');
    vi.unstubAllGlobals();
  });

  it('surfaces a Twilio rejection with retryability', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ code: 21211, message: 'invalid To number' }, { status: 400 }),
    );
    const r = await sendChannelMessage(channel, '+1555bad', 'hello');
    expect(r?.mid).toBeNull();
    expect(r?.error).toContain('Twilio');
    expect(r?.retryable).toBe(false); // bad number — permanent
    vi.unstubAllGlobals();
  });

  it('requests a StatusCallback so undelivered finals reach the loop', async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')).entries());
      return Response.json({ sid: 'SM-cb' });
    });
    await sendChannelMessage(channel, '+15553334444', 'hi');
    expect(seen.StatusCallback).toBe(`${ORIGIN}/sms/${channel.id}/status`);
    vi.unstubAllGlobals();
  });
});

describe('delivery status callback', () => {
  it('suppresses a dead number and flips the recent send to failed', async () => {
    const [camp] = await db
      .insert(campaigns)
      .values({ workspaceId: wsId, channelId: channel.id, name: 'Blast', text: 'x', status: 'sending' })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, phone: '+15559998888' })
      .returning();
    const [send] = await db
      .insert(campaignSends)
      .values({
        workspaceId: wsId,
        campaignId: camp.id,
        contactId: contact.id,
        channelId: channel.id,
        recipient: '+15559998888',
        status: 'sent',
        sentAt: new Date(),
      })
      .returning();

    const res = await post(`/sms/${channel.id}/status`, {
      MessageSid: 'SM-dead',
      MessageStatus: 'undelivered',
      ErrorCode: '30034',
      To: '+15559998888',
      From: '+15550001111',
    });
    expect(res.status).toBe(200);

    const sups = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspaceId, wsId));
    expect(
      sups.some((s) => s.address === '+15559998888' && s.reason === 'dead_number'),
    ).toBe(true);
    const [after] = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.id, send.id));
    expect(after.status).toBe('failed');
    expect(after.error).toContain('30034');
  });

  it('ignores non-final statuses and bad signatures', async () => {
    const params = {
      MessageSid: 'SM-pending',
      MessageStatus: 'delivered',
      To: '+15551119999',
      From: '+15550001111',
    };
    const ok = await post(`/sms/${channel.id}/status`, params);
    expect(ok.status).toBe(200);
    const bad = await post(`/sms/${channel.id}/status`, params, true);
    expect(bad.status).toBe(401);
    const sups = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.address, '+15551119999'));
    expect(sups).toHaveLength(0); // delivered → no suppression
  });
});
