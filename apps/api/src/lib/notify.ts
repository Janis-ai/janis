import webpush from 'web-push';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agentMembers, channelBindings, channels, pushSubscriptions, users } from '../db/schema.js';
import { workspaceMembers } from './members.js';
import { env } from '../env.js';

let configured = false;

function ensureVapid(): boolean {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    configured = true;
  }
  return true;
}

/** Per-event notification prefs — a member can mute a whole alert class
 *  (e.g. keyword pings) without turning off handoffs. Missing key = on. */
export type NotifyEvent =
  | 'handoff'
  | 'assigned'
  | 'keyword'
  | 'mention'
  | 'digest'
  | 'approval'
  | 'eval'
  | 'ops';

interface NotifyPrefs {
  push?: boolean;
  email?: boolean;
  sound?: boolean;
  events?: Partial<Record<NotifyEvent, boolean>>;
}

/** Alert type → the pref bucket that can mute it. */
export function eventForAlertType(type: string): NotifyEvent {
  if (type === 'keyword') return 'keyword';
  if (type === 'approval_request') return 'approval';
  // run-degradation signals page the ops bucket, not the handoff queue
  if (type === 'error') return 'ops';
  return 'handoff';
}

/** Titles shared by in-app toasts, push, and email — one alert, one message. */
const ALERT_TITLES: Record<string, string> = {
  failure: 'Agent failure',
  help_request: 'Handoff requested',
  handoff_offer: 'Agent offered a human',
  custom: 'Alert',
  inactivity: 'Inactive conversation',
  keyword: 'Keyword match',
  sla: 'SLA breach — still unclaimed',
  approval_request: 'Approval requested',
  sentiment: 'Negative sentiment',
  intent: 'Topic match',
  error: 'Agent run error',
  csat: 'Low satisfaction score',
};

const CHANNEL_LABELS: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Bubble',
};

/** "Messenger" / "Instagram"… from the hosted-channel binding, falling back
 * to the channel tag SDK/BYOK agents put on the user profile. */
async function channelLabel(
  db: Db,
  conv: { id: string; userProfile?: unknown },
): Promise<string | null> {
  const [row] = await db
    .select({ kind: channels.kind })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conv.id))
    .limit(1);
  const raw = row?.kind ?? ((conv.userProfile ?? {}) as { channel?: string }).channel;
  return raw ? (CHANNEL_LABELS[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1)) : null;
}

/**
 * The single notification payload for an alert. The SSE event carries this
 * verbatim and push/email send the same title/body/url — the channels mirror
 * each other, so an alert reads identically wherever it lands. Carries the
 * brief context operators need at a glance: agent, customer, channel, detail.
 */
export async function alertNotification(
  db: Db,
  alert: { type: string; detail: string | null },
  conv: { id: string; externalId: string; userProfile?: unknown },
  agent: { name: string },
  body?: string | null,
): Promise<{ title: string; body: string; url: string }> {
  const profile = (conv.userProfile ?? {}) as { name?: string };
  const customer = profile.name ?? friendlyName(conv.externalId);
  const channel = await channelLabel(db, conv);
  return {
    title: `${ALERT_TITLES[alert.type] ?? 'Needs attention'} · ${agent.name}`,
    body: `${customer}${channel ? ` on ${channel}` : ''}: ${
      body ?? alert.detail ?? 'needs attention'
    }`,
    url: `/conversations/${conv.id}`,
  };
}

/** Send a web push to a single subscription endpoint — returns false if VAPID isn't configured or the send failed. */
export async function sendPushToEndpoint(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  notification: { title: string; body: string; url?: string },
): Promise<boolean> {
  if (!ensureVapid()) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify(notification));
    return true;
  } catch {
    return false;
  }
}

/** Transactional email via Resend — no-op until RESEND_API_KEY is configured. */
async function sendEmail(to: string[], title: string, body: string, url?: string) {
  if (!env.resendApiKey || to.length === 0) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.resendApiKey}`,
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to,
      subject: title,
      text: url ? `${body}\n\n${env.webOrigin}${url}` : body,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error('email send failed:', res.status, await res.text().catch(() => ''));
}

/**
 * Alert workspace members when an agent needs a human — each user's
 * notify_prefs decide web push and/or email; `sound: false` marks the push
 * silent so the OS doesn't chime. opts.userIds scopes delivery to specific
 * members (e.g. an auto-assignee) instead of the whole workspace.
 * No-op without VAPID/Resend keys.
 */
export async function notifyWorkspace(
  db: Db,
  workspaceId: string,
  notification: { title: string; body: string; url?: string },
  opts: { userIds?: string[]; agentId?: string; event?: NotifyEvent } = {},
): Promise<void> {
  let members = (await workspaceMembers(db, workspaceId)).map((m) => m.user);
  // Agent-scoped users hold no membership — pull them in when the alert is
  // for an agent they're granted on, else they'd never see escalations.
  // 'hidden' rows deny the agent: scoped hidden users are skipped and
  // hidden workspace members are dropped from this agent's alerts.
  const memberIds = new Set(members.map((m) => m.id));
  if (opts.agentId) {
    const scoped = await db
      .select({ user: users, role: agentMembers.role })
      .from(agentMembers)
      .innerJoin(users, eq(agentMembers.userId, users.id))
      .where(and(eq(agentMembers.agentId, opts.agentId), isNotNull(agentMembers.acceptedAt)));
    const hidden = new Set(scoped.filter((s) => s.role === 'hidden').map((s) => s.user.id));
    for (const s of scoped) {
      if (s.role !== 'hidden' && !memberIds.has(s.user.id)) members.push(s.user);
    }
    members = members.filter((m) => !hidden.has(m.id));
  }
  // Per-agent notify overrides (agent_members.notify_prefs) win field-wise
  // over the user's workspace prefs for this agent's alerts.
  const overrideByUser = new Map<string, NotifyPrefs>();
  if (opts.agentId) {
    const rows = await db
      .select({ userId: agentMembers.userId, prefs: agentMembers.notifyPrefs })
      .from(agentMembers)
      .where(eq(agentMembers.agentId, opts.agentId));
    for (const r of rows) if (r.prefs) overrideByUser.set(r.userId, r.prefs as NotifyPrefs);
  }
  const prefs = (u: (typeof members)[number]): NotifyPrefs => {
    const base = u.notifyPrefs as NotifyPrefs;
    const over = overrideByUser.get(u.id);
    // events merge per-key — an agent override muting 'keyword' keeps the
    // member's workspace-level 'digest: false' instead of wiping the map
    return {
      ...base,
      ...over,
      ...(base?.events || over?.events
        ? { events: { ...base?.events, ...over?.events } }
        : {}),
    };
  };

  // Targeted pages to an owner count as 'assigned' events; broadcasts use the
  // caller's event kind. A muted event drops the member entirely — push and
  // email alike.
  const event = opts.event ?? (opts.userIds?.length ? 'assigned' : 'handoff');
  const recipients = members.filter(
    (m) =>
      (!opts.userIds || opts.userIds.includes(m.id)) &&
      prefs(m).events?.[event] !== false,
  );
  if (recipients.length === 0) return;

  const pushUserIds = recipients.filter((m) => prefs(m).push !== false).map((m) => m.id);
  const emailAddrs = recipients.filter((m) => prefs(m).email !== false).map((m) => m.email);
  const silentUsers = new Set(
    recipients.filter((m) => prefs(m).sound === false).map((m) => m.id),
  );

  const jobs: Promise<unknown>[] = [];

  if (ensureVapid() && pushUserIds.length) {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, pushUserIds));
    console.log(
      `[push] notify "${notification.title}" → ${subs.length} sub(s) for ${pushUserIds.length} member(s)`,
    );
    jobs.push(
      ...subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
            JSON.stringify({ ...notification, silent: silentUsers.has(sub.userId) }),
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // dead endpoint — prune it so we stop paying for sends to it
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          } else {
            console.error('[push] send failed:', status, err);
          }
        }
      }),
    );
  }

  jobs.push(
    sendEmail(emailAddrs, notification.title, notification.body, notification.url).catch((err) =>
      console.error('email send failed:', err),
    ),
  );

  await Promise.allSettled(jobs);
}
