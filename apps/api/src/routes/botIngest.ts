import { Hono } from 'hono';
import { and, eq, gt, or, sql, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, conversations, messages } from '../db/schema.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { normalizeChatfuel, normalizeManychat } from './legacy.js';
import { dbRateLimit } from '../lib/rateLimit.js';

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

const shapeFor = (flavor: Flavor, text: string) =>
  flavor === 'manychat'
    ? { version: 'v2', content: { messages: [{ type: 'text', text }], actions: [] } }
    : { messages: [{ text }] };

/** The platform call is synchronous and the platforms wait ~15s — poll for
 *  the hosted pipeline's reply rather than holding the pipeline open. */
async function waitForOutbound(db: Db, conversationId: string, since: Date) {
  const ms = Number(process.env.BOT_INGEST_WAIT_MS ?? 14_000);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [hit] = await db
      .select({ text: messages.text })
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
    if (hit?.text) return hit.text;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
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
    await handleChannelMessage(db, channel, {
      objectId: '',
      senderId: norm.userId,
      text: norm.text ?? '',
      payload: { via: flavor, attrs: norm.attrs },
    });

    const externalId = `${flavor}:${norm.userId}`;
    const [conv] = await db
      .select({ id: conversations.id, state: conversations.state })
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, externalId)))
      .limit(1);
    if (!conv || conv.state === 'human') return c.json(emptyFor(flavor));

    const reply = await waitForOutbound(db, conv.id, since);
    return c.json(reply ? shapeFor(flavor, reply) : emptyFor(flavor));
  });

  return app;
}
