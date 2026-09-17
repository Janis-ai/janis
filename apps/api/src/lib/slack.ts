import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  conversations,
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

/**
 * Post an alert into Slack with action buttons and record the thread so
 * subsequent messages mirror into it. One thread per conversation.
 */
export async function postSlackAlert(
  db: Db,
  workspaceId: string,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
  alert: AlertRow,
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

  if (existing) {
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
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'janis_takeover',
            text: { type: 'plain_text', text: 'Take over' },
            style: 'primary',
            value: conv.id,
          },
          {
            type: 'button',
            action_id: 'janis_resume',
            text: { type: 'plain_text', text: 'Resume agent' },
            value: conv.id,
          },
          {
            type: 'button',
            action_id: 'janis_open',
            text: { type: 'plain_text', text: 'Open in Janis' },
            url: `${env.webOrigin}/conversations/${conv.id}`,
          },
        ],
      },
    ],
  });
  if (res.ok) {
    await db.insert(slackThreads).values({
      conversationId: conv.id,
      installationId: inst.id,
      channelId: res.channel,
      ts: res.ts,
    });
  } else {
    console.error('slack alert post failed:', res.error);
  }
}

/** Mirror a console-originated message into the conversation's Slack thread. */
export async function mirrorToSlack(
  db: Db,
  conversationId: string,
  label: string,
  text: string,
): Promise<void> {
  const [thread] = await db
    .select({ slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(eq(slackThreads.conversationId, conversationId))
    .limit(1);
  if (!thread) return;
  await slackApi(thread.installation.botToken, 'chat.postMessage', {
    channel: thread.slackThreads.channelId,
    thread_ts: thread.slackThreads.ts,
    text: `${label} ${text}`,
  });
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
