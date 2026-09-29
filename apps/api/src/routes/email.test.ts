import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  channelBindings,
  channels,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import {
  htmlToText,
  isAutoReply,
  mailSkipReason,
  parseAddressList,
  parseFrom,
  verifySvixSignature,
} from '../lib/email.js';

const INBOUND = 'ch_aaaa1111@inbound.janis.ai';

let db: Db;
let app: Hono;
let agentId: string;
let channel: typeof channels.$inferSelect;

const WHSEC_KEY = Buffer.from('test-key-32-bytes-test-key-32-bytes!').toString('base64');
const svixSign = (raw: string) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(WHSEC_KEY, 'base64'))
    .update(`msg_1.${ts}.${raw}`)
    .digest('base64');
  return { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
};
const inboundEvent = (data: Record<string, unknown>) => {
  const body = JSON.stringify({ type: 'email.received', data });
  return app.request('/channels/email/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...svixSign(body) },
    body,
  });
};

beforeAll(async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_INBOUND_SECRET = `whsec_${WHSEC_KEY}`;
  process.env.EMAIL_INBOUND_DOMAIN = 'inbound.janis.ai';
  const { channelWebhookRoutes } = await import('./channels.js');
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/channels', channelWebhookRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
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
      agentId,
      kind: 'email',
      name: 'Support Inbox',
      credentials: { inbound_address: INBOUND, from_name: 'Acme Support' },
    })
    .returning();
});

afterEach(() => vi.unstubAllGlobals());

describe('parsing helpers', () => {
  it('parses address lists and display-name From headers', () => {
    expect(parseAddressList('"Jane" <jane@x.com>, bob@y.com')).toEqual([
      'jane@x.com',
      'bob@y.com',
    ]);
    expect(parseFrom('"Jane Doe" <jane@x.com>')).toEqual({
      name: 'Jane Doe',
      address: 'jane@x.com',
    });
    expect(parseFrom('jane@x.com')).toEqual({ address: 'jane@x.com' });
  });

  it('flags machine-generated mail for the loop guard', () => {
    expect(isAutoReply({ 'Auto-Submitted': 'auto-replied' })).toBe(true);
    expect(isAutoReply({ 'Auto-Submitted': 'no' })).toBe(false);
    expect(isAutoReply({ precedence: 'bulk' })).toBe(true);
    expect(isAutoReply({ 'list-id': '<list.x.com>' })).toBe(true);
    expect(isAutoReply({ 'list-id': '<list.x.com>' }, { allowList: true })).toBe(false);
    expect(isAutoReply({ 'Auto-Submitted': 'auto-replied' }, { allowList: true })).toBe(true);
    expect(isAutoReply(undefined)).toBe(false);
  });

  it('mailSkipReason applies per-channel answer rules', () => {
    const groupMail = {
      headers: { 'list-id': '<support.you.com>' },
      from: 'Customer <customer@x.com>',
      to: 'support@you.com',
      subject: 'help!',
    };
    // The group bug: no filters → list-fanned mail dies as before.
    expect(mailSkipReason(groupMail, { selfAddress: 'me@you.com' })).toBe('list');
    // Configured answer address exempts it — the group/alias case.
    expect(
      mailSkipReason(groupMail, {
        selfAddress: 'me@you.com',
        filters: { answer_addresses: ['support@you.com'] },
      }),
    ).toBeNull();
    // list_mail opt-in works without an address list.
    expect(
      mailSkipReason(groupMail, { selfAddress: 'me@you.com', filters: { list_mail: true } }),
    ).toBeNull();
    // ...but true machine mail still skips even on a list-enabled channel.
    expect(
      mailSkipReason(
        { ...groupMail, headers: { 'auto-submitted': 'auto-replied' } },
        { selfAddress: 'me@you.com', filters: { list_mail: true } },
      ),
    ).toBe('machine');
    // Address allowlist rejects mail to other addresses (shared-mailbox noise).
    expect(
      mailSkipReason(
        { ...groupMail, headers: {}, to: 'alice@you.com' },
        { selfAddress: 'me@you.com', filters: { answer_addresses: ['support@you.com'] } },
      ),
    ).toBe('not-addressed');
    // Sender rules: block wins over allow.
    expect(
      mailSkipReason(
        { headers: {}, from: 'coworker@you.com', to: 'me@you.com' },
        { filters: { sender_block: ['@you.com'] } },
      ),
    ).toBe('sender-blocked');
    expect(
      mailSkipReason(
        { headers: {}, from: 'random@x.com', to: 'me@you.com' },
        { filters: { sender_allow: ['@you.com'] } },
      ),
    ).toBe('not-allowed');
    expect(
      mailSkipReason(
        { headers: {}, from: 'vip@you.com', to: 'me@you.com' },
        { filters: { sender_allow: ['@you.com'], sender_block: ['vip@you.com'] } },
      ),
    ).toBe('sender-blocked');
    // Subject excludes + self/daemon guards.
    expect(
      mailSkipReason(
        { headers: {}, from: 'a@x.com', to: 'me@you.com', subject: 'RE: Out of office' },
        { filters: { subject_exclude: ['out of office'] } },
      ),
    ).toBe('subject-excluded');
    expect(
      mailSkipReason(
        { headers: {}, from: 'me@you.com', to: 'me@you.com' },
        { selfAddress: 'me@you.com' },
      ),
    ).toBe('self');
    expect(mailSkipReason({ from: 'mailer-daemon@x.com' }, {})).toBe('daemon');
    expect(mailSkipReason({ headers: {}, from: 'a@x.com' }, {})).toBeNull();
  });

  it('strips html to text for html-only mail', () => {
    const text = htmlToText('<p>Hello<br>there</p><style>x{}</style><p>Bye &amp; bye</p>');
    expect(text).toBe('Hello\nthere\nBye & bye');
  });

  it('verifies a valid svix signature and rejects a bad one', () => {
    const secret = `whsec_${Buffer.from('test-key-32-bytes-test-key-32-bytes!').toString('base64')}`;
    const raw = '{"type":"email.received"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`msg_1.${ts}.${raw}`)
      .digest('base64');
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': ts,
      'svix-signature': `v1,${sig}`,
    });
    expect(verifySvixSignature(secret, raw, headers)).toBe(true);
    expect(verifySvixSignature(secret, raw + 'x', headers)).toBe(false);
  });
});

describe('inbound email webhook', () => {
  it('creates a conversation and stores threading metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );
    const res = await inboundEvent({
      email_id: 'em_1',
      from: '"Jane Doe" <jane@x.com>',
      to: [INBOUND],
      subject: 'Need help',
      message_id: '<m1@mail.x.com>',
      text: 'Hi — my order never arrived',
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'email:jane@x.com'));
    expect(conv).toBeTruthy();
    expect((conv.userProfile as { email?: string }).email).toBe('jane@x.com');
    expect((conv.userProfile as { name?: string }).name).toBe('Jane Doe');
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')));
    expect(msg.text).toBe('Hi — my order never arrived');
    expect((msg.payload as { email?: { subject?: string } }).email?.subject).toBe('Need help');
    expect((msg.payload as { mid?: string }).mid).toBe('<m1@mail.x.com>');
  });

  it('drops auto-submitted mail without a conversation', async () => {
    const res = await inboundEvent({
      from: 'vacation@x.com',
      to: [INBOUND],
      subject: 'Out of office',
      text: 'auto-reply',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'email:vacation@x.com'));
    expect(conv).toBeUndefined();
  });

  it('rejects unsigned posts', async () => {
    const res = await app.request('/channels/email/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'email.received',
        data: { from: 'jane@x.com', to: [INBOUND], text: 'hi' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('ignores mail to an address no channel owns', async () => {
    const res = await inboundEvent({
      from: 'jane@x.com',
      to: ['nobody@inbound.janis.ai'],
      subject: 'Hi',
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    expect(convs.every((c) => c.externalId !== 'email:jane@x.com:nobody')).toBe(true);
  });

  it('extracts text from html-only mail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );
    await inboundEvent({
      from: 'htmlguy@x.com',
      to: [INBOUND],
      subject: 'Formatting',
      html: '<p>Line one</p><p>Line two</p>',
    });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'email:htmlguy@x.com'));
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')));
    expect(msg.text).toBe('Line one\nLine two');
  });
});

describe('email reply send', () => {
  it('sends through Resend threaded onto the inbound message', async () => {
    // Conversation + binding + an inbound message carrying threading meta.
    const [conv] = await db
      .insert(conversations)
      .values({
        agentId,
        externalId: 'email:sender@x.com',
        userProfile: { id: 'sender@x.com', channel: 'email', email: 'sender@x.com' },
      })
      .returning();
    await db.insert(channelBindings).values({
      channelId: channel.id,
      conversationId: conv.id,
      platformUserId: 'sender@x.com',
    });
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'help please',
      payload: {
        email: { subject: 'Help request', message_id: '<orig@mail.x.com>' },
        mid: '<orig@mail.x.com>',
      },
    });

    let sent: { url: string; body: Record<string, unknown> } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        sent = { url, body: JSON.parse(String(init?.body)) };
        return Promise.resolve(new Response(JSON.stringify({ id: 're_1' }), { status: 200 }));
      }),
    );
    // Imported after beforeAll so env.ts sees the RESEND_API_KEY set there —
    // env is evaluated at module load.
    const { sendChannelMessage } = await import('../lib/channels.js');
    const result = await sendChannelMessage(
      channel,
      'sender@x.com',
      'Your order shipped today.',
      undefined,
      { quickReplies: ['Track it', 'Talk to a human'], senderName: 'Mike' },
      db,
    );
    expect(result?.error).toBeNull();
    expect(result?.mid).toBe('re_1');
    expect(sent?.url).toBe('https://api.resend.com/emails');
    expect(sent?.body.from).toBe('Mike via Acme Support <ch_aaaa1111@inbound.janis.ai>');
    expect(sent?.body.to).toEqual(['sender@x.com']);
    expect(sent?.body.subject).toBe('Re: Help request');
    const headers = sent?.body.headers as Record<string, string>;
    expect(headers['In-Reply-To']).toBe('<orig@mail.x.com>');
    expect(headers.References).toContain('<orig@mail.x.com>');
    // Suggested replies flatten to a numbered list — email's button equivalent
    expect(sent?.body.text).toBe('Your order shipped today.\n\n1. Track it\n2. Talk to a human');
  });
});
