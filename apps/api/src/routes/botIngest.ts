import { Hono } from 'hono';
import { and, eq, gt, inArray, or, sql, desc } from 'drizzle-orm';
import type { QuickReply } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { normalizeChatfuel, normalizeManychat } from './legacy.js';
import { dbRateLimit } from '../lib/rateLimit.js';
import { splitResponse } from '../lib/legacyFormat.js';
import { qrTitle, type ChannelCredentials } from '../lib/channels.js';

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

/** Suggested replies → the platform's quick-reply shape. A Chatfuel tap
 *  sets `user input` and redirects to the Janis block (the documented name
 *  for the block holding the JSON API card) so the card re-fires with the
 *  label as the user's message; a ManyChat node target is named after the
 *  label so a same-named flow/node picks the tap up. Non-string replies
 *  (email/phone collectors) have no bot-platform primitive — dropped. */
const qrFor = (flavor: Flavor, qrs: QuickReply[]) =>
  qrs
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, 11)
    .map((label) =>
      flavor === 'chatfuel'
        ? { title: qrTitle(label), block_names: ['Janis'], set_attributes: { 'user input': label } }
        : { type: 'node', caption: qrTitle(label), target: label },
    );

/** Reply text → the platform's response shape. Long answers split at the
 *  640-char message cap (the legacy formatter's limit — Chatfuel drops
 *  oversize message objects silently). Quick replies ride the last text
 *  message, the only spot Chatfuel renders them. */
export function shapeReply(flavor: Flavor, text: string, qrs: QuickReply[] = []) {
  const chunks = splitResponse(text).filter(Boolean);
  const quickReplies = qrFor(flavor, qrs);
  if (flavor === 'manychat') {
    const content: Record<string, unknown> = {
      messages: chunks.map((t) => ({ type: 'text', text: t })),
      actions: [],
    };
    if (quickReplies.length) content.quick_replies = quickReplies;
    return { version: 'v2', content };
  }
  const msgs = chunks.map((t) => ({ text: t }) as Record<string, unknown>);
  if (quickReplies.length && msgs.length) msgs[msgs.length - 1].quick_replies = quickReplies;
  return { messages: msgs };
}

/** The platform call is synchronous and the platforms wait ~15s — poll for
 *  the hosted pipeline's reply rather than holding the pipeline open. */
async function waitForOutbound(db: Db, conversationId: string, since: Date) {
  const ms = Number(process.env.BOT_INGEST_WAIT_MS ?? 14_000);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [hit] = await db
      .select({ text: messages.text, payload: messages.payload })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'out'),
          gt(messages.createdAt, since),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (hit?.text) {
      const quickReplies =
        (hit.payload as { quick_replies?: QuickReply[] } | undefined)?.quick_replies ?? [];
      return { text: hit.text, quickReplies };
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
  if (bound.kind === 'chatfuel') return false;
  if (bound.kind === 'manychat')
    return Boolean((bound.credentials as ChannelCredentials).manychat_token);
  return true;
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
    // The same message can arrive twice when the page is ALSO subscribed to
    // our Meta webhook (secondary receiver) and the bot card forwards it —
    // Meta's mid doesn't reach the card, so dedup on sender+text+window.
    if (norm.text) {
      const [dup] = await db
        .select({ id: messages.id })
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
            eq(messages.text, norm.text),
            gt(messages.createdAt, new Date(Date.now() - 90_000)),
          ),
        )
        .limit(1);
      if (dup) {
        const [conv] = await db
          .select({ id: conversations.id, state: conversations.state })
          .from(conversations)
          .innerJoin(messages, eq(messages.conversationId, conversations.id))
          .where(eq(messages.id, dup.id))
          .limit(1);
        if (!conv || conv.state === 'human' || (await pushOwnsDelivery(db, conv.id)))
          return c.json(emptyFor(flavor));
        const reply = await waitForOutbound(db, conv.id, new Date(Date.now() - 90_000));
        return c.json(reply ? shapeReply(flavor, reply.text, reply.quickReplies) : emptyFor(flavor));
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
    return c.json(reply ? shapeReply(flavor, reply.text, reply.quickReplies) : emptyFor(flavor));
  });

  return app;
}
