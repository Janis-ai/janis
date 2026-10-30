import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import { contactForBinding, linkConversationContact } from '../lib/contacts.js';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  alertRules,
  campaignSends,
  channelBindings,
  channels,
  convTombstones,
  conversations,
  messages,
  shopifyShops,
  slackThreads,
  suggestions,
  usageEvents,
  workspaces,
} from '../db/schema.js';
import type { ChannelCredentials, InboundMessage } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { messageCap } from '../lib/plans.js';
import { deliverToChannel, fetchPlatformProfile, sendChannelTyping } from '../lib/channels.js';
import { rehostAttachments } from '../lib/uploads.js';
import { toMessage } from '../lib/serializers.js';
import { bus } from '../lib/bus.js';
import { dispatchAlert, openAlertOnce } from '../lib/alerts.js';
import type { CapStatus } from '../lib/plans.js';
import { captureCsat } from '../lib/csat.js';
import { queueCrmActivity } from '../lib/crm.js';
import { pickAutoAssignee } from '../lib/rules.js';
import { systemNote } from '../lib/systemNote.js';
import { groupsForRules } from '../lib/ruleAlerts.js';
import { env } from '../env.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { emitHookEvent } from '../lib/hooks.js';
import { isUniqueViolation } from '../lib/errorReporting.js';
import { processEvents } from './ingest.js';

type ChannelRow = typeof channels.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

const PROFILE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Fields we always know from the channel itself. */
function baseProfile(channel: ChannelRow, msg: InboundMessage): UserProfile {
  return {
    id: msg.senderId,
    channel: channel.kind,
    channel_name: channel.name,
    ...(channel.kind === 'whatsapp' || channel.kind === 'sms' ? { phone: msg.senderId } : {}),
    ...(msg.user?.name ?? msg.name ? { name: msg.user?.name ?? msg.name } : {}),
    // webchat host-asserted identity. external_id is the host's user id and
    // feeds account lookups — only persist it when the assertion was
    // verified (session cookie or HMAC signature); an unverified claim could
    // point tools at someone else's account. name/email are as trustworthy
    // as anything the visitor types, so claims are fine.
    ...(msg.user?.verified && msg.user.id ? { external_id: msg.user.id } : {}),
    ...(msg.user?.email ? { email: msg.user.email } : {}),
    // Verified Janis identities carry the user's own avatar — picture_url is
    // the field every avatar surface (console, Slack) already reads.
    ...(msg.user?.avatarUrl ? { picture_url: msg.user.avatarUrl } : {}),
    ...(msg.user ? { identity_verified: msg.user.verified === true } : {}),
    // Storefront market the shopper is browsing — environment context, not
    // a host claim: "sold out" on their screen can mean "not deliverable in
    // this market", which is a different answer than out of stock.
    ...(msg.market ? { market: msg.market } : {}),
    // metadata merges per-key on update — cart rides alongside identify
    // traits without touching identity_verified (an anonymous shopper is
    // not "unverified", they just have a cart).
    ...(msg.user?.traits || msg.cart
      ? { metadata: { ...(msg.user?.traits ?? {}), ...(msg.cart ? { cart: msg.cart } : {}) } }
      : {}),
  };
}

/** Drop undefined/empty values so a sparse fetch never erases known data. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
}

/** Refresh the stored profile when stale — fire-and-forget after ingest. */
async function refreshProfile(
  db: Db,
  channel: ChannelRow,
  conv: ConversationRow,
): Promise<void> {
  const fetched = await fetchPlatformProfile(channel, String((conv.userProfile as UserProfile)?.id ?? ''));
  if (!Object.keys(defined(fetched)).length) return;
  // Key-level merge — a stale-snapshot replace can clobber verification state
  // a concurrent run wrote between this read and the platform fetch.
  await db
    .update(conversations)
    .set({
      userProfile: sql`coalesce(${conversations.userProfile}, '{}'::jsonb) || ${JSON.stringify(defined(fetched))}::jsonb`,
    })
    .where(eq(conversations.id, conv.id));
}

/**
 * A verified Janis user arriving with a visitor_id adopts that browser's
 * anonymous thread: when no user-bound conversation exists the visitor
 * conversation is re-keyed in place (transcript, state and binding carry
 * over untouched); when both exist the visitor transcript is folded into
 * the user thread. Called on message posts and transcript polls so logging
 * in never orphans the anonymous history. Visitor ids are unguessable
 * bearer tokens — knowing one already grants transcript read via the poll,
 * so adoption adds no meaningful exposure.
 */
/** Meta-PSID surfaces — a Chatfuel card, a ManyChat external request, and a
 *  direct Meta webhook event for the same page user are the same person. */
const META_PSID_KINDS = new Set(['messenger', 'instagram', 'chatfuel', 'manychat']);

export async function adoptVisitorConversation(
  db: Db,
  channel: ChannelRow,
  userParticipant: string,
  visitorParticipant: string,
  userEmail?: string,
): Promise<void> {
  // Internal test channels never adopt — they're console-only, and re-keying
  // a test thread to `kind:u:*` would collide with the operator's real
  // visitor conversation on the same agent.
  if ((channel.credentials as ChannelCredentials | null)?.internal) return;
  const find = (participant: string) =>
    db
      .select({ binding: channelBindings, conversation: conversations })
      .from(channelBindings)
      .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
      .where(
        and(
          eq(channelBindings.channelId, channel.id),
          eq(channelBindings.platformUserId, participant),
        ),
      )
      .limit(1);

  let uConv: ConversationRow | undefined;
  let wsId: string | undefined;
  // Internal transcript line so the folded history doesn't look like a
  // stranger's thread — invisible to anonymous viewers, visible in the
  // console and to the verified signed-in viewer.
  const noteAdopt = async (convId: string) => {
    if (!wsId) {
      const [a] = await db
        .select({ w: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, channel.agentId));
      wsId = a?.w;
    }
    if (wsId) {
      await systemNote(
        db, wsId, convId,
        'Signed in — continuing the earlier chat from this browser',
        'adopted',
      );
    }
  };
  const adopt = async (participant: string) => {
    if (!participant || participant === userParticipant) return;
    const [vb] = await find(participant);
    if (!vb) return;
    if (!uConv) {
      const [uRow] = await find(userParticipant);
      if (uRow) uConv = uRow.conversation;
      else {
        // u: threads are shared across surfaces — the user's conversation
        // may be bound to a sibling channel. Find it by externalId rather
        // than re-keying the visitor conv into the unique constraint.
        [uConv] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, channel.agentId),
              eq(conversations.externalId, `${channel.kind}:${userParticipant}`),
            ),
          )
          .limit(1);
      }
    }

    if (!uConv) {
      await db
        .update(conversations)
        .set({ externalId: `${channel.kind}:${userParticipant}` })
        .where(eq(conversations.id, vb.conversation.id));
      await db
        .update(channelBindings)
        .set({ platformUserId: userParticipant })
        .where(eq(channelBindings.id, vb.binding.id));
      uConv = vb.conversation;
      await noteAdopt(uConv.id);
      return;
    }
    if (uConv.id === vb.conversation.id) {
      await db
        .update(channelBindings)
        .set({ platformUserId: userParticipant })
        .where(eq(channelBindings.id, vb.binding.id));
      await noteAdopt(uConv.id);
      return;
    }

    const vId = vb.conversation.id;
    const uId = uConv.id;
    for (const t of [messages, suggestions, usageEvents] as const) {
      await db.update(t).set({ conversationId: uId }).where(eq(t.conversationId, vId));
    }
    // alerts_one_open_per_type is unique per (conversation,type): if the
    // survivor already has an open alert of that type the source's copy is
    // a true duplicate — drop it rather than let the retarget violate.
    await db.delete(alerts).where(and(
      eq(alerts.conversationId, vId),
      eq(alerts.status, 'open'),
      inArray(alerts.type, db.select({ t: alerts.type }).from(alerts)
        .where(and(eq(alerts.conversationId, uId), eq(alerts.status, 'open')))),
    ));
    await db.update(alerts).set({ conversationId: uId }).where(eq(alerts.conversationId, vId));
    // A conversation can own many Slack threads and all of them stay live —
    // repoint every one of the anonymous visitor's threads onto the merged
    // user conversation so replies there keep routing.
    await db.update(slackThreads).set({ conversationId: uId }).where(eq(slackThreads.conversationId, vId));
    // Tombstone the merge — links minted against the anon conv (alert
    // emails, bookmarks) resolve to the survivor instead of 404ing.
    await db
      .insert(convTombstones)
      .values({ id: vId, mergedIntoId: uId })
      .onConflictDoNothing();
    await db.delete(channelBindings).where(eq(channelBindings.id, vb.binding.id));
    await db.delete(conversations).where(eq(conversations.id, vId));

    const patch: Record<string, unknown> = {};
    // The stronger state wins — a live takeover or help request on the
    // anonymous thread must survive the merge.
    if (
      (vb.conversation.state === 'human' || vb.conversation.state === 'needs_human') &&
      uConv.state === 'active'
    ) {
      patch.state = vb.conversation.state;
      if (vb.conversation.state === 'human' && vb.conversation.humanSince) {
        patch.humanSince = vb.conversation.humanSince;
      }
    }
    if (vb.conversation.isUnread) patch.isUnread = true;
    if (vb.conversation.isStarred) patch.isStarred = true;
    if (!uConv.assigneeId && vb.conversation.assigneeId) {
      patch.assigneeId = vb.conversation.assigneeId;
    }
    if (
      vb.conversation.lastMessageAt &&
      (!uConv.lastMessageAt ||
        vb.conversation.lastMessageAt > uConv.lastMessageAt)
    ) {
      patch.lastMessageAt = vb.conversation.lastMessageAt;
      patch.lastMessagePreview = vb.conversation.lastMessagePreview;
      patch.lastMessageDirection = vb.conversation.lastMessageDirection;
    }
    if (Object.keys(patch).length) {
      await db.update(conversations).set(patch).where(eq(conversations.id, uId));
      uConv = { ...uConv, ...patch };
    }
    await noteAdopt(uId);
  };

  await adopt(visitorParticipant);

  // Other threads on this channel carrying a VERIFIED claim to the user's
  // email — e.g. a host site HMAC-asserted that visitor owns the address.
  // Self-reported emails (typed to the bot, unsigned claims) do NOT qualify:
  // anyone can claim an address, and a thread full of someone else's
  // messages must never land in a signed-in user's inbox on a bare say-so.
  if (!userEmail) return;
  const matches = await db
    .select({ binding: channelBindings, conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        sql`${channelBindings.platformUserId} not like 'u:%'`,
        sql`${conversations.userProfile}->>'identity_verified' = 'true'`,
        sql`lower(${conversations.userProfile}->>'email') = lower(${userEmail})`,
      ),
    );
  for (const m of matches) {
    await adopt(m.binding.platformUserId);
  }
}

/**
 * Handle an inbound message on a hosted channel:
 *   Meta → binding/conversation → ingest message_in → if the agent still owns
 *   the conversation, forward `message.user` to its webhook so it can reply.
 * needs_human only flags the conversation for attention — the agent keeps
 * replying. Only a human takeover pauses it, enforced at the pipe.
 */
export async function handleChannelMessage(
  db: Db,
  channel: ChannelRow,
  msg: InboundMessage,
): Promise<void> {
  // A verified Janis identity keys the conversation on the user — same
  // person, same thread across devices and surfaces (console rail, site
  // widget, cross-origin embeds presenting a signed claim for a real Janis
  // user). Host claims for their own users annotate the visitor's
  // conversation instead, and anonymous visitors keep their senderId binding.
  const baseParticipant =
    msg.user?.verified && msg.user.id && (msg.user.via === 'session' || msg.user.janisUser)
      ? `u:${msg.user.id}`
      : msg.senderId;
  // Copilot "New chat" — a thread key forks the verified user's participant
  // into u:<id>:<key>, binding its own conversation instead of the shared
  // u:<id> thread.
  const participantId =
    msg.thread && baseParticipant.startsWith('u:')
      ? `${baseParticipant}:${msg.thread}`
      : baseParticipant;
  const creds = channel.credentials as ChannelCredentials;
  // Internal test channels namespace externalId by channel — an operator's
  // test thread must not collide with their real visitor conversation on the
  // same agent (conversations_agent_external is unique), e.g. testing the
  // concierge that already answers their Ask Janis thread.
  let externalId = creds.internal
    ? `${channel.kind}:test:${channel.id}:${participantId}`
    : `${channel.kind}:${participantId}`;

  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  if (!agent) return;

  // A verified user posting from a browser that has an anonymous thread
  // adopts it — the old visitor conversation becomes (or folds into) the
  // user-bound one rather than stranding the transcript. On a named copilot
  // thread the browser's own thread still folds in, but the verified-email
  // sweep stays on the default thread — a fresh chat shouldn't inherit the
  // user's whole anonymous past.
  if (participantId !== msg.senderId) {
    await adoptVisitorConversation(
      db,
      channel,
      participantId,
      msg.senderId,
      msg.thread ? undefined : msg.user?.email,
    );
  }

  // Find or create the conversation + binding
  const [binding] = await db
    .select({ binding: channelBindings, conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, participantId),
      ),
    )
    .limit(1);

  let conv = binding?.conversation;

  // A conversation can exist for (agent, externalId) without this channel's
  // binding — a channel deleted and re-created, a binding pruned, or the same
  // participant arriving through a sibling channel. The insert below is
  // unique on (agent_id, external_id), so without this reattach path the
  // insert violates the constraint and gmail polls retry the same mail every
  // sweep forever.
  if (!conv) {
    // Meta-family surfaces (Meta webhook, Chatfuel, ManyChat) key their
    // threads on the same PSID but under different kind prefixes — search
    // all of them so one person keeps one conversation.
    const extCandidates =
      META_PSID_KINDS.has(channel.kind) && !participantId.startsWith('u:')
        ? [...META_PSID_KINDS].map((k) => `${k}:${participantId}`)
        : [externalId];
    const [byExt] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, channel.agentId),
          inArray(conversations.externalId, extCandidates),
        ),
      )
      .limit(1);
    if (byExt) {
      // Whose thread is this? channelBindings.conversationId is unique — a
      // conversation can only ever be bound to ONE channel, so "reattach"
      // only happens when the match has no live binding. Collision shapes:
      //   - a legacy internal test thread still carrying the plain
      //     kind:participant externalId (pre-namespacing) — re-key it to its
      //     test-scoped id so real channels stop shadowing on it
      //   - a thread bound to another live channel — u: participants share
      //     the thread across surfaces; anyone else would silently
      //     cross-post into a thread this channel can't poll, so this
      //     channel gets its own conversation under a channel-scoped
      //     externalId
      const [bound] = await db
        .select({
          channelId: channelBindings.channelId,
          credentials: channels.credentials,
          kind: channels.kind,
        })
        .from(channelBindings)
        .innerJoin(channels, eq(channelBindings.channelId, channels.id))
        .where(eq(channelBindings.conversationId, byExt.id))
        .limit(1);
      if (bound && (bound.credentials as ChannelCredentials | null)?.internal === true) {
        // A legacy internal test thread still carrying the plain
        // kind:participant externalId (pre-namespacing) — re-key it to its
        // test-scoped id so real channels stop shadowing on it.
        const testExt = `${channel.kind}:test:${bound.channelId}:${participantId}`;
        const [clash] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.agentId, channel.agentId), eq(conversations.externalId, testExt)),
          )
          .limit(1);
        await db
          .update(conversations)
          .set({ externalId: clash ? `${testExt}#legacy` : testExt })
          .where(eq(conversations.id, byExt.id));
      } else if (bound && bound.channelId !== channel.id) {
        if (participantId.startsWith('u:') ||
          (META_PSID_KINDS.has(bound.kind) && META_PSID_KINDS.has(channel.kind))) {
          // Verified Janis users share one thread across surfaces by design,
          // and Meta-family surfaces (Meta webhook / Chatfuel / ManyChat)
          // all key on the same PSID — one person, one conversation.
          conv = byExt;
        } else {
          // Anonymous/PSID threads belong to the channel that owns them —
          // attaching would silently cross-post into a thread this channel
          // can't poll. Channel-scoped externalId → own conversation.
          externalId = `${externalId}#ch:${channel.id}`;
        }
      } else {
        await db
          .insert(channelBindings)
          .values({ channelId: channel.id, conversationId: byExt.id, platformUserId: participantId })
          .onConflictDoNothing();
        conv = byExt;
      }
    }
  }

  // Test threads created before externalId namespacing still carry
  // `webchat:u:*` — re-key on the next message so they stop colliding with
  // (or shadowing) a real visitor conversation for the same user+agent.
  if (conv && creds.internal && conv.externalId !== externalId) {
    await db
      .update(conversations)
      .set({ externalId })
      .where(eq(conversations.id, conv.id));
    conv = { ...conv, externalId };
  }

  // The bound conversation's stored externalId can differ from the base id
  // recomputed above — POST /new forks it to `…#<ts>` (the archived thread
  // keeps the bare id) and a sibling-channel collision appends `#ch:<id>`.
  // processEvents and deliverWebhook re-resolve the conversation BY
  // externalId, so they must see the stored value — otherwise the inbound
  // lands on the archived thread (widget never echoes it → "Not delivered")
  // while the agent dispatches against the empty fork and replies to
  // nothing.
  if (conv) externalId = conv.externalId;

  // Hard-capped plan (free tier over its included volume): drop the inbound
  // before any platform calls or transcript writes — no profile fetch, no
  // greeting, no message row, no webhook delivery. First-time senders still
  // get a conversation shell so the alert has a home; one open 'custom'
  // alert per conversation keeps a flooded page from spamming alerts.
  const cap = await messageCap(db, agent.workspaceId);
  // Approaching-cap nudge (once per billing window): the merchant hears about
  // it while the agent still answers, not after it goes quiet.
  if (!cap.capped && cap.capKind && cap.fill >= 0.8) {
    void capNudge(db, agent, conv, cap, 'warn').catch(() => {});
  }
  if (cap.capped) {
    if (!conv) {
      // A parallel delivery (webhook + legacy fallback, Meta retry) can win
      // the create — on conflict re-read rather than 500.
      [conv] = await db
        .insert(conversations)
        .values({ agentId: channel.agentId, externalId, userProfile: baseProfile(channel, msg) })
        .onConflictDoNothing({ target: [conversations.agentId, conversations.externalId] })
        .returning();
      if (conv) emitHookEvent(db, channel.agentId, 'new_conversation', conv);
      if (!conv) {
        [conv] = await db
          .select()
          .from(conversations)
          .where(
            and(eq(conversations.agentId, channel.agentId), eq(conversations.externalId, externalId)),
          )
          .limit(1);
      }
      if (!conv) return; // winner's insert not yet visible — it owns the row
      await db.insert(channelBindings).values({
        channelId: channel.id,
        conversationId: conv.id,
        platformUserId: participantId,
      }).onConflictDoNothing();
      const contactId = await contactForBinding(db, {
        workspaceId: agent.workspaceId,
        channelId: channel.id,
        platformUserId: participantId,
        profile: conv.userProfile as UserProfile,
      });
      if (contactId) await linkConversationContact(db, conv.id, contactId);
    }
    const [openAlert] = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.conversationId, conv.id),
          eq(alerts.type, 'custom'),
          eq(alerts.status, 'open'),
        ),
      )
      .limit(1);
    if (!openAlert) {
      const { created, alert } = await openAlertOnce(db, {
        conversationId: conv.id,
        type: 'custom',
        detail: capHitDetail(cap),
      });
      // The first cap-hit per billing window dispatches; further alerts still
      // open per conversation (the inbox ledger) without re-pinging.
      if (created && alert && (await capNotice(db, agent.workspaceId, 'hit', cap.period))) {
        void dispatchAlert(db, agent, conv, alert, {
          url: await capActionUrl(db, agent.workspaceId, cap),
        }).catch(() => {});
      }
    }
    // While traffic keeps arriving over the cap, re-dispatch the open alert
    // once a day — the cap keeps dropping messages until the merchant acts.
    const reminder = openAlert ?? null;
    if (reminder && (await capNotice(db, agent.workspaceId, 'remind', cap.period))) {
      void dispatchAlert(db, agent, conv, reminder, {
        url: await capActionUrl(db, agent.workspaceId, cap),
      }).catch(() => {});
    }
    // Webchat visitors shouldn't type into a void — store one canned offline
    // reply per conversation so the transcript poll renders an answer. The
    // via marker doubles as the dedupe key and identifies it in the console.
    if (channel.kind === 'webchat') {
      const [sent] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            sql`direction = 'out' and payload->>'via' = 'cap_offline'`,
          ),
        )
        .limit(1);
      if (!sent) {
        const [note] = await db
          .insert(messages)
          .values({
            conversationId: conv.id,
            direction: 'out',
            text: "Sorry — this chat is offline right now. Please try again later, or reach the store through its contact page.",
            payload: { via: 'cap_offline' },
          })
          .returning();
        bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
      }
    }
    return;
  }

  // First-contact side effects (binding, auto-assign, greeting) belong to
  // the transaction that actually inserted the row — a delivery that loses
  // the create race re-reads the winner and skips them.
  let created = false;
  if (!conv) {
    // First contact — enrich with the platform profile (name/handle/picture)
    const fetched = await fetchPlatformProfile(channel, msg.senderId);
    const userProfile = { ...baseProfile(channel, msg), ...defined(fetched) };
    // Two deliveries (Meta retry, webhook + legacy-relay copies, or the
    // Chatfuel/ManyChat fallback racing the standby feed) can both miss the
    // lookups above — let the unique index settle it and re-read the winner.
    const [ins] = await db
      .insert(conversations)
      .values({ agentId: channel.agentId, externalId, userProfile })
      .onConflictDoNothing({ target: [conversations.agentId, conversations.externalId] })
      .returning();
    if (ins) {
      conv = ins;
      created = true;
    } else {
      [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(eq(conversations.agentId, channel.agentId), eq(conversations.externalId, externalId)),
        )
        .limit(1);
      if (!conv) return; // winner's insert not yet committed — it owns the row
    }
  }
  if (created) {
    await db.insert(channelBindings).values({
      channelId: channel.id,
      conversationId: conv.id,
      platformUserId: participantId,
    }).onConflictDoNothing();
    // Routing: an auto_assign rule picks the owner — fixed assignee or a
    // round-robin pool whose cursor persists on the rule config.
    const assignRules = await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.agentId, agent.id), eq(alertRules.kind, 'auto_assign')));
    const pick = pickAutoAssignee(
      assignRules,
      await groupsForRules(db, agent.workspaceId, assignRules),
    );
    if (pick) {
      await db
        .update(conversations)
        .set({ assigneeId: pick.userId })
        .where(eq(conversations.id, conv.id));
      conv = { ...conv, assigneeId: pick.userId };
      const cfg = (assignRules.find((r) => r.id === pick.ruleId)?.config ?? {}) as Record<
        string,
        unknown
      >;
      await db
        .update(alertRules)
        .set({ config: { ...cfg, next: pick.next } })
        .where(eq(alertRules.id, pick.ruleId));
      bus.publish(agent.workspaceId, {
        type: 'conversation',
        data: { id: conv.id, state: conv.state },
      });
    }
    // Greeting — a real outbound message stored before the inbound so the
    // transcript opens with it. Only fires on deliberate openers: a Meta
    // postback tap (Get Started/menu), or webchat/internal channels where
    // the widget renders its own greeting on open and this row keeps the
    // transcript honest. A typed first message IS the opener — greeting +
    // agent answer would double up. Null when greetings are disabled.
    // Internal test channels resolve synchronously so the row matches what
    // the rail's bootstrap already rendered — a background resolve could
    // land the generated text here after the placeholder showed the default.
    const greet = msg.postback === true || channel.kind === 'webchat';
    const greeting = !greet
      ? null
      : await resolveGreeting(channel, agent, undefined, {
          background: creds.internal !== true,
        }, db);
    if (greeting) {
      // Suggested replies ride the greeting on Meta channels — native quick
      // replies on Messenger/IG, interactive buttons on WhatsApp. Channel
      // list overrides the agent's, same as the widget. Also stored on the
      // payload so transcript surfaces (test rail, console) can render them.
      const replies = creds.quick_replies?.length
        ? creds.quick_replies
        : (((agent.config ?? {}) as { quick_replies?: string[] }).quick_replies ?? []);
      const [note] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: 'out',
          text: greeting,
          payload: { via: 'greeting', ...(replies.length ? { quick_replies: replies } : {}) },
        })
        .returning();
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
      void deliverToChannel(db, conv.id, greeting, undefined, { quickReplies: replies, messageId: note.id });
    }
  } else {
    // Keep WhatsApp names and channel identity current on every message;
    // re-fetch the Meta profile when it's stale (picture URLs expire)
    const profile = (conv.userProfile ?? {}) as UserProfile;
    const updates = defined({ ...baseProfile(channel, msg) });
    const stale =
      !profile.profile_fetched_at ||
      Date.now() - Date.parse(profile.profile_fetched_at) > PROFILE_STALE_MS;
    if (stale && profile.id) {
      void refreshProfile(db, channel, conv).catch(() => {});
    }
    // metadata is a dict of traits — merge keys rather than letting a later
    // message's partial trait set erase earlier ones.
    const mergedMeta =
      updates.metadata || profile.metadata
        ? {
            ...((profile.metadata as Record<string, unknown>) ?? {}),
            ...((updates.metadata as Record<string, unknown>) ?? {}),
          }
        : undefined;
    const nextProfile = {
      ...profile,
      ...updates,
      ...(mergedMeta ? { metadata: mergedMeta } : {}),
    };
    // Merge, never replace: this write runs on every inbound BEFORE the
    // conversation lock — a blind overwrite of a stale snapshot erases keys
    // a concurrent run just wrote (pending_verification, verified_emails).
    // Concat-only patch of the keys this message actually changed, with
    // metadata merged at the nested level for the same reason.
    const { metadata: _m, ...topPatch } = Object.fromEntries(
      Object.entries(nextProfile).filter(
        ([k, v]) => JSON.stringify((profile as Record<string, unknown>)[k]) !== JSON.stringify(v),
      ),
    );
    const metaPatch = (updates.metadata ?? {}) as Record<string, unknown>;
    const metaChanged =
      mergedMeta !== undefined &&
      JSON.stringify(profile.metadata) !== JSON.stringify(mergedMeta) &&
      Object.keys(metaPatch).length > 0;
    if (Object.keys(topPatch).length || metaChanged) {
      let merge = sql`coalesce(${conversations.userProfile}, '{}'::jsonb) || ${JSON.stringify(topPatch)}::jsonb`;
      if (metaChanged)
        merge = sql`${merge} || jsonb_build_object('metadata', coalesce(${conversations.userProfile}->'metadata', '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb)`;
      await db
        .update(conversations)
        .set({ userProfile: merge })
        .where(eq(conversations.id, conv.id));
      conv = { ...conv, userProfile: nextProfile };
    }
  }

  // Contact spine — resolve (channel, platformUserId) to a workspace contact
  // and link the conversation. Runs once per conversation (linked rows skip);
  // never blocks ingest — a failure just leaves contact_id null.
  if (!conv.contactId) {
    const profile = (conv.userProfile ?? {}) as UserProfile;
    void contactForBinding(db, {
      workspaceId: agent.workspaceId,
      channelId: channel.id,
      platformUserId: participantId,
      profile,
    })
      .then((contactId) => linkConversationContact(db, conv.id, contactId))
      .catch(() => {});
  }

  // Dedup: the same Meta event can reach us twice — once via the direct app
  // webhook and again through the legacy relay — when a page is subscribed
  // to both apps. The platform message id is unique per message.
  if (msg.messageId) {
    const [dup] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.direction, 'in'),
          sql`payload->>'mid' = ${msg.messageId}`,
        ),
      )
      .limit(1);
    if (dup) return;
  }

  const user = defined(conv.userProfile as UserProfile);
  const { picture_url: _pic, ...publicUser } = user; // raw CDN url stays server-side

  // Rehost remote attachment URLs (expiring Meta CDN links, wa-media: refs)
  // into durable /uploads/* rows before they enter the transcript or webhook.
  if (msg.attachments?.length) {
    // Twilio media URLs sit behind basic auth (sid:token) — pass the channel
    // creds so MMS attachments rehost instead of breaking.
    msg.attachments = await rehostAttachments(
      db,
      msg.attachments,
      creds.access_token,
      channel.kind === 'sms' && creds.twilio_account_sid
        ? { user: creds.twilio_account_sid, pass: creds.twilio_auth_token ?? '' }
        : undefined,
    );
  }

  // Store + evaluate rules
  const hasFiles = (msg.attachments?.length ?? 0) > 0;
  let result: Awaited<ReturnType<typeof processEvents>>[number] | undefined;
  try {
    [result] = await processEvents(db, agent, [
      {
        type: 'message_in',
        conversation_id: externalId,
        text: msg.text || (msg.attachments ?? []).map((a) => `📎 ${a.name}`).join('\n'),
        payload: {
          ...(msg.messageId ? { mid: msg.messageId } : {}),
          ...(hasFiles ? { attachments: msg.attachments } : {}),
          ...(msg.payload ?? {}),
          // u:-bound participants are verified Janis users — the Ask rail,
          // copilot threads, and the Slack concierge DM are operators
          // exercising the product, not customers. Ingest uses this to skip
          // intent/sentiment classification on their turns. Placed after
          // msg.payload so a caller can't forge or clear it.
          ...(participantId.startsWith('u:') ? { operator: true } : {}),
        },
        user: { id: msg.senderId },
      },
    ]);
  } catch (err) {
    // The same Meta event delivered concurrently via webhook + relay races
    // the dedup select above — the mid unique index settles it: the loser
    // is a dup, not an error.
    if (isUniqueViolation(err, 'messages_in_mid')) return;
    throw err;
  }

  // processEvents sees the ingress-created row as pre-existing, so its own
  // isNew emit can't fire — emit here, after the inbound message landed,
  // so the hook payload carries the first message's preview.
  if (created) emitHookEvent(db, channel.agentId, 'new_conversation', conv);

  // Campaign reply attribution — an inbound on a conversation a campaign
  // sent to marks those sends replied (also what stops a drip sequence).
  const repliedSends = await db
    .update(campaignSends)
    .set({ repliedAt: new Date() })
    .where(and(eq(campaignSends.conversationId, conv.id), isNull(campaignSends.repliedAt)))
    .returning({ id: campaignSends.id, contactId: campaignSends.contactId });
  for (const s of repliedSends) {
    if (s.contactId) {
      void queueCrmActivity(db, {
        workspaceId: channel.workspaceId,
        contactId: s.contactId,
        kind: 'campaign_reply',
        refId: s.id,
        summary: `Recipient replied${conv.contactId ? ` — conversation ${conv.id}` : ''}`,
      }).catch(() => {});
    }
  }

  // A pending CSAT prompt turns this reply into a rating — it's already in
  // the transcript; record the score and thank them without waking the agent.
  if (conv.csatPending) {
    if (await captureCsat(db, conv, msg.text ?? '')) return;
    conv = { ...conv, csatPending: false };
  }

  // Forward to the agent unless a human owns it — needs_human is just a
  // flag, and archived is inbox organization, not a mute: archived threads
  // still get answered, they just stay out of the inbox until escalation.
  const state = result?.conversation_state ?? conv.state;
  if (state !== 'human' && (agent.webhookUrl || agent.hosted)) {
    void sendChannelTyping(channel, msg.senderId);
    await deliverWebhook(db, agent, 'message.user', {
      conversation_id: externalId,
      janis_conversation_id: conv.id,
      text: msg.text || (msg.attachments ?? []).map((a) => `📎 ${a.name}`).join('\n'),
      user: publicUser,
      channel: { kind: channel.kind, name: channel.name },
      // External agents get absolute URLs — relative /uploads/* refs only
      // resolve against our own origin (transcript + widget).
      ...(hasFiles
        ? {
            payload: {
              attachments: (msg.attachments ?? []).map((a) => ({
                ...a,
                url: a.url.startsWith('http') ? a.url : `${env.apiOrigin}${a.url}`,
              })),
            },
          }
        : {}),
    });
  }
}

function capHitDetail(cap: CapStatus): string {
  return cap.capKind === 'shopify-usage'
    ? `Shopify usage cap reached on the ${cap.plan.name} plan — the merchant-approved billing ceiling rejected further usage records, so the agent stops answering until the cap is raised (Shopify admin → the Janis subscription) or the cycle rolls.`
    : `Message cap reached on ${cap.plan.name} plan (${cap.used}/${cap.plan.includedMessages} this period) — inbound messages are dropped until the plan is upgraded.`;
}

/** Cap-notice ledger on workspaces.config.cap_notices: 'warn'/'hit' fire once
 *  per billing window (keyed by cap.period), 'remind' throttles to once per
 *  day while the cap holds. Returns true when this notice should fire — the
 *  mark writes on the same read so the check is one update. */
async function capNotice(
  db: Db,
  workspaceId: string,
  kind: 'warn' | 'hit' | 'remind',
  period: string,
): Promise<boolean> {
  const [ws] = await db
    .select({ config: workspaces.config })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) return false;
  const config = { ...((ws.config ?? {}) as Record<string, unknown>) };
  const notices = { ...((config.cap_notices ?? {}) as Record<string, string>) };
  if (kind === 'remind') {
    const last = notices.remind ? new Date(notices.remind).getTime() : 0;
    if (Date.now() - last < 24 * 3600_000) return false;
    notices.remind = new Date().toISOString();
  } else {
    if (notices[kind] === period) return false;
    notices[kind] = period;
  }
  config.cap_notices = notices;
  await db
    .update(workspaces)
    .set({ config })
    .where(eq(workspaces.id, workspaceId));
  return true;
}

/** Warn/hit dispatch — attaches to the inbound conversation when there is
 *  one, else the agent's newest thread (an alert needs a home). */
async function capNudge(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect | null,
  cap: CapStatus,
  kind: 'warn',
): Promise<void> {
  if (!(await capNotice(db, agent.workspaceId, kind, cap.period))) return;
  let target = conv;
  if (!target) {
    [target] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agent.id))
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
  }
  if (!target) return; // no thread to pin the alert on — nothing to drop anyway
  const pct = Math.round(cap.fill * 100);
  const detail =
    cap.capKind === 'shopify-usage'
      ? `Approaching the Shopify usage cap on the ${cap.plan.name} plan — ${pct}% of the merchant-approved billing ceiling used this cycle. Raise the cap in Shopify admin before the agent stops answering.`
      : `Approaching the ${cap.plan.name} plan's message cap — ${cap.used}/${cap.plan.includedMessages} messages used this period (${pct}%). Upgrade before the agent stops answering.`;
  const { created, alert } = await openAlertOnce(db, {
    conversationId: target.id,
    type: 'custom',
    detail,
  });
  if (created && alert) {
    await dispatchAlert(db, agent, target, alert, {
      url: await capActionUrl(db, agent.workspaceId, cap),
    }).catch(() => {});
  }
}

/** Where the nudge email/push lands the operator: the billing page for
 *  message caps, the merchant's own Shopify admin for usage caps (that's
 *  where the cappedAmount gets raised — our console can't do it for them). */
async function capActionUrl(
  db: Db,
  workspaceId: string,
  cap: CapStatus,
): Promise<string | undefined> {
  if (cap.capKind !== 'shopify-usage') return '/billing';
  const [shop] = await db
    .select({ shop: shopifyShops.shop })
    .from(shopifyShops)
    .where(eq(shopifyShops.workspaceId, workspaceId))
    .limit(1);
  return shop
    ? `https://${shop.shop}/admin/apps/${env.shopifyAppApiKey}`
    : '/billing';
}
