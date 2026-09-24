import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages, sessions, users } from '../db/schema.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { sha256 } from '../lib/crypto.js';
import type { ChannelCredentials, InboundMessage } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { MAX_UPLOAD_BYTES, storeUpload } from '../lib/uploads.js';
import { adoptVisitorConversation, handleChannelMessage } from '../services/channelIngress.js';
import { bus } from '../lib/bus.js';
import { agentWorking, operatorTyping } from '../lib/typingState.js';

/**
 * Public web-chat widget endpoints, mounted at /chat (no session auth).
 * The channel id is the public token; the visitor id (crypto-random, stored
 * in the visitor's browser) is the transcript credential.
 */
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

const attachment = z.object({
  name: z.string().max(255),
  url: z.string().regex(/^\/uploads\//),
  type: z.string().max(100),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
});

/** Host-asserted identity — `sig` is HMAC-SHA256(identity_secret, `${id}|${email}|${name}`). */
const identityClaim = z.object({
  id: z.string().max(120).optional(),
  name: z.string().max(80).optional(),
  email: z.string().max(200).optional(),
  sig: z.string().max(200).optional(),
});

const postMessage = z
  .object({
    visitor_id: z.string().regex(VISITOR_RE),
    text: z.string().max(4000).default(''),
    name: z.string().max(80).optional(),
    user: identityClaim.optional(),
    attachments: z.array(attachment).max(5).optional(),
  })
  .refine((d) => d.text.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'text or attachments required',
  });

async function findChannel(db: Db, token: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, token), eq(channels.kind, 'webchat')))
    .limit(1);
  return channel;
}

type Claim = z.infer<typeof identityClaim>;
type ChannelRow = typeof channels.$inferSelect;

/** HMAC check — sig proves the host server (which knows the secret) vouched
 *  for this exact id/email/name triple. */
function verifyIdentitySig(secret: string, claim: Claim): boolean {
  if (!claim.sig) return false;
  const expected = createHmac('sha256', secret)
    .update(`${claim.id ?? ''}|${claim.email ?? ''}|${claim.name ?? ''}`)
    .digest('hex');
  return (
    expected.length === claim.sig.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(claim.sig))
  );
}

/**
 * Resolve who the visitor is, most-trusted first:
 *   1. a valid Janis session cookie — same-origin embeds (app.janis.ai) and
 *      credentialed embeds identify the logged-in account automatically;
 *   2. a host-signed claim — the embedding site signs with the channel's
 *      identity_secret (server-side) so identity can't be forged client-side;
 *   3. an unsigned claim — stored but flagged unverified.
 */
async function resolveIdentity(
  c: Context,
  db: Db,
  channel: ChannelRow,
  claim: Claim | undefined,
): Promise<InboundMessage['user']> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (row) {
      return {
        id: row.user.id,
        name: row.user.name,
        email: row.user.email,
        verified: true,
        via: 'session',
        avatarUrl: row.user.avatarUrl ?? undefined,
      };
    }
  }
  if (!claim) return undefined;
  const secret = (channel.credentials as ChannelCredentials).identity_secret;
  const verified = secret ? verifyIdentitySig(secret, claim) : false;
  // A verified claim whose id is a real Janis user is the cross-origin form
  // of a session identity (the /identity endpoint vends exactly this) — it
  // binds the conversation to the user the same way.
  let janisUser = false;
  let avatarUrl: string | undefined;
  if (verified && claim.id && UUID_RE.test(claim.id)) {
    const [u] = await db
      .select({ id: users.id, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, claim.id))
      .limit(1);
    janisUser = Boolean(u);
    avatarUrl = u?.avatarUrl ?? undefined;
  }
  return {
    id: claim.id,
    name: claim.name,
    email: claim.email,
    verified,
    via: 'claim',
    janisUser,
    avatarUrl,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Binding key for transcript lookups — mirrors channelIngress: a verified
 * Janis identity (session cookie, or a signed claim whose id is a real Janis
 * user) keys the conversation on the user so the same person keeps one
 * thread across devices and surfaces. Host-signed claims for their own
 * (non-Janis) users annotate the visitor's conversation instead. */
function participantFor(resolved: InboundMessage['user'] | undefined, visitorId: string) {
  return resolved?.verified && resolved.id && (resolved.via === 'session' || resolved.janisUser)
    ? `u:${resolved.id}`
    : visitorId;
}

/** Conversation bound to this channel + visitor, if one exists. */
async function findConversation(db: Db, channelId: string, visitorId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channelId),
        eq(channelBindings.platformUserId, visitorId),
      ),
    )
    .limit(1);
  return row?.conversation;
}

export function webchatRoutes(db: Db) {
  const app = new Hono();

  // Widget bootstrap — display config only; credentials never leave the API.
  app.get('/:token', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1);
    const creds = channel.credentials as ChannelCredentials;
    const agentCfg = (agent?.config ?? {}) as { quick_replies?: string[] };
    const agentReplies = agentCfg.quick_replies ?? [];
    // Same resolver as ingress so the widget's greeting matches the one
    // stored on the transcript (generated greetings are cached per channel).
    // Internal test channels resolve synchronously — a background resolve
    // could return the default here while the stored row gets the generated
    // text once the cache warms, and the rail would show a placeholder that
    // doesn't match the transcript.
    const internal = (channel.credentials as ChannelCredentials).internal === true;
    const greeting = await resolveGreeting(channel, agent, undefined, { background: !internal });
    return c.json({
      name: channel.name,
      agent_name: agent?.name ?? 'Assistant',
      title: creds.title ?? channel.name,
      subtitle: creds.subtitle ?? null,
      greeting,
      accent: creds.accent ?? null,
      position: creds.position === 'left' ? 'left' : 'right',
      logo_url: creds.logo_url ?? null,
      // channel-level override wins; agent config is the default
      quick_replies: creds.quick_replies?.length ? creds.quick_replies : agentReplies,
    });
  });

  // Send a visitor message — runs through the same ingest/agent pipeline.
  app.post('/:token/messages', zValidator('json', postMessage), async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const { visitor_id, text, name, user, attachments } = c.req.valid('json');
    const resolved = await resolveIdentity(c, db, channel, user);
    await handleChannelMessage(db, channel, {
      objectId: '',
      senderId: visitor_id,
      text,
      name: resolved?.name ?? name,
      user: resolved,
      attachments,
    });
    return c.json({ ok: true });
  });

  // Host-asserted identity update — lets the embed call Janis.identify()
  // before the first message or after a login/logout on the host page.
  app.post(
    '/:token/identify',
    zValidator('json', z.object({ visitor_id: z.string().regex(VISITOR_RE), user: identityClaim })),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id, user } = c.req.valid('json');
      const resolved = await resolveIdentity(c, db, channel, user);
      const conv = await findConversation(db, channel.id, participantFor(resolved, visitor_id));
      if (!resolved || !conv) return c.json({ ok: true }); // attaches on first message anyway
      const profile = (conv.userProfile ?? {}) as Record<string, unknown>;
      const patch = {
        ...(resolved.name ? { name: resolved.name } : {}),
        ...(resolved.email ? { email: resolved.email } : {}),
        ...(resolved.avatarUrl ? { picture_url: resolved.avatarUrl } : {}),
        ...(resolved.verified && resolved.id ? { external_id: resolved.id } : {}),
        identity_verified: resolved.verified === true,
      };
      await db
        .update(conversations)
        .set({ userProfile: { ...profile, ...patch } })
        .where(eq(conversations.id, conv.id));
      return c.json({ ok: true });
    },
  );

  // Signed identity bootstrap — a logged-in Janis session holder gets their
  // own identity back, HMAC-signed with the channel's identity_secret, ready
  // to pass to Janis.identify(). Lets host pages on any origin assert a
  // verified identity; unsigned/absent sessions get {enabled:false}.
  app.get('/:token/identity', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const secret = (channel.credentials as ChannelCredentials).identity_secret;
    const token = getCookie(c, SESSION_COOKIE);
    if (!secret || !token) return c.json({ enabled: false });
    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ enabled: false });
    const u = { id: row.user.id, name: row.user.name, email: row.user.email };
    const sig = createHmac('sha256', secret)
      .update(`${u.id}|${u.email}|${u.name}`)
      .digest('hex');
    return c.json({ id: u.id, name: u.name, email: u.email, sig });
  });

  // Widget file upload — same storage as console uploads, but scoped to a
  // live channel + well-formed visitor id instead of a session. URL comes
  // back relative; the widget prefixes its API origin, and attachments are
  // only accepted into messages if they point at /uploads/*.
  app.post('/:token/uploads', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const body = await c.req.parseBody();
    const visitorId = typeof body['visitor_id'] === 'string' ? body['visitor_id'] : '';
    if (!VISITOR_RE.test(visitorId)) return c.json({ error: 'bad visitor_id' }, 400);
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const ref = await storeUpload(db, {
      name: file.name,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(ref, 201);
  });

  // Poll for messages. ?visitor_id= identifies anonymous browsers; a session
  // cookie or a signed claim (?u_id&u_name&u_email&u_sig) for a real Janis
  // user resolves to the user's own conversation instead (see ingress).
  // & after=<ISO timestamp> increments. Only direction/text/created_at are
  // exposed — never payloads or internals.
  app.get('/:token/messages', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const claim: Claim = {
      id: c.req.query('u_id'),
      name: c.req.query('u_name'),
      email: c.req.query('u_email'),
      sig: c.req.query('u_sig'),
    };
    const resolved = await resolveIdentity(c, db, channel, claim);
    const visitorId = c.req.query('visitor_id') ?? '';
    const bound =
      resolved?.verified && resolved.id && (resolved.via === 'session' || resolved.janisUser);
    if (!bound && !VISITOR_RE.test(visitorId)) {
      return c.json({ error: 'bad visitor_id' }, 400);
    }
    // Same adoption as ingress — a signed-in user's poll pulls their
    // browser's anonymous thread into the user-bound conversation even
    // before they send anything new.
    if (bound && VISITOR_RE.test(visitorId)) {
      await adoptVisitorConversation(db, channel, `u:${resolved!.id}`, visitorId, resolved!.email);
    }
    // Live transcript data must never be heuristically cached — a stale
    // response hides new messages and makes delivery look broken.
    c.header('cache-control', 'no-store');
    const conv = await findConversation(db, channel.id, participantFor(resolved, visitorId));
    if (!conv) return c.json({ messages: [], state: 'new' });

    const after = c.req.query('after');
    const afterDate = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
    const before = c.req.query('before');
    const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
    // Latest page first: with no cursor the visitor cares about the newest
    // history, and older pages back-fill via ?before= as they scroll up.
    // Fetching PAGE+1 rows tells us whether an earlier page exists.
    const PAGE = 100;
    const select = () =>
      db
        .select({
          id: messages.id,
          direction: messages.direction,
          text: messages.text,
          created_at: messages.createdAt,
          payload: messages.payload,
          flags: messages.flags,
          author_id: messages.authorId,
        })
        .from(messages);
    let rows;
    let hasMore = false;
    if (afterDate) {
      // incremental poll — chronological, everything since the cursor
      rows = await select()
        .where(and(eq(messages.conversationId, conv.id), gte(messages.createdAt, afterDate)))
        .orderBy(asc(messages.createdAt))
        .limit(500);
    } else {
      const fetched = await select()
        .where(
          and(
            eq(messages.conversationId, conv.id),
            ...(beforeDate ? [lt(messages.createdAt, beforeDate)] : []),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(PAGE + 1);
      hasMore = fetched.length > PAGE;
      rows = fetched.slice(0, PAGE).reverse();
    }

    // Operator identity on human replies — driven by each operator's
    // show_identity setting. display_name wins, else first name.
    const authors = new Map<string, { name: string; avatar: string | null }>();
    const ids = [...new Set(rows.filter((r) => r.direction === 'human' && r.author_id).map((r) => r.author_id!))];
    if (ids.length) {
      const us = await db
        .select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl, showIdentity: users.showIdentity })
        .from(users)
        .where(inArray(users.id, ids));
      for (const u of us) {
        // per-operator opt-out — their replies stay anonymous
        if (u.showIdentity === false) continue;
        authors.set(u.id, {
          name: u.displayName || u.name.split(' ')[0] || u.name,
          avatar: u.avatarUrl,
        });
      }
    }

    // Internal test channels: the greeting row is a real transcript message
    // the rail should show — the widget's own bootstrap-greeting render is
    // skipped for those, so there's nothing to double.
    const internal = (channel.credentials as ChannelCredentials).internal === true;

    return c.json({
      // Internal notes (failures/handoffs/alerts) are stored as 'out' but must
      // never reach the visitor — filter them here, same as deliverToChannel does.
      messages: rows
        .filter((m) => {
          const f = (m.flags ?? {}) as {
            failure?: boolean;
            help_requested?: boolean;
            custom_alert?: boolean;
            handoff_offer?: boolean;
            handoff_cancelled?: boolean;
          };
          // via:'greeting' rows are real transcript messages, but the widget
          // renders its own greeting from the bootstrap — don't double it.
          // payload.internal covers operator-only rows (takeover/resume/notes)
          // — they carry the author's real name and must never reach visitors.
          const p = m.payload as
            | { via?: string; internal?: boolean; action?: unknown }
            | undefined;
          return (
            !f.failure &&
            !f.help_requested &&
            !f.custom_alert &&
            !f.handoff_offer &&
            !f.handoff_cancelled &&
            (internal || p?.via !== 'greeting') &&
            // Approval cards reach the internal test rail (Ask Janis) so an
            // operator can exercise a gated tool end-to-end; every other
            // internal row stays operator-side.
            (!p?.internal || (internal && !!p?.action))
          );
        })
        .map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        created_at: m.created_at.toISOString(),
        attachments: (m.payload as { attachments?: unknown[] } | undefined)?.attachments,
        quick_replies: (m.payload as { quick_replies?: string[] } | undefined)?.quick_replies,
        // approval card payload — serialized only for internal test channels;
        // external embeds must never see tool args (refund amounts, order ids)
        ...(internal
          ? { action: (m.payload as { action?: unknown } | undefined)?.action }
          : {}),
        // operator identity on human replies — gated by each operator's
        // show_identity profile setting, not a per-channel flag
        ...(m.direction === 'human' && m.author_id && authors.has(m.author_id)
          ? { author: authors.get(m.author_id) }
          : {}),
      })),
      state: conv.state,
      participant: participantFor(resolved, visitorId),
      conversation_id: conv.id,
      // an operator composing in the console — the widget/rail render dots;
      // name is null when the operator opted out of identity sharing
      operator_typing: operatorTyping(conv.id),
      // a message.user was dispatched to the agent and no reply has landed
      // yet — real signal, unlike the post-send guess clients already make
      agent_typing: agentWorking(conv.id),
      // only meaningful on full-page loads — incremental `after` polls omit it
      ...(afterDate ? {} : { has_more: hasMore }),
    });
  });

  // Visitor typing ping — ephemeral bus event to the console, never stored.
  // Throttled client-side; drops silently when the thread doesn't exist yet.
  app.post(
    '/:token/typing',
    zValidator('json', z.object({ visitor_id: z.string().regex(VISITOR_RE) })),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id } = c.req.valid('json');
      const resolved = await resolveIdentity(c, db, channel, undefined);
      const participant = participantFor(resolved, visitor_id);
      const conv = await findConversation(db, channel.id, participant);
      if (!conv) return c.json({ ok: true });
      const [agent] = await db
        .select({ workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, channel.agentId))
        .limit(1);
      if (agent) {
        const name = (conv.userProfile as { name?: string } | null)?.name;
        // the typer's own Janis account, when session-bound — lets the
        // console suppress "visitor is typing" for your own rail chats.
        // Internal test channels omit it: there the operator IS role-playing
        // the visitor, and seeing the dots land in the console is the point.
        const internal = (channel.credentials as ChannelCredentials).internal === true;
        bus.publish(agent.workspaceId, {
          type: 'typing',
          data: {
            conversation_id: conv.id,
            name,
            user_id: internal
              ? null
              : participant.startsWith('u:')
                ? participant.slice(2)
                : null,
          },
        });
      }
      return c.json({ ok: true });
    },
  );

  return app;
}
