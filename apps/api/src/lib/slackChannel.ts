/**
 * Visitor-facing Slack channels (kind 'slack'). A customer message on a bound
 * Slack surface lands in the shared channel pipeline (handleChannelMessage)
 * and replies post back to the Slack thread they came from — the same shape
 * as every other channel kind. Two credential flavors:
 *
 *   via 'oauth'  — the shared Janis Slack app: credentials.slack_installation_id
 *                  points at a slack_installations row owned by the same
 *                  workspace; inbound events arrive at POST /slack/events and
 *                  are claimed here before the concierge surface.
 *   via 'manual' — the customer's own Slack app: bot_token + signing_secret
 *                  live on the channel; its Events API Request URL points at
 *                  POST /slack/ext/:channelId/events.
 *
 * Claim rules (which events a slack channel swallows): an event in one of
 * creds.slack_channel_ids, or a bot DM (channel_type 'im') when creds.slack_dm.
 * @mentions outside bound channels stay with the concierge.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  channelBindings,
  channels,
  messages,
  slackInstallations,
} from '../db/schema.js';
import type {
  AttachmentRef,
  ChannelCredentials,
  SendOptions,
  SendResult,
} from './channels.js';
import { slackApi, slackMrkdwn } from './slack.js';
import { handleChannelMessage } from '../services/channelIngress.js';

type ChannelRow = typeof channels.$inferSelect;
type Installation = typeof slackInstallations.$inferSelect;

/** A normalized inbound Slack event (message or app_mention). */
export interface SlackVisitorEvent {
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  mention: boolean;
  /** Slack's channel_type: 'im' | 'channel' | 'group' | 'mpim'. */
  channelType?: string;
}

/** Does this channel's config claim the event surface? Bot DMs need the
 *  explicit opt-in (a workspace's concierge already answers DMs by default);
 *  listed channel ids claim every message + mention inside them. */
export function claimsVisitorEvent(
  creds: ChannelCredentials,
  slackChannelId: string,
  channelType?: string,
): boolean {
  if (channelType === 'im') return creds.slack_dm === true;
  return (creds.slack_channel_ids ?? []).includes(slackChannelId);
}

/** Shared-app path: find the slack channel bound to this installation that
 *  claims the event, if any. Earliest-created wins on overlapping claims. */
export async function visitorChannelFor(
  db: Db,
  inst: Installation,
  slackChannelId: string,
  channelType?: string,
): Promise<ChannelRow | undefined> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, inst.workspaceId), eq(channels.kind, 'slack')))
    .orderBy(asc(channels.createdAt));
  return rows.find(
    (r) =>
      (r.credentials as ChannelCredentials).slack_installation_id === inst.id &&
      claimsVisitorEvent(r.credentials as ChannelCredentials, slackChannelId, channelType),
  );
}

/** The bot token a channel sends with — manual creds carry their own; oauth
 *  channels read the bound installation's (scoped to the channel's workspace
 *  so a stale installation_id can't borrow another workspace's grant). */
export async function slackBotToken(
  db: Db | undefined,
  channel: ChannelRow,
  creds: ChannelCredentials,
): Promise<string | undefined> {
  if (creds.slack_bot_token) return creds.slack_bot_token;
  if (db && creds.slack_installation_id) {
    const [inst] = await db
      .select({ botToken: slackInstallations.botToken, workspaceId: slackInstallations.workspaceId })
      .from(slackInstallations)
      .where(eq(slackInstallations.id, creds.slack_installation_id))
      .limit(1);
    if (inst && inst.workspaceId === channel.workspaceId) return inst.botToken;
  }
  return undefined;
}

/** Slack mrkdwn → canonical text for visitor inbound. Unlike slackToCanonical
 *  (operator rail), mention names resolve through users.info on the bot token
 *  — visitors aren't workspace members, and a BYO app has no installation. */
export async function slackVisitorToCanonical(botToken: string, text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const r = await slackApi<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string } } }>(
        botToken,
        'users.info',
        { user: id },
      ).catch(() => null);
      const u = r?.user;
      names.set(id, u?.profile?.display_name || u?.real_name || u?.name || 'someone');
    }),
  );
  let out = text.replace(/<@[UW][A-Z0-9]+>/g, (m) => `@${names.get(m.slice(2, -1)) ?? 'someone'}`);
  out = out.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '[$2]($1)');
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  out = out.replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, _id, n) => `#${n ?? 'channel'}`);
  out = out.replace(/<!(here|channel|everyone)>/g, '@$1');
  out = out.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  out = out.replace(/```([^`]+)```/gs, (_m, c: string) => `\`${c.trim()}\``);
  return out.replace(
    /\*([^\s*](?:[^*]*[^\s*])?)\*|_([^\s_](?:[^_]*[^\s_])?)_|~([^\s~](?:[^~]*[^\s~])?)~/g,
    (_m, b, i, s) => (b != null ? `**${b}**` : i != null ? `*${i}*` : `~~${s}~~`),
  );
}

/** Ingest one claimed event into the channel pipeline. Conversation keys on
 *  `slack:{team}:{user}` — one conversation per Slack user, and the reply
 *  lands wherever they last spoke (the payload.slack stamp read back by
 *  sendSlackReply). Slack user emails come from the workspace directory, not
 *  a verified identity — they annotate the contact but never verify it. */
export async function visitorSlackInbound(
  db: Db,
  channel: ChannelRow,
  ev: SlackVisitorEvent,
  teamId: string,
): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  const token = await slackBotToken(db, channel, creds);
  if (!token) {
    console.error('slack visitor inbound: no bot token on channel', channel.id);
    return;
  }
  // Mentions arrive "<@BOT> question" — drop the leading mention so the
  // question reads clean; other mentions resolve to names downstream.
  const raw = ev.mention ? ev.text.replace(/^<@[UW][A-Z0-9]+>\s*/, '') : ev.text;
  const text = (await slackVisitorToCanonical(token, raw)).trim();
  if (!text) return;

  const info = await slackApi<{
    user?: {
      name?: string;
      real_name?: string;
      is_bot?: boolean;
      profile?: { display_name?: string; email?: string; image_72?: string };
    };
  }>(token, 'users.info', { user: ev.user }).catch(() => null);
  const u = info?.user;
  if (u?.is_bot) return;
  const name = u?.profile?.display_name || u?.real_name || u?.name;

  await handleChannelMessage(db, channel, {
    objectId: channel.id,
    senderId: `slack:${teamId}:${ev.user}`,
    messageId: `slack:${ev.channel}:${ev.ts}`,
    text,
    user: {
      name,
      email: u?.profile?.email,
      verified: false,
      avatarUrl: u?.profile?.image_72,
      traits: {
        surface: 'slack',
        slack_team: teamId,
        slack_channel: ev.channel,
        slack_user: ev.user,
      },
    },
    // sendSlackReply reads this stamp back off the last inbound message to
    // find the reply target — same trick as email's threading headers.
    payload: {
      slack: {
        team: teamId,
        channel: ev.channel,
        ts: ev.ts,
        thread_ts: ev.threadTs,
        channel_type: ev.channelType,
      },
    },
  });
}

/** Push a reply to the Slack surface the customer last wrote on: their DM
 *  (unthreaded, DM convention) or the thread they spoke in (channel
 *  convention — top-level posts get replies in a new thread under them). */
export async function sendSlackReply(
  db: Db | undefined,
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  opts: SendOptions | undefined,
): Promise<SendResult> {
  const creds = channel.credentials as ChannelCredentials;
  const token = await slackBotToken(db, channel, creds);
  if (!token) {
    return {
      mid: null,
      error: 'slack channel has no bot token — reconnect it under Integrations',
      retryable: false,
    };
  }
  if (!db) return { mid: null, error: 'slack send needs db access', retryable: false };

  const [binding] = await db
    .select({ conversationId: channelBindings.conversationId })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  const [lastIn] = binding
    ? await db
        .select({ payload: messages.payload })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, binding.conversationId),
            eq(messages.direction, 'in'),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
    : [];
  const s = (
    lastIn?.payload as {
      slack?: { channel?: string; ts?: string; thread_ts?: string; channel_type?: string };
    } | null
  )?.slack;
  if (!s?.channel) {
    return {
      mid: null,
      error: 'no slack thread on this conversation — the customer must message first',
      retryable: false,
    };
  }
  const threadTs = s.thread_ts ?? (s.channel_type === 'im' ? undefined : s.ts);

  const lines = [slackMrkdwn(text)];
  const qrs = (opts?.quickReplies ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);
  if (qrs.length) lines.push('', ...qrs.map((t) => `• ${slackMrkdwn(t)}`));
  const attLines = (attachments ?? [])
    .filter((a) => a.url)
    .map((a) => `<${a.url}|${a.name || 'attachment'}>`);
  if (attLines.length) lines.push(...attLines);

  // Per-message persona (chat:write.customize): operator replies carry the
  // operator's name, agent replies carry the agent's — the app itself still
  // shows as the Janis/bot install in Slack's chrome.
  const [agent] = opts?.senderName
    ? []
    : await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, channel.agentId))
        .limit(1);

  const res = await slackApi<{ ts?: string }>(token, 'chat.postMessage', {
    channel: s.channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: lines.join('\n'),
    username: opts?.senderName ?? agent?.name ?? undefined,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!res.ok) {
    return {
      mid: null,
      error: `slack post failed: ${res.error ?? 'unknown'}`,
      retryable: res.error === 'ratelimited',
    };
  }
  return { mid: res.ts ?? null, error: null, retryable: false };
}

/** Best-effort conversations.join on every bound channel id — the Events API
 *  only delivers messages from channels the bot is a member of. Private
 *  channels can't be self-joined (Slack requires a member invite); the
 *  failures go back to the caller to surface as a hint. */
export async function joinBoundSlackChannels(
  botToken: string,
  channelIds: string[],
): Promise<{ failed: { id: string; error: string }[] }> {
  const failed: { id: string; error: string }[] = [];
  for (const id of channelIds) {
    const r = await slackApi(botToken, 'conversations.join', { channel: id }).catch(
      () => ({ ok: false, error: 'request_failed' }) as { ok: boolean; error?: string },
    );
    // already_in_channel is a success for our purposes
    if (!r.ok && r.error !== 'already_in_channel') {
      failed.push({ id, error: r.error ?? 'unknown' });
    }
  }
  return { failed };
}

/** YAML manifest for the manual (BYO) Slack app — the customer creates it at
 *  api.slack.com/apps?create → "from a manifest", then pastes back bot_token
 *  + signing_secret. Events URL is per-channel so inbound lands on exactly
 *  one channel row. */
export function slackAppManifest(apiOrigin: string, channelId: string, appName: string): string {
  const eventsUrl = `${apiOrigin}/slack/ext/${channelId}/events`;
  return `display_information:
  name: ${appName}
  description: AI support agent powered by Janis
features:
  bot_user:
    display_name: ${appName}
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - channels:history
      - groups:history
      - im:history
      - im:write
      - mpim:history
      - app_mentions:read
      - users:read
      - users:read.email
      - channels:join
settings:
  event_subscriptions:
    request_url: ${eventsUrl}
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}
