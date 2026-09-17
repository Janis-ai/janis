import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  conversations,
  messages,
  slackInstallations,
  slackThreads,
  users,
} from '../db/schema.js';
import { env } from '../env.js';

type Installation = typeof slackInstallations.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;
type UserRow = typeof users.$inferSelect;

const SLACK_API = 'https://slack.com/api';

export async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

/** Verify Slack's request signature (v0 HMAC-SHA256, 5-minute replay window). */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const digest = createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  const expected = `v0=${digest}`;
  return (
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}

/** Public avatar URL for Slack message blocks — Slack's image fetcher has
 * no session, so the URL carries an HMAC over the conversation id. */
export function slackAvatarUrl(convId: string): string | null {
  if (!env.slackSigningSecret) return null;
  const sig = createHmac('sha256', env.slackSigningSecret)
    .update(`avatar:${convId}`)
    .digest('hex')
    .slice(0, 32);
  return `${env.apiOrigin}/slack/avatar/${convId}?sig=${sig}`;
}

export function verifyAvatarSig(convId: string, sig: string | undefined): boolean {
  if (!env.slackSigningSecret || !sig) return false;
  const expected = createHmac('sha256', env.slackSigningSecret)
    .update(`avatar:${convId}`)
    .digest('hex')
    .slice(0, 32);
  return (
    sig.length === expected.length &&
    timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

export async function getInstallation(
  db: Db,
  workspaceId: string,
): Promise<Installation | undefined> {
  const [row] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.workspaceId, workspaceId))
    .limit(1);
  return row;
}

/** Post a plain message to the workspace's alert channel (or a thread). */
export async function postSlackMessage(
  db: Db,
  workspaceId: string,
  text: string,
  opts: { channelId?: string; threadTs?: string } = {},
): Promise<{ channel?: string; ts?: string } | null> {
  const inst = await getInstallation(db, workspaceId);
  const channel = opts.channelId ?? inst?.alertChannelId;
  if (!inst || !channel) return null;
  const res = await slackApi<{ channel: string; ts: string }>(inst.botToken, 'chat.postMessage', {
    channel,
    text,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  });
  if (!res.ok) return null;
  return { channel: res.channel, ts: res.ts };
}

type SlackBlock = Record<string, unknown>;

/** Alert message blocks: summary, customer/channel details, state-aware
 * action buttons. When a human owns the conversation the buttons collapse
 * to Resume — mirroring how the wordhop alert toggled pause/resume. */
function alertBlocks(
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
  alert: Pick<AlertRow, 'type' | 'detail'>,
): SlackBlock[] {
  const p = (conv.userProfile ?? {}) as {
    name?: string;
    username?: string;
    id?: string;
    channel?: string;
    channel_name?: string;
    email?: string;
  };
  const who =
    [p.name, p.username ? `@${p.username}` : null].filter(Boolean).join(' ') ||
    p.id ||
    'unknown';
  const channel = `${p.channel ?? conv.externalId.split(':')[0]}${p.channel_name ? ` — "${p.channel_name}"` : ''}`;
  const summary =
    `:rotating_light: *${alert.type.replace('_', ' ')}* — agent *${agent.name}*\n` +
    `${alert.detail ?? conv.lastMessagePreview ?? ''}`;
  const paused = conv.state === 'human';

  const details = [
    `*Customer:* ${who}`,
    p.email ? `*Email:* ${p.email}` : null,
    `*Channel:* ${channel}`,
    `*Conv:* \`${conv.externalId}\``,
  ]
    .filter(Boolean)
    .join('   ·   ');

  // Suggest reply lives only on the paused (taken-over) state — its output
  // lands in the thread, and by then the operator is already in it.
  const actions: SlackBlock[] = paused
    ? [
        {
          type: 'button',
          action_id: 'janis_resume',
          text: { type: 'plain_text', text: 'Resume agent' },
          style: 'primary',
          value: conv.id,
        },
        {
          type: 'button',
          action_id: 'janis_suggest',
          text: { type: 'plain_text', text: 'Suggest reply' },
          value: conv.id,
        },
      ]
    : [
        {
          type: 'button',
          action_id: 'janis_takeover',
          text: { type: 'plain_text', text: 'Take over' },
          style: 'primary',
          value: conv.id,
        },
      ];
  actions.push(
    {
    type: 'button',
    action_id: 'janis_open',
    text: { type: 'plain_text', text: 'Open in Janis' },
    url: `${env.webOrigin}/conversations/${conv.id}`,
  });

  const stateLine = paused ? `\n*Agent paused* — replying as human.` : '';
  const avatar = (conv.userProfile as { picture_url?: string } | null)?.picture_url
    ? slackAvatarUrl(conv.id)
    : null;
  const section: SlackBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: summary + stateLine },
    ...(avatar
      ? { accessory: { type: 'image', image_url: avatar, alt_text: p.name ?? 'customer' } }
      : {}),
  };
  return [
    section,
    { type: 'context', elements: [{ type: 'mrkdwn', text: details }] },
    { type: 'actions', elements: actions },
  ];
}

/**
 * Post an alert into Slack with action buttons and record the thread so
 * subsequent messages mirror into it. A NEW alert always posts a fresh
 * channel message and claims the conversation's thread row — after a
 * takeover/resume cycle a new escalation must be a new top-level alert,
 * not a buried reply. Deduped handoffs (opts.reply) stay in the thread.
 */
export async function postSlackAlert(
  db: Db,
  workspaceId: string,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
  alert: AlertRow,
  opts: { reply?: boolean } = {},
): Promise<void> {
  const inst = await getInstallation(db, workspaceId);
  if (!inst?.alertChannelId) return;

  const [existing] = await db
    .select()
    .from(slackThreads)
    .where(eq(slackThreads.conversationId, conv.id))
    .limit(1);

  const summary =
    `:rotating_light: *${alert.type.replace('_', ' ')}* — agent *${agent.name}* · ` +
    `conversation \`${conv.externalId}\`\n${alert.detail ?? conv.lastMessagePreview ?? ''}`;

  if (existing && opts.reply) {
    const res = await slackApi(inst.botToken, 'chat.postMessage', {
      channel: existing.channelId,
      thread_ts: existing.ts,
      text: summary,
    });
    if (!res.ok) console.error('slack thread reply failed:', res.error);
    return;
  }

  const res = await slackApi<{ channel: string; ts: string }>(inst.botToken, 'chat.postMessage', {
    channel: inst.alertChannelId,
    text: summary,
    blocks: alertBlocks(conv, agent, alert),
  });
  if (res.ok) {
    if (existing) {
      // Point mirroring/interactions at the current escalation thread.
      await db
        .update(slackThreads)
        .set({ channelId: res.channel, ts: res.ts })
        .where(eq(slackThreads.id, existing.id));
    } else {
      await db.insert(slackThreads).values({
        conversationId: conv.id,
        installationId: inst.id,
        channelId: res.channel,
        ts: res.ts,
      });
    }
    // Seed the thread with the recent transcript — one reply per message,
    // attributed to the actual participants (customer photo included via
    // icon_url when the install has chat:write.customize).
    const recent = await db
      .select({
        direction: messages.direction,
        text: messages.text,
        author: users.name,
      })
      .from(messages)
      .leftJoin(users, eq(messages.authorId, users.id))
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(20);
    const profile = (conv.userProfile ?? {}) as {
      name?: string;
      picture_url?: string;
    };
    const customerName = profile.name ?? 'customer';
    const avatar = profile.picture_url ? slackAvatarUrl(conv.id) : null;
    for (const m of recent.reverse()) {
      if (!m.text) continue;
      const identity =
        m.direction === 'in'
          ? { username: customerName, icon_url: avatar ?? undefined }
          : m.direction === 'human'
            ? { username: m.author ?? 'operator' }
            : { username: agent.name };
      const res2 = await slackApi(inst.botToken, 'chat.postMessage', {
        channel: res.channel,
        thread_ts: res.ts,
        text: m.text,
        ...identity,
      });
      if (!res2.ok) {
        // Install predates chat:write.customize — fall back to a label.
        await slackApi(inst.botToken, 'chat.postMessage', {
          channel: res.channel,
          thread_ts: res.ts,
          text: `*${identity.username}:* ${m.text}`,
        });
      }
    }
    // One pointer to the thread per alert, right after it's seeded.
    await slackApi(inst.botToken, 'chat.postMessage', {
      channel: res.channel,
      text: '_Transcript and controls are in the thread — click the replies link on the alert above._',
    });
  } else {
    console.error('slack alert post failed:', res.error);
  }
}

/** Refresh the alert message after takeover/resume so the buttons toggle
 * to match conversation state (Take over ↔ Resume agent). */
export async function updateSlackAlert(
  db: Db,
  workspaceId: string,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
): Promise<void> {
  const [thread] = await db
    .select({ slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(eq(slackThreads.conversationId, conv.id))
    .limit(1);
  if (!thread) return;
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.conversationId, conv.id))
    .orderBy(desc(alerts.createdAt))
    .limit(1);
  const res = await slackApi(thread.installation.botToken, 'chat.update', {
    channel: thread.slackThreads.channelId,
    ts: thread.slackThreads.ts,
    text: `alert — ${conv.externalId}`,
    blocks: alertBlocks(conv, agent, alert ?? { type: 'help_request', detail: null }),
  });
  if (!res.ok) console.error('slack alert update failed:', res.error);
}

/** Mirror a console-originated message into the conversation's Slack thread. */
export async function mirrorToSlack(
  db: Db,
  conversationId: string,
  label: string,
  text: string,
  direction?: 'in' | 'out' | 'human',
): Promise<void> {
  const [thread] = await db
    .select({ slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(eq(slackThreads.conversationId, conversationId))
    .limit(1);
  if (!thread) return;

  let identity: { username?: string; icon_url?: string } = {};
  if (direction) {
    const [row] = await db
      .select({ conv: conversations, agent: agents })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (row) {
      const profile = (row.conv.userProfile ?? {}) as {
        name?: string;
        picture_url?: string;
      };
      identity =
        direction === 'in'
          ? {
              username: profile.name ?? 'customer',
              icon_url: profile.picture_url ? slackAvatarUrl(conversationId) ?? undefined : undefined,
            }
          : direction === 'out'
            ? { username: row.agent.name }
            : {};
    }
  }

  const res = await slackApi(thread.installation.botToken, 'chat.postMessage', {
    channel: thread.slackThreads.channelId,
    thread_ts: thread.slackThreads.ts,
    text,
    ...identity,
  });
  if (!res.ok) {
    // Install predates chat:write.customize — keep the labeled text form.
    await slackApi(thread.installation.botToken, 'chat.postMessage', {
      channel: thread.slackThreads.channelId,
      thread_ts: thread.slackThreads.ts,
      text: `${label} ${text}`,
    });
  }
}

/** Look up the Slack thread for a channel+thread_ts pair. */
export async function findThread(db: Db, channelId: string, threadTs: string) {
  const [row] = await db
    .select({ thread: slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(and(eq(slackThreads.channelId, channelId), eq(slackThreads.ts, threadTs)))
    .limit(1);
  return row;
}

/**
 * Map a Slack user to a Janis member: fetch their email from Slack and match
 * on users.email in the installation's workspace. Falls back to the installer.
 */
export async function slackUserToMember(
  db: Db,
  inst: Installation,
  slackUserId: string,
): Promise<UserRow | undefined> {
  const info = await slackApi<{ user: { profile?: { email?: string } } }>(
    inst.botToken,
    'users.info',
    { user: slackUserId },
  ).catch(() => null);
  const email = info?.ok ? info.user?.profile?.email : undefined;
  if (email) {
    const [member] = await db
      .select()
      .from(users)
      .where(and(eq(users.workspaceId, inst.workspaceId), eq(users.email, email)))
      .limit(1);
    if (member) return member;
  }
  if (inst.installerUserId) {
    const [installer] = await db.select().from(users).where(eq(users.id, inst.installerUserId));
    return installer;
  }
  const [anyAdmin] = await db
    .select()
    .from(users)
    .where(and(eq(users.workspaceId, inst.workspaceId), eq(users.role, 'admin')))
    .limit(1);
  return anyAdmin;
}
