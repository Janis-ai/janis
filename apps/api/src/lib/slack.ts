import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNotNull, sql, type SQLWrapper } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  channelBindings,
  channels,
  conversations,
  memberships,
  messages,
  pendingActions,
  slackInstallations,
  slackThreads,
  users,
} from '../db/schema.js';
import { workspaceMembers } from './members.js';
import { env } from '../env.js';

type Installation = typeof slackInstallations.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;
type UserRow = typeof users.$inferSelect;
type SlackThreadRow = typeof slackThreads.$inferSelect;

const SLACK_API = 'https://slack.com/api';

export async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<T & { ok: boolean; error?: string }> {
  const url = query ? `${SLACK_API}/${method}?${new URLSearchParams(query)}` : `${SLACK_API}/${method}`;
  const res = await fetch(url, {
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

/** All channels the bot can see — follows conversations.list pagination
 * (a single 200-limit page drops channels in bigger workspaces).
 * exclude_archived goes on the QUERY STRING — Slack ignores it in a JSON
 * body — and we still filter is_archived client-side as a backstop: legacy
 * workspaces carry thousands of archived channels. */
export async function listSlackChannels(
  botToken: string,
): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const res: {
      channels?: { id: string; name: string; is_archived?: boolean }[];
      response_metadata?: { next_cursor?: string };
    } & { ok: boolean; error?: string } = await slackApi(
      botToken,
      'conversations.list',
      {},
      {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      },
    );
    if (!res.ok) break;
    for (const c of res.channels ?? []) {
      if (!c.is_archived) out.push({ id: c.id, name: c.name });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < 2000);
  return out;
}

/** Slack channel names: lowercase letters/digits/dash/underscore, ≤80 chars. */
export function sanitizeChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Create a Slack channel. On name_taken retries with a short suffix unless
 * retryOnTaken is false — user-initiated creates want the collision surfaced
 * so they can pick another name, not a silent -x3yz rename. */
export async function createSlackChannel(
  inst: Installation,
  name: string,
  opts: { suffix?: string; retryOnTaken?: boolean } = {},
): Promise<{ channel?: { id: string; name: string }; error?: string }> {
  const { suffix = '', retryOnTaken = true } = opts;
  const res = await slackApi<{ channel: { id: string; name: string } }>(
    inst.botToken,
    'conversations.create',
    { name: `${name}${suffix}` },
  ).catch(() => null);
  if (res?.ok) return { channel: res.channel };
  if (res?.error === 'name_taken' && retryOnTaken && !suffix) {
    return createSlackChannel(inst, name.slice(0, 74), {
      suffix: `-${Math.random().toString(36).slice(2, 6)}`,
      retryOnTaken,
    });
  }
  console.error('slack conversations.create failed:', res?.error);
  return { error: res?.error ?? 'request failed' };
}

/** Fetch one channel — conversations.info takes its param on the QUERY
 * STRING; in a JSON body Slack answers "missing required field: channel". */
export async function slackChannelInfo(
  botToken: string,
  channelId: string,
): Promise<{ id: string; name: string; isArchived: boolean } | null> {
  const res = await slackApi<{ channel: { id: string; name: string; is_archived?: boolean } }>(
    botToken,
    'conversations.info',
    {},
    { channel: channelId },
  ).catch(() => null);
  return res?.ok
    ? { id: res.channel.id, name: res.channel.name, isArchived: !!res.channel.is_archived }
    : null;
}

/** Where this agent's alerts post — its own channel if set, else the
 * workspace-wide alert channel. */
export async function alertChannelFor(
  db: Db,
  inst: Installation,
  agentId: string | null | undefined,
): Promise<string | null> {
  if (agentId) {
    const [agent] = await db
      .select({ slackChannelId: agents.slackChannelId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (agent?.slackChannelId) return agent.slackChannelId;
  }
  return inst.alertChannelId;
}

/** Slack answers not_in_channel / channel_not_found when the bot can't use a
 * channel — a public one it hasn't joined (recoverable via
 * conversations.join) or a deleted/private one it can't see (dead for good). */
const deadChannelError = (err?: string) => err === 'not_in_channel' || err === 'channel_not_found';

/** Threads anchored in a channel the bot can no longer reach are dead weight:
 * every mirror, status write and alert keeps erroring on them. Drop the rows
 * so fan-out stops and the next alert re-anchors somewhere reachable. */
async function pruneDeadThreads(db: Db, conversationId: string, channelId: string): Promise<void> {
  await db
    .delete(slackThreads)
    .where(
      and(eq(slackThreads.conversationId, conversationId), eq(slackThreads.channelId, channelId)),
    )
    .catch((err) => console.error('slack dead-thread prune failed:', err));
}

/** Any Slack call aimed at a channel — when the bot isn't a member, join it
 * and retry once (freshly-created alert channels, re-adds). The channel id
 * is read from body.channel / body.channel_id. */
async function callInChannel<T>(
  inst: Installation,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const channel = body.channel ?? body.channel_id;
  const call = () => slackApi<T>(inst.botToken, method, body);
  let res = await call();
  if (!res.ok && typeof channel === 'string' && deadChannelError(res.error)) {
    const join = await slackApi(inst.botToken, 'conversations.join', { channel }).catch(() => null);
    if (join?.ok) res = await call();
  }
  return res;
}

/** Post to a channel; if the bot isn't a member yet (e.g. a freshly-created
 * alert channel), join it and retry once — Slack answers not_in_channel
 * rather than posting for non-members even with chat:write.public. */
async function postChannelMessage(
  inst: Installation,
  channelId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; channel?: string; ts?: string; error?: string }> {
  return callInChannel<{ channel?: string; ts?: string }>(inst, 'chat.postMessage', {
    channel: channelId,
    ...body,
  });
}

/** Post into a live thread — same join+retry as postChannelMessage, then
 * prune the thread rows when the channel turns out to be unreachable so the
 * failure isn't repeated on every mirror, notice and status write. */
async function postThreadMessage(
  db: Db,
  t: { slackThreads: SlackThreadRow; installation: Installation },
  body: Record<string, unknown>,
): Promise<{ ok: boolean; channel?: string; ts?: string; error?: string }> {
  const res = await callInChannel<{ channel?: string; ts?: string }>(
    t.installation,
    'chat.postMessage',
    { channel: t.slackThreads.channelId, thread_ts: t.slackThreads.ts, ...body },
  );
  if (!res.ok && deadChannelError(res.error)) {
    await pruneDeadThreads(db, t.slackThreads.conversationId, t.slackThreads.channelId);
  }
  return res;
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
  const res = await postChannelMessage(inst, channel, {
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
  threadLink?: string,
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
  if (threadLink) {
    actions.push({
      type: 'button',
      action_id: 'janis_view_thread',
      text: { type: 'plain_text', text: 'View thread' },
      url: threadLink,
    });
  }

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
  // lookupByEmail ignores JSON bodies — the email must go on the query string.
  const res = await slackApi<{ user: { id: string } }>(
    inst.botToken,
    'users.lookupByEmail',
    {},
    { email: member.email },
  ).catch(() => null);
  const slackId = res?.ok && res.user ? res.user.id : null;
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
    const members = await workspaceMembers(db, inst.workspaceId);
    const ids = (
      await Promise.all(members.map((m) => memberToSlackUser(db, inst, m.user.id)))
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
  const members = await workspaceMembers(db, inst.workspaceId);
  for (const m of members) {
    const sid = await memberToSlackUser(db, inst, m.user.id);
    if (sid) await ensureInAlertChannel(inst, sid, channelId);
  }
}

/** Every channel Janis posts alerts to in this workspace: the workspace
 * alert channel plus each agent's own override channel. */
async function janisAlertChannels(db: Db, inst: Installation): Promise<string[]> {
  const ids = new Set<string>();
  if (inst.alertChannelId) ids.add(inst.alertChannelId);
  const rows = await db
    .select({ ch: agents.slackChannelId })
    .from(agents)
    .where(and(eq(agents.workspaceId, inst.workspaceId), isNotNull(agents.slackChannelId)));
  for (const r of rows) if (r.ch) ids.add(r.ch);
  return [...ids];
}

/** A newly-accepted member gets invited into every Janis alert channel —
 * thread replies and buttons only reach channel members. */
export async function syncMemberToAlertChannels(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const inst = await getInstallation(db, workspaceId);
  if (!inst) return;
  const sid = await memberToSlackUser(db, inst, userId);
  if (!sid) return;
  for (const ch of await janisAlertChannels(db, inst)) {
    await ensureInAlertChannel(inst, sid, ch);
  }
}

/** A removed member gets kicked out of every Janis alert channel. The user
 * row survives workspace removal, so memberToSlackUser still resolves. */
export async function removeMemberFromAlertChannels(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const inst = await getInstallation(db, workspaceId);
  if (!inst) return;
  const sid = await memberToSlackUser(db, inst, userId);
  if (!sid) return;
  for (const ch of await janisAlertChannels(db, inst)) {
    const kick = () =>
      slackApi(inst.botToken, 'conversations.kick', { channel: ch, user: sid }).catch(() => null);
    let res = await kick();
    // Bot must be a channel member to kick — join first on public channels.
    if (res?.error === 'not_in_channel') {
      await slackApi(inst.botToken, 'conversations.join', { channel: ch }).catch(() => null);
      res = await kick();
    }
    if (res && !res.ok && !['not_in_channel', 'cant_kick_self'].includes(res.error ?? '')) {
      console.error('slack kick failed:', res.error);
    }
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

/** All live Slack threads for a conversation, newest first, each joined to
 * its installation. A conversation accumulates one thread per alert and all
 * of them stay live forever: mirrors fan out to every thread and replies in
 * any of them route back via findThread — so nothing an operator sees ever
 * goes dead or out of sync. */
async function threadsForConversation(db: Db, conversationId: string) {
  return db
    .select({ slackThreads, installation: slackInstallations })
    .from(slackThreads)
    .innerJoin(slackInstallations, eq(slackThreads.installationId, slackInstallations.id))
    .where(eq(slackThreads.conversationId, conversationId))
    .orderBy(desc(slackThreads.createdAt));
}

/**
 * Post an alert into Slack with action buttons and register its thread.
 * A NEW alert always posts a fresh top-level channel message and gets its
 * own seeded thread — but every previous thread for the conversation stays
 * registered and keeps receiving mirrors, so operators can reply in any of
 * them. Deduped handoffs (opts.reply) echo into all live threads.
 */
/**
 * Post an approval card for a gated tool call into every live thread —
 * Approve/Deny buttons carry the pending_action id.
 */
export async function postSlackActionRequest(
  db: Db,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
  action: typeof pendingActions.$inferSelect,
): Promise<void> {
  const threads = await threadsForConversation(db, conv.id);
  if (!threads.length) return;
  const argsText = JSON.stringify(action.args, null, 2).slice(0, 800);
  const text = `:lock: *Approval needed* — \`${action.toolName}\`\n\`\`\`${argsText}\`\`\``;
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:lock: *Approval needed* — agent *${agent.name}* wants to run \`${action.toolName}\`\n\`\`\`${argsText}\`\`\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'janis_approve_action',
          text: { type: 'plain_text', text: 'Approve & run' },
          style: 'primary',
          value: action.id,
        },
        {
          type: 'button',
          action_id: 'janis_deny_action',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          value: action.id,
        },
      ],
    },
  ];
  const posts: { channelId: string; ts: string }[] = [];
  for (const t of threads) {
    const res = await postThreadMessage(db, t, { text, blocks });
    if (res.ok && res.ts) {
      posts.push({ channelId: res.channel ?? t.slackThreads.channelId, ts: res.ts });
      await markThreadReply(db, t.slackThreads.channelId, t.slackThreads.ts, res.ts);
    }
  }
  if (posts.length) {
    await db
      .update(pendingActions)
      .set({ slackPosts: posts })
      .where(eq(pendingActions.id, action.id));
  }
}

/** After a decision, rewrite every posted card to show the outcome. */
export async function resolveSlackActionCards(
  db: Db,
  action: typeof pendingActions.$inferSelect,
  approved: boolean,
  decidedByName: string,
): Promise<void> {
  const posts = (action.slackPosts ?? []) as { channelId: string; ts: string }[];
  if (!posts.length) return;
  const threads = await threadsForConversation(db, action.conversationId);
  const preview = action.result ? `\n\`\`\`${action.result.slice(0, 400)}\`\`\`` : '';
  const text = approved
    ? `:white_check_mark: *${decidedByName} approved* \`${action.toolName}\` — executed${preview}`
    : `:no_entry_sign: *${decidedByName} denied* \`${action.toolName}\``;
  for (const p of posts) {
    const t = threads.find((x) => x.slackThreads.channelId === p.channelId);
    if (!t) continue;
    const res = await callInChannel(t.installation, 'chat.update', {
      channel: p.channelId,
      ts: p.ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    }).catch(() => null);
    if (res && !res.ok && deadChannelError(res.error)) {
      await pruneDeadThreads(db, action.conversationId, p.channelId);
    }
  }
}

/** Record the newest reply ts on a thread row — "View thread" permalinks
 * land on it. Slack ts are epoch-seconds.micros strings; a lexical guard
 * keeps an out-of-order post from rewinding it. */
export async function markThreadReply(
  db: Db,
  channelId: string,
  threadTs: string,
  replyTs: string,
): Promise<void> {
  await db
    .update(slackThreads)
    .set({ lastReplyTs: replyTs })
    .where(
      and(
        eq(slackThreads.channelId, channelId),
        eq(slackThreads.ts, threadTs),
        sql`(${slackThreads.lastReplyTs} is null or ${slackThreads.lastReplyTs} < ${replyTs})`,
      ),
    );
}

/** A link that opens the thread panel highlighting the latest reply —
 * getPermalink on the reply gives the archives URL (on the workspace's
 * own subdomain); thread_ts/cid make Slack open the panel (this is what
 * "Copy link" on a reply produces — app_redirect lands on the channel
 * message without opening the panel). replyTs falls back to the anchor
 * when the thread has no replies yet. */
async function threadPermalink(
  token: string,
  channelId: string,
  threadTs: string,
  replyTs?: string,
): Promise<string> {
  const target = replyTs ?? threadTs;
  const res = await slackApi<{ permalink?: string }>(
    token,
    'chat.getPermalink',
    {},
    { channel: channelId, message_ts: target },
  ).catch(() => null);
  if (res?.ok && res.permalink) {
    const sep = res.permalink.includes('?') ? '&' : '?';
    return `${res.permalink}${sep}thread_ts=${threadTs}&cid=${channelId}`;
  }
  return `https://slack.com/app_redirect?channel=${channelId}&message=${target}`;
}

/**
 * Post an alert into Slack with action buttons. A conversation gets ONE
 * Slack thread: the first alert posts a top-level card that anchors it and
 * is seeded with the transcript. Every later alert is still a fresh
 * top-level message — channel visibility — but carries a "View thread"
 * permalink into the canonical thread instead of anchoring a parallel one,
 * so nothing accumulates and links always open the same place.
 */
export async function postSlackAlert(
  db: Db,
  workspaceId: string,
  conv: ConversationRow,
  agent: typeof agents.$inferSelect,
  alert: AlertRow,
): Promise<void> {
  const inst = await getInstallation(db, workspaceId);
  if (!inst) return;
  const channelId = await alertChannelFor(db, inst, agent.id);
  if (!channelId) return;

  let existing = await threadsForConversation(db, conv.id);

  // Routing: assigned → invite them into the alert channel (idempotent) and
  // @mention; if they can't be invited, DM a pointer instead. Unassigned →
  // every resolvable member gets an individual <@U> in the post plus a DM
  // (direct mentions can't be suppressed the way @channel can). Assigned-but-
  // unresolvable → @here: the assignee is paged via Janis push/email anyway.
  const { text: mention, slackUserId, dmIds } = await alertMention(db, inst, conv);
  const dmTargets = new Set(dmIds);
  if (slackUserId && !(await ensureInAlertChannel(inst, slackUserId, channelId))) {
    dmTargets.add(slackUserId);
  }

  const summary =
    `${mention}:rotating_light: *${alert.type.replace('_', ' ')}* — agent *${agent.name}* · ` +
    `conversation \`${conv.externalId}\`\n${alert.detail ?? conv.lastMessagePreview ?? ''}`;

  const dmAll = (link: string) => {
    const text =
      `${summary}\n<${link}|View alert thread>` +
      ` · <${env.webOrigin}/conversations/${conv.id}|Open in Janis>`;
    for (const id of dmTargets) void dmAlertPointer(inst, id, text);
  };

  while (existing.length) {
    // The conversation already has a thread — post a fresh top-level alert
    // for channel visibility, but link it into the canonical thread instead
    // of anchoring a parallel one. Store where the card landed so
    // updateSlackAlert can refresh its buttons.
    const t = existing[0];
    const link = await threadPermalink(
      t.installation.botToken,
      t.slackThreads.channelId,
      t.slackThreads.ts,
      t.slackThreads.lastReplyTs ?? undefined,
    );
    const res = await postChannelMessage(t.installation, t.slackThreads.channelId, {
      text: summary,
      blocks: alertBlocks(conv, agent, alert, mention, link),
    });
    if (res.ok && res.ts) {
      await db
        .update(alerts)
        .set({ slackTs: res.ts, slackChannelId: res.channel ?? t.slackThreads.channelId })
        .where(eq(alerts.id, alert.id));
      dmAll(link);
      return;
    }
    if (!deadChannelError(res.error)) {
      console.error('slack alert post failed:', res.error);
      return;
    }
    // The canonical thread's channel is unreachable even after the join
    // retry — deleted, or the bot was removed from a private one. Drop the
    // dead rows and try the next thread; if none are left, fall through and
    // anchor a fresh thread in the configured alert channel.
    await pruneDeadThreads(db, conv.id, t.slackThreads.channelId);
    existing = await threadsForConversation(db, conv.id);
  }

  const res = await postChannelMessage(inst, channelId, {
    text: summary,
    blocks: alertBlocks(conv, agent, alert, mention),
  });
  if (res.ok && res.channel && res.ts) {
    await db
      .insert(slackThreads)
      .values({
        conversationId: conv.id,
        installationId: inst.id,
        channelId: res.channel,
        ts: res.ts,
      })
      .onConflictDoNothing();
    dmAll(await threadPermalink(inst.botToken, res.channel, res.ts));
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
      authorDisplayName: users.displayName,
      authorAvatarUrl: users.avatarUrl,
      authorShowIdentity: users.showIdentity,
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
  const agentIcon = await agentIconFor(db, conv.id);

  let lastReplyTs: string | undefined;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conv.id));
  if (count > recent.length) {
    const res = await slackApi<{ ts?: string }>(inst.botToken, 'chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: `_Showing the last ${recent.length} of ${count} messages — <${env.webOrigin}/conversations/${conv.id}|full transcript in Janis>._`,
    });
    if (res.ok && res.ts) lastReplyTs = res.ts;
  }

  for (const m of recent.reverse()) {
    if (!m.text) continue;
    // Flagged notes (handoff/failure/custom alert) are internal system lines
    // — italic, from the app itself, not attributed to a participant.
    const f = m.flags as {
      failure?: boolean;
      help_requested?: boolean;
      custom_alert?: boolean;
      handoff_offer?: boolean;
    } | null;
    const isSystemNote = Boolean(
      f?.failure || f?.help_requested || f?.custom_alert || f?.handoff_offer,
    );
    // Role suffixes keep same-named participants (e.g. agent and customer
    // both "Michael Nathanson") from collapsing into a single header.
    const identity: { username?: string; icon_url?: string } = isSystemNote
      ? {}
      : m.direction === 'in'
        ? { username: `${customerName} (customer)`, icon_url: avatar ?? undefined }
        : m.direction === 'human'
          ? operatorIdentity(
              agent.name,
              {
                name: m.author,
                displayName: m.authorDisplayName,
                avatarUrl: m.authorAvatarUrl,
                showIdentity: m.authorShowIdentity,
              },
              agentIcon,
            )
          : { username: `${agent.name} (agent)`, icon_url: agentIcon };
    const res2 = await slackApi<{ ts?: string }>(inst.botToken, 'chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: isSystemNote ? `_${m.text}_` : m.text,
      ...identity,
    });
    if (res2.ok && res2.ts) {
      lastReplyTs = res2.ts;
    } else if (!res2.ok && !isSystemNote) {
      // Install predates chat:write.customize — fall back to a label.
      const res3 = await slackApi<{ ts?: string }>(inst.botToken, 'chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text: `*${identity.username}:* ${m.text}`,
      });
      if (res3.ok && res3.ts) lastReplyTs = res3.ts;
    }
  }
  if (lastReplyTs) await markThreadReply(db, channel, threadTs, lastReplyTs);
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
  const threads = await threadsForConversation(db, conv.id);
  if (!threads.length) return;
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.conversationId, conv.id))
    .orderBy(desc(alerts.createdAt))
    .limit(1);
  for (const t of threads) {
    const { text: mention } = await alertMention(db, t.installation, conv);
    const blocks = alertBlocks(
      conv,
      agent,
      alert ?? { type: 'help_request', detail: null },
      mention,
    );
    const res = await callInChannel(t.installation, 'chat.update', {
      channel: t.slackThreads.channelId,
      ts: t.slackThreads.ts,
      text: `${mention}alert — ${conv.externalId}`,
      blocks,
    });
    if (!res.ok && deadChannelError(res.error)) {
      await pruneDeadThreads(db, t.slackThreads.conversationId, t.slackThreads.channelId);
      continue;
    }
    if (!res.ok) console.error('slack alert update failed:', res.error);
    // Alerts after the first land as replies in the thread — refresh that
    // card's buttons too, it isn't the anchor message.
    if (alert?.slackTs && alert.slackChannelId === t.slackThreads.channelId) {
      const res2 = await callInChannel(t.installation, 'chat.update', {
        channel: t.slackThreads.channelId,
        ts: alert.slackTs,
        text: `${mention}alert — ${conv.externalId}`,
        blocks,
      });
      if (!res2.ok) console.error('slack alert update failed:', res2.error);
    }
  }
}

/** Operator identity for transcript rendering — honors their show_identity
 * pref: their profile display name + avatar when they opted to show them to
 * customers, the agent's masquerade when not. Avatar falls back to the
 * agent icon so the thread keeps a consistent face. */
function operatorIdentity(
  agentName: string,
  u: {
    name?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    showIdentity?: boolean | null;
  } | null | undefined,
  agentIcon: string | undefined,
): { username: string; icon_url?: string } {
  const name =
    u?.showIdentity === false
      ? null
      : (u?.displayName ?? u?.name?.split(' ')[0] ?? u?.name ?? null);
  if (!name) return { username: `${agentName} (operator)`, icon_url: agentIcon };
  return {
    username: `${name} (operator)`,
    icon_url: u?.avatarUrl ? `${env.apiOrigin}${u.avatarUrl}` : agentIcon,
  };
}

/** The agent's face for reposted/mirrored messages — the conversation's
 * channel logo (the same image the widget shows as the agent avatar),
 * absolutized for Slack. */
async function agentIconFor(db: Db, conversationId: string): Promise<string | undefined> {
  const [bind] = await db
    .select({ creds: channels.credentials })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  const logo = (bind?.creds as { logo_url?: string } | null)?.logo_url;
  if (!logo) return undefined;
  return /^https?:\/\//.test(logo) ? logo : `${env.apiOrigin}${logo}`;
}

/** Mirror a console-originated message into the conversation's Slack threads.
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
    operator?: UserRow; // direction 'human' — resolves show_identity prefs
  } = {},
): Promise<void> {
  const threads = await threadsForConversation(db, conversationId);
  if (!threads.length) return;

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
      if (opts.direction === 'in') {
        identity = {
          username: `${profile.name ?? friendlyName(row.conv.externalId)} (customer)`,
          icon_url: profile.picture_url ? slackAvatarUrl(conversationId) ?? undefined : undefined,
        };
      } else if (opts.direction === 'out') {
        identity = {
          username: `${row.agent.name} (agent)`,
          icon_url: await agentIconFor(db, conversationId),
        };
      } else if (opts.direction === 'human') {
        // Operators who opted to show their identity appear as themselves;
        // the rest wear the agent's face — the same masquerade the
        // customer sees, so the thread reads like the customer transcript.
        identity = operatorIdentity(
          row.agent.name,
          opts.operator,
          await agentIconFor(db, conversationId),
        );
      }
    }
  }

  for (const t of threads) {
    const res = await postThreadMessage(db, t, { text, ...identity });
    if (res.ok && res.ts) {
      await markThreadReply(db, t.slackThreads.channelId, t.slackThreads.ts, res.ts);
    } else if (!res.ok && !deadChannelError(res.error)) {
      // Install predates chat:write.customize — keep the labeled text form.
      const res2 = await postThreadMessage(db, t, { text: `${label} ${text}` });
      if (res2.ok && res2.ts) {
        await markThreadReply(db, t.slackThreads.channelId, t.slackThreads.ts, res2.ts);
      }
    }
  }
}

// assistant.threads.setStatus bookkeeping — Slack keeps a status ~2min and
// auto-clears it when the app posts in the thread, so re-set the same
// status at most every 90s and arm a self-clear so a status can't outlive
// the work it describes.
const lastThreadStatus = new Map<string, { status: string; at: number; timer: NodeJS.Timeout }>();

async function applyThreadStatus(db: Db, conversationId: string, status: string | null): Promise<boolean> {
  const threads = await threadsForConversation(db, conversationId);
  if (!threads.length) return false;
  let ok = false;
  for (const t of threads) {
    const res = await callInChannel(t.installation, 'assistant.threads.setStatus', {
      channel_id: t.slackThreads.channelId,
      thread_ts: t.slackThreads.ts,
      status: status ?? '',
    });
    if (!res.ok && deadChannelError(res.error)) {
      await pruneDeadThreads(db, t.slackThreads.conversationId, t.slackThreads.channelId);
      continue;
    }
    if (!res.ok) console.error('slack thread status failed:', res.error);
    ok = ok || res.ok;
  }
  return ok;
}

function armStatusExpiry(db: Db, conversationId: string, expireMs: number) {
  return setTimeout(() => {
    lastThreadStatus.delete(conversationId);
    void applyThreadStatus(db, conversationId, null).catch(() => {});
  }, expireMs);
}

/** Mirror "the app is working" into the conversation's Slack thread via
 * Slack's assistant status API — rendered under the app name, so only use
 * it when Janis itself is doing the work (agent processing); it can't
 * attribute a visitor's or operator's typing. Works on plain chat:write.
 * Pass null to clear. Self-clears after expireMs so it can't get stuck.
 * Never throws. */
export async function setSlackThreadStatus(
  db: Db,
  conversationId: string,
  status: string | null,
  expireMs = 95_000,
): Promise<void> {
  try {
    const last = lastThreadStatus.get(conversationId);
    if (last) clearTimeout(last.timer);
    if (status === null) {
      lastThreadStatus.delete(conversationId);
      if (last) await applyThreadStatus(db, conversationId, null);
      return;
    }
    if (last && last.status === status && Date.now() - last.at < 90_000) {
      // already live — just push the self-clear out
      last.timer = armStatusExpiry(db, conversationId, expireMs);
      return;
    }
    const ok = await applyThreadStatus(db, conversationId, status);
    if (!ok) return;
    lastThreadStatus.set(conversationId, {
      status,
      at: Date.now(),
      timer: armStatusExpiry(db, conversationId, expireMs),
    });
  } catch (err) {
    console.error('slack thread status failed:', err);
  }
}

/** Post a lifecycle notice (takeover/resume) into the conversation's Slack
 * thread. If the conversation never escalated it has no thread — post the
 * notice to the alert channel top-level and adopt it as the thread anchor so
 * later mirrors, warnings, and the refreshed alert card have somewhere to go.
 * Always best-effort: failures log and return, never throw. */
export async function slackNotice(
  db: Db,
  workspaceId: string,
  conv: ConversationRow,
  label: string,
  text: string,
): Promise<void> {
  const threads = await threadsForConversation(db, conv.id);
  if (threads.length) {
    for (const t of threads) {
      const res = await postThreadMessage(db, t, { text: `${label} ${text}` });
      if (res.ok && res.ts) {
        await markThreadReply(db, t.slackThreads.channelId, t.slackThreads.ts, res.ts);
      } else if (!res.ok && !deadChannelError(res.error)) console.error('slack notice failed:', res.error);
    }
    return;
  }
  const inst = await getInstallation(db, workspaceId);
  if (!inst) return;
  const channelId = await alertChannelFor(db, inst, conv.agentId);
  if (!channelId) return;
  const res = await postChannelMessage(inst, channelId, {
    text: `${label} ${text} — \`${conv.externalId}\``,
  });
  if (!res.ok || !res.channel || !res.ts) {
    console.error('slack notice failed:', res.error);
    return;
  }
  await db
    .insert(slackThreads)
    .values({
      conversationId: conv.id,
      installationId: inst.id,
      channelId: res.channel,
      ts: res.ts,
    })
    .onConflictDoNothing();
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
 * Map a Slack user to a Janis member — ONLY by verified identity: the stored
 * users.slackUserId link, or their Slack profile email matched against
 * accepted workspace members (which then caches the link). No fallback: an
 * unresolvable Slack user must NOT act as the installer or an admin.
 */
export async function slackUserToMember(
  db: Db,
  inst: Installation,
  slackUserId: string,
): Promise<UserRow | undefined> {
  const memberWhere = (pred: SQLWrapper) =>
    db
      .select({ user: users })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.workspaceId, inst.workspaceId),
          pred,
          isNotNull(memberships.acceptedAt),
        ),
      )
      .limit(1);

  // Fast path — identity linked on a previous lookup.
  const [linked] = await memberWhere(eq(users.slackUserId, slackUserId));
  if (linked) return linked.user;

  const info = await slackApi<{ user: { profile?: { email?: string } } }>(
    inst.botToken,
    'users.info',
    { user: slackUserId },
  ).catch(() => null);
  const email = info?.ok ? info.user?.profile?.email : undefined;
  if (email) {
    const [member] = await memberWhere(eq(users.email, email));
    if (member) {
      // Cache the link so future actions skip the users.info call.
      await db.update(users).set({ slackUserId }).where(eq(users.id, member.user.id));
      return member.user;
    }
  }
  return undefined;
}
