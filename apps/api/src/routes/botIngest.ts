import { Hono } from 'hono';
import { and, eq, gt, inArray, or, sql, desc } from 'drizzle-orm';
import type { QuickReply } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { normalizeChatfuel, normalizeManychat } from './legacy.js';
import { dbRateLimit } from '../lib/rateLimit.js';
import { buildBotResponse, type BotEffect } from '../lib/botPlatform.js';
import { formatForChannel, stampDelivery, type ChannelCredentials } from '../lib/channels.js';
import type { AttachmentRef } from '../lib/channels.js';
import type { WidgetComponent } from '../lib/widgets.js';

/**
 * First-class bot-platform ingest — POST /bot/:key/:flavor.
 *
 * Chatfuel's JSON API card and ManyChat's External Request both POST the
 * user's message synchronously and expect the reply in the HTTP response.
 * The agent's `metadata.bot_key` (minted by GET /api/agents/:id/bot)
 * authorizes the call; a migrated agent's `legacy_client_key` also works —
 * repointing a legacy bot's card at this URL IS the migration path off the
 * Dialogflow shim.
 *
 * Unlike the legacy /messenger/client/* fallbacks this runs the hosted
 * pipeline (knowledge, tools, persona) — no Dialogflow, no legacy paywall.
 * A human-owned conversation returns an empty platform response — the bot
 * goes silent while a teammate owns the thread.
 */

type Flavor = 'chatfuel' | 'manychat';

const emptyFor = (flavor: Flavor) =>
  flavor === 'manychat'
    ? { version: 'v2', content: { messages: [], actions: [] } }
    : { messages: [] };

/** Reply text + quick replies → the platform's response shape. Kept as the
 *  public name tests and older callers know — the mapping itself lives in
 *  lib/botPlatform (widgets, attachments and {{…}} effects included). */
export function shapeReply(flavor: Flavor, text: string, qrs: QuickReply[] = []) {
  return buildBotResponse(flavor, { text, quickReplies: qrs });
}

/** The platform call is synchronous and the platforms wait ~15s — poll for
 *  the hosted pipeline's reply rather than holding the pipeline open. The
 *  outbound row carries the reply's rich parts on its payload: widgets and
 *  attachments render into platform cards/media, and channel_effects are
 *  the human labels for the {{…}} directives ingest stripped out — the
 *  structured effects alongside them become set_attributes/actions. */
async function waitForOutbound(db: Db, conversationId: string, since: Date) {
  const ms = Number(process.env.BOT_INGEST_WAIT_MS ?? 14_000);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [hit] = await db
      .select({ id: messages.id, text: messages.text, payload: messages.payload })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'out'),
          gt(messages.createdAt, since),
          // Internal notes and system-flagged markers (handoff, status,
          // alerts) aren't replies — the card must never show them.
          sql`(${messages.payload}->>'internal') is distinct from 'true'`,
          sql`not exists (select 1 from jsonb_each_text(${messages.flags}) f where f.value = 'true')`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const p = hit?.payload as
      | {
          quick_replies?: QuickReply[];
          widgets?: WidgetComponent[];
          attachments?: AttachmentRef[];
          effects?: BotEffect[];
          channel_effects?: string[];
        }
      | undefined;
    // A directive- or widget-only reply stores no text — rich payload still
    // counts as an answer (a bare {{goto}} IS the whole reply).
    if (hit && (hit.text || p?.widgets?.length || p?.attachments?.length || p?.effects?.length)) {
      return {
        id: hit.id,
        text: hit.text ?? '',
        quickReplies: p?.quick_replies ?? [],
        widgets: p?.widgets,
        attachments: p?.attachments,
        effects: p?.effects,
        channelEffects: p?.channel_effects,
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Does a push channel already own delivery for this conversation? A conv
 *  bound to a Meta channel (the Meta-family merge — the page is also on
 *  our webhook) gets its replies Graph-sent by the outbox, and a ManyChat
 *  channel holding an API token pushes via sendContent. In both cases the
 *  card response must stay empty or the user sees every reply twice. */
async function pushOwnsDelivery(db: Db, conversationId: string) {
  const [bound] = await db
    .select({ kind: channels.kind, credentials: channels.credentials })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  if (!bound) return false;
  // Chatfuel agent replies never push — the card response IS the delivery
  // channel even on OAuth'd pages (only human takeover sends push, via
  // the HUMAN_AGENT tag, and those aren't agent replies).
  if (bound.kind === 'chatfuel') return false;
  if (bound.kind === 'manychat')
    return Boolean((bound.credentials as ChannelCredentials).manychat_token);
  return true;
}

/** Stored reply → platform JSON. The stored text is canonical markdown —
 *  bot platforms render plain text, so translate it the same way the push
 *  path does before shaping the response. */
function botResponse(flavor: Flavor, reply: NonNullable<Awaited<ReturnType<typeof waitForOutbound>>>) {
  return buildBotResponse(flavor, {
    text: formatForChannel(reply.text, flavor),
    quickReplies: reply.quickReplies,
    widgets: reply.widgets,
    attachments: reply.attachments,
    effects: reply.effects,
  });
}

export function botIngestRoutes(db: Db) {
  const app = new Hono();

  app.use(
    '/*',
    dbRateLimit(db, {
      scope: 'bot-ingest',
      windowMs: 60_000,
      max: 120,
      methods: ['POST'],
      key: (c) => c.req.param('key') ?? 'unknown',
    }),
  );

  app.post('/:key/:flavor', async (c) => {
    const flavor = c.req.param('flavor') as Flavor;
    if (flavor !== 'chatfuel' && flavor !== 'manychat') return c.json({ error: 'not found' }, 404);

    const [agent] = await db
      .select()
      .from(agents)
      .where(
        or(
          sql`${agents.metadata}->>'bot_key' = ${c.req.param('key')}`,
          sql`${agents.metadata}->>'legacy_client_key' = ${c.req.param('key')}`,
        ),
      )
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);

    const norm = flavor === 'chatfuel' ? await normalizeChatfuel(c) : (await normalizeManychat(c)).norm;
    if (!norm.userId) return c.json(emptyFor(flavor));

    // find-or-create the flavor channel so the conversation namespaces
    // correctly (chatfuel:<psid> — not folded into the messenger thread).
    let [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.agentId, agent.id), eq(channels.kind, flavor)))
      .limit(1);
    if (!channel) {
      [channel] = await db
        .insert(channels)
        .values({
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          kind: flavor,
          name: flavor === 'chatfuel' ? 'Chatfuel' : 'ManyChat',
          credentials: {},
        })
        .onConflictDoNothing()
        .returning();
      channel ??= (
        await db
          .select()
          .from(channels)
          .where(and(eq(channels.agentId, agent.id), eq(channels.kind, flavor)))
          .limit(1)
      )[0];
    }
    if (!channel) return c.json(emptyFor(flavor));

    const since = new Date();
    // The same customer message can arrive twice — once via the page's Meta
    // webhook (mid-stamped), once via the bot card (via-stamped). Each
    // delivery has one of each, so counting halves separates a second COPY
    // (completes a pair) from a genuine REPEAT (tips the balance) — paired
    // deliveries sit at v == m.
    if (norm.text) {
      const normText = norm.text;
      const matching = () =>
        db
          .select({
            id: messages.id,
            convId: messages.conversationId,
            via: sql<string | null>`${messages.payload}->>'via'`,
            mid: sql<string | null>`${messages.payload}->>'mid'`,
          })
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(
            and(
              eq(conversations.agentId, agent.id),
              inArray(
                conversations.externalId,
                ['messenger', 'instagram', 'chatfuel', 'manychat'].map(
                  (k) => `${k}:${norm.userId}`,
                ),
              ),
              eq(messages.direction, 'in'),
              eq(messages.text, normText),
              gt(messages.createdAt, new Date(Date.now() - 90_000)),
            ),
          );
      // An OAuth'd (webhook-backed) channel is fed by Meta — an unpaired
      // webhook copy means THIS call is the pair's other half, a reply
      // poller only. A credless channel has no webhook; any prior copy is
      // a duplicate card call.
      const webhookBacked =
        flavor === 'chatfuel' &&
        Boolean((channel.credentials as ChannelCredentials).access_token);
      const isDup = (rows: Awaited<ReturnType<typeof matching>>) => {
        const v = rows.filter((r) => r.via === flavor).length;
        const m = rows.filter((r) => r.via !== flavor && r.mid).length;
        return webhookBacked ? v < m : rows.length > 0;
      };
      let rows = await matching();
      // Meta's copy may still be in flight when the card lands — give it a
      // few seconds before treating the card's copy as the real one.
      for (let i = 0; webhookBacked && !isDup(rows) && i < 16; i++) {
        await new Promise((r) => setTimeout(r, 250));
        rows = await matching();
      }
      if (isDup(rows)) {
        const convId = (rows.find((r) => r.mid) ?? rows[0]).convId;
        const [conv] = await db
          .select({ id: conversations.id, state: conversations.state })
          .from(conversations)
          .where(eq(conversations.id, convId))
          .limit(1);
        if (!conv || conv.state === 'human' || (await pushOwnsDelivery(db, conv.id)))
          return c.json(emptyFor(flavor));
        const reply = await waitForOutbound(db, conv.id, new Date(Date.now() - 90_000));
        if (reply) {
          // Riding the card response IS the delivery — stamp it confirmed.
          void stampDelivery(db, agent.workspaceId, reply.id, { delivered: true }).catch(() => {});
          return c.json(botResponse(flavor, reply));
        }
        return c.json(emptyFor(flavor));
      }
    }

    await handleChannelMessage(db, channel, {
      objectId: '',
      senderId: norm.userId,
      // an event-only post (a flow/button firing {{event}} / dfEvent with
      // no typed text) still reaches the agent — same mapping the legacy
      // fallback used; on a new conversation it opens with the greeting.
      text: norm.text ?? (norm.event ? `[event] ${norm.event.name}` : ''),
      postback: !norm.text && Boolean(norm.event),
      payload: { via: flavor, attrs: norm.attrs },
    });

    const externalId = `${flavor}:${norm.userId}`;
    const [conv] = await db
      .select({ id: conversations.id, state: conversations.state })
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, externalId)))
      .limit(1);
    if (!conv || conv.state === 'human' || (await pushOwnsDelivery(db, conv.id)))
      return c.json(emptyFor(flavor));

    const reply = await waitForOutbound(db, conv.id, since);
    if (reply) {
      // Riding the card response IS the delivery — stamp it confirmed.
      void stampDelivery(db, agent.workspaceId, reply.id, { delivered: true }).catch(() => {});
      return c.json(botResponse(flavor, reply));
    }
    return c.json(emptyFor(flavor));
  });

  return app;
}
