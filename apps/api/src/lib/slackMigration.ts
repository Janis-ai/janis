import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import {
  agentSecrets,
  agents,
  slackClassicChannels,
  slackClassicPrefs,
  slackInstallations,
  slackMemberLinks,
} from '../db/schema.js';
import { encryptSecret } from './secrets.js';
import { inviteWorkspaceMembers, listSlackChannels, slackApi } from './slack.js';
import { legacyChannelDocs, legacyTeamBots, markLegacyTeamMigrated } from './legacyMongo.js';
import { resolveLegacyBotCreds } from './legacyDfCreds.js';

/**
 * Self-serve classic→new Slack migration. Replaces the assisted runbook
 * (migrate-slack-teams + import-classic-channels + `mark` + heroku restart):
 *   1. bind the parked OAuth grant as a `migrated` installation
 *   2. flag the Mongo slack_integrations doc — wordhop-slack reads it
 *      per-event and stands down within the request that lands it
 *   3. reseed slack_classic_channels + slack_classic_prefs from the legacy
 *      botkit `channels` docs (same mapping as import-classic-channels.ts)
 *   4. pre-pick an alert channel so classic alerts have somewhere to land
 *
 * Runs synchronously inside POST /api/slack/claim — a team's channel docs
 * are a few hundred rows at most and the Slack calls are paged, so the
 * whole thing lands in seconds. A thrown step leaves the pending row in
 * place for the assisted fallback.
 */
export interface MigrationPending {
  teamId: string;
  teamName: string | null;
  botToken: string;
  installerSlackUserId: string | null;
  installerUserToken: string | null;
}

export interface MigrationStats {
  transcripts: number;
  training: number;
  memberDms: number;
  dmUnresolved: number;
  agents: number;
  agentsNoEngine: number;
  marked: boolean;
  alertChannel: string | null;
}

const WORDHOP_CLIENT_KEY = process.env.WORDHOP_CLIENT_KEY ?? 'wordhop';

// Session/volatile keys that would rot the moment they're imported — same
// list as scripts/import-classic-channels.ts.
const VOLATILE = new Set([
  '_id', 'id', 'team', 'client_key', 'conversation', 'intent', 'dialog',
  'mid', 'ts', 'user', 'type', 'event', 'actions', 'original_message',
  'callback_id', 'attachments', 'response_url', 'trigger_id', 'channel',
  'message_ts', 'action_ts', 'text', 'token', 'is_archived', 'members',
  'is_im', 'is_group', 'is_channel', 'is_mpim', 'created', 'creator',
]);

export async function runSlackMigration(
  db: Db,
  pending: MigrationPending,
  workspaceId: string,
  installerUserId: string | null,
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    transcripts: 0,
    training: 0,
    memberDms: 0,
    dmUnresolved: 0,
    agents: 0,
    agentsNoEngine: 0,
    marked: false,
    alertChannel: null,
  };

  // 1 — bind. An existing row keeps its token (it may already carry the
  // granular scope set from a fresh install) and just flips migrated.
  const [existing] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, pending.teamId))
    .limit(1);
  let inst;
  if (existing) {
    await db
      .update(slackInstallations)
      .set({ workspaceId, migrated: true, installerUserId: installerUserId ?? existing.installerUserId })
      .where(eq(slackInstallations.id, existing.id));
    inst = { ...existing, workspaceId, migrated: true };
  } else {
    [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId,
        teamId: pending.teamId,
        teamName: pending.teamName,
        botToken: pending.botToken,
        installerUserId,
        installerSlackUserId: pending.installerSlackUserId,
        installerUserToken: pending.installerUserToken,
        migrated: true,
      })
      .returning();
    if (pending.installerSlackUserId && installerUserId) {
      await db
        .insert(slackMemberLinks)
        .values({
          installationId: inst.id,
          slackUserId: pending.installerSlackUserId,
          userId: installerUserId,
        })
        .onConflictDoNothing();
    }
  }

  // 2 — stand wordhop-slack down for the team before anything else heavy:
  // its per-event migrated check drops traffic within seconds of the flip.
  stats.marked = await markLegacyTeamMigrated(pending.teamId);

  // 2b — import the team's subscribed bots as legacy-engine agents. Same
  // mapping as import-legacy.ts: DF project + service account ride over
  // intact so agents keep answering on the customer's existing Dialogflow
  // ES brain (convert-hosted is the per-agent opt-in after). A bot with no
  // DF config imports as a monitor — it can escalate but won't answer.
  const bots = await legacyTeamBots(pending.teamId);
  if (bots.length) {
    const wsAgents = await db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
    for (const b of bots) {
      if (!b.client_key) continue;
      // code_lang (chatfuel/manychat) is the *Messenger* driver — on Slack
      // the DF project is always the answering brain, so it doesn't gate.
      const { project, saJson } = await resolveLegacyBotCreds(b);
      const config = {
        engine: (project && saJson ? 'dialogflow' : 'monitor') as 'dialogflow' | 'monitor',
        ...(project ? { dialogflow: { project, lang: b.dialogflow?.agent_object?.defaultLanguageCode ?? 'en' } } : {}),
        legacy: {
          client_key: b.client_key,
          ...(b.code_lang ? { code_lang: b.code_lang } : {}),
          ...(b.takeover_timeout ? { takeover_timeout: b.takeover_timeout } : {}),
        },
        greeting_enabled: false,
      };
      const metadata = { legacy_client_key: b.client_key, migrated_from: 'wordhopapi' };
      let agent = wsAgents.find(
        (a) => (a.metadata as { legacy_client_key?: string })?.legacy_client_key === b.client_key,
      );
      if (agent) {
        await db
          .update(agents)
          .set({ name: b.name ?? agent.name, hosted: true, config, metadata })
          .where(eq(agents.id, agent.id));
      } else {
        [agent] = await db
          .insert(agents)
          .values({ workspaceId, name: b.name ?? b.client_key, hosted: true, config, metadata })
          .returning();
        wsAgents.push(agent);
      }
      if (saJson) {
        const enc = encryptSecret(JSON.stringify(saJson));
        const [secret] = await db
          .select()
          .from(agentSecrets)
          .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.name, 'DIALOGFLOW_SA_JSON')))
          .limit(1);
        if (secret) {
          await db
            .update(agentSecrets)
            .set({ valueEnc: enc, updatedAt: new Date() })
            .where(eq(agentSecrets.id, secret.id));
        } else {
          await db
            .insert(agentSecrets)
            .values({ workspaceId, agentId: agent.id, name: 'DIALOGFLOW_SA_JSON', valueEnc: enc });
        }
      }
      stats.agents++;
      if (config.engine === 'monitor') stats.agentsNoEngine++;
    }
  }

  // 3 — reseed classic channel state from the legacy botkit docs.
  const docs = await legacyChannelDocs(pending.teamId);
  const dmUserCache = new Map<string, string | null>();
  const dmUserFor = async (dmChannelId: string): Promise<string | null> => {
    if (dmUserCache.has(dmChannelId)) return dmUserCache.get(dmChannelId) ?? null;
    const res = await slackApi<{ channel?: { user?: string } }>(
      inst.botToken,
      'conversations.info',
      { channel: dmChannelId },
    ).catch(() => null);
    const user = res?.ok && res.channel?.user ? res.channel.user : null;
    dmUserCache.set(dmChannelId, user);
    return user;
  };

  for (const d of docs) {
    const docId = String(d.id ?? d._id ?? '');
    if (!docId) continue;
    const sourceChannel = (d.sourceChannel ?? d.source_channel) as string | undefined;
    const isWordhop = d.is_wordhop_channel === true || sourceChannel != null;
    const isTraining = d.is_training_channel === true;
    const isMemberDm =
      docId.startsWith('D') ||
      (d.client_key === WORDHOP_CLIENT_KEY && !isWordhop && !isTraining);
    if (d.is_archived === true && d.is_wordhop_channel !== true) continue;

    if (isWordhop || isTraining) {
      const values = {
        installationId: inst.id,
        sourceChannel: String(sourceChannel ?? `training:${docId}`),
        slackChannelId: docId,
        name: String(d.name ?? docId),
        clientKey: (d.client_key as string) ?? null,
        sourceUser: (d.source_user as string) ?? null,
        team: pending.teamId,
        sourceTeam: (d.source_team as string) ?? null,
        lang: (d.lang as string) ?? null,
        isWordhopChannel: isWordhop,
        isTrainingChannel: isTraining,
        paused: d.paused === true,
        shouldProcessTranscript: d.should_process_transcript === true,
        lastMessageTs: (d.last_message_ts as string) ?? null,
        lastAgentTs:
          d.last_agent_ts != null && !Number.isNaN(Number(d.last_agent_ts))
            ? new Date(Number(d.last_agent_ts) * (String(d.last_agent_ts).length > 11 ? 1 : 1000))
            : null,
      };
      await db
        .insert(slackClassicChannels)
        .values(values)
        .onConflictDoUpdate({
          target: [slackClassicChannels.installationId, slackClassicChannels.sourceChannel],
          set: values,
        });
      if (isTraining) stats.training++;
      else stats.transcripts++;
    } else if (isMemberDm) {
      let slackUserId = (d.source_user as string | undefined) ?? null;
      if (!slackUserId) slackUserId = await dmUserFor(docId);
      if (!slackUserId) {
        stats.dmUnresolved++;
        continue;
      }
      const settings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) {
        if (!VOLATILE.has(k) && v !== undefined) settings[k] = v;
      }
      await db
        .insert(slackClassicPrefs)
        .values({ installationId: inst.id, slackUserId, clientKey: '*', dmChannelId: docId, settings: {} })
        .onConflictDoUpdate({
          target: [slackClassicPrefs.installationId, slackClassicPrefs.slackUserId, slackClassicPrefs.clientKey],
          set: { dmChannelId: docId },
        });
      const [prev] = await db
        .select()
        .from(slackClassicPrefs)
        .where(
          and(
            eq(slackClassicPrefs.installationId, inst.id),
            eq(slackClassicPrefs.slackUserId, slackUserId),
            eq(slackClassicPrefs.clientKey, '__dm__'),
          ),
        )
        .limit(1);
      if (prev) {
        await db.update(slackClassicPrefs).set({ settings }).where(eq(slackClassicPrefs.id, prev.id));
      } else {
        await db.insert(slackClassicPrefs).values({
          installationId: inst.id,
          slackUserId,
          clientKey: '__dm__',
          settings,
        });
      }
      stats.memberDms++;
    }
  }

  // 4 — pre-pick an alert channel so classic alerts land somewhere.
  if (!inst.alertChannelId) {
    const { channels: chans, complete } = await listSlackChannels(inst.botToken);
    const pick =
      chans.find((ch) => ch.name === 'janis-alerts') ??
      (complete ? chans.find((ch) => /janis/i.test(ch.name)) : undefined) ??
      chans.find((ch) => ch.name === 'general');
    if (pick) {
      await db
        .update(slackInstallations)
        .set({ alertChannelId: pick.id })
        .where(eq(slackInstallations.id, inst.id));
      stats.alertChannel = pick.name;
      void inviteWorkspaceMembers(db, inst, pick.id);
    }
  } else {
    stats.alertChannel = inst.alertChannelId;
  }

  return stats;
}
