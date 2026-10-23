import { env } from '../env.js';
import type { LegacyBotDoc } from './legacyMongo.js';

/**
 * Legacy Dialogflow credential resolution — shared by the Slack team
 * migration (slackMigration) and the per-agent retry endpoint
 * (POST /api/agents/:id/retry-legacy-engine). Order: stored SA key →
 * OAuth-grant refresh → IAM key mint. Returns a human-readable reason on
 * failure so the console can tell the operator exactly what to fix on the
 * legacy side (re-connect Dialogflow on the classic dashboard, then retry).
 */
export interface LegacyBotCreds {
  project?: string;
  saJson?: Record<string, unknown>;
  reason?: string;
}

// dialogflow.service_account.key is an IAM key resource whose privateKeyData
// is the base64-encoded service-account JSON (export-legacy-bots.mjs).
function decodeSaKey(key: string | undefined): Record<string, unknown> | undefined {
  if (!key) return undefined;
  try {
    const parsed = JSON.parse(key) as { privateKeyData?: string };
    if (parsed.privateKeyData) {
      return JSON.parse(Buffer.from(parsed.privateKeyData, 'base64').toString('utf8'));
    }
    return parsed;
  } catch {
    return undefined;
  }
}

// Pre-service-account-era bots carry the owner's Google OAuth grant under
// dialogflow.credentials instead of a stored SA key — wordhopapi refreshed
// it per-call and, on a 403, minted an SA key via IAM. Same move here:
// refresh → serviceAccounts.keys.create on the conventional
// janis-dialogflow@ SA → the minted SA JSON migrates with the bot.
async function mintSaViaOauth(
  project: string | undefined,
  creds: { access_token?: string; refresh_token?: string } | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!project || !env.legacyGoogleClientId || !env.legacyGoogleClientSecret) return undefined;
  let accessToken = creds?.access_token;
  if (creds?.refresh_token) {
    const tok = (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.legacyGoogleClientId,
        client_secret: env.legacyGoogleClientSecret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { access_token?: string } | null;
    accessToken = tok?.access_token ?? accessToken;
  }
  if (!accessToken) return undefined;
  const saEmail = `janis-dialogflow@${project}.iam.gserviceaccount.com`;
  const mint = async (email: string) =>
    ((await fetch(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}/keys`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: '{}',
      },
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { privateKeyData?: string } | null);
  let res = await mint(saEmail);
  if (!res?.privateKeyData) {
    // SA name may predate the convention — list and retry the likeliest one.
    const list = (await fetch(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { accounts?: { email?: string }[] } | null;
    const alt = (list?.accounts ?? [])
      .map((a) => a.email)
      .filter((e): e is string => !!e)
      .find((e) => /dialogflow|janis/i.test(e)) ?? list?.accounts?.[0]?.email;
    if (alt) res = await mint(alt);
  }
  if (!res?.privateKeyData) return undefined;
  try {
    return JSON.parse(Buffer.from(res.privateKeyData, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function resolveLegacyBotCreds(b: LegacyBotDoc): Promise<LegacyBotCreds> {
  const project = b.dialogflow?.agent;
  if (!project) return { reason: 'the legacy bot has no Dialogflow agent configured' };
  const stored = decodeSaKey(b.dialogflow?.service_account?.key);
  if (stored) return { project, saJson: stored };
  const minted = await mintSaViaOauth(project, b.dialogflow?.credentials);
  if (minted) return { project, saJson: minted };
  return {
    project,
    reason: b.dialogflow?.credentials
      ? 'the bot owner\'s stored Google grant is revoked — re-connect Dialogflow on the legacy dashboard, then retry'
      : 'no service-account key or OAuth grant on the legacy bot — re-connect Dialogflow on the legacy dashboard, then retry',
  };
}
