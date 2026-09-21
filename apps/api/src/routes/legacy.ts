import { Hono, type Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, agentSecrets, channelBindings, channels, conversations, messages } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { findChannelByObjectId, parseMetaWebhook } from '../lib/channels.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { processEvents } from '../services/ingest.js';
import { toConversation, toMessage } from '../lib/serializers.js';
import { bus } from '../lib/bus.js';
import { env } from '../env.js';
import { detectIntentChain, type LegacyContext, type ServiceAccount } from '../lib/dialogflow.js';
import { buildChatfuelPayload, buildManychatPayload } from '../lib/legacyFormat.js';
import { loadSecretsMap } from '../lib/secrets.js';
import { reportLegacyUsage } from '../lib/legacyBilling.js';

const PAGE_INBOX_TAG = 'page-inbox-takeover';
const DF_PAUSE_TAG = 'df-pause';
// Meta app ids that mean "a human spoke", not the bot:
//   263902037430900 = Page Inbox itself; the Janis apps = replies sent from
//   the old Slack UI. Echoes from other app ids (Chatfuel etc.) are the bot.
const PAGE_INBOX_APP_ID = '263902037430900';
const JANIS_APP_IDS = new Set(['1242623579085955', '452644005136867']);

type ChannelRow = typeof channels.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Legacy endpoint — serves the paths the old wordhopapi app owns on
 * webhook.janis.ai / janis.ai:
 *
 *   GET/POST /messenger/webhook                       — Meta page events
 *   ALL /messenger/client/:key/chatfuel/fallback      — Chatfuel JSON API card
 *   ALL /messenger/client/:key/manychat/fallback      — ManyChat ext request
 *   ALL /messenger/client/:key/sendtouser/fallback    — Janis-initiated sends
 *   ALL /messenger/client/:key/dialogflow/fallback    — DF-native callers
 *   ALL /messenger/client/:key/manychat/app-auth      — stores manychat token
 *
 * The fallback endpoints are synchronous: the bot platform POSTs the user
 * message + attributes, we run Dialogflow, and return the platform-format
 * response. A paused (human-owned) conversation returns an empty message
 * list — the bot goes silent while a human is on the thread.
 */
export function legacyWebhookRoutes(db: Db) {
  const app = new Hono();

  // ---- Meta webhook ------------------------------------------------------

  app.get('/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe') {
      if (!env.metaVerifyToken || token !== env.metaVerifyToken || !challenge) {
        return c.text('forbidden', 403);
      }
      return c.text(challenge);
    }
    return c.text('OK', 200);
  });

  app.post('/webhook', async (c) => {
    const raw = await c.req.text();
    let body: { entry?: Record<string, unknown>[] };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text('bad json', 400);
    }

    for (const entry of body.entry ?? []) {
      const pageId = String(entry.id ?? '');
      if (!pageId) continue;
      const channel = await findChannelByObjectId(db, pageId);
      if (!channel) continue;
      const creds = channel.credentials as ChannelCredentials;

      const standby = (entry.standby ?? []) as Record<string, unknown>[];
      const messaging = (entry.messaging ?? []) as Record<string, unknown>[];

      // Echoes = the page (or one of its apps) speaking. app_id decides who:
      // our own app / Page Inbox → a human; anything else → the bot replied.
      for (const m of [...messaging, ...standby]) {
        const msg = m.message as
          | { is_echo?: boolean; mid?: string; text?: string; app_id?: number | string }
          | undefined;
        if (!msg?.is_echo) continue;
        const userId = (m.recipient as { id?: string } | undefined)?.id;
        if (!userId) continue;
        const appId = msg.app_id != null ? String(msg.app_id) : null;
        const isHuman =
          appId == null ||
          appId === PAGE_INBOX_APP_ID ||
          JANIS_APP_IDS.has(appId) ||
          (env.metaAppId !== '' && appId === env.metaAppId);
        if (isHuman) {
          if (creds.takeover_from_page_inbox !== false) {
            await takeoverFromPageInbox(db, channel, userId, msg);
          }
        } else {
          await recordBotEcho(db, channel, userId, msg, appId!);
        }
      }

      // Standby user messages — Janis is the secondary receiver on migrated
      // pages, so the live feed arrives here. Transcript only: 'monitor'
      // agents never reply from the webhook path.
      for (const m of standby) {
        const msg = m.message as
          | { is_echo?: boolean; mid?: string; text?: string }
          | undefined;
        const sender = (m.sender as { id?: string } | undefined)?.id;
        if (!msg || msg.is_echo || !sender || !msg.text) continue;
        await handleChannelMessage(db, channel, {
          objectId: pageId,
          senderId: sender,
          text: msg.text,
          messageId: msg.mid,
        });
      }
    }

    for (const msg of parseMetaWebhook(body)) {
      const channel = await findChannelByObjectId(db, msg.objectId);
      if (!channel) continue;
      await handleChannelMessage(db, channel, msg);
    }
    return c.json({ ok: true });
  });

  // ---- Bot-platform fallbacks ---------------------------------------------

  app.all('/client/:client_key/chatfuel/fallback', async (c) => {
    const out = await runFallback(db, c.req.param('client_key'), await normalizeChatfuel(c), 'chatfuel');
    return c.json(out ?? { messages: [] });
  });

  app.all('/client/:client_key/manychat/fallback', async (c) => {
    const { norm, subscriberId } = await normalizeManychat(c);
    if (!subscriberId) return c.json({ version: 'v2', content: { messages: [], actions: [] } });
    const out = await runFallback(db, c.req.param('client_key'), norm, 'manychat');
    return c.json(out ?? { version: 'v2', content: { messages: [], actions: [] } });
  });

  app.all('/client/:client_key/sendtouser/fallback', async (c) => {
    const out = await runFallback(db, c.req.param('client_key'), await normalizeChatfuel(c), 'chatfuel', true);
    return c.json(out ?? { messages: [] });
  });

  app.all('/client/:client_key/dialogflow/fallback', async (c) => {
    const out = await runFallback(db, c.req.param('client_key'), await normalizeDialogflow(c), 'chatfuel');
    return c.json(out ?? { messages: [] });
  });

  app.all('/client/:client_key/manychat/app-auth', async (c) => {
    const key = c.req.param('client_key');
    const body = (await c.req.json().catch(() => ({}))) as { app_token?: string };
    const agent = await agentByClientKey(db, key);
    if (!agent || !body.app_token) return c.json({ error: 'no match' }, 404);
    const channel = await messengerChannelFor(db, agent.id);
    if (channel) {
      await db
        .update(channels)
        .set({ credentials: { ...(channel.credentials as ChannelCredentials), manychat_token: body.app_token } })
        .where(eq(channels.id, channel.id));
    }
    return c.json({ success: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Normalizers — one per caller flavor, all produce the same shape
// ---------------------------------------------------------------------------

interface Normalized {
  userId?: string;
  text?: string;
  event?: { name: string; data?: Record<string, unknown> };
  contexts: LegacyContext[];
  lang?: string;
  resetContexts?: boolean;
  location?: { latitude: number; longitude: number };
  attrs: Record<string, unknown>;
}

const USER_INPUT_KEYS = [
  'user input', 'userInput', 'user_input', 'userinput', 'User input',
  'USERINPUT', 'user message', 'last user freeform input', 'last clicked button name',
];

/** Merge query string + JSON body — Chatfuel/ManyChat send either. */
async function rawParams(c: Context): Promise<Record<string, unknown>> {
  const raw: Record<string, unknown> = {};
  try {
    new URL(c.req.url).searchParams.forEach((v, k) => (raw[k] = v));
  } catch {}
  if (c.req.method !== 'GET') {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) raw[k] = v;
  }
  return raw;
}

function chatfuelAttrs(raw: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set([
    'dfEvent', 'event', 'dfContext', 'context', 'contexts', 'dfResetContexts',
    'reset contexts', 'dfLifespan', 'context lifespan', 'dfLang', 'lang', 'locale',
    'messenger user id', 'chatfuel user id', 'latitude', 'longitude', 'isFromChatfuel',
    'isFromManychat', ...USER_INPUT_KEYS,
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!reserved.has(k) && /^[A-Za-z\d_\-%]+$/.test(k.split(' ').join('_'))) out[k] = v;
  }
  return out;
}

async function normalizeChatfuel(c: Context): Promise<Normalized> {
  const raw = await rawParams(c);
  const userId = str(raw['messenger user id'] ?? raw['chatfuel user id']);
  const text = USER_INPUT_KEYS.map((k) => raw[k]).find((v) => v != null && v !== '');
  const ev = str(raw.dfEvent ?? raw.event);
  const ctxNames = str(raw.dfContext ?? raw.context);
  const lifespan = num(raw.dfLifespan ?? raw['context lifespan']);
  const contexts: LegacyContext[] = [{ name: 'janis', lifespan: 2, parameters: chatfuelAttrs(raw) }];
  if (ctxNames) {
    let parsed: string = ctxNames;
    try { parsed = JSON.parse(ctxNames).toString(); } catch {}
    for (const name of parsed.split(',').map((s) => s.trim())) {
      if (name && name !== 'janis' && name !== '__system_counters__') {
        contexts.push({ name: name.split(' ').join('_'), lifespan: lifespan ?? 1 });
      }
    }
  }
  const lang = str(raw.dfLang ?? raw.lang ?? raw.locale)?.replaceAll('_', '-');
  const resetContexts = raw.dfResetContexts === true || raw['reset contexts'] === true || raw.dfResetContexts === 'true';
  const lat = num(raw.latitude); const lng = num(raw.longitude);
  return {
    userId,
    text: text != null ? String(text) : undefined,
    event: ev ? { name: ev } : undefined,
    contexts,
    lang,
    resetContexts,
    location: lat != null && lng != null ? { latitude: lat, longitude: lng } : undefined,
    attrs: chatfuelAttrs(raw),
  };
}

async function normalizeManychat(c: Context): Promise<{ norm: Normalized; subscriberId?: string }> {
  const b = await rawParams(c);
  const subscriberId = b.id != null ? String(b.id) : undefined;
  const custom = (b.custom_fields ?? {}) as Record<string, unknown>;
  const text =
    (custom['user input'] != null && custom['user input'] !== '' ? custom['user input'] : b['last_input_text']) as
      | string
      | undefined;
  const ev = custom['event'] != null && custom['event'] !== '' ? String(custom['event']) : undefined;
  const tags = Array.isArray(b.tags) ? (b.tags as { name?: string }[]) : [];
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k !== 'custom_fields' && k !== 'tags' && typeof v !== 'object') params[stripDiacritics(k)] = v;
  }
  for (const [k, v] of Object.entries(custom)) params[stripDiacritics(k)] = v;
  const contexts: LegacyContext[] = [{ name: 'janis', lifespan: 2, parameters: params }];
  for (const t of tags) {
    if (t?.name) contexts.push({ name: stripDiacritics(t.name).split(' ').join('_'), lifespan: 1 });
  }
  return {
    subscriberId,
    norm: {
      userId: subscriberId,
      text: text != null ? String(text) : undefined,
      event: ev ? { name: ev } : undefined,
      contexts,
      attrs: params,
    },
  };
}

async function normalizeDialogflow(c: Context): Promise<Normalized> {
  const b = await rawParams(c);
  const odi = b.originalDetectIntentRequest as { postback?: { payload?: string } } | undefined;
  const userId = str(b.user ?? b.channel);
  return {
    userId,
    text: odi?.postback?.payload ? undefined : str(b.text),
    event: odi?.postback?.payload ? { name: odi.postback.payload } : undefined,
    contexts: [{ name: 'janis', lifespan: 2 }],
    attrs: {},
  };
}

const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && v != null && v !== '' ? n : undefined;
};
const stripDiacritics = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------------------
// The pipeline — shared by all fallback flavors
// ---------------------------------------------------------------------------

async function agentByClientKey(db: Db, key: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${key}`)
    .limit(1);
  return row;
}

async function messengerChannelFor(db: Db, agentId: string) {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.kind, 'messenger')))
    .limit(1);
  return row;
}

/** Find-or-create the conversation for (channel, platform user). */
async function convForUser(db: Db, channel: ChannelRow, userId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(and(eq(channelBindings.channelId, channel.id), eq(channelBindings.platformUserId, userId)))
    .limit(1);
  if (row) return row.conversation;
  const [conv] = await db
    .insert(conversations)
    .values({
      agentId: channel.agentId,
      externalId: `messenger:${userId}`,
      userProfile: { id: userId, channel: 'messenger', channelName: channel.name },
    })
    .returning();
  await db
    .insert(channelBindings)
    .values({ channelId: channel.id, conversationId: conv.id, platformUserId: userId });
  return conv;
}

/** A page-inbox/df pause lapses after takeover_timeout minutes (legacy ~5). */
async function pauseLapsed(
  db: Db,
  conv: typeof conversations.$inferSelect,
  workspaceId: string,
  creds: ChannelCredentials,
  cfg: { takeover_timeout?: number },
) {
  if (conv.state !== 'human') return conv;
  const timed = conv.tags.includes(PAGE_INBOX_TAG) || conv.tags.includes(DF_PAUSE_TAG);
  if (!timed) return conv;
  const mins = cfg.takeover_timeout ?? creds.takeover_timeout ?? 5;
  if (!conv.humanSince || Date.now() - conv.humanSince.getTime() < mins * 60_000) return conv;
  const [updated] = await db
    .update(conversations)
    .set({
      state: 'active',
      humanSince: null,
      tags: conv.tags.filter((t) => t !== PAGE_INBOX_TAG && t !== DF_PAUSE_TAG),
    })
    .where(eq(conversations.id, conv.id))
    .returning();
  bus.publish(workspaceId, { type: 'conversation', data: toConversation(updated) });
  // Mirror legacy channelUpdate: on resume, pass the thread back to Janis's
  // secondary receiver app (metadata JANIS_SENDING_RESUME).
  const userId = conv.externalId.replace(/^messenger:/, '');
  if (creds.access_token && creds.secondary_receiver_id) {
    void passThreadControl(creds.access_token, userId, creds.secondary_receiver_id);
  }
  return updated;
}

async function setPaused(db: Db, conv: typeof conversations.$inferSelect, workspaceId: string, tag: string) {
  const tags = conv.tags.includes(tag) ? conv.tags : [...conv.tags, tag];
  const [updated] = await db
    .update(conversations)
    .set({ state: 'human', humanSince: new Date(), tags })
    .where(eq(conversations.id, conv.id))
    .returning();
  bus.publish(workspaceId, { type: 'conversation', data: toConversation(updated) });
}

/**
 * One fallback call = one user turn:
 *   client_key → agent → messenger channel → conv (find/create)
 *   paused → empty response (bot silent while a human owns the thread)
 *   DF query (sessionId = the messenger user id, as legacy did) → platform
 *   response → transcript events (in/out) + alert events for DF actions.
 */
async function runFallback(
  db: Db,
  clientKey: string,
  norm: Normalized,
  flavor: 'chatfuel' | 'manychat',
  sendtouser = false,
): Promise<Record<string, unknown> | null> {
  const agent = await agentByClientKey(db, clientKey);
  if (!agent) return null;
  const channel = await messengerChannelFor(db, agent.id);
  if (!channel || !norm.userId) return null;
  const creds = channel.credentials as ChannelCredentials;
  const cfg = (agent.config ?? {}) as { dialogflow?: { project: string; lang?: string }; legacy?: { takeover_timeout?: number } };

  let conv = await convForUser(db, channel, norm.userId);
  conv = await pauseLapsed(db, conv, channel.workspaceId, creds, cfg.legacy ?? {});

  const empty = flavor === 'manychat' ? { version: 'v2', content: { messages: [], actions: [] } } : { messages: [] };

  // log the turn even when paused — the transcript shouldn't go blind
  if (!sendtouser) {
    await processEvents(db, agent, [
      {
        type: 'message_in',
        conversation_id: conv.externalId,
        text: norm.text ?? (norm.event ? `[event] ${norm.event.name}` : ''),
        payload: { via: flavor },
      },
    ]);
  }
  if (conv.state === 'human' && !sendtouser) return empty;

  const secrets = await loadSecretsMap(db, agent.id);
  let sa: ServiceAccount | undefined;
  try {
    sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
  } catch {}
  if (!cfg.dialogflow?.project || !sa?.client_email || !sa.private_key) return empty;

  try {
    const res = await detectIntentChain(
      cfg.dialogflow.project,
      norm.userId, // legacy sessionId = messenger user id
      {
        text: norm.text,
        event: norm.event,
        lang: norm.lang ?? cfg.dialogflow.lang,
        contexts: norm.contexts,
        resetContexts: norm.resetContexts,
        location: norm.location,
        originalRequest: { source: 'FACEBOOK', data: norm.attrs },
      },
      sa,
    );
    const result = res?.result;
    if (!result) return empty;

    // legacy metered billing — one DF turn = one usage record, same spot as
    // wordhopapi's incrementUsageRecords (post-apirequest)
    void reportLegacyUsage(db, agent, conv);

    const out = flavor === 'manychat' ? buildManychatPayload(result) : buildChatfuelPayload(result);

    // transcript: store the reply summary as agent output
    const outText = transcriptSummary(out, flavor);
    if (outText) {
      await processEvents(db, agent, [
        {
          type: 'message_out',
          conversation_id: conv.externalId,
          text: outText,
          payload: { via: flavor, delivered: true, intent: result.metadata?.intentName },
        },
      ]);
    }

    // DF action contract (wordhopapi processApiAIResponse):
    const p = result.parameters ?? {};
    const action = result.action ?? '';
    const events: Parameters<typeof processEvents>[2] = [];
    if (result.metadata?.isFallback || action === 'input.unknown' || p.unknown_input != null) {
      events.push({ type: 'failure', conversation_id: conv.externalId, reason: `no intent matched "${(norm.text ?? '').slice(0, 120)}"` });
    }
    if (action === 'pause' || p.pause != null) {
      await setPaused(db, conv, channel.workspaceId, DF_PAUSE_TAG);
      conv = { ...conv, state: 'human' };
    }
    if (action === 'human' || p.human != null || action === 'takeover' || p.takeover != null) {
      events.push({ type: 'handoff_request', conversation_id: conv.externalId, reason: `intent ${result.metadata?.intentName ?? action}` });
      if (action === 'takeover' || p.takeover != null) {
        await setPaused(db, conv, channel.workspaceId, DF_PAUSE_TAG);
      }
    }
    if (action === 'alert.custom' || action === 'custom_alert' || p.custom_alert != null) {
      events.push({ type: 'custom_alert', conversation_id: conv.externalId, alert_type: result.metadata?.intentName ?? 'custom', text: norm.text });
    }
    if (events.length) await processEvents(db, agent, events);

    // "stop chat" = user-facing magic phrase: pass the thread to Janis's app
    if (
      !sendtouser &&
      norm.text?.toLowerCase().includes('stop chat') &&
      creds.secondary_receiver_id &&
      creds.access_token
    ) {
      void passThreadControl(creds.access_token, norm.userId, creds.secondary_receiver_id);
      await setPaused(db, conv, channel.workspaceId, PAGE_INBOX_TAG);
    }

    // ManyChat server-side send (sendContent/sendFlow) when we hold a token
    if (flavor === 'manychat' && creds.manychat_token) {
      void sendManyChatContent(creds.manychat_token, norm.userId, out);
      const flow = result.fulfillment.messages?.find((m) => m.payload?.flow)?.payload?.flow;
      if (typeof flow === 'string') void sendManyChatFlow(creds.manychat_token, norm.userId, flow);
    }

    return out;
  } catch {
    await processEvents(db, agent, [
      { type: 'failure', conversation_id: conv.externalId, reason: 'dialogflow call failed' },
    ]);
    return empty;
  }
}

function transcriptSummary(out: Record<string, unknown>, flavor: string): string {
  const list = (flavor === 'manychat' ? (out.content as { messages?: unknown[] })?.messages : out.messages) as
    | Record<string, unknown>[]
    | undefined;
  const parts: string[] = [];
  for (const m of list ?? []) {
    if (typeof m.text === 'string' && m.text.trim()) parts.push(m.text);
    else if (m.attachment) parts.push('[card]');
    else if (m.type === 'cards') parts.push('[cards]');
    else if (m.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

async function passThreadControl(accessToken: string, userId: string, targetAppId: string) {
  try {
    await fetch(`${GRAPH}/me/pass_thread_control?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: userId }, target_app_id: targetAppId, metadata: 'stop chat' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

async function sendManyChatContent(token: string, subscriberId: string, content: Record<string, unknown>) {
  try {
    await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriber_id: subscriberId, data: content, message_tag: 'ACCOUNT_UPDATE' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

async function sendManyChatFlow(token: string, subscriberId: string, flowNs: string) {
  try {
    await fetch('https://api.manychat.com/fb/sending/sendFlow', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: flowNs }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

async function convFor(db: Db, channel: ChannelRow, platformUserId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(and(eq(channelBindings.channelId, channel.id), eq(channelBindings.platformUserId, platformUserId)))
    .limit(1);
  return row?.conversation;
}

/** Dedupe on the Meta mid — retries and messaging+standby double-copies. */
async function midSeen(db: Db, convId: string, mid: string | undefined) {
  if (!mid) return false;
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), sql`payload->>'mid' = ${mid}`))
    .limit(1);
  return rows.length > 0;
}

/** An echo carrying another app's id = the bot platform (Chatfuel) replied. */
async function recordBotEcho(
  db: Db,
  channel: ChannelRow,
  platformUserId: string,
  msg: { mid?: string; text?: string },
  appId: string,
): Promise<void> {
  const conv = await convFor(db, channel, platformUserId);
  if (!conv || (await midSeen(db, conv.id, msg.mid))) return;
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: msg.text ?? null,
      payload: { via: 'bot_echo', app_id: appId, ...(msg.mid ? { mid: msg.mid } : {}) },
    })
    .returning();
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conv.id));
  bus.publish(channel.workspaceId, { type: 'message', data: toMessage(note) });
}

/** A human replied from FB Page Inbox — pause the bot on this conv. */
async function takeoverFromPageInbox(
  db: Db,
  channel: ChannelRow,
  platformUserId: string,
  msg: { mid?: string; text?: string },
): Promise<void> {
  const conv = await convFor(db, channel, platformUserId);
  if (!conv) return;
  const tags = conv.tags.includes(PAGE_INBOX_TAG) ? conv.tags : [...conv.tags, PAGE_INBOX_TAG];
  const [updated] = await db
    .update(conversations)
    .set({ state: 'human', humanSince: new Date(), tags })
    .where(eq(conversations.id, conv.id))
    .returning();
  if (await midSeen(db, conv.id, msg.mid)) return;
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'human',
      text: msg.text ?? null,
      payload: { via: 'page_inbox', ...(msg.mid ? { mid: msg.mid } : {}) },
    })
    .returning();
  bus.publish(channel.workspaceId, { type: 'message', data: toMessage(note) });
  bus.publish(channel.workspaceId, { type: 'conversation', data: toConversation(updated) });
}
