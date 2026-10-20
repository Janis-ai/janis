// Port of transcript_api.js getTranscriptChannel — j-channel provisioning:
// name → create → invite bot → creator leaves → registry save, with
// merge/unarchive on re-contact and duplicate-name handling.
// Legacy creates channels with the installer's USER token (channel owned by a
// human, not the app) — we use installerUserToken for the same effect; bot
// token falls back when no user token was captured.

import type { Db } from '../../db/client.js';
import type { ClassicChannelRow, ClassicCtx, Installation, LegacyEvent } from './types.js';
import {
  getClassicChannelBySource,
  getClassicChannelByName,
  saveClassicChannel,
} from './store.js';
import { suggestedChannelName, getUserName } from './profiles.js';

// Serializes provisioning per (sourceChannel, team) — channelQueue port.
const channelQueue = new Map<string, Promise<ClassicChannelRow | null>>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface Ctx extends ClassicCtx {
  sourceChannel: string;
  clientKey?: string;
  json: LegacyEvent;
  type: string; // 'chatMessage' | 'botMessage' | 'takeOver' | alert types
}

function userToken(install: Installation): string {
  const cfg = install.classicConfig as { userToken?: string };
  return install.installerUserToken ?? cfg.userToken ?? install.botToken;
}

// saveTranscriptChannel — registry doc update (merge on re-contact).
async function saveTranscriptChannel(ctx: Ctx, slackChannel: any): Promise<void> {
  const { db, install, sourceChannel, clientKey, json, type } = ctx;
  const sourceUser = (json.user_profile as any)?.id;
  const existing = await getClassicChannelBySource(db, install.id, sourceChannel);
  const team =
    typeof json.team === 'object' && json.team ? json.team.id : (json.team as string | undefined);

  let lang = existing?.lang;
  for (const m of (json.messages as any[]) ?? []) {
    let response = m.reply;
    if (typeof response === 'string') {
      try {
        response = JSON.parse(response);
      } catch {
        response = null;
      }
    }
    const l = response?.result?.lang;
    if (l) {
      lang = l;
      break;
    }
  }

  const values: Partial<ClassicChannelRow> = {
    installationId: install.id,
    sourceChannel: String(sourceChannel),
    slackChannelId: slackChannel.id,
    name: slackChannel.name,
    clientKey: clientKey ?? existing?.clientKey,
    sourceUser: sourceUser ? String(sourceUser) : existing?.sourceUser,
    team: install.teamId,
    sourceTeam:
      (typeof json.sourceTeam === 'object' && json.sourceTeam ? json.sourceTeam.id : json.sourceTeam as string | undefined) ??
      team ??
      existing?.sourceTeam,
    lang: lang ?? null,
    isWordhopChannel: true,
    trainingEnabled: json.trainingEnabled === true || existing?.trainingEnabled === true,
    lastAgentTs:
      type === 'chatMessage' || type === 'takeOver' ? new Date() : existing?.lastAgentTs,
  };
  await saveClassicChannel(db, values as any);
}

// mergeAndSave — re-contact on an existing j-channel: refresh info, unarchive
// if needed, ensure bot membership.
async function mergeAndSave(ctx: Ctx, existing: ClassicChannelRow): Promise<ClassicChannelRow | null> {
  const { install } = ctx;
  const token = install.botToken;
  const uToken = userToken(install);
  const info = await ctx.api<{ channel?: any }>(token, 'conversations.info', {
    channel: existing.slackChannelId,
  });
  if (!info.ok && info.error === 'channel_not_found') {
    // Legacy deletes the doc and recreates.
    const fresh = await getChannelNameAndCreateNew(ctx);
    return fresh;
  }
  let channel = info.channel ?? { id: existing.slackChannelId, name: existing.name };
  if (channel.is_archived) {
    await ctx.api(uToken, 'conversations.unarchive', { channel: channel.id });
    const cfg = install.classicConfig as { botUserId?: string };
    const botUserId = cfg.botUserId;
    if (botUserId) {
      const members = await ctx.api<{ members?: string[] }>(token, 'conversations.members', {
        channel: channel.id,
      });
      if (!members.members?.includes(botUserId)) {
        await ctx.api(uToken, 'conversations.invite', {
          channel: channel.id,
          users: botUserId,
        });
        await ctx.api(uToken, 'conversations.leave', { channel: channel.id });
      }
    }
    const refreshed = await ctx.api<{ channel?: any }>(token, 'conversations.info', {
      channel: channel.id,
    });
    if (refreshed.ok && refreshed.channel) channel = refreshed.channel;
  }
  await saveTranscriptChannel(ctx, channel);
  return { ...existing, slackChannelId: channel.id, name: channel.name ?? existing.name };
}

// getChannelName — Slack-sourced channels enrich via team/users APIs; we only
// need the profile-driven name for customer transcripts.
function getChannelName(ctx: Ctx): string {
  const obj = suggestedChannelName(ctx.sourceChannel, ctx.json.user_profile);
  return obj.name;
}

// duplicateNameHandler — name_taken → same sourceChannel? merge : suffix -N.
async function duplicateNameHandler(
  ctx: Ctx,
  channelName: string,
  label: string,
  index: number,
  stopLookingForDupe = false,
): Promise<ClassicChannelRow | null> {
  const obj = await getClassicChannelByName(ctx.db, ctx.install.id, label);
  if (obj && obj.sourceChannel === ctx.sourceChannel) {
    return mergeAndSave(ctx, obj);
  }
  if (obj == null && !stopLookingForDupe) {
    await sleep(1000);
    return duplicateNameHandler(ctx, channelName, label, index, true);
  }
  const suffix = `-${index}`;
  const res = channelName.substr(0, 21 - suffix.length);
  label = res + suffix;
  index = index + Math.floor(Math.random() * 99) + 1;
  return createChannel(ctx, channelName, label, index);
}

// createChannel — create via user token, invite bot user, creator leaves,
// save registry row.
async function createChannel(
  ctx: Ctx,
  channelName: string,
  label: string,
  index: number,
): Promise<ClassicChannelRow | null> {
  const { install } = ctx;
  channelName = channelName.substr(0, 21);
  label = label.substr(0, 21);
  const uToken = userToken(install);
  let created = await ctx.api<{ channel?: any }>(uToken, 'conversations.create', {
    name: label,
  });
  // Fresh installs only carry user_scope=chat:write — legacy relied on the
  // old app's broader user grants. Fall back to the bot token so channel
  // creation still works when the installer token lacks channels:manage.
  if (!created.ok && created.error === 'missing_scope' && uToken !== install.botToken) {
    created = await ctx.api<{ channel?: any }>(install.botToken, 'conversations.create', {
      name: label,
    });
  }
  if (!created.ok || !created.channel) {
    if (created.error === 'name_taken') {
      return duplicateNameHandler(ctx, channelName, label, index);
    }
    return null;
  }
  const channel = created.channel;
  const cfg = install.classicConfig as { botUserId?: string };
  if (cfg.botUserId) {
    await ctx.api(uToken, 'conversations.invite', {
      channel: channel.id,
      users: cfg.botUserId,
    });
    await ctx.api(uToken, 'conversations.leave', { channel: channel.id });
  }
  const info = await ctx.api<{ channel?: any }>(install.botToken, 'conversations.info', {
    channel: channel.id,
  });
  const final = info.ok && info.channel ? info.channel : channel;
  await saveTranscriptChannel(ctx, final);
  return {
    id: '',
    installationId: install.id,
    sourceChannel: ctx.sourceChannel,
    slackChannelId: final.id,
    name: final.name ?? label,
    clientKey: ctx.clientKey ?? null,
    sourceUser: null,
    team: install.teamId,
    sourceTeam: null,
    lang: null,
    isWordhopChannel: true,
    isTrainingChannel: false,
    trainingEnabled: false,
    lastMessageTs: null,
    lastAgentTs: null,
    paused: false,
    shouldProcessTranscript: false,
    createdAt: new Date(),
  } as ClassicChannelRow;
}

async function getChannelNameAndCreateNew(ctx: Ctx): Promise<ClassicChannelRow | null> {
  const name = getChannelName(ctx);
  return createChannel(ctx, name, name, 1);
}

async function init(ctx: Ctx): Promise<ClassicChannelRow | null> {
  const existing = await getClassicChannelBySource(ctx.db, ctx.install.id, ctx.sourceChannel);
  if (existing) return mergeAndSave(ctx, existing);
  return getChannelNameAndCreateNew(ctx);
}

// queueTranscriptChannel gate + serialized init — returns the j-channel or
// null when gated out (not on pro plan / no facebook connection / bad source).
export async function getTranscriptChannel(
  ctx: Ctx & { pro: boolean; isMessengerNoFb?: boolean },
): Promise<ClassicChannelRow | null> {
  const key = `${ctx.install.id}:${ctx.sourceChannel}`;
  const prior = channelQueue.get(key) ?? Promise.resolve(null);
  const run = prior.then(async () => {
    // getParamsForTranscriptChannel gate (verbatim order):
    if (!ctx.pro) return null; // "not on pro plan"
    if (ctx.isMessengerNoFb) return null; // "no facebook connection"
    return init(ctx);
  });
  const tracked = run.finally(() => {
    if (channelQueue.get(key) === tracked) channelQueue.delete(key);
  });
  channelQueue.set(key, tracked);
  return run;
}

// The channel_update mirror equivalent — legacy stores paused +
// should_process_transcript on the source doc; the classic channel row
// mirrors it so pause/resume buttons render the right variant.
export async function syncClassicChannelState(
  db: Db,
  installationId: string,
  sourceChannel: string,
  state: { paused?: boolean; shouldProcessTranscript?: boolean; lastMessageTs?: string },
): Promise<void> {
  const existing = await getClassicChannelBySource(db, installationId, sourceChannel);
  if (!existing) return;
  await saveClassicChannel(db, {
    installationId,
    sourceChannel,
    slackChannelId: existing.slackChannelId,
    name: existing.name,
    paused: state.paused ?? existing.paused,
    shouldProcessTranscript:
      state.shouldProcessTranscript ?? existing.shouldProcessTranscript,
    lastMessageTs: state.lastMessageTs ?? existing.lastMessageTs,
  });
}

export { getUserName };
