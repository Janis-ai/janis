import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { toMessage } from '../lib/serializers.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { findChannelByObjectId } from '../lib/channels.js';
import { isLegacyPaid, reportLegacyUsage } from '../lib/legacyBilling.js';
import { detectIntentV1, type LegacyContext, type ServiceAccount } from '../lib/dialogflow.js';
import { env } from '../env.js';
import { loadSecretsMap } from '../lib/secrets.js';
import { processEvents } from '../services/ingest.js';

type AgentRow = typeof agents.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/**
 * Legacy npm-SDK endpoints (api.janis.ai/api/v1/*). Self-hosted bots run the
 * `janis` package: they receive Meta webhooks on their own infra, call their
 * own Dialogflow agent (or ours via the `detectintent` header), and log both
 * directions here for transcripts + alerts.
 *
 * Auth is the `clientkey` header — a 48-char secret unique per bot, resolved
 * to an imported agent via metadata.legacy_client_key. Non-paying/trialing
 * callers get legacy's refusal shape and nothing is stored.
 */

const REFUSED = { error: 'no subscription found' };

async function agentForKey(db: Db, key: string): Promise<AgentRow | null> {
  const [a] = await db
    .select()
    .from(agents)
    .where(sql`metadata->>'legacy_client_key' = ${key}`)
    .limit(1);
  return a ?? null;
}

/** Page that received the event — rawbody.entry[0].id when present. */
function pageIdFrom(msg: Record<string, unknown>): string | null {
  try {
    const raw = typeof msg.rawbody === 'string' ? JSON.parse(msg.rawbody) : msg.rawbody;
    const id = (raw as { entry?: { id?: unknown }[] })?.entry?.[0]?.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

async function channelFor(
  db: Db,
  agent: AgentRow,
  msg: Record<string, unknown>,
): Promise<ChannelRow | null> {
  const pageId = pageIdFrom(msg);
  if (pageId) {
    const ch = await findChannelByObjectId(db, pageId);
    if (ch) return ch;
  }
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agent.id), eq(channels.kind, 'messenger')))
    .limit(1);
  return ch ?? null;
}

async function findOrCreateConv(
  db: Db,
  agent: AgentRow,
  channel: ChannelRow,
  platformUserId: string,
): Promise<ConversationRow> {
  const [binding] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  if (binding) return binding.conversation;

  const [conv] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      externalId: `${channel.kind}:${platformUserId}`,
      userProfile: { id: platformUserId, channel: channel.kind, channel_name: channel.name },
    })
    .returning();
  await db.insert(channelBindings).values({
    channelId: channel.id,
    conversationId: conv.id,
    platformUserId,
  });
  return conv;
}

/** Store one transcript row; a raced duplicate mid resolves to undefined. */
async function storeMessage(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  direction: 'in' | 'out',
  msg: Record<string, unknown>,
): Promise<void> {
  const text = typeof msg.text === 'string' ? msg.text : '';
  try {
    await processEvents(db, agent, [
      {
        type: direction === 'in' ? 'message_in' : 'message_out',
        conversation_id: conv.externalId,
        text,
        payload: {
          ...(msg.mid ? { mid: String(msg.mid) } : {}),
          ...(direction === 'out' ? { delivered: true, via: 'legacy-sdk' } : {}),
        },
        user: { id: String(msg.user ?? msg.channel ?? '') },
      },
    ]);
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === '23505' && e.constraint_name === 'messages_in_mid') return;
    throw err;
  }
}

/**
 * Mirror a request to wordhopapi so the legacy pipeline keeps working:
 * Mongo transcripts (legacy dashboard), channel paused state (takeovers),
 * and the POST to wordhop-slack that mirrors messages into customer Slack
 * channels. Returns null when forwarding is disabled or unreachable.
 */
async function forwardToLegacy(
  path: string,
  method: string,
  reqHeaders: Headers,
  body: string | null,
): Promise<Response | null> {
  if (!env.legacyApiUrl) return null;
  const headers = new Headers();
  reqHeaders.forEach((v, k) => {
    if (!/^(host|connection|content-length|cf-|x-forwarded)/i.test(k)) headers.set(k, v);
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    return await fetch(`${env.legacyApiUrl}/api/v1${path}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? undefined),
      signal: ctrl.signal,
    });
  } catch (err) {
    console.warn('legacy forward failed', path, (err as Error).message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function isLegacyAgent(agent: AgentRow): boolean {
  return !!(agent.metadata as Record<string, unknown> | null)?.legacy_client_key;
}

async function dfConfig(agent: AgentRow) {
  const dfCfg = (agent.config as { dialogflow?: { project?: string; lang?: string } } | null)
    ?.dialogflow;
  return dfCfg?.project ? dfCfg : null;
}

export function legacyApiRoutes(db: Db) {
  const app = new Hono();

  // POST /api/v1/in — log inbound; `detectintent` header → run our DF call
  // and return the v1-shaped reply the SDK expects. Response is either
  // {paused, id} (channel state) or the message array with `reply`.
  app.post('/in', async (c) => {
    const agent = await agentForKey(db, c.req.header('clientkey') ?? '');
    if (!agent || !(await isLegacyPaid(agent))) return c.json(REFUSED);

    const rawBody = await c.req.text();
    const msg = (() => { try { return JSON.parse(rawBody); } catch { return null; } })() as Record<
      string,
      unknown
    > | null;
    const channelId = String(msg?.channel ?? msg?.user ?? '');
    if (!msg || !channelId) return c.json({ error: 'bad request' }, 400);

    // Mirror into legacy in parallel — must be awaited: Cloud Run throttles
    // CPU between requests, so fire-and-forget fetches may never complete.
    const fwd = isLegacyAgent(agent)
      ? forwardToLegacy('/in', 'POST', c.req.raw.headers, rawBody)
      : null;

    const channel = await channelFor(db, agent, msg);
    if (!channel) return c.json({ error: 'no channel' }, 404);
    const conv = await findOrCreateConv(db, agent, channel, channelId);

    await storeMessage(db, agent, conv, 'in', msg);
    void reportLegacyUsage(db, agent, conv);

    // The forwarded response carries Mongo's channel state — the
    // authoritative paused flag for Slack/dashboard takeovers.
    let paused = conv.state === 'human';
    if (fwd) {
      const fwdJson = (await fwd.then((r) => r?.json().catch(() => null))) as {
        paused?: unknown;
      } | null;
      if (typeof fwdJson?.paused === 'boolean') paused = fwdJson.paused;
    }
    if (paused !== (conv.state === 'human') && (paused || conv.state === 'human')) {
      await db
        .update(conversations)
        .set({ state: paused ? 'human' : 'active' })
        .where(eq(conversations.id, conv.id));
    }

    if (c.req.header('detectintent')) {
      // Caller already ran DF itself and passed the reply through — echo it
      // back rather than paying for a second detectIntent (legacy behavior).
      let reply = typeof msg.reply === 'string' ? msg.reply : null;
      if (!reply) {
        const df = await dfConfig(agent);
        const secrets = await loadSecretsMap(db, agent.id);
        let sa: ServiceAccount | undefined;
        try {
          sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
        } catch {}
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (df && sa?.client_email && sa.private_key && text) {
          const contexts = (Array.isArray(msg.contexts) ? msg.contexts : undefined) as
            | LegacyContext[]
            | undefined;
          const r = await detectIntentV1(
            df.project!,
            channelId, // legacy used message.channel as the session id
            { text, lang: df.lang ?? 'en', contexts: contexts ?? [{ name: 'janis', lifespan: 2 }] },
            sa,
          ).catch(() => null);
          if (r) reply = JSON.stringify(r);
        }
      }
      return c.json([{ ...msg, ...(reply ? { reply } : {}) }]);
    }

    return c.json({ paused, id: channelId });
  });

  // POST /api/v1/out — log the bot's outbound reply. Legacy answered 'OK'
  // first and processed async; we just await the insert.
  app.post('/out', async (c) => {
    const agent = await agentForKey(db, c.req.header('clientkey') ?? '');
    if (!agent || !(await isLegacyPaid(agent))) return c.json(REFUSED);

    const rawBody = await c.req.text();
    const fwd = isLegacyAgent(agent)
      ? forwardToLegacy('/out', 'POST', c.req.raw.headers, rawBody)
      : null;

    const msg = (() => { try { return JSON.parse(rawBody); } catch { return null; } })() as Record<
      string,
      unknown
    > | null;
    const channelId = String(msg?.channel ?? msg?.user ?? '');
    if (!msg || !channelId) return c.json({ error: 'bad request' }, 400);

    const channel = await channelFor(db, agent, msg);
    if (!channel) return c.json({ error: 'no channel' }, 404);
    const conv = await findOrCreateConv(db, agent, channel, channelId);
    await storeMessage(db, agent, conv, 'out', msg);
    await fwd; // ensure the mirror completes before we respond
    return c.text('OK');
  });

  // POST /api/v1/update_bot_socket_id — the SDK registers its socket.io id
  // (from wordhop-socket-server) on connect/reconnect; we store it on the
  // agent so operator replies and channel updates can be pushed to the bot.
  app.post('/update_bot_socket_id', async (c) => {
    const agent = await agentForKey(db, c.req.header('clientkey') ?? '');
    if (!agent) return c.json(REFUSED);

    const body = (await c.req.json().catch(() => null)) as { socket_id?: unknown } | null;
    const socketId = typeof body?.socket_id === 'string' ? body.socket_id : null;
    if (!socketId) return c.json({ error: 'bad request' }, 400);

    await db
      .update(agents)
      .set({
        metadata: {
          ...(agent.metadata as Record<string, unknown>),
          legacy_socket_id: socketId,
        },
      })
      .where(eq(agents.id, agent.id));
    return c.json({ response: { socket_id: socketId } });
  });

  // POST /api/v1/mirror — reverse direction of the forward above:
  // wordhopapi calls this when a human replies via legacy Slack takeover
  // (/send_chat_response) or pauses/resumes a channel (/api/v1/update_channel),
  // so Postgres transcripts + conversation state stay complete.
  app.post('/mirror', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const key = c.req.header('clientkey') ?? String(body?.client_key ?? '');
    const agent = key ? await agentForKey(db, key) : null;
    if (!agent) return c.json(REFUSED);

    const channelId = String(body?.channel ?? body?.user ?? '');
    if (!channelId) return c.json({ error: 'bad request' }, 400);
    const channel = await channelFor(db, agent, body!);
    if (!channel) return c.json({ error: 'no channel' }, 404);
    const conv = await findOrCreateConv(db, agent, channel, channelId);

    if (typeof body?.paused === 'boolean') {
      const isHuman = conv.state === 'human';
      if (body.paused !== isHuman && (body.paused || isHuman)) {
        await db
          .update(conversations)
          .set({ state: body.paused ? 'human' : 'active' })
          .where(eq(conversations.id, conv.id));
      }
    }

    const text = typeof body?.text === 'string' ? body.text : '';
    if (text) {
      const [message] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: 'human',
          text,
          payload: { via: 'legacy-takeover' },
        })
        .returning();
      await db
        .update(conversations)
        .set({
          lastMessageAt: message.createdAt,
          lastMessagePreview: text.slice(0, 140),
          lastMessageDirection: 'human',
        })
        .where(eq(conversations.id, conv.id));
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(message) });
    }
    return c.json({ ok: true });
  });

  // Everything else the old api.janis.ai exposed (/unknown, /human,
  // /customalert, /channel_state, /transcribe, /get_profile, …) is proxied
  // to wordhopapi verbatim — those endpoints drive legacy alerts/takeovers
  // and have no Postgres-side equivalent yet.
  app.all('/*', async (c) => {
    const key = c.req.header('clientkey');
    if (!key || !env.legacyApiUrl) return c.json(REFUSED);
    const agent = await agentForKey(db, key);
    // Native (non-legacy) agents have no counterpart upstream.
    if (agent && !isLegacyAgent(agent)) return c.json({ error: 'not found' }, 404);

    const path =
      (c.req.path.replace(/^\/api\/v1/, '') || '/') + new URL(c.req.url).search;
    const body =
      c.req.raw.method === 'GET' || c.req.raw.method === 'HEAD' ? null : await c.req.text();
    const res = await forwardToLegacy(path, c.req.raw.method, c.req.raw.headers, body);
    if (!res) return c.json(REFUSED);
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  });

  return app;
}
