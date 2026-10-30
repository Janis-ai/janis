import type { IngestEvent, IngestResult, QuickReply } from '@janis/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alertRules,
  alerts,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { openAlertOnce, resolveOpenAlerts } from '../lib/alerts.js';
import { enrichHandoff } from '../lib/handoff.js';
import { alertNotification, eventForAlertType, notifyWorkspace, type NotifyEvent } from '../lib/notify.js';
import { evaluateActions, evaluateEvent } from '../lib/rules.js';
import { advanceRuleCursor, groupsForRules } from '../lib/ruleAlerts.js';
import { classifyAndRoute, checkInboundSentiment, recheckIntent } from '../lib/intent.js';
import { fireEventWebhook } from '../lib/eventWebhook.js';
import { emitHookEvent } from '../lib/hooks.js';
import { mirrorToSlack, postSlackAlert, setSlackThreadStatus } from '../lib/slack.js';
import { agentEligibleMembers } from '../lib/members.js';
import { deliverToChannel, type AttachmentRef } from '../lib/channels.js';
import { effectLabel, parseDirectives, type BotEffect } from '../lib/botPlatform.js';
import type { WidgetComponent } from '../lib/widgets.js';
import { toAlert, toConversation, toMessage } from '../lib/serializers.js';
import { METER_MESSAGES, billingCustomerFor, reportMeter } from '../lib/stripe.js';
import { messageCap } from '../lib/plans.js';
import { clearAgentWorking, clearOperatorTyping } from '../lib/typingState.js';
import { noteRuleRouting, systemNote, userNames } from '../lib/systemNote.js';
import { applyConvEffects } from '../lib/conversationOps.js';
import { emitInboundLine, emitOutboundLine } from '../lib/slackClassic/emit.js';
import { markProcessed } from '../lib/slackClassic/store.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/**
 * Process a batch of ingest events for one agent.
 * Creates conversations/messages/alerts, updates state, emits SSE + push.
 */
/** An open handoff alert this old escalates again as a fresh channel post
 *  rather than a deduped thread reply. */
const REHANDOFF_ALERT_MS = 5 * 60_000;

export async function processEvents(
  db: Db,
  agent: AgentRow,
  events: IngestEvent[],
): Promise<IngestResult[]> {
  const rules = await db.select().from(alertRules).where(eq(alertRules.agentId, agent.id));
  // Rule pools resolve through group rosters — fetched once per batch.
  const ruleGroups = await groupsForRules(db, agent.workspaceId, rules);
  const results: IngestResult[] = [];
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agent.id));

  // Stripe customer for metered billing — agency children meter to the
  // parent's account (wholesale); resolved once per batch
  const stripeCustomerId = await billingCustomerFor(db, agent.workspaceId);
  // Hard-capped plan (free tier over its included volume): customer messages
  // are dropped before storage — nothing is transcribed, metered, or mirrored.
  const cap = await messageCap(db, agent.workspaceId);
  // Conversations that already got a real reply in this batch — a canned
  // handoff notice on top of the agent's own "a human is coming" text is
  // redundant noise for the customer.
  const repliedInBatch = new Set<string>();

  for (const event of events) {
    if (cap.capped && event.type === 'message_in') {
      // keep results[] index-aligned with events[] — SDK callers correlate
      // per-event results by position; skipping shifts every later answer
      results.push({
        conversation_id: event.conversation_id,
        paused: false,
        conversation_state: 'active',
        alert_ids: [],
        capped: true,
      });
      continue;
    }
    const { conv, isNew } = await findOrCreateConversation(db, agent, event);
    const alertIds: string[] = [];
    const newAlertTypes: string[] = [];

    // Store a message row for events that carry conversational content
    const message = await insertEventMessage(db, conv, event);
    if (message) {
      // Any stored reply — agent answer, failure note, handoff, operator
      // message — ends the typing indicators for this thread: the agent is
      // no longer working on it and a delivered reply can't still be typing.
      // A second inbound mid-work keeps "is thinking" live — correct.
      if (message.direction !== 'in') {
        void clearAgentWorking(db, conv.id);
        void clearOperatorTyping(db, conv.id);
        void setSlackThreadStatus(db, conv.id, null);
      }
      reportMeter(stripeCustomerId, METER_MESSAGES, 1);
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(message) });
      if (message.text) {
        const flags = (message.flags ?? {}) as {
          failure?: boolean;
          help_requested?: boolean;
          custom_alert?: boolean;
          handoff_offer?: boolean;
          handoff_cancelled?: boolean;
          resolved?: boolean;
        };
        if (
          flags.failure ||
          flags.help_requested ||
          flags.custom_alert ||
          flags.handoff_offer ||
          flags.handoff_cancelled ||
          flags.resolved
        ) {
          // Internal notes are system messages in Slack, not agent transcript lines
          const icon = flags.failure
            ? ':warning:'
            : flags.help_requested
              ? ':raising_hand:'
              : flags.handoff_offer
                ? ':question:'
                : flags.handoff_cancelled
                  ? ':arrow_backward:'
                  : flags.resolved
                    ? ':white_check_mark:'
                    : ':rotating_light:';
          void mirrorToSlack(db, conv.id, icon, `_${message.text}_`);
        } else {
          const label = message.direction === 'in' ? ':busts_in_silhouette: *user:*' : ':robot_face: *agent:*';
          const mp = (message.payload ?? {}) as {
            widgets?: WidgetComponent[];
            quick_replies?: QuickReply[];
          };
          void mirrorToSlack(db, conv.id, label, message.text, {
            direction: message.direction,
            widgets: mp.widgets,
            quickReplies: mp.quick_replies,
          });
        }
        // hosted channels: agent replies go straight to the end user —
        // never internal notes (failures/handoffs/alerts), which are also 'out'.
        // payload.delivered marks replies already sent raw by the caller
        // (legacy Dialogflow payload.facebook passthrough).
        if (event.type === 'message_out') repliedInBatch.add(conv.id);
        if (
          event.type === 'message_out' &&
          !(message.payload as { delivered?: boolean } | undefined)?.delivered
        ) {
          const atts = (message.payload as { attachments?: AttachmentRef[] } | undefined)?.attachments;
          const qrs = (message.payload as { quick_replies?: QuickReply[] } | undefined)
            ?.quick_replies;
          const widgets = (message.payload as { widgets?: WidgetComponent[] } | undefined)
            ?.widgets;
          const effects = (message.payload as { effects?: BotEffect[] } | undefined)?.effects;
          void deliverToChannel(db, conv.id, message.text, atts, {
            messageId: message.id,
            quickReplies: qrs,
            widgets,
            effects,
          });
        }
      }

      // Classic-Slack bridge — synthesize the legacy transcript events
      // wordhopapi used to POST, so a classic-mode install renders the same
      // j-channel lines for Janis-native bots. Dialogflow-engine bots emit
      // their own 'chat message' inside runLegacyReply (the DF result rides
      // along as `reply` for the training-menu enrichment) — unless a human
      // owns the conv and the reply path never runs.
      const operatorSent =
        'payload' in event &&
        (event.payload as { operator?: boolean } | undefined)?.operator === true;
      if (message.direction === 'in' && !operatorSent) {
        const engine = (agent.config as { engine?: string }).engine;
        if (engine !== 'dialogflow' || conv.state === 'human') {
          emitInboundLine(db, agent, conv, message.text);
        }
      } else if (event.type === 'message_out') {
        emitOutboundLine(db, agent, conv, message.text, {
          quick_replies: (message.payload as { quick_replies?: QuickReply[] } | undefined)
            ?.quick_replies,
        });
        // Posted directly by the 'bot message' path — keep it out of the
        // backlog so a later flush can't double-post it.
        void markProcessed(db, [message.id]);
      }
    }

    // Intent classification — once per conversation, off the hot path. BYO
    // agents can stamp payload.intent and skip the LLM entirely. Later
    // inbounds feed the drift re-check (throttled in recheckIntent) plus a
    // per-message sentiment read when a sentiment rule opted in. Operator
    // turns (Ask rail, copilot, Slack concierge — any u:-bound participant)
    // skip all of it: scoring a teammate's mood against "customer sentiment"
    // produces noise alerts and internal notes on internal surfaces.
    const operatorInbound =
      'payload' in event &&
      (event.payload as { operator?: boolean } | undefined)?.operator === true;
    if (event.type === 'message_in' && !operatorInbound) {
      if (conv.intent == null) {
        const payloadIntent =
          typeof event.payload?.intent === 'string' ? event.payload.intent : null;
        void classifyAndRoute(db, agent, conv, event.text, payloadIntent).catch(() => {});
      } else {
        void recheckIntent(db, agent, conv).catch(() => {});
        void checkInboundSentiment(db, agent, conv, event.text, rules).catch(() => {});
      }
    }

    // Workspace event export — Zapier/Make catch hooks see inbound traffic
    // and handoff asks, so customers can wire their own integrations.
    if (event.type === 'message_in' || event.type === 'handoff_request') {
      fireEventWebhook(db, agent.workspaceId, event.type, {
        agent_id: agent.id,
        agent_name: agent.name,
        conversation_id: conv.id,
        text: 'text' in event ? event.text : event.reason,
        channel: (conv.userProfile as { channel?: string } | null)?.channel ?? null,
      });
    }

    // Evaluate alert rules — one open alert per type per conversation, so a
    // struggling agent doesn't spam push/email on every message
    let handoffAlertId: string | undefined;
    let handoffAlertNew = false;
    const pendingNotifies: { title: string; body: string; url: string; event: NotifyEvent }[] = [];
    for (const triggered of evaluateEvent(event, rules)) {
      // keyword alerts have no flagged transcript line — note every fire so
      // the audit trail shows the rule triggered even when the alert dedupes
      // or the workspace muted that bucket
      if (triggered.type === 'keyword') {
        await systemNote(
          db,
          agent.workspaceId,
          conv.id,
          `Alert rule fired — keyword ${triggered.detail ?? 'matched'}`,
          'rule_trigger',
        );
      }
      const [open] = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.conversationId, conv.id),
            eq(alerts.type, triggered.type),
            eq(alerts.status, 'open'),
          ),
        )
        .limit(1);
      if (open) {
        if (triggered.type === 'help_request') {
          handoffAlertId = open.id;
          const ageMs = Date.now() - new Date(open.createdAt).getTime();
          if (ageMs >= REHANDOFF_ALERT_MS) {
            // Ignored for 5+ min and the agent asked again — escalate with a
            // fresh channel post, not a buried thread reply. Bumping the
            // alert's age means repeats re-alert at most once per window.
            await db
              .update(alerts)
              .set({ createdAt: new Date(), detail: triggered.detail })
              .where(eq(alerts.id, open.id));
            const reAlert = { ...open, createdAt: new Date(), detail: triggered.detail };
            const n = await alertNotification(db, reAlert, conv, agent);
            bus.publish(agent.workspaceId, {
              type: 'alert',
              data: { ...toAlert(reAlert), notification: n },
            });
            void postSlackAlert(db, agent.workspaceId, conv, agent, reAlert);
            // Re-page whoever owns it — an ignored handoff is an escalation
            void notifyWorkspace(db, agent.workspaceId, n, { agentId: agent.id,
              userIds: conv.assigneeId ? [conv.assigneeId] : undefined,
              event: eventForAlertType(reAlert.type),
            });
          } else {
            // Recent open alert — postSlackAlert replies in the existing
            // thread, so a struggling agent doesn't spam the channel
            void postSlackAlert(db, agent.workspaceId, conv, agent, open);
          }
        }
        continue;
      }
      // A concurrent event may have opened the same alert between our select
      // and insert — the unique index decides; the loser skips (the winner's
      // publish/notify already covers it).
      const { alert, created } = await openAlertOnce(db, {
        conversationId: conv.id,
        type: triggered.type,
        detail: triggered.detail ?? undefined,
      });
      if (!created) continue;
      alertIds.push(alert.id);
      newAlertTypes.push(alert.type);
      // Handoff toasts wait for the AI brief — enrichHandoff republishes
      // with the same payload push/email get. Firing a toast now off the
      // raw reason would read as a second alert for the same message.
      const enrichPending = triggered.type === 'help_request';
      bus.publish(agent.workspaceId, {
        type: 'alert',
        data: {
          ...toAlert(alert),
          notification: enrichPending
            ? undefined
            : await alertNotification(db, alert, conv, agent),
          ...(enrichPending ? { pending: true } : {}),
        },
      });
      if (triggered.type === 'help_request') {
        // handoff alerts notify after the "what does the customer need"
        // brief is generated — enriched below via enrichHandoff
        handoffAlertId = alert.id;
        handoffAlertNew = true;
        continue;
      }
      void postSlackAlert(db, agent.workspaceId, conv, agent, alert);
      // queued — fired after auto-assign so the page goes to the owner
      pendingNotifies.push({
        ...(await alertNotification(db, alert, conv, agent)),
        event: eventForAlertType(alert.type),
      });
    }

    // State transitions: only a real handoff escalates to needs_human —
    // keyword/custom/failure/offer alerts notify operators without pulling
    // the thread out of the agent's queue (a "billing" keyword match is
    // signal, not a takeover request). Archived conversations escalate too
    // — an escalation unarchives: the thread resurfaces as needs_human.
    let state = conv.state;
    if (
      newAlertTypes.includes('help_request') &&
      (state === 'active' || state === 'archived')
    )
      state = 'needs_human';
    if (event.type === 'handoff_request' && (state === 'active' || state === 'archived'))
      state = 'needs_human';
    // Customer declined a human (or retracted the request) — drop a pending
    // escalation back to the agent. 'human'/'archived' are untouched: a
    // human who took over owns the release decision.
    if (event.type === 'handoff_cancelled' && state === 'needs_human') state = 'active';
    // Agent/customer-declared resolution archives the thread — CSAT fires
    // below. 'human' is untouched: a human who took over owns the close.
    if (event.type === 'resolve' && (state === 'active' || state === 'needs_human'))
      state = 'archived';

    // A customer reply past a handoff offer closes the "awaiting customer"
    // window, so the offer alert is stale. Whether they accepted or moved
    // on, the reply itself decides what happens next — an accepted offer
    // fires handoff_request → help_request on the same turn.
    if (event.type === 'message_in' && !newAlertTypes.includes('help_request')) {
      const staleOffers = await resolveOpenAlerts(db, agent.workspaceId, conv.id, 'handoff_offer');
      if (staleOffers.length) {
        await systemNote(
          db,
          agent.workspaceId,
          conv.id,
          'Handoff offer closed — the customer replied',
          'alert_status',
        );
      }
    }

    // Automation: keyword rules can route the thread alongside their alert —
    // assign to a teammate (only when unassigned, so a routed thread doesn't
    // steal someone's queue) and/or tag it. Pools resolve through groups and
    // persist their rotation cursor back onto the rule.
    const actions = evaluateActions(event, rules, ruleGroups);
    const assignTo = actions.find((a) => a.assignTo)?.assignTo;
    for (const a of actions) {
      if (a.ruleId === undefined || a.next === undefined) continue;
      const rule = rules.find((r) => r.id === a.ruleId);
      if (rule) await advanceRuleCursor(db, rule, a.next);
    }
    const mergedTags = actions.some((a) => a.tag)
      ? [...new Set([...conv.tags, ...actions.map((a) => a.tag).filter((t): t is string => !!t)])]
      : conv.tags;

    const preview = eventText(event);
    // Per-key merge, never stale-snapshot replace — verification and ingress
    // writes elsewhere land on this row between the conv read and here.
    const profileDefined = event.user
      ? Object.fromEntries(Object.entries(event.user).filter(([, v]) => v != null && v !== ''))
      : null;
    let profileMerge: SQL | undefined;
    if (profileDefined && Object.keys(profileDefined).length) {
      const { metadata: metaPatch, ...topPatch } = profileDefined as Record<string, unknown> & {
        metadata?: Record<string, unknown>;
      };
      profileMerge = sql`coalesce(${conversations.userProfile}, '{}'::jsonb) || ${JSON.stringify(topPatch)}::jsonb`;
      if (metaPatch && Object.keys(metaPatch).length)
        profileMerge = sql`${profileMerge} || jsonb_build_object('metadata', coalesce(${conversations.userProfile}->'metadata', '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb)`;
    }
    const [updated] = await db
      .update(conversations)
      .set({
        state,
        ...(assignTo && !conv.assigneeId ? { assigneeId: assignTo } : {}),
        ...(mergedTags.length !== conv.tags.length ? { tags: mergedTags } : {}),
        lastMessageAt: event.timestamp ? new Date(event.timestamp) : new Date(),
        lastMessagePreview: preview?.slice(0, 140) ?? conv.lastMessagePreview,
        lastMessageDirection: directionFor(event),
        // new inbound traffic marks the conversation unread for operators
        isUnread: directionFor(event) === 'in' ? true : conv.isUnread,
        // a customer reply wakes a snoozed conversation — snooze means
        // "remind me later", not "ignore the customer"
        snoozedUntil: directionFor(event) === 'in' ? null : conv.snoozedUntil,
        ...(event.type === 'resolve' && state === 'archived' && !conv.archivedAt
          ? { archivedAt: new Date() }
          : {}),
        // Merge, not replace — later events only overwrite the fields they
        // actually carry, so a profile fetched earlier (or an email the
        // customer shared) survives sparse updates
        ...(profileMerge ? { userProfile: profileMerge } : {}),
      })
      .where(eq(conversations.id, conv.id))
      .returning();
    // Conv deleted between our read and this update — nothing to act on.
    if (!updated) continue;

    // Emit with the post-update row — this event's message preview/activity
    // have just been written, so hook pushes carry a populated payload
    // rather than the all-null creation snapshot.
    if (isNew) emitHookEvent(db, agent.id, 'new_conversation', updated);

    // Transition side effects — the shared path the operator PATCH runs:
    // conversation event, state-change audit line, escalated/resolved hooks,
    // CSAT on archive, and the open-alert sweep (a resolved thread means its
    // alerts are handled; handoff_cancelled→active closes the page too).
    if (updated.state !== conv.state) {
      await applyConvEffects(db, agent.workspaceId, conv, updated, {
        state: updated.state,
      }, null);
    }

    // Rule-routing audit — every applied (or refused) effect is a line in the
    // transcript, independent of whether the alert itself was deduped or its
    // notifications were muted
    for (const a of actions) {
      await noteRuleRouting(
        db,
        agent.workspaceId,
        conv,
        { assigneeId: a.assignTo, tags: a.tag ? [a.tag] : [] },
        a.kind ? `${a.kind} rule` : 'rule',
      );
    }

    // Resolution side effects (CSAT prompt, conversation_resolved hook) and
    // the open-alert sweep ran inside applyConvEffects above — same
    // implementation an operator archive/active flip goes through.

    // Escalation routing: auto-assign fresh handoffs to the least-loaded
    // teammate when the agent opts in (config.auto_assign).
    let assigneeId = updated.assigneeId;
    if (
      updated.state === 'needs_human' &&
      conv.state !== 'needs_human' &&
      !assigneeId &&
      (agent.config as { auto_assign?: boolean } | null)?.auto_assign
    ) {
      assigneeId = (await autoAssign(db, agent, updated)) ?? null;
      if (assigneeId) {
        const name = (await userNames(db, [assigneeId])).get(assigneeId) ?? 'a teammate';
        await systemNote(db, agent.workspaceId, conv.id,
          `Auto-assigned to ${name} (least-loaded)`, 'assign');
      }
    }

    // Queued alert notifications — scoped to the assignee when one exists so
    // the page reaches the person who owns it, not the whole workspace
    for (const n of pendingNotifies) {
      void notifyWorkspace(db, agent.workspaceId, n, { agentId: agent.id,
        userIds: assigneeId ? [assigneeId] : undefined,
        event: n.event,
      });
    }

    // Enrich every handoff moment with an operator brief — even when the
    // alert was deduped, each note keeps its own summary in the transcript
    if (event.type === 'handoff_request' && message) {
      void enrichHandoff(
        db,
        agent,
        updated,
        message,
        handoffAlertId,
        handoffAlertNew,
        event.reason,
        assigneeId,
      );
    }

    // Handing off — tell the end user a human is joining, unless the agent's
    // own reply in this batch already said so. Every request gets a reply
    // until a human actually takes over (needs_human doesn't pause the
    // agent); config.handoff_message overrides, '' disables.
    if (
      event.type === 'handoff_request' &&
      !repliedInBatch.has(conv.id) &&
      updated.state !== 'human' &&
      updated.state !== 'archived'
    ) {
      const notice = handoffNotice(agent, conv.state === 'needs_human');
      if (notice) {
        const [note] = await db
          .insert(messages)
          .values({
            conversationId: conv.id,
            direction: 'out',
            text: notice,
            payload: { via: 'handoff' },
          })
          .returning();
        bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
        void deliverToChannel(db, conv.id, notice, undefined, { messageId: note.id });
      }
    }

    results.push({
      conversation_id: event.conversation_id,
      paused: updated.state === 'human',
      conversation_state: updated.state,
      alert_ids: alertIds,
    });
  }

  return results;
}

async function findOrCreateConversation(
  db: Db,
  agent: AgentRow,
  event: IngestEvent,
): Promise<{ conv: ConversationRow; isNew: boolean }> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.externalId, event.conversation_id),
      ),
    )
    .limit(1);
  if (existing) return { conv: existing, isNew: false };

  const [created] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      externalId: event.conversation_id,
      userProfile: event.user ?? {},
    })
    .returning();
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: created.id, state: created.state },
  });
  return { conv: created, isNew: true };
}

/** Conversations owned by a bot-platform channel — externalId is
 *  `<kind>:<participant>` (cheap check, no binding join; the flavor's
 *  prompt only teaches the directive grammar on these threads anyway). */
const BOT_FLAVOR_EXT = /^(chatfuel|manychat):/;

async function insertEventMessage(db: Db, conv: ConversationRow, event: IngestEvent) {
  let text = eventText(event) ?? null;
  let payload = ('payload' in event ? event.payload : undefined) ?? {};
  // Bot-platform replies carry invisible {{set/tag/untag/goto}} directives —
   // strip them at store time so transcripts stay clean, keep the structured
  // effects (platform mapping at egress) plus human labels for the console.
  if (
    event.type === 'message_out' &&
    text?.includes('{{') &&
    BOT_FLAVOR_EXT.test(conv.externalId)
  ) {
    const parsed = parseDirectives(text);
    if (parsed.effects.length) {
      text = parsed.clean || null; // a directive-only reply has no text at all
      payload = {
        ...payload,
        effects: parsed.effects,
        channel_effects: parsed.effects.map(effectLabel),
      };
    }
  }
  const row = {
    conversationId: conv.id,
    text,
    payload,
    direction: directionFor(event),
    flags: {
      failure: event.type === 'failure',
      help_requested: event.type === 'handoff_request',
      custom_alert: event.type === 'custom_alert',
      handoff_offer: event.type === 'handoff_offer',
      handoff_cancelled: event.type === 'handoff_cancelled',
      resolved: event.type === 'resolve',
    },
    ...(event.timestamp ? { createdAt: new Date(event.timestamp) } : {}),
  };
  // message_out / message_in / human-bearing events all produce a message row
  const [message] = await db.insert(messages).values(row).returning();
  return message;
}

function directionFor(event: IngestEvent): 'in' | 'out' | 'human' {
  switch (event.type) {
    case 'message_in':
      return 'in';
    case 'message_out':
      return 'out';
    default:
      // failures/handoffs/alerts are stored as agent-side context notes
      return 'out';
  }
}

function handoffNotice(agent: AgentRow, repeat: boolean): string | null {
  const cfg = (agent.config ?? {}) as {
    handoff_message?: string;
    handoff_repeat_message?: string;
  };
  if (cfg.handoff_message === '') return null; // explicit opt-out
  if (repeat) {
    return (
      cfg.handoff_repeat_message ??
      cfg.handoff_message ??
      'Thanks for bearing with us — a human teammate is still on the way.'
    );
  }
  return (
    cfg.handoff_message ??
    'Thanks for your patience — a human teammate is joining the conversation to help you further.'
  );
}

function eventText(event: IngestEvent): string | undefined {
  switch (event.type) {
    case 'message_in':
    case 'message_out':
      return event.text;
    case 'failure':
      return event.text ?? event.reason;
    case 'handoff_request':
      return event.reason ? `Handoff requested: ${event.reason}` : 'Handoff requested';
    case 'handoff_offer':
      return event.reason
        ? `Offered a human: ${event.reason}`
        : 'Agent offered a human teammate';
    case 'handoff_cancelled':
      return event.reason
        ? `Declined a human: ${event.reason}`
        : 'Customer declined a human — staying with the agent';
    case 'custom_alert':
      return event.text ?? `Alert: ${event.alert_type}`;
    case 'resolve':
      return event.reason ? `Conversation resolved — ${event.reason}` : 'Conversation resolved';
  }
}

/** Assign a fresh handoff to the workspace member with the fewest open
 * conversations. Returns the chosen assignee so callers can route alerts. */
async function autoAssign(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
): Promise<string | undefined> {
  const members = await agentEligibleMembers(db, agent.workspaceId, agent.id);
  if (!members.length) return undefined;
  const loads = new Map(members.map((m) => [m.user.id, 0]));
  const open = await db
    .select({ assignee: conversations.assigneeId, n: sql<number>`count(*)::int` })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(agents.workspaceId, agent.workspaceId),
        inArray(conversations.state, ['needs_human', 'human']),
      ),
    )
    .groupBy(conversations.assigneeId);
  for (const r of open) if (r.assignee && loads.has(r.assignee)) loads.set(r.assignee, r.n);
  const [assignee] = [...loads.entries()].sort((a, b) => a[1] - b[1])[0];
  await db
    .update(conversations)
    .set({ assigneeId: assignee })
    .where(eq(conversations.id, conv.id));
  // re-emit so the client refetches the row (assignee is fetched, not pushed)
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: conv.id, state: conv.state },
  });
  return assignee;
}
