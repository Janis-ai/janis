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
  contacts,
  conversations,
  messages,
  suppressions,
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
let wsId: string;

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

  it('remembers the forwarding mailbox for reply mirroring', async () => {
    const res = await inboundEvent({
      from: 'fwd@x.com',
      to: [INBOUND],
      subject: 'Forwarded customer mail',
      text: 'hello',
      headers: {
        To: 'janis@janis.ai',
        'X-Forwarded-For': `janis@janis.ai ${INBOUND}`,
        'Delivered-To': INBOUND,
      },
    });
    expect(res.status).toBe(200);
    const [ch] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((ch.credentials as { mirror_address?: string }).mirror_address).toBe('janis@janis.ai');
  });

  it('skips our own outbound mail boomeranging through the mirror', async () => {
    // From is NOT on our inbound domain — only the X-Janis-Outbound marker
    // stops a mirror copy from ingesting as fresh customer mail.
    const res = await inboundEvent({
      from: 'bounceback@x.com',
      to: [INBOUND],
      subject: 'Re: hi',
      text: 'reply copy',
      headers: { 'X-Janis-Outbound': channel.id },
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'email:bounceback@x.com'));
    expect(conv).toBeUndefined();
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
    // re-fetch — the inbound tests above may have persisted mirror_address
    const [fresh] = await db.select().from(channels).where(eq(channels.id, channel.id));
    const result = await sendChannelMessage(
      fresh,
      'sender@x.com',
      'Your order shipped today.',
      undefined,
      { quickReplies: ['Track it', 'Talk to a human'], senderName: 'Mike' },
      db,
    );
    expect(result?.error).toBeNull();
    expect(result?.mid).toBe('re_1');
    expect(sent?.url).toBe('https://api.resend.com/emails');
    // From = the channel's unique reply address (slug of channel name) —
    // Reply-To identical, so the visible address is what routes back.
    expect(sent?.body.from).toBe('Mike via Acme Support <support-inbox@inbound.janis.ai>');
    expect(sent?.body.reply_to).toEqual(['support-inbox@inbound.janis.ai']);
    // …and it persists on the channel creds for stable threading
    const [after] = await db.select().from(channels).where(eq(channels.id, channel.id));
    expect((after.credentials as { reply_address?: string }).reply_address).toBe(
      'support-inbox@inbound.janis.ai',
    );
    expect(sent?.body.to).toEqual(['sender@x.com']);
    expect(sent?.body.subject).toBe('Re: Help request');
    const headers = sent?.body.headers as Record<string, string>;
    expect(headers['In-Reply-To']).toBe('<orig@mail.x.com>');
    expect(headers.References).toContain('<orig@mail.x.com>');
    // outbound marker — a forwarded mirror copy of this send gets skipped
    expect(headers['X-Janis-Outbound']).toBe(channel.id);
    // mirror was detected in the inbound tests above → replies BCC it
    expect(sent?.body.bcc).toEqual(['janis@janis.ai']);
    // Suggested replies flatten to a numbered list — email's button equivalent
    expect(sent?.body.text).toBe('Your order shipped today.\n\n1. Track it\n2. Talk to a human');
  });

  it('keeps a custom-domain From while Reply-To stays the channel address', async () => {
    await db
      .update(channels)
      .set({
        credentials: {
          ...(channel.credentials as object),
          reply_address: 'support-inbox@inbound.janis.ai',
          from_address: 'help@acme.test',
        },
      })
      .where(eq(channels.id, channel.id));
    let sent: { body: Record<string, unknown> } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        sent = { body: JSON.parse(String(init?.body)) };
        return Promise.resolve(new Response(JSON.stringify({ id: 're_2' }), { status: 200 }));
      }),
    );
    const { sendChannelMessage } = await import('../lib/channels.js');
    const [fresh] = await db.select().from(channels).where(eq(channels.id, channel.id));
    await sendChannelMessage(fresh, 'sender@x.com', 'hi', undefined, undefined, db);
    expect(sent?.body.from).toBe('Acme Support <help@acme.test>');
    expect(sent?.body.reply_to).toEqual(['support-inbox@inbound.janis.ai']);
    await db
      .update(channels)
      .set({ credentials: channel.credentials as object })
      .where(eq(channels.id, channel.id));
  });
});

describe('reply address routing', () => {
  it('routes inbound mail addressed to the reply_address to the channel', async () => {
    await db
      .update(channels)
      .set({
        credentials: {
          ...(channel.credentials as object),
          reply_address: 'support-inbox@inbound.janis.ai',
        },
      })
      .where(eq(channels.id, channel.id));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );
    const res = await inboundEvent({
      email_id: 'em_reply_addr',
      from: 'pat@x.com',
      to: ['support-inbox@inbound.janis.ai'],
      subject: 're',
      message_id: '<r1@mail.x.com>',
      text: 'reply to the pretty address',
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'email:pat@x.com'));
    // the channel's agent owns the conversation — the reply address routed
    expect(conv?.agentId).toBe(channel.agentId);
    const [binding] = await db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.conversationId, conv.id));
    expect(binding.channelId).toBe(channel.id);
  });

  it('allocates unique slugs — same channel name gets a -2 suffix', async () => {
    const { uniqueReplyAddress } = await import('../lib/channels.js');
    await db
      .update(channels)
      .set({
        credentials: {
          ...(channel.credentials as object),
          reply_address: 'acme-co@inbound.janis.ai',
        },
      })
      .where(eq(channels.id, channel.id));
    const addr = await uniqueReplyAddress(db, 'Acme Co', 'deadbeef');
    expect(addr).toBe('acme-co-2@inbound.janis.ai');
    // and a names-empty channel falls back to a ch- prefixed id
    const blank = await uniqueReplyAddress(db, '!!!', 'c0ffee11');
    expect(blank).toBe('ch-c0ffee11@inbound.janis.ai');
    await db
      .update(channels)
      .set({ credentials: channel.credentials as object })
      .where(eq(channels.id, channel.id));
  });
});

describe('outbound event webhooks (/channels/email/events)', () => {
  const eventsReq = (data: Record<string, unknown>, type = 'email.bounced', badSig = false) => {
    const body = JSON.stringify({ type, data });
    const headers = badSig
      ? { 'svix-id': 'x', 'svix-timestamp': '0', 'svix-signature': 'v1,bogus' }
      : svixSign(body);
    return app.request('/channels/email/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  };

  it('suppresses a bounced recipient in every workspace that owns the contact', async () => {
    await db
      .insert(contacts)
      .values({ workspaceId: wsId, email: 'dead@mailbox.test', name: 'Dead' });
    const res = await eventsReq({ to: ['dead@mailbox.test'], email_id: 'em_1' });
    expect(res.status).toBe(200);
    const sups = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspaceId, wsId));
    expect(
      sups.some(
        (s) => s.address === 'dead@mailbox.test' && s.kind === 'email' && s.reason === 'bounce',
      ),
    ).toBe(true);
    // Idempotent — a retried webhook doesn't duplicate.
    await eventsReq({ to: ['dead@mailbox.test'], email_id: 'em_1' });
    const again = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.address, 'dead@mailbox.test'));
    expect(again).toHaveLength(1);
  });

  it('records complaints with complaint reason, ignores other events + bad sigs', async () => {
    await db.insert(contacts).values({ workspaceId: wsId, email: 'mad@customer.test' });
    const res = await eventsReq({ to: 'mad@customer.test' }, 'email.complained');
    expect(res.status).toBe(200);
    const sups = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.address, 'mad@customer.test'));
    expect(sups[0]?.reason).toBe('complaint');

    expect((await eventsReq({ to: 'x@y.test' }, 'email.delivered')).status).toBe(200);
    expect(
      (await db.select().from(suppressions).where(eq(suppressions.address, 'x@y.test'))).length,
    ).toBe(0);
    expect((await eventsReq({ to: 'dead@mailbox.test' }, 'email.bounced', true)).status).toBe(401);
  });
});
