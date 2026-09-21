/**
 * Import legacy wordhop-slack teams into slack_installations.
 *
 *   npm run migrate-slack-teams -w apps/api -- --file slack-integrations.json [--apply]
 *
 * Input is the JSON produced by wordhop-slack's scripts/slack-migration.js
 * `export` (contains live bot tokens — keep the file local, it's gitignored).
 *
 * For each integration:
 *   - workspace = majority owner of its bot_subscriptions client_keys
 *     (agents.metadata->>'legacy_client_key'), falling back to the installer's
 *     email → users row
 *   - upserts slack_installations on teamId with migrated: true, which tells
 *     the /slack fan-out to stop forwarding that team to wordhop-slack
 *   - writes migrated-teams.json — feed it to `slack-migration.js mark` in
 *     wordhop-slack, then `heroku restart -a wordhop-slack`, so legacy stops
 *     respawning RTM connections and drops the team's ingest traffic
 *
 * Dry-run unless --apply. Idempotent.
 */
import '../src/loadEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb, migrateDb } from '../src/db/client.js';
import { agents, slackInstallations, users } from '../src/db/schema.js';
import { slackApi } from '../src/lib/slack.js';

interface LegacyIntegration {
  team_id: string;
  team_domain?: string | null;
  user_id?: string | null; // installer slack user id — email resolved via users.info
  bot_user_id?: string | null;
  bot_access_token: string;
  client_keys: string[];
  error?: string | null;
  already_migrated?: boolean;
  paying?: boolean;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt('file');
const apply = args.includes('--apply');
if (!file) {
  console.error('usage: --file slack-integrations.json [--apply]');
  process.exit(1);
}

const integrations = JSON.parse(readFileSync(file, 'utf8')) as LegacyIntegration[];
const db = await createDb();
await migrateDb(db);

// Load the client_key → workspace map once — most of the 6k+ integrations are
// dead trials whose keys won't intersect anything we imported.
const agentRows = await db
  .select({ workspaceId: agents.workspaceId, key: sql<string>`${agents.metadata}->>'legacy_client_key'` })
  .from(agents)
  .where(sql`${agents.metadata}->>'legacy_client_key' is not null`);
const wsByKey = new Map(agentRows.map((r) => [r.key, r.workspaceId]));

const migratedTeamIds: string[] = [];
const skipped: { team: string; reason: string }[] = [];

for (const integ of integrations) {
  const label = `${integ.team_domain ?? '?'} (${integ.team_id})`;

  // workspace: majority owner of the team's subscribed bots
  const counts = new Map<string, number>();
  for (const k of integ.client_keys) {
    const ws = wsByKey.get(k);
    if (ws) counts.set(ws, (counts.get(ws) ?? 0) + 1);
  }
  const workspaceId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!workspaceId) {
    skipped.push({ team: label, reason: 'no workspace via client_keys' });
    continue;
  }

  // installer: slack user_id → users.info (works on bot:basic tokens) → email
  // → users row. Only called for teams that actually map, so the full export
  // doesn't fan out into thousands of API calls.
  let installer: typeof users.$inferSelect | undefined;
  if (integ.user_id) {
    try {
      const res = await fetch(
        `https://slack.com/api/users.info?user=${encodeURIComponent(integ.user_id)}`,
        { headers: { Authorization: `Bearer ${integ.bot_access_token}` } },
      );
      const info = (await res.json()) as { ok: boolean; user?: { profile?: { email?: string } } };
      const email = info.ok ? info.user?.profile?.email : undefined;
      if (email) {
        [installer] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
      }
    } catch {
      // token dead or Slack hiccup — runtime falls back to any workspace admin
    }
  }

  const [existing] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, integ.team_id))
    .limit(1);

  const matched = [...counts.values()].reduce((a, b) => a + b, 0);
  const note = `${label} → ws ${workspaceId} keys=${matched}/${integ.client_keys.length} installer=${installer?.email ?? '-'}${existing ? ' (update existing)' : ''}`;
  if (!apply) {
    console.log(`DRY  ${note}`);
    migratedTeamIds.push(integ.team_id);
    continue;
  }

  let instId: string;
  let alertChannelId: string | null;
  if (existing) {
    await db
      .update(slackInstallations)
      .set({
        workspaceId,
        botToken: integ.bot_access_token,
        installerUserId: installer?.id ?? existing.installerUserId,
        migrated: true,
      })
      .where(eq(slackInstallations.id, existing.id));
    instId = existing.id;
    alertChannelId = existing.alertChannelId;
  } else {
    const [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId,
        teamId: integ.team_id,
        botToken: integ.bot_access_token,
        installerUserId: installer?.id ?? null,
        migrated: true,
      })
      .returning();
    instId = inst.id;
    alertChannelId = null;
  }

  // Same heuristic as the OAuth install — a migrated team without an alert
  // channel never posts to Slack at all, so pre-pick one (editable in
  // Settings). bot:basic tokens can conversations.list.
  if (!alertChannelId) {
    const chans = await slackApi<{ channels: { id: string; name: string }[] }>(
      integ.bot_access_token,
      'conversations.list',
      { types: 'public_channel,private_channel', limit: 200 },
    ).catch(() => null);
    const pick =
      chans?.ok &&
      (chans.channels.find((ch) => /janis|wordhop|alerts?/i.test(ch.name)) ??
        chans.channels.find((ch) => ch.name === 'general'));
    if (pick) {
      await db
        .update(slackInstallations)
        .set({ alertChannelId: pick.id })
        .where(eq(slackInstallations.id, instId));
      console.log(`     alert channel → #${pick.name}`);
    } else {
      console.log('     no alert channel picked — set it in Settings → Slack');
    }
  }
  console.log(`DONE ${note}`);
  migratedTeamIds.push(integ.team_id);
}

if (skipped.length) {
  console.log('\nskipped:');
  for (const s of skipped) console.log(`  ${s.team} — ${s.reason}`);
}

writeFileSync('migrated-teams.json', JSON.stringify({ team_ids: migratedTeamIds }, null, 2));
console.log(
  `\n${apply ? 'Migrated' : 'Would migrate'} ${migratedTeamIds.length} team(s) → migrated-teams.json` +
    `\nNext: MONGODB_URI=… node scripts/slack-migration.js mark migrated-teams.json   (in wordhop-slack)` +
    `\nThen: heroku restart -a wordhop-slack`,
);
