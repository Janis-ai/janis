/**
 * Seed slack_classic_channels + slack_classic_prefs from the legacy
 * wordhop-slack `channels` collection (botkit mongoStorage docs).
 *
 *   npm run import-classic-channels -w apps/api -- \
 *     --file channels.jsonl [--team T…[,T…]] [--resolve-dm] [--apply]
 *
 * Input is the JSONL produced by `node scripts/slack-migration.js
 * export-channels` in wordhop-slack (one mongo doc per line; a plain JSON
 * array is also accepted). Keep the file local — docs carry session state.
 *
 * Doc split (getChannelsWithJanis semantics):
 *   - is_wordhop_channel/sourceChannel  → slack_classic_channels row
 *     (paused + should_process_transcript preserved verbatim).
 *   - is_training_channel               → slack_classic_channels row with a
 *     `training:<id>` sentinel sourceChannel (legacy docs lack one).
 *   - DM docs (id 'D…', or client_key==WORDHOP_CLIENT_KEY with no channel
 *     flags)                               → slack_classic_prefs:
 *       * `*` row       → dmChannelId
 *       * `__dm__` row  → the doc's persistent fields copied wholesale into
 *         settings (custom_alerts, severities, broadcasting, filtertype,
 *         bot_context…); volatile session keys are dropped.
 *   - everything else (ordinary channels) → skipped: legacy kept the same
 *     stateDefault fields there, but the port scopes shell state to the
 *     member, so there is nothing to carry over.
 *
 * DM docs do not record the member's slack user id — `--resolve-dm` calls
 * conversations.info per unique DM channel id (cached) to recover it.
 * Without the flag those docs are counted and skipped.
 *
 * Dry-run unless --apply. Idempotent on (installation, source_channel) and
 * (installation, slack_user, client_key) upserts.
 */
import '../src/loadEnv.js';
import { readFileSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, migrateDb } from '../src/db/client.js';
import { slackClassicChannels, slackClassicPrefs, slackInstallations } from '../src/db/schema.js';
import { slackApi } from '../src/lib/slack.js';

const WORDHOP_CLIENT_KEY = process.env.WORDHOP_CLIENT_KEY ?? 'wordhop';

// Session/volatile keys that would rot the moment they're imported.
const VOLATILE = new Set([
  '_id', 'id', 'team', 'client_key', 'conversation', 'intent', 'dialog',
  'mid', 'ts', 'user', 'type', 'event', 'actions', 'original_message',
  'callback_id', 'attachments', 'response_url', 'trigger_id', 'channel',
  'message_ts', 'action_ts', 'text', 'token', 'is_archived', 'members',
  'is_im', 'is_group', 'is_channel', 'is_mpim', 'created', 'creator',
]);

interface LegacyDoc {
  id?: string;
  _id?: string;
  team?: string;
  client_key?: string;
  name?: string;
  sourceChannel?: string;
  source_channel?: string;
  source_user?: string;
  source_team?: string;
  lang?: string;
  is_wordhop_channel?: boolean;
  is_training_channel?: boolean;
  paused?: boolean;
  should_process_transcript?: boolean;
  last_message_ts?: string;
  last_agent_ts?: number | string;
  is_archived?: boolean;
  [k: string]: unknown;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt('file');
const apply = args.includes('--apply');
const resolveDm = args.includes('--resolve-dm');
const teamFilter = new Set((opt('team') ?? '').split(',').filter(Boolean));
if (!file) {
  console.error('usage: --file channels.jsonl [--team T…[,T…]] [--resolve-dm] [--apply]');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8').trim();
const docs: LegacyDoc[] = raw.startsWith('[')
  ? (JSON.parse(raw) as LegacyDoc[])
  : raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LegacyDoc);

const db = await createDb();
await migrateDb(db);

// team_id → installation (imported earlier by migrate-slack-teams.ts).
const installs = await db
  .select({ id: slackInstallations.id, teamId: slackInstallations.teamId, botToken: slackInstallations.botToken })
  .from(slackInstallations);
const installByTeam = new Map(installs.map((i) => [i.teamId, i]));

// Slack-side lookup for DM docs: D-channel id → member slack user id.
const dmUserCache = new Map<string, string | null>();
async function dmUserFor(teamId: string, dmChannelId: string): Promise<string | null> {
  const key = `${teamId}:${dmChannelId}`;
  if (dmUserCache.has(key)) return dmUserCache.get(key) ?? null;
  const install = installByTeam.get(teamId);
  if (!install?.botToken) {
    dmUserCache.set(key, null);
    return null;
  }
  const res = await slackApi<{ channel?: { user?: string } }>(
    install.botToken,
    'conversations.info',
    { channel: dmChannelId },
  );
  const user = res.ok && res.channel?.user ? res.channel.user : null;
  dmUserCache.set(key, user);
  return user;
}

const stats = {
  transcripts: 0,
  training: 0,
  memberDms: 0,
  dmUnresolved: 0,
  ordinarySkipped: 0,
  archivedSkipped: 0,
  noInstall: 0,
  errors: 0,
};

for (const d of docs) {
  const docId = String(d.id ?? d._id ?? '');
  const teamId = d.team ?? '';
  if (!docId) continue;
  if (teamFilter.size && !teamFilter.has(teamId)) continue;
  const install = installByTeam.get(teamId);
  if (!install) {
    stats.noInstall++;
    continue;
  }
  if (d.is_archived === true && d.is_wordhop_channel !== true) {
    stats.archivedSkipped++;
    continue;
  }

  const sourceChannel = d.sourceChannel ?? d.source_channel;
  const isWordhop = d.is_wordhop_channel === true || sourceChannel != null;
  const isTraining = d.is_training_channel === true;
  const isMemberDm =
    docId.startsWith('D') ||
    (d.client_key === WORDHOP_CLIENT_KEY && !isWordhop && !isTraining);

  try {
    if (isWordhop || isTraining) {
      const src = sourceChannel ?? `training:${docId}`;
      const values = {
        installationId: install.id,
        sourceChannel: String(src),
        slackChannelId: docId,
        name: String(d.name ?? docId),
        clientKey: d.client_key ?? null,
        sourceUser: d.source_user ?? null,
        team: teamId || null,
        sourceTeam: d.source_team ?? null,
        lang: d.lang ?? null,
        isWordhopChannel: d.is_wordhop_channel === true || sourceChannel != null,
        isTrainingChannel: isTraining,
        paused: d.paused === true,
        shouldProcessTranscript: d.should_process_transcript === true,
        lastMessageTs: d.last_message_ts ?? null,
        lastAgentTs:
          d.last_agent_ts != null && !Number.isNaN(Number(d.last_agent_ts))
            ? new Date(Number(d.last_agent_ts) * (String(d.last_agent_ts).length > 11 ? 1 : 1000))
            : null,
      };
      if (apply) {
        await db
          .insert(slackClassicChannels)
          .values(values as any)
          .onConflictDoUpdate({
            target: [slackClassicChannels.installationId, slackClassicChannels.sourceChannel],
            set: values as any,
          });
      }
      if (isTraining) stats.training++;
      else stats.transcripts++;
    } else if (isMemberDm) {
      let slackUserId = (d.source_user as string) ?? null;
      if (!slackUserId && resolveDm) slackUserId = await dmUserFor(teamId, docId);
      if (!slackUserId) {
        stats.dmUnresolved++;
        continue;
      }
      // Copy persistent doc fields verbatim into the __dm__ settings blob.
      const settings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) {
        if (!VOLATILE.has(k) && v !== undefined) settings[k] = v;
      }
      if (apply) {
        // '*' wildcard row carries the DM channel id.
        await db
          .insert(slackClassicPrefs)
          .values({ installationId: install.id, slackUserId, clientKey: '*', dmChannelId: docId, settings: {} })
          .onConflictDoUpdate({
            target: [slackClassicPrefs.installationId, slackClassicPrefs.slackUserId, slackClassicPrefs.clientKey],
            set: { dmChannelId: docId },
          });
        const [existing] = await db
          .select()
          .from(slackClassicPrefs)
          .where(
            and(
              eq(slackClassicPrefs.installationId, install.id),
              eq(slackClassicPrefs.slackUserId, slackUserId),
              eq(slackClassicPrefs.clientKey, '__dm__'),
            ),
          )
          .limit(1);
        if (existing) {
          await db.update(slackClassicPrefs).set({ settings }).where(eq(slackClassicPrefs.id, existing.id));
        } else {
          await db.insert(slackClassicPrefs).values({
            installationId: install.id,
            slackUserId,
            clientKey: '__dm__',
            settings,
          });
        }
      }
      stats.memberDms++;
    } else {
      stats.ordinarySkipped++;
    }
  } catch (e) {
    stats.errors++;
    console.error(`doc ${docId}:`, (e as Error).message);
  }
}

console.log(
  `${apply ? 'APPLIED' : 'DRY-RUN'} — transcripts:${stats.transcripts} ` +
    `training:${stats.training} memberDms:${stats.memberDms} ` +
    `dmUnresolved:${stats.dmUnresolved} ordinarySkipped:${stats.ordinarySkipped} ` +
    `archivedSkipped:${stats.archivedSkipped} noInstall:${stats.noInstall} errors:${stats.errors}`,
);
