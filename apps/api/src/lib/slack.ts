import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
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
    // charset is required — without it Slack silently ignores the JSON body
    // on most methods (chat.postMessage tolerates it; users.*, conversations.*
    // return invalid_arguments / "missing required field").
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
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
  mention = '',
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
    // mention (<@U…>/<!channel>) must live in a rendered block — the `text`
    // fallback field never displays when blocks are present.
    text: { type: 'mrkdwn', text: mention + summary + stateLine },
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
 * Resolve a Janis member to their Slack user id, cached on users.slackUserId.
 * Uses users.lookupByEmail (scope: users:read.email) — Slack user ids are
 * workspace-scoped so the cache is keyed on this installation's mapping.
 */
async function memberToSlackUser(
  db: Db,
  inst: Installation,
  memberId: string,
): Promise<string | null> {
  const [member] = await db
    .select({ id: users.id, email: users.email, slackUserId: users.slackUserId })
    .from(users)
    .where(eq(users.id, memberId))
    .limit(1);
  if (!member) return null;
  if (member.slackUserId) return member.slackUserId;
  const res = await slackApi<{ user: { id: string } }>(
    inst.botToken,
    'users.lookupByEmail',
    { email: member.email },
  ).catch(() => null);
  const slackId = res?.ok ? res.user.id : null;
  if (slackId) {
    await db.update(users).set({ slackUserId: slackId }).where(eq(users.id, member.id));
  }
  return slackId;
}

/** Who an alert post should ping: the assignee's Slack mention, every member
 * when unassigned (individual <@U>s can't be suppressed the way @channel can
 * by user prefs or workspace restrictions — and each gets a DM pointer too),
 * or @here when the assignee isn't on Slack. Pure lookup — invites and DMs
 * are side effects of posting, handled by the caller. */
async function alertMention(
  db: Db,
  inst: Installation,
  conv: ConversationRow,
): Promise<{ text: string; slackUserId: string | null; dmIds: string[] }> {
  if (!conv.assigneeId) {
    const members = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.workspaceId, inst.workspaceId));
    const ids = (
      await Promise.all(members.map((m) => memberToSlackUser(db, inst, m.id)))
    ).filter((x): x is string => !!x);
    if (ids.length && ids.length <= 8) {
      return { text: ids.map((id) => `<@${id}>`).join(' ') + ' ', slackUserId: null, dmIds: ids };
    }
    return { text: '<!channel> ', slackUserId: null, dmIds: [] };
  }
  const slackId = await memberToSlackUser(db, inst, conv.assigneeId);
  return slackId
    ? { text: `<@${slackId}> `, slackUserId: slackId, dmIds: [] }
    : { text: '<!here> ', slackUserId: null, dmIds: [] };
}

/**
 * Make sure a Slack user can see the alert channel — conversations.invite is
 * idempotent (already_in_channel is fine). Returns false when the bot lacks
 * channels:manage/groups:write or the channel can't invite.
 */
async function ensureInAlertChannel(
  inst: Installation,
  slackUserId: string,
  channelId: string,
): Promise<boolean> {
  const invite = () =>
    slackApi(inst.botToken, 'conversations.invite', {
      channel: channelId,
      users: slackUserId,
    }).catch(() => null);
  let res = await invite();
  // Bot must be a channel member to invite — join first on public channels.
  if (res?.error === 'not_in_channel') {
    await slackApi(inst.botToken, 'conversations.join', { channel: channelId }).catch(() => null);
    res = await invite();
  }
  if (!res) return false;
  if (res.ok || res.error === 'already_in_channel') return true;
  if (res.error !== 'user_not_found') {
    console.error('slack invite failed:', res.error);
  }
  return false;
}

/** Resolve every workspace member to a Slack user and invite them into the
 * alert channel — thread replies only reach humans who are channel members. */
export async function inviteWorkspaceMembers(
  db: Db,
  inst: Installation,
  channelId: string,
): Promise<void> {
  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.workspaceId, inst.workspaceId));
  for (const m of members) {
    const sid = await memberToSlackUser(db, inst, m.id);
    if (sid) await ensureInAlertChannel(inst, sid, channelId);
  }
}

/**
 * DM fallback for assignees who can't be invited to the alert channel —
 * opens an app DM (im:write) and posts a one-line pointer.
 */
async function dmAlertPointer(
  inst: Installation,
  slackUserId: string,
  text: string,
): Promise<void> {
  const opened = await slackApi<{ channel: { id: string } }>(
    inst.botToken,
    'conversations.open',
    { users: slackUserId },
  ).catch(() => null);
  if (!opened?.ok) {
    console.error('slack dm open failed:', opened?.error);
    return;
  }
  const res = await slackApi(inst.botToken, 'chat.postMessage', {
    channel: opened.channel.id,
    text,
  });
  if (!res.ok) console.error('slack dm post failed:', res.error);
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

  // Routing: assigned → invite them into the alert channel (idempotent) and
  // @mention; if they can't be invited, DM a pointer instead. Unassigned →
  // every resolvable member gets an individual <@U> in the post plus a DM
  // (direct mentions can't be suppressed the way @channel can). Assigned-but-
  // unresolvable → @here: the assignee is paged via Janis push/email anyway.
  const { text: mention, slackUserId, dmIds } = await alertMention(db, inst, conv);
  const dmTargets = new Set(dmIds);
  if (
    slackUserId &&
    !(await ensureInAlertChannel(inst, slackUserId, inst.alertChannelId))
  ) {
    dmTargets.add(slackUserId);
  }

  const summary =
    `${mention}:rotating_light: *${alert.type.replace('_', ' ')}* — agent *${agent.name}* · ` +
    `conversation \`${conv.externalId}\`\n${alert.detail ?? conv.lastMessagePreview ?? ''}`;

  const dmAll = (channelId: string, ts: string) => {
    const text =
      `${summary}\n<https://slack.com/app_redirect?channel=${channelId}&message=${ts}|View alert thread>` +
      ` · <${env.webOrigin}/conversations/${conv.id}|Open in Janis>`;
    for (const id of dmTargets) void dmAlertPointer(inst, id, text);
  };

  if (existing && opts.reply) {
    const res = await slackApi(inst.botToken, 'chat.postMessage', {
      channel: existing.channelId,
      thread_ts: existing.ts,
      text: summary,
    });
    if (!res.ok) console.error('slack thread reply failed:', res.error);
    else dmAll(existing.channelId, existing.ts);
    return;
  }

  const res = await slackApi<{ channel: string; ts: string }>(inst.botToken, 'chat.postMessage', {
    channel: inst.alertChannelId,
    text: summary,
    blocks: alertBlocks(conv, agent, alert, mention),
  });
  if (res.ok) {
    dmAll(res.channel, res.ts);
    if (existing) {
      // Point mirroring/interactions at the current escalation thread, then
      // seed it — a fresh top-level alert still needs its transcript.
      await db
        .update(slackThreads)
        .set({ channelId: res.channel, ts: res.ts })
        .where(eq(slackThreads.id, existing.id));
      await seedSlackThread(db, inst, res.channel, res.ts, conv, agent);
      return;
    }
    const [inserted] = await db
      .insert(slackThreads)
      .values({
        conversationId: conv.id,
        installationId: inst.id,
        channelId: res.channel,
        ts: res.ts,
      })
      .onConflictDoNothing({ target: slackThreads.conversationId })
      .returning();
    if (!inserted) {
      // Another alert won the race for this conversation's thread row —
      // its seeded thread stays canonical.
      return;
    }
    await seedSlackThread(db, inst, res.channel, res.ts, conv, agent);
  } else {
    console.error('slack alert post failed:', res.error);
  }
}

/**
 * Seed a fresh alert's thread with the recent transcript — one reply per
 * message, attributed to the actual participants (customer photo included
 * via icon_url when the install has chat:write.customize) — then post the
 * channel pointer so operators know the thread exists.
 */
async function seedSlackThread(
  db: Db,
  inst: Installation,
  channel: string,
  threadTs: string,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
): Promise<void> {
  const recent = await db
    .select({
      direction: messages.direction,
      text: messages.text,
      author: users.name,
      flags: messages.flags,
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
  const customerName = profile.name ?? friendlyName(conv.externalId);
  const avatar = profile.picture_url ? slackAvatarUrl(conv.id) : null;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conv.id));
  if (count > recent.length) {
    await slackApi(inst.botToken, 'chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: `_Showing the last ${recent.length} of ${count} messages — <${env.webOrigin}/conversations/${conv.id}|full transcript in Janis>._`,
    });
  }

  for (const m of recent.reverse()) {
    if (!m.text) continue;
    // Flagged notes (handoff/failure/custom alert) are internal system lines
    // — italic, from the app itself, not attributed to a participant.
    const f = m.flags as { failure?: boolean; help_requested?: boolean; custom_alert?: boolean } | null;
    const isSystemNote = Boolean(f?.failure || f?.help_requested || f?.custom_alert);
    // Role suffixes keep same-named participants (e.g. agent and customer
    // both "Michael Nathanson") from collapsing into a single header.
    const identity = isSystemNote
      ? {}
      : m.direction === 'in'
        ? { username: `${customerName} (customer)`, icon_url: avatar ?? undefined }
        : m.direction === 'human'
          ? { username: `${m.author ?? 'operator'} (operator)` }
          : { username: `${agent.name} (agent)` };
    const res2 = await slackApi(inst.botToken, 'chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: isSystemNote ? `_${m.text}_` : m.text,
      ...identity,
    });
    if (!res2.ok && !isSystemNote) {
      // Install predates chat:write.customize — fall back to a label.
      await slackApi(inst.botToken, 'chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text: `*${identity.username}:* ${m.text}`,
      });
    }
  }
  // One pointer to the thread per alert, right after it's seeded.
  await slackApi(inst.botToken, 'chat.postMessage', {
    channel,
    text: '_Transcript and controls are in the thread — click the replies link on the alert above._',
  });
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
  const { text: mention } = await alertMention(db, thread.installation, conv);
  const res = await slackApi(thread.installation.botToken, 'chat.update', {
    channel: thread.slackThreads.channelId,
    ts: thread.slackThreads.ts,
    text: `${mention}alert — ${conv.externalId}`,
    blocks: alertBlocks(conv, agent, alert ?? { type: 'help_request', detail: null }, mention),
  });
  if (!res.ok) console.error('slack alert update failed:', res.error);
}

/** Mirror a console-originated message into the conversation's Slack thread.
 * opts.identity overrides the sender attribution (username/icon) so mirrored
 * messages match the seeded transcript style; opts.direction derives it. */
export async function mirrorToSlack(
  db: Db,
  conversationId: string,
  label: string,
  text: string,
  opts: {
    direction?: 'in' | 'out' | 'human';
    identity?: { username?: string; icon_url?: string };
  } = {},
): Promise<void> {
  const [thread] = await db
    .select({ slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(eq(slackThreads.conversationId, conversationId))
    .limit(1);
  if (!thread) return;

  let identity: { username?: string; icon_url?: string } = opts.identity ?? {};
  if (!opts.identity && opts.direction) {
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
        opts.direction === 'in'
          ? {
              username: `${profile.name ?? friendlyName(row.conv.externalId)} (customer)`,
              icon_url: profile.picture_url ? slackAvatarUrl(conversationId) ?? undefined : undefined,
            }
          : opts.direction === 'out'
            ? { username: `${row.agent.name} (agent)` }
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
