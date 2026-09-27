import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import {
  agents,
  channelBindings,
  channels,
  conversations,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import type { ChannelCredentials } from '../lib/channels.js';
import type { gmailApiRoutes, gmailPublicRoutes } from './gmail.js';
import type { sweepGmail } from '../services/gmailSweep.js';

let db: Db;
let app: Hono;
let agentId: string;
let cookie: string;
let channel: typeof channels.$inferSelect;
// Wired in beforeAll — env.ts evaluates at module load, so the Google creds
// must be set before these modules import.
let routes: typeof gmailApiRoutes;
let publicRoutes: typeof gmailPublicRoutes;
let sweep: typeof sweepGmail;
let sendChannelMessage: typeof import('../lib/channels.js').sendChannelMessage;

const MAILBOX = 'support@acme.test';
const freshCreds: ChannelCredentials = {
  via: 'oauth',
  email_address: MAILBOX,
  access_token: 'ya29.fresh',
  refresh_token: 'rt_1',
  token_expiry: Date.now() + 3600_000,
  gmail_cursor: 1_700_000_000_000,
};

/** Gmail API response for one inbound mail. */
const gmailMessage = (over: Record<string, unknown> = {}) => ({
  id: 'gm1',
  threadId: 'thr_1',
  internalDate: '1700000005000',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: '"Jane Doe" <jane@x.com>' },
      { name: 'To', value: MAILBOX },
      { name: 'Subject', value: 'Where is my order?' },
      { name: 'Message-ID', value: '<orig@mail.x.com>' },
      { name: 'References', value: '<earlier@mail.x.com>' },
    ],
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: Buffer.from('my order never arrived').toString('base64url') },
      },
    ],
  },
  ...over,
});

/** fetch stub dispatching on URL — override per test with mockImplementation. */
const stubFetch = (routes: Record<string, () => Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      for (const [match, fn] of Object.entries(routes)) {
        if (url.includes(match)) return Promise.resolve(fn());
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = 'gid_test';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret_test';
  const [routesMod, sweepMod, channelsMod] = await Promise.all([
    import('./gmail.js'),
    import('../services/gmailSweep.js'),
    import('../lib/channels.js'),
  ]);
  routes = routesMod.gmailApiRoutes;
  publicRoutes = routesMod.gmailPublicRoutes;
  sweep = sweepMod.sweepGmail;
  sendChannelMessage = channelsMod.sendChannelMessage;

  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/gmail', routes(db))
    .route('/gmail', publicRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  agentId = agent.id;

  const [u] = await db.insert(users).values({ email: 'a@x.test', name: 'a' }).returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  cookie = `${SESSION_COOKIE}=${token}`;

  [channel] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId,
      kind: 'gmail',
      name: 'Support Mailbox',
      credentials: { ...freshCreds, from_name: 'Acme Support' },
    })
    .returning();
});

afterEach(() => vi.unstubAllGlobals());

describe('gmail poller', () => {
  it('ingests inbox mail as a conversation and advances the cursor', async () => {
    stubFetch({
      'messages?': () =>
        new Response(JSON.stringify({ messages: [{ id: 'gm1', threadId: 'thr_1' }] })),
      'messages/gm1': () => new Response(JSON.stringify(gmailMessage())),
    });
    await sweep(db);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'gmail:jane@x.com'));
    expect(conv).toBeTruthy();
    expect((conv.userProfile as { email?: string }).email).toBe('jane@x.com');
    expect((conv.userProfile as { name?: string }).name).toBe('Jane Doe');
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')));
    expect(msg.text).toBe('my order never arrived');
    const em = (msg.payload as { email?: Record<string, unknown> }).email ?? {};
    expect(em.thread_id).toBe('thr_1');
    expect(em.message_id).toBe('<orig@mail.x.com>');
    expect(em.references).toEqual(['<earlier@mail.x.com>']);
    // cursor advanced to the message's internalDate
    const [updated] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((updated.credentials as ChannelCredentials).gmail_cursor).toBe(1_700_000_005_000);
  });

  it('dedups mail already ingested (overlapping polls)', async () => {
    stubFetch({
      'messages?': () =>
        new Response(JSON.stringify({ messages: [{ id: 'gm1', threadId: 'thr_1' }] })),
      'messages/gm1': () => new Response(JSON.stringify(gmailMessage())),
    });
    await sweep(db);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'gmail:jane@x.com'));
    const inbound = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')));
    expect(inbound).toHaveLength(1);
  });

  it('skips our own sends and auto-replies but still advances the cursor', async () => {
    const own = gmailMessage({
      id: 'gm2',
      internalDate: '1700000006000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: MAILBOX }],
        body: { data: Buffer.from('our reply').toString('base64url') },
      },
    });
    const ooo = gmailMessage({
      id: 'gm3',
      internalDate: '1700000007000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'jane@x.com' },
          { name: 'Auto-Submitted', value: 'auto-replied' },
        ],
        body: { data: Buffer.from('away').toString('base64url') },
      },
    });
    stubFetch({
      'messages?': () =>
        new Response(
          JSON.stringify({
            messages: [
              { id: 'gm3', threadId: 't3' },
              { id: 'gm2', threadId: 't2' },
            ],
          }),
        ),
      'messages/gm2': () => new Response(JSON.stringify(own)),
      'messages/gm3': () => new Response(JSON.stringify(ooo)),
    });
    await sweep(db);
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    expect(convs.find((c) => c.externalId === `gmail:${MAILBOX}`)).toBeUndefined();
    const [updated] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((updated.credentials as ChannelCredentials).gmail_cursor).toBe(1_700_000_007_000);
  });
});

describe('gmail send', () => {
  it('threads replies onto the customer mail thread', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({
        agentId,
        externalId: 'gmail:sender@x.com',
        userProfile: { id: 'sender@x.com', channel: 'gmail', email: 'sender@x.com' },
      })
      .returning();
    await db.insert(channelBindings).values({
      conversationId: conv.id,
      channelId: channel.id,
      platformUserId: 'sender@x.com',
    });
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'help',
      payload: {
        mid: 'gmail:gmX',
        email: { subject: 'Refund?', message_id: '<in@x.com>', thread_id: 'thr_X' },
      },
    });

    let sentBody: { raw: string; threadId?: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('messages/send')) {
          sentBody = JSON.parse(String(init?.body));
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'gm_out', threadId: 'thr_X' })),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    const result = await sendChannelMessage(channel, 'sender@x.com', 'On it!', undefined, {
      senderName: 'Mike',
      quickReplies: ['Yes', 'No'],
    }, db);
    expect(result?.error).toBeNull();
    expect(sentBody?.threadId).toBe('thr_X');
    const mime = Buffer.from(sentBody!.raw, 'base64url').toString('utf-8');
    expect(mime).toContain('From: Mike via Acme Support <support@acme.test>');
    expect(mime).toContain('To: sender@x.com');
    expect(mime).toContain('Subject: Re: Refund?');
    expect(mime).toContain('In-Reply-To: <in@x.com>');
    // quick replies flatten to a numbered list in the base64 body
    expect(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString('utf-8')).toContain(
      '1. Yes',
    );
  });

  it('refreshes an expired access token before sending', async () => {
    await db
      .update(channels)
      .set({ credentials: { ...freshCreds, token_expiry: 1 } })
      .where(eq(channels.id, channel.id));
    let refreshHit = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('oauth2.googleapis.com/token')) {
          refreshHit = true;
          const params = new URLSearchParams(String(init?.body));
          expect(params.get('refresh_token')).toBe('rt_1');
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 })),
          );
        }
        if (url.includes('messages/send')) {
          expect(init?.headers && (init.headers as Record<string, string>)['Authorization']).toBe(
            'Bearer ya29.new',
          );
          return Promise.resolve(new Response(JSON.stringify({ id: 'gm_out' })));
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    // Re-select — real callers hand sendChannelMessage a fresh row, and the
    // expired token lives on the DB copy.
    const [stale] = await db.select().from(channels).where(eq(channels.id, channel.id));
    const result = await sendChannelMessage(stale, 'anyone@x.com', 'hi', undefined, undefined, db);
    expect(refreshHit).toBe(true);
    expect(result?.error).toBeNull();
    const [updated] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((updated.credentials as ChannelCredentials).access_token).toBe('ya29.new');
  });
});

describe('gmail oauth', () => {
  const googleTokenResponse = () =>
    new Response(
      JSON.stringify({
        access_token: 'ya29.cb',
        refresh_token: 'rt_cb',
        expires_in: 3600,
      }),
    );

  it('connect → callback creates a channel bound to the agent', async () => {
    // Step 1: connect redirects to Google consent with signed state.
    const connect = await app.request(
      `/api/gmail/connect?agent_id=${agentId}&name=Acme%20Inbox`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(connect.status).toBe(302);
    const consent = new URL(connect.headers.get('location')!);
    expect(consent.origin + consent.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(consent.searchParams.get('scope')).toContain('gmail.readonly');
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(consent.searchParams.get('prompt')).toContain('select_account');
    const state = consent.searchParams.get('state')!;

    // Step 2: callback exchanges the code, reads the profile, makes a channel.
    stubFetch({
      'oauth2.googleapis.com/token': googleTokenResponse,
      'users/me/profile': () => new Response(JSON.stringify({ emailAddress: 'CS@ACME.TEST' })),
    });
    const cb = await app.request(`/gmail/callback?state=${state}&code=authcode`, {
      redirect: 'manual',
    });
    expect(cb.status).toBe(302);
    const loc = cb.headers.get('location')!;
    // Returns to the connecting agent's Channels tab, not a global page.
    expect(loc).toContain(`/agents/${agentId}?tab=integrations`);
    expect(loc).toContain('gmail_connect=cs%40acme.test');
    const [created] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.kind, 'gmail'), eq(channels.name, 'Acme Inbox')));
    const creds = created.credentials as ChannelCredentials;
    expect(created.agentId).toBe(agentId);
    expect(creds.email_address).toBe('cs@acme.test');
    expect(creds.refresh_token).toBe('rt_cb');
    expect(creds.gmail_cursor).toBeGreaterThan(0);
  });

  it('invite link runs the whole flow with no Janis session', async () => {
    const linkRes = await app.request(
      `/api/gmail/connect-link?agent_id=${agentId}&name=Client%20Mailbox`,
      { headers: { cookie } },
    );
    const { url } = (await linkRes.json()) as { url: string };
    const key = new URL(url).searchParams.get('key')!;

    // Mailbox owner clicks the link → /gmail/start → Google consent.
    const start = await app.request(`/gmail/start?key=${key}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get('location')!);
    expect(consent.origin).toBe('https://accounts.google.com');
    const state = consent.searchParams.get('state')!;

    stubFetch({
      'oauth2.googleapis.com/token': googleTokenResponse,
      'users/me/profile': () =>
        new Response(JSON.stringify({ emailAddress: 'owner@client.test' })),
    });
    // No cookie at all — the signed state is the only auth.
    const cb = await app.request(`/gmail/callback?state=${state}&code=authcode`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('owner@client.test');
    const [created] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.kind, 'gmail'), eq(channels.name, 'Client Mailbox')));
    const creds = created.credentials as ChannelCredentials;
    expect(creds.email_address).toBe('owner@client.test');
    expect(created.agentId).toBe(agentId);
  });

  it('rejects a bad invite key and bad OAuth state', async () => {
    const bad = await app.request('/gmail/start?key=bogus', { redirect: 'manual' });
    expect(bad.status).toBe(400);
    const cb = await app.request('/gmail/callback?state=bogus&code=x', { redirect: 'manual' });
    expect(cb.headers.get('location')).toContain('gmail_error=');
  });
});
