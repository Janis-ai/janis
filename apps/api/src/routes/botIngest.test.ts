import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, messages, workspaces } from '../db/schema.js';
import { botIngestRoutes, shapeReply } from './botIngest.js';
import { buildBotResponse, effectsToPlatform, parseDirectives } from '../lib/botPlatform.js';
import { processEvents } from '../services/ingest.js';

let db: Db;
let app: Hono;
let wsId: string;
const KEY = 'bk_test_ingest_key';
const LEGACY_KEY = 'ck_migrated_bot';

process.env.BOT_INGEST_WAIT_MS = '400';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/bot', botIngestRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  await db.insert(agents).values({ workspaceId: wsId, name: 'Bot', metadata: { bot_key: KEY } });
  await db.insert(agents).values({ workspaceId: wsId, name: 'Migrated', metadata: { legacy_client_key: LEGACY_KEY } });
});

const agentFor = async (key: string) =>
  (await db.select().from(agents).where(eq(agents.name, key === KEY ? 'Bot' : 'Migrated')).limit(1))[0];

describe('bot ingest', () => {
  it('404s an unknown key and unknown flavor', async () => {
    expect((await app.request('/bot/nope/chatfuel', { method: 'POST' })).status).toBe(404);
    expect((await app.request(`/bot/${KEY}/discord`, { method: 'POST' })).status).toBe(404);
  });

  it('ingests a chatfuel turn — conv + stored inbound, chatfuel-shaped reply', async () => {
    const agent = await agentFor(KEY);
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-1', 'user input': 'hello there' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('messages');

    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-1')));
    expect(conv).toBeTruthy();
    const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id));
    expect(ch.kind).toBe('chatfuel');
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msg.direction).toBe('in');
  });

  it('returns the empty manychat shape when the agent stays silent', async () => {
    const r = await app.request(`/bot/${KEY}/manychat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sub-9', custom_fields: { 'user input': 'hi' } }),
    });
    const body = await r.json();
    expect(body.version).toBe('v2');
    expect(body.content.messages).toEqual([]);
  }, 20_000);

  it('accepts a migrated agent on its legacy client_key', async () => {
    const agent = await agentFor(LEGACY_KEY);
    const r = await app.request(`/bot/${LEGACY_KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-7', 'user input': 'migrated' }),
    });
    expect(r.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-7')));
    expect(conv).toBeTruthy();
  }, 20_000);

  it('meta-family merge — bot ingest lands on the existing messenger thread', async () => {
    const agent = await agentFor(KEY);
    // A messenger channel + conv + binding for this PSID already exists
    const [mch] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: agent.id, kind: 'messenger', name: 'Page', credentials: {} })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:psid-shared', userProfile: {} })
      .returning();
    const { channelBindings } = await import('../db/schema.js');
    await db
      .insert(channelBindings)
      .values({ channelId: mch.id, conversationId: conv.id, platformUserId: 'psid-shared' });

    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-shared', 'user input': 'via card' }),
    });
    expect(r.status).toBe(200);
    // inbound landed on the EXISTING messenger conv, not a new chatfuel one
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.some((m) => m.text === 'via card' && m.direction === 'in')).toBe(true);
    const [other] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'chatfuel:psid-shared'));
    expect(other).toBeUndefined();
  }, 20_000);

  it('dedups the same message arriving via webhook + card', async () => {
    const agent = await agentFor(KEY);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:psid-dup', userProfile: {} })
      .returning();
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'same words',
      createdAt: new Date(),
    });
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-dup', 'user input': 'same words' }),
    });
    expect(r.status).toBe(200);
    const msgs = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')));
    expect(msgs.filter((m) => m.text === 'same words')).toHaveLength(1);
  }, 20_000);

  it('silent when the conversation is human-owned', async () => {
    const agent = await agentFor(KEY);
    await db
      .update(conversations)
      .set({ state: 'human' })
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-1')));
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-1', 'user input': 'are you there' }),
    });
    const body = await r.json();
    expect(body.messages).toEqual([]);
  });

  it('maps an event-only post to [event] text and opens with the greeting', async () => {
    const agent = await agentFor(KEY);
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-ev', event: 'WELCOME_BACK' }),
    });
    expect(r.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-ev')),
      );
    expect(conv).toBeTruthy();
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.some((m) => m.direction === 'in' && m.text === '[event] WELCOME_BACK')).toBe(true);
    // a first-contact event is a postback-class opener — the greeting is the reply
    const body = await r.json();
    expect(body.messages.some((m: { text?: string }) => (m.text ?? '').length > 0)).toBe(true);
  });

  it('renders widgets, attachments and effects from the stored reply', async () => {
    const agent = await agentFor(KEY);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'chatfuel:psid-rich', userProfile: {} })
      .returning();
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'show me something',
      createdAt: new Date(),
    });
    // Stored by ingest: clean text, rich parts on the payload.
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'out',
      text: 'Here you go',
      createdAt: new Date(),
      payload: {
        widgets: [
          {
            type: 'cards',
            items: [
              {
                title: 'Trail Board',
                subtitle: 'All-mountain',
                image: 'https://img.example.com/board.png',
                price: '$499',
                link: 'https://shop.example.com/board',
                link_label: 'View board',
                select_label: 'Tell me more about the Trail Board',
                select_button: 'Tell me more…',
              },
            ],
          },
        ],
        attachments: [{ name: 'spec.png', url: 'https://img.example.com/spec.png', type: 'image/png', size: 10 }],
        effects: [
          { kind: 'set', name: 'interested_in', value: 'Trail Board' },
          { kind: 'goto', name: 'Checkout' },
        ],
        channel_effects: ['set interested_in', 'flow: Checkout'],
      },
    });
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-rich', 'user input': 'show me something' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    const kinds = body.messages.map((m: Record<string, unknown>) => Object.keys(m)[0]);
    expect(kinds).toEqual(['text', 'attachment', 'attachment']);
    const card = body.messages[2].attachment.payload;
    expect(card.template_type).toBe('generic');
    const el = card.elements[0];
    expect(el.title).toBe('Trail Board');
    expect(el.subtitle).toBe('All-mountain · $499');
    expect(el.image_url).toBe('https://img.example.com/board.png');
    expect(el.default_action).toEqual({ type: 'web_url', url: 'https://shop.example.com/board' });
    expect(el.buttons).toEqual([
      { type: 'web_url', title: 'View board', url: 'https://shop.example.com/board' },
      {
        type: 'show_block',
        title: 'Tell me more…',
        block_names: ['Janis'],
        set_attributes: { 'user input': 'Tell me more about the Trail Board' },
      },
    ]);
    expect(body.messages[1].attachment).toEqual({
      type: 'image',
      payload: { url: 'https://img.example.com/spec.png' },
    });
    // effects → top-level chatfuel fields
    expect(body.set_attributes).toEqual({ interested_in: 'Trail Board' });
    expect(body.redirect_to_blocks).toEqual(['Checkout']);
  });

  it('renders options widgets and actions into manychat v2 content', async () => {
    const agent = await agentFor(KEY);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'manychat:sub-rich', userProfile: {} })
      .returning();
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'which plan?',
      createdAt: new Date(),
    });
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'out',
      text: 'Two options:',
      createdAt: new Date(),
      payload: {
        widgets: [
          { type: 'options', title: 'Pick a plan', items: [{ label: 'Pro' }, { label: 'Free', send: 'I want the Free plan' }] },
        ],
        effects: [
          { kind: 'set', name: 'plan', value: 'pro' },
          { kind: 'tag', name: 'prospect' },
          { kind: 'untag', name: 'visitor' },
          { kind: 'goto', name: 'Onboarding' },
        ],
      },
    });
    const r = await app.request(`/bot/${KEY}/manychat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sub-rich', custom_fields: { 'user input': 'which plan?' } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe('v2');
    expect(body.content.messages).toEqual([
      { type: 'text', text: 'Two options:' },
      { type: 'text', text: 'Pick a plan' },
    ]);
    expect(body.content.quick_replies).toEqual([
      { type: 'node', caption: 'Pro', target: 'Pro' },
      { type: 'node', caption: 'Free', target: 'I want the Free plan' },
    ]);
    expect(body.content.actions).toEqual([
      { action: 'set_field_value', field_name: 'plan', value: 'pro' },
      { action: 'add_tag', tag_name: 'prospect' },
      { action: 'remove_tag', tag_name: 'visitor' },
      { action: 'send_flow', flow_ns: 'Onboarding' },
    ]);
  });

  it('strips directives from the stored reply and records channel_effects', async () => {
    const agent = await agentFor(KEY);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'chatfuel:psid-dir', userProfile: {} })
      .returning();
    await processEvents(db, agent, [
      {
        type: 'message_out',
        conversation_id: 'chatfuel:psid-dir',
        text: 'All set {{set plan=pro}} {{goto "Onboarding"}} — anything else?',
      },
    ]);
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msg.text).toBe('All set — anything else?');
    const p = msg.payload as { effects?: unknown[]; channel_effects?: string[] };
    expect(p.effects).toEqual([
      { kind: 'set', name: 'plan', value: 'pro' },
      { kind: 'goto', name: 'Onboarding' },
    ]);
    expect(p.channel_effects).toEqual(['set plan', 'flow: Onboarding']);
  });

  it('leaves {{…}} untouched on non-bot conversations', async () => {
    const agent = await agentFor(KEY);
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'webchat:vis-dir', userProfile: {} })
      .returning();
    await processEvents(db, agent, [
      { type: 'message_out', conversation_id: 'webchat:vis-dir', text: 'literal {{set x=y}} braces' },
    ]);
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msg.text).toBe('literal {{set x=y}} braces');
    expect((msg.payload as Record<string, unknown>).effects).toBeUndefined();
  });

  it('empty response when a ManyChat token channel owns delivery', async () => {
    const agent = await agentFor(KEY);
    const [mc] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'manychat',
        name: 'MC',
        credentials: { manychat_token: 'tok' },
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'manychat:sub-tok', userProfile: {} })
      .returning();
    const { channelBindings } = await import('../db/schema.js');
    await db
      .insert(channelBindings)
      .values({ channelId: mc.id, conversationId: conv.id, platformUserId: 'sub-tok' });
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'out', text: 'already answered' });
    const r = await app.request(`/bot/${KEY}/manychat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sub-tok', custom_fields: { 'user input': 'hello' } }),
    });
    const body = await r.json();
    // the out-row exists but must NOT be echoed — sendContent pushes it,
    // echoing too would double-deliver
    expect(body.content.messages).toEqual([]);
  });
});

describe('shapeReply', () => {
  it('splits long chatfuel replies at the 640-char cap', () => {
    const long = `${'word '.repeat(300)}end`;
    const out = shapeReply('chatfuel', long) as { messages: { text: string }[] };
    expect(out.messages.length).toBeGreaterThan(1);
    expect(out.messages.every((m) => m.text.length <= 640)).toBe(true);
    expect(out.messages.map((m) => m.text).join(' ')).toContain('end');
  });

  it('attaches quick replies to the last chatfuel message', () => {
    const out = shapeReply('chatfuel', 'Pick one', ['Yes', 'No']) as {
      messages: Record<string, unknown>[];
    };
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].quick_replies).toEqual([
      { title: 'Yes', block_names: ['Janis'], set_attributes: { 'user input': 'Yes' } },
      { title: 'No', block_names: ['Janis'], set_attributes: { 'user input': 'No' } },
    ]);
  });

  it('shapes manychat v2 content with node quick replies', () => {
    const out = shapeReply('manychat', 'Pick one', ['Yes', { type: 'email' } as never]) as {
      version: string;
      content: { messages: unknown[]; actions: unknown[]; quick_replies: unknown[] };
    };
    expect(out.version).toBe('v2');
    expect(out.content.messages).toEqual([{ type: 'text', text: 'Pick one' }]);
    // email/phone collectors have no bot-platform primitive — dropped
    expect(out.content.quick_replies).toEqual([{ type: 'node', caption: 'Yes', target: 'Yes' }]);
  });

  it('manychat splits long replies too', () => {
    const out = shapeReply('manychat', 'x'.repeat(1400)) as {
      content: { messages: { text: string }[] };
    };
    expect(out.content.messages.length).toBeGreaterThan(1);
    expect(out.content.messages.every((m) => m.text.length <= 640)).toBe(true);
  });
});

describe('botPlatform', () => {
  describe('parseDirectives', () => {
    it('parses the closed grammar and strips it from the text', () => {
      const { clean, effects } = parseDirectives(
        'Sure thing {{ set first_name = Mike }} {{tag vip}} {{untag lead}} {{goto "Onboarding Flow"}}!',
      );
      expect(clean).toBe('Sure thing !');
      expect(effects).toEqual([
        { kind: 'set', name: 'first_name', value: 'Mike' },
        { kind: 'tag', name: 'vip' },
        { kind: 'untag', name: 'lead' },
        { kind: 'goto', name: 'Onboarding Flow' },
      ]);
    });

    it('accepts an unquoted goto name and quoted set values', () => {
      const { effects } = parseDirectives('{{goto Checkout Now}} {{set note="a b"}}');
      expect(effects).toEqual([
        { kind: 'goto', name: 'Checkout Now' },
        { kind: 'set', name: 'note', value: 'a b' },
      ]);
    });

    it('leaves unrecognized and malformed {{…}} in the text untouched', () => {
      const { clean, effects } = parseDirectives('keep {{unknown x}} and {{set name}} here');
      expect(clean).toBe('keep {{unknown x}} and {{set name}} here');
      expect(effects).toEqual([]);
    });

    it('a directive-only reply cleans to empty', () => {
      const { clean, effects } = parseDirectives('{{goto Onboarding}}');
      expect(clean).toBe('');
      expect(effects).toEqual([{ kind: 'goto', name: 'Onboarding' }]);
    });
  });

  describe('effectsToPlatform', () => {
    it('maps chatfuel to top-level fields and drops tags', () => {
      expect(
        effectsToPlatform('chatfuel', [
          { kind: 'set', name: 'plan', value: 'pro' },
          { kind: 'tag', name: 'vip' },
          { kind: 'goto', name: 'Checkout' },
        ]),
      ).toEqual({ set_attributes: { plan: 'pro' }, redirect_to_blocks: ['Checkout'] });
    });

    it('maps manychat to content actions', () => {
      expect(
        effectsToPlatform('manychat', [
          { kind: 'set', name: 'plan', value: 'pro' },
          { kind: 'tag', name: 'vip' },
          { kind: 'untag', name: 'lead' },
          { kind: 'goto', name: 'Checkout' },
        ]),
      ).toEqual([
        { action: 'set_field_value', field_name: 'plan', value: 'pro' },
        { action: 'add_tag', tag_name: 'vip' },
        { action: 'remove_tag', tag_name: 'lead' },
        { action: 'send_flow', flow_ns: 'Checkout' },
      ]);
    });
  });

  describe('buildBotResponse', () => {
    it('empty reply keeps the exact legacy empty shapes', () => {
      expect(buildBotResponse('chatfuel', { text: '' })).toEqual({ messages: [] });
      expect(buildBotResponse('manychat', { text: '' })).toEqual({
        version: 'v2',
        content: { messages: [], actions: [] },
      });
    });

    it('effects-only chatfuel reply still redirects', () => {
      expect(
        buildBotResponse('chatfuel', { text: '', effects: [{ kind: 'goto', name: 'Main Menu' }] }),
      ).toEqual({ messages: [], redirect_to_blocks: ['Main Menu'] });
    });
  });
});
