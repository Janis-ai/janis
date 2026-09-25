import { and, eq, sql } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  channelBindings,
  channels,
  conversations,
  messages,
  slackThreads,
  suggestions,
  usageEvents,
} from '../db/schema.js';
import type { ChannelCredentials, InboundMessage } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { messageCap } from '../lib/plans.js';
import { deliverToChannel, fetchPlatformProfile, sendChannelTyping } from '../lib/channels.js';
import { rehostAttachments } from '../lib/uploads.js';
import { toMessage } from '../lib/serializers.js';
import { bus } from '../lib/bus.js';
import { openAlertOnce } from '../lib/alerts.js';
import { env } from '../env.js';
import { deliverWebhook } from '../lib/webhooks.js';
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
    ...(channel.kind === 'whatsapp' ? { phone: msg.senderId } : {}),
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
  const merged = { ...(conv.userProfile as UserProfile), ...defined(fetched) };
  await db
    .update(conversations)
    .set({ userProfile: merged })
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

  let ub: { binding: typeof channelBindings.$inferSelect; conversation: ConversationRow } | undefined;
  const adopt = async (participant: string) => {
    if (!participant || participant === userParticipant) return;
    const [vb] = await find(participant);
    if (!vb) return;
    if (!ub) [ub] = await find(userParticipant);

    if (!ub) {
      await db
        .update(conversations)
        .set({ externalId: `${channel.kind}:${userParticipant}` })
        .where(eq(conversations.id, vb.conversation.id));
      await db
        .update(channelBindings)
        .set({ platformUserId: userParticipant })
        .where(eq(channelBindings.id, vb.binding.id));
      [ub] = await find(userParticipant);
      return;
    }

    const vId = vb.conversation.id;
    const uId = ub.conversation.id;
    for (const t of [messages, alerts, suggestions, usageEvents] as const) {
      await db.update(t).set({ conversationId: uId }).where(eq(t.conversationId, vId));
    }
    // A conversation can own many Slack threads and all of them stay live —
    // repoint every one of the anonymous visitor's threads onto the merged
    // user conversation so replies there keep routing.
    await db.update(slackThreads).set({ conversationId: uId }).where(eq(slackThreads.conversationId, vId));
    await db.delete(channelBindings).where(eq(channelBindings.id, vb.binding.id));
    await db.delete(conversations).where(eq(conversations.id, vId));

    const patch: Record<string, unknown> = {};
    // The stronger state wins — a live takeover or help request on the
    // anonymous thread must survive the merge.
    if (
      (vb.conversation.state === 'human' || vb.conversation.state === 'needs_human') &&
      ub.conversation.state === 'active'
    ) {
      patch.state = vb.conversation.state;
      if (vb.conversation.state === 'human' && vb.conversation.humanSince) {
        patch.humanSince = vb.conversation.humanSince;
      }
    }
    if (vb.conversation.isUnread) patch.isUnread = true;
    if (vb.conversation.isStarred) patch.isStarred = true;
    if (!ub.conversation.assigneeId && vb.conversation.assigneeId) {
      patch.assigneeId = vb.conversation.assigneeId;
    }
    if (
      vb.conversation.lastMessageAt &&
      (!ub.conversation.lastMessageAt ||
        vb.conversation.lastMessageAt > ub.conversation.lastMessageAt)
    ) {
      patch.lastMessageAt = vb.conversation.lastMessageAt;
      patch.lastMessagePreview = vb.conversation.lastMessagePreview;
      patch.lastMessageDirection = vb.conversation.lastMessageDirection;
    }
    if (Object.keys(patch).length) {
      await db.update(conversations).set(patch).where(eq(conversations.id, uId));
      ub = { ...ub, conversation: { ...ub.conversation, ...patch } };
    }
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
  const participantId =
    msg.user?.verified && msg.user.id && (msg.user.via === 'session' || msg.user.janisUser)
      ? `u:${msg.user.id}`
      : msg.senderId;
  const creds = channel.credentials as ChannelCredentials;
  // Internal test channels namespace externalId by channel — an operator's
  // test thread must not collide with their real visitor conversation on the
  // same agent (conversations_agent_external is unique), e.g. testing the
  // concierge that already answers their Ask Janis thread.
  const externalId = creds.internal
    ? `${channel.kind}:test:${channel.id}:${participantId}`
    : `${channel.kind}:${participantId}`;

  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  if (!agent) return;

  // A verified user posting from a browser that has an anonymous thread
  // adopts it — the old visitor conversation becomes (or folds into) the
  // user-bound one rather than stranding the transcript.
  if (participantId !== msg.senderId) {
    await adoptVisitorConversation(db, channel, participantId, msg.senderId, msg.user?.email);
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

  // Hard-capped plan (free tier over its included volume): drop the inbound
  // before any platform calls or transcript writes — no profile fetch, no
  // greeting, no message row, no webhook delivery. First-time senders still
  // get a conversation shell so the alert has a home; one open 'custom'
  // alert per conversation keeps a flooded page from spamming alerts.
  const cap = await messageCap(db, agent.workspaceId);
  if (cap.capped) {
    if (!conv) {
      [conv] = await db
        .insert(conversations)
        .values({ agentId: channel.agentId, externalId, userProfile: baseProfile(channel, msg) })
        .returning();
      await db.insert(channelBindings).values({
        channelId: channel.id,
        conversationId: conv.id,
        platformUserId: participantId,
      });
    }
    const [open] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.conversationId, conv.id),
          eq(alerts.type, 'custom'),
          eq(alerts.status, 'open'),
        ),
      )
      .limit(1);
    if (!open) {
      await openAlertOnce(db, {
        conversationId: conv.id,
        type: 'custom',
        detail: `Message cap reached on ${cap.plan.name} plan (${cap.used}/${cap.plan.includedMessages} this period) — inbound messages are dropped until the plan is upgraded.`,
      });
    }
    return;
  }

  if (!conv) {
    // First contact — enrich with the platform profile (name/handle/picture)
    const fetched = await fetchPlatformProfile(channel, msg.senderId);
    const userProfile = { ...baseProfile(channel, msg), ...defined(fetched) };
    [conv] = await db
      .insert(conversations)
      .values({ agentId: channel.agentId, externalId, userProfile })
      .returning();
    await db.insert(channelBindings).values({
      channelId: channel.id,
      conversationId: conv.id,
      platformUserId: participantId,
    });
    // Greeting — a real outbound message stored before the inbound so the
    // transcript opens with it. Null when the agent has greetings disabled.
    // deliverToChannel pushes it on Meta; on webchat the widget renders its
    // own greeting locally and the poll filters this row out. Internal test
    // channels resolve synchronously so the row matches what the rail's
    // bootstrap already rendered — a background resolve could land the
    // generated text here after the placeholder showed the default.
    const greeting = await resolveGreeting(channel, agent, undefined, {
      background: creds.internal !== true,
    });
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
    const changed = Object.entries(updates).some(
      ([k, v]) => (profile as Record<string, unknown>)[k] !== v,
    );
    if (changed) {
      await db
        .update(conversations)
        .set({ userProfile: { ...profile, ...updates } })
        .where(eq(conversations.id, conv.id));
      conv = { ...conv, userProfile: { ...profile, ...updates } };
    }
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
    msg.attachments = await rehostAttachments(db, msg.attachments, creds.access_token);
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
        },
        user: { id: msg.senderId },
      },
    ]);
  } catch (err) {
    // The same Meta event delivered concurrently via webhook + relay races
    // the dedup select above — the mid unique index settles it: the loser
    // is a dup, not an error.
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === '23505' && e.constraint_name === 'messages_in_mid') return;
    throw err;
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
