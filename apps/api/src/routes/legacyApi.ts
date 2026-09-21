import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { findChannelByObjectId } from '../lib/channels.js';
import { isLegacyPaid, reportLegacyUsage } from '../lib/legacyBilling.js';
import { detectIntentV1, type LegacyContext, type ServiceAccount } from '../lib/dialogflow.js';
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

    const msg = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const channelId = String(msg?.channel ?? msg?.user ?? '');
    if (!msg || !channelId) return c.json({ error: 'bad request' }, 400);

    const channel = await channelFor(db, agent, msg);
    if (!channel) return c.json({ error: 'no channel' }, 404);
    const conv = await findOrCreateConv(db, agent, channel, channelId);

    await storeMessage(db, agent, conv, 'in', msg);
    void reportLegacyUsage(db, agent, conv);

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

    return c.json({ paused: conv.state === 'human', id: channelId });
  });

  // POST /api/v1/out — log the bot's outbound reply. Legacy answered 'OK'
  // first and processed async; we just await the insert.
  app.post('/out', async (c) => {
    const agent = await agentForKey(db, c.req.header('clientkey') ?? '');
    if (!agent || !(await isLegacyPaid(agent))) return c.json(REFUSED);

    const msg = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const channelId = String(msg?.channel ?? msg?.user ?? '');
    if (!msg || !channelId) return c.json({ error: 'bad request' }, 400);

    const channel = await channelFor(db, agent, msg);
    if (!channel) return c.json({ error: 'no channel' }, 404);
    const conv = await findOrCreateConv(db, agent, channel, channelId);
    await storeMessage(db, agent, conv, 'out', msg);
    return c.text('OK');
  });

  // POST /api/v1/update_bot_socket_id — socket server isn't ported; accept
  // and discard so the SDK's startup call doesn't error.
  app.post('/update_bot_socket_id', (c) => c.json({ ok: true }));

  return app;
}
