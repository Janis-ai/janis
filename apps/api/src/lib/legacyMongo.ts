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
    const doc = await client
      .db()
      .collection('slack_integrations')
      .findOne(
        { team_id: teamId },
        { projection: { access_token: 1, 'bot.bot_access_token': 1 } },
      );
    const botToken = (doc?.bot as { bot_access_token?: string } | undefined)?.bot_access_token;
    return doc?.access_token || botToken ? 'live' : 'none';
  } catch (err) {
    console.error('legacy slack_integrations lookup failed:', err);
    return 'unknown';
  }
}
