import { MongoClient } from 'mongodb';
import { env } from '../env.js';

// Read-only handle on the legacy wordhopapi Mongo. The only question the
// new stack needs answered at request time is "does this Slack team still
// run on classic Janis?" — a live slack_integrations doc means its traffic
// must keep fanning out to wordhop-slack (or be cut over deliberately,
// never silently). Heavier imports stay in the file-based scripts.
let client: MongoClient | undefined;
let override: ((teamId: string) => Promise<LegacyTeamState>) | undefined;

/** Test seam — same shape as the real lookup, no Mongo needed. */
export function setLegacyTeamLookup(fn: typeof override): void {
  override = fn;
}

export type LegacyTeamState = 'none' | 'live' | 'unknown';

/** Test seams for the migration-time ops below (same pattern as the
 *  team-state override — no Mongo needed in tests). */
let opsOverride:
  | {
      channels?: (teamId: string) => Promise<Record<string, unknown>[]>;
      mark?: (teamId: string) => Promise<boolean>;
      bots?: (teamId: string) => Promise<LegacyBotDoc[]>;
    }
  | undefined;
export function setLegacyOps(o: typeof opsOverride): void {
  opsOverride = o;
}

/** A legacy `bots` doc slimmed to what migration imports — Dialogflow creds
 *  ride nested under `dialogflow.service_account.key` as an IAM key resource
 *  whose privateKeyData is the base64 SA JSON (export-legacy-bots.mjs). */
export interface LegacyBotDoc {
  name?: string;
  client_key?: string;
  code_lang?: string;
  takeover_timeout?: number;
  dialogflow?: {
    agent?: string;
    agent_object?: { defaultLanguageCode?: string };
    service_account?: { email?: string; key?: string };
  };
}

/** The team's actively-subscribed bots: slack_integrations.bot_subscriptions
 *  client_keys resolved against the `bots` collection. */
export async function legacyTeamBots(teamId: string): Promise<LegacyBotDoc[]> {
  if (opsOverride?.bots) return opsOverride.bots(teamId);
  if (!env.legacyMongoUri) return [];
  client ??= await MongoClient.connect(env.legacyMongoUri, {
    serverSelectionTimeoutMS: 2500,
  });
  const db = client.db();
  const integ = await db
    .collection('slack_integrations')
    .findOne({ 'slack_params.team_id': teamId }, { projection: { bot_subscriptions: 1 } });
  const keys = ((integ?.bot_subscriptions as { client_key?: string; active?: boolean }[]) ?? [])
    .filter((s) => s.active !== false)
    .map((s) => s.client_key)
    .filter((k): k is string => !!k);
  if (!keys.length) return [];
  return (await db
    .collection('bots')
    .find({ client_key: { $in: keys } })
    .toArray()) as unknown as LegacyBotDoc[];
}

/** The botkit `channels` collection docs for one team — transcript/training
 *  channel state and member-DM prefs the classic-mode install reseeds. */
export async function legacyChannelDocs(teamId: string): Promise<Record<string, unknown>[]> {
  if (opsOverride?.channels) return opsOverride.channels(teamId);
  if (!env.legacyMongoUri) return [];
  client ??= await MongoClient.connect(env.legacyMongoUri, {
    serverSelectionTimeoutMS: 2500,
  });
  return (await client
    .db()
    .collection('channels')
    .find({ team: teamId })
    .toArray()) as Record<string, unknown>[];
}

/** Flip `migrated: true` on the team's slack_integrations doc — the signal
 *  wordhop-slack reads (per-event drop + spawnStoredBots filter) to stand
 *  down for the team. Returns false when no doc exists or Mongo is
 *  unconfigured. */
export async function markLegacyTeamMigrated(teamId: string): Promise<boolean> {
  if (opsOverride?.mark) return opsOverride.mark(teamId);
  if (!env.legacyMongoUri) return false;
  client ??= await MongoClient.connect(env.legacyMongoUri, {
    serverSelectionTimeoutMS: 2500,
  });
  const r = await client
    .db()
    .collection('slack_integrations')
    .updateOne({ 'slack_params.team_id': teamId }, { $set: { migrated: true } });
  return r.matchedCount > 0;
}

/**
 * 'live'   — Mongo has a slack_integrations doc with a usable token.
 * 'none'   — no doc, a tokenless doc, or no LEGACY_MONGODB_URI configured.
 * 'unknown'— the lookup itself failed. Callers must fail safe here: parking
 *            the grant beats treating a real legacy team as new, since a
 *            new-mode row silently severs its classic traffic.
 */
export async function legacyTeamState(teamId: string): Promise<LegacyTeamState> {
  try {
    if (override) return await override(teamId);
    if (!env.legacyMongoUri) return 'none';
    client ??= await MongoClient.connect(env.legacyMongoUri, {
      serverSelectionTimeoutMS: 2500,
    });
    // Legacy docs nest the OAuth grant under `slack_params` — there is no
    // top-level team_id/access_token on any doc (verified 2026-10-23:
    // 0/17,296). Querying the flat paths silently returned 'none' for every
    // classic team and let installs sever them unguarded.
    const doc = await client
      .db()
      .collection('slack_integrations')
      .findOne(
        { 'slack_params.team_id': teamId },
        {
          projection: {
            'slack_params.access_token': 1,
            'slack_params.bot.bot_access_token': 1,
            migrated: 1,
          },
        },
      );
    if (doc?.migrated) return 'none'; // stood down via slack-migration mark
    const sp = doc?.slack_params as
      | { access_token?: string; bot?: { bot_access_token?: string } }
      | undefined;
    return sp?.access_token || sp?.bot?.bot_access_token ? 'live' : 'none';
  } catch (err) {
    console.error('legacy slack_integrations lookup failed:', err);
    return 'unknown';
  }
}
