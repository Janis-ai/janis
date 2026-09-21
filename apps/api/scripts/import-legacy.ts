/**
 * Import legacy (wordhopapi) Messenger bots as hosted Dialogflow agents.
 *
 *   npm run import-legacy -w apps/api -- --file legacy-bots.json [--workspace <id>] [--dry-run]
 *
 * Input is the JSON produced by scripts/export-legacy-bots.mjs — it contains
 * live credentials (page tokens, service-account keys), so keep the file
 * local and delete it when done (it's gitignored).
 *
 * For each bot:
 *   - resolves the FB page via Graph /me with the stored page token
 *   - upserts an agent { hosted, engine:'dialogflow', df project/lang }
 *   - stores the service account as the DIALOGFLOW_SA_JSON agent secret
 *   - upserts a messenger channel bound to the page id
 * Idempotent on metadata.legacy_client_key.
 */
import '../src/loadEnv.js';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, migrateDb } from '../src/db/client.js';
import { agentSecrets, agents, channels, workspaces } from '../src/db/schema.js';
import { encryptSecret } from '../src/lib/secrets.js';

interface LegacyBot {
  name: string;
  client_key: string;
  platform?: string;
  code_lang?: string; // 'chatfuel' | 'manychat' | ...
  df_project?: string;
  df_lang?: string;
  sa_email?: string;
  sa_json?: { client_email?: string; private_key?: string };
  page_token?: string;
  page_id?: string; // legacy fb_app_id — actually the page id
  takeover_from_page_inbox?: boolean;
  takeover_timeout?: number;
  secondary_receiver_id?: string;
  manychat_token?: string;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt('file');
const dryRun = args.includes('--dry-run');
if (!file) {
  console.error('usage: --file legacy-bots.json [--workspace <id>] [--dry-run]');
  process.exit(1);
}

const records = JSON.parse(readFileSync(file, 'utf8')) as LegacyBot[];
const db = await createDb();
await migrateDb(db);

const [ws] = opt('workspace')
  ? await db.select().from(workspaces).where(eq(workspaces.id, opt('workspace')!)).limit(1)
  : await db.select().from(workspaces).limit(1);
if (!ws) {
  console.error('no workspace found');
  process.exit(1);
}
console.log(`workspace: ${ws.name ?? ws.id}`);

const existingAgents = await db.select().from(agents);
const existingChannels = await db.select().from(channels);

let ok = 0;
for (const rec of records) {
  if (!rec.client_key || !rec.df_project || !rec.sa_json?.private_key || !rec.sa_json?.client_email) {
    console.log(`skip ${rec.name}: missing df_project/sa`);
    continue;
  }

  // page id: legacy fb_app_id is the page id (misnamed). Verify the stored
  // page token when present — a dead token still imports (monitoring works,
  // operator reconnects later), just flagged.
  let pageId = rec.page_id;
  let pageName: string | undefined;
  let tokenValid = false;
  if (rec.page_token) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${rec.page_token}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const me = (await res.json()) as { id?: string; name?: string };
      if (res.ok && me.id) {
        pageId = me.id;
        pageName = me.name;
        tokenValid = true;
      }
    } catch {}
  }
  if (!pageId) {
    console.log(`skip ${rec.name}: no page id (dead token + no fb_app_id)`);
    continue;
  }

  // chatfuel/manychat bots reply through their own platform via the
  // /messenger/client/:key/*fallback* endpoints — the webhook just monitors.
  // Other engines answer inbound directly via DF on the webhook path.
  const chatfuelDriven = rec.code_lang === 'chatfuel' || rec.code_lang === 'manychat';
  const config = {
    engine: (chatfuelDriven ? 'monitor' : 'dialogflow') as 'monitor' | 'dialogflow',
    dialogflow: { project: rec.df_project, lang: rec.df_lang ?? 'en' },
    legacy: {
      client_key: rec.client_key,
      ...(rec.code_lang ? { code_lang: rec.code_lang } : {}),
      ...(rec.takeover_timeout ? { takeover_timeout: rec.takeover_timeout } : {}),
    },
    // no Janis greeting — the bot platform owns first contact
    greeting_enabled: false,
  };
  const saJson = JSON.stringify(rec.sa_json);
  const channelCreds = {
    via: 'legacy' as const,
    page_id: pageId,
    access_token: rec.page_token,
    token_invalid: rec.page_token ? !tokenValid : undefined,
    takeover_from_page_inbox: rec.takeover_from_page_inbox,
    takeover_timeout: rec.takeover_timeout,
    secondary_receiver_id: rec.secondary_receiver_id,
    manychat_token: rec.manychat_token,
  };

  console.log(
    `${dryRun ? '[dry] ' : ''}${rec.name} → page ${pageName ?? pageId} (${pageId}) engine:${config.engine} df:${rec.df_project} lang:${rec.df_lang ?? 'en'}${tokenValid ? '' : ' [token dead]'}`,
  );
  if (dryRun) continue;

  let agent = existingAgents.find(
    (a) => (a.metadata as { legacy_client_key?: string })?.legacy_client_key === rec.client_key,
  );
  if (agent) {
    await db.update(agents).set({ name: rec.name, hosted: true, config }).where(eq(agents.id, agent.id));
  } else {
    [agent] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: rec.name,
        hosted: true,
        config,
        metadata: { legacy_client_key: rec.client_key, migrated_from: 'wordhopapi' },
      })
      .returning();
    existingAgents.push(agent);
  }

  const [existingSecret] = await db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.name, 'DIALOGFLOW_SA_JSON')))
    .limit(1);
  const enc = encryptSecret(saJson);
  if (existingSecret) {
    await db.update(agentSecrets).set({ valueEnc: enc, updatedAt: new Date() }).where(eq(agentSecrets.id, existingSecret.id));
  } else {
    await db.insert(agentSecrets).values({ workspaceId: ws.id, agentId: agent.id, name: 'DIALOGFLOW_SA_JSON', valueEnc: enc });
  }

  let channel = existingChannels.find(
    (ch) => (ch.credentials as { page_id?: string })?.page_id === pageId,
  );
  if (channel) {
    await db
      .update(channels)
      .set({ agentId: agent.id, name: pageName ?? rec.name, credentials: channelCreds })
      .where(eq(channels.id, channel.id));
  } else {
    [channel] = await db
      .insert(channels)
      .values({ workspaceId: ws.id, agentId: agent.id, kind: 'messenger', name: pageName ?? rec.name, credentials: channelCreds })
      .returning();
    existingChannels.push(channel);
  }
  ok++;
}
console.log(`done: ${ok}/${records.length} imported`);
process.exit(0);
