/**
 * Sync the real Janis Slack app (A15NCEA7K) manifest with what the new API
 * needs — OAuth scopes, event subscriptions, interactivity + OAuth URLs —
 * via the apps.manifest.* tooling APIs.
 *
 *   SLACK_CONFIG_TOKEN=xapp-... npx tsx scripts/slack-manifest-sync.ts            # dry-run diff
 *   SLACK_CONFIG_TOKEN=xapp-... npx tsx scripts/slack-manifest-sync.ts --apply    # write it
 *
 * A configuration token is required (xapp-…, 12h TTL). Generate one at
 * https://api.slack.com/apps/A15NCEA7K → Basic Information → Configuration
 * Tokens → Generate Token. Do NOT commit it.
 *
 * Merge rules:
 *   - bot scopes: union of existing + required (never removes)
 *   - redirect_urls: union (never removes)
 *   - bot_events: union (never removes)
 *   - request URLs: REPLACED with ours — legacy surfaces keep working via the
 *     interactivity fan-out (/slack/interactions → wordhop-slack) and the
 *     legacy RTM bot (events were never its input anyway)
 *   - slash_commands: UNTOUCHED — they keep pointing at slack.janis.ai until
 *     the new API implements them
 *   - socket_mode, token_rotation, org_deploy: UNTOUCHED
 */

/// <reference types="node" />

export {};

const APP_ID = process.env.SLACK_APP_ID ?? 'A15NCEA7K';
const API_ORIGIN = process.env.API_ORIGIN ?? 'https://app.janis.ai';
const TOKEN = process.env.SLACK_CONFIG_TOKEN;
const APPLY = process.argv.includes('--apply');

// Scopes the new API needs. History scopes are required companions to the
// message.* bot events — without them Slack rejects the subscription.
const REQUIRED_BOT_SCOPES = [
  'chat:write',
  'chat:write.public',
  'chat:write.customize',
  'channels:read',
  'channels:manage',
  'channels:join',
  'channels:history',
  'groups:read',
  'groups:write',
  'groups:history',
  'im:write',
  'im:history',
  'mpim:history',
  'users:read',
  'users:read.email',
];

const REQUIRED_BOT_EVENTS = [
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
];

const REDIRECT_URL = `${API_ORIGIN}/slack/oauth/callback`;
const EVENTS_URL = `${API_ORIGIN}/slack/events`;
const INTERACTIONS_URL = `${API_ORIGIN}/slack/interactions`;

interface Manifest {
  oauth_config?: {
    redirect_urls?: string[];
    scopes?: { bot?: string[]; user?: string[] };
  };
  settings?: {
    event_subscriptions?: { request_url?: string; bot_events?: string[] };
    interactivity?: { is_enabled?: boolean; request_url?: string };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function slackApi(method: string, params: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

if (!TOKEN) {
  console.error('SLACK_CONFIG_TOKEN (xapp-…) is required. Generate at https://api.slack.com/apps/' + APP_ID);
  process.exit(1);
}

const { manifest } = (await slackApi('apps.manifest.export', { app_id: APP_ID })) as unknown as {
  manifest: Manifest;
};

const before = JSON.parse(JSON.stringify(manifest)) as Manifest;
const m = manifest;

m.oauth_config ??= {};
m.oauth_config.scopes ??= {};
m.settings ??= {};

const existingScopes = new Set(m.oauth_config.scopes.bot ?? []);
m.oauth_config.scopes.bot = [
  ...existingScopes,
  'commands', // required by the app's existing slash commands
  ...REQUIRED_BOT_SCOPES.filter((s) => !existingScopes.has(s)),
];

// v1-era leftovers fail modern validation — translate or drop:
//   commands                → moved to bot scopes above
//   bot                     → v2 expresses it via features.bot_user
//   chat:write:user         → user scope 'chat:write'
//   files:write:user        → user scope 'files:write'
const userScopes = (m.oauth_config.scopes.user ?? [])
  .filter((s) => s !== 'bot' && s !== 'commands')
  .map((s) => (s === 'chat:write:user' ? 'chat:write' : s === 'files:write:user' ? 'files:write' : s));
m.oauth_config.scopes.user = [...new Set(userScopes)];

// http:// redirect URLs are rejected — the https equivalents already exist
const existingRedirects = new Set(
  (m.oauth_config.redirect_urls ?? []).filter((u) => u.startsWith('https://')),
);
if (!existingRedirects.has(REDIRECT_URL)) {
  m.oauth_config.redirect_urls = [...existingRedirects, REDIRECT_URL];
}

const ev = (m.settings.event_subscriptions ??= {});
const existingEvents = new Set(ev.bot_events ?? []);
ev.request_url = EVENTS_URL;
ev.bot_events = [...existingEvents, ...REQUIRED_BOT_EVENTS.filter((e) => !existingEvents.has(e))];

// Merge — legacy still owns message_menu_options_url (wordhopapi /intents)
m.settings.interactivity = {
  ...m.settings.interactivity,
  is_enabled: true,
  request_url: INTERACTIONS_URL,
};

const diff = (label: string, b: unknown, a: unknown) => {
  if (JSON.stringify(b) !== JSON.stringify(a)) {
    console.log(`\n${label}:`);
    console.log(`  before: ${JSON.stringify(b)}`);
    console.log(`  after:  ${JSON.stringify(a)}`);
  }
};

console.log(`Slack app ${APP_ID} manifest sync → ${API_ORIGIN}\n`);
diff('bot scopes', before.oauth_config?.scopes?.bot, m.oauth_config.scopes.bot);
diff('user scopes', before.oauth_config?.scopes?.user, m.oauth_config.scopes.user);
diff('redirect_urls', before.oauth_config?.redirect_urls, m.oauth_config.redirect_urls);
diff('event_subscriptions', before.settings?.event_subscriptions, m.settings.event_subscriptions);
diff('interactivity', before.settings?.interactivity, m.settings.interactivity);

const slashCount = ((m as { features?: { slash_commands?: unknown[] } }).features?.slash_commands ?? []).length;
if (slashCount) console.log(`\n${slashCount} slash command(s) left untouched (still point at legacy slack.janis.ai).`);

if (JSON.stringify(before) === JSON.stringify(m)) {
  console.log('\nAlready in sync — nothing to do.');
  process.exit(0);
}

// Loud warning if events were previously pointed elsewhere — repointing
// diverts that traffic (fine for RTM-era wordhop-slack, but worth seeing).
const oldEventsUrl = before.settings?.event_subscriptions?.request_url;
if (oldEventsUrl && oldEventsUrl !== EVENTS_URL) {
  console.log(`\n⚠️  event_subscriptions.request_url was ${oldEventsUrl} — repointing diverts those events to the new API.`);
}

// Preflight — update rejects the whole manifest on any invalid field
const v = await slackApi('apps.manifest.validate', {
  app_id: APP_ID,
  manifest: JSON.stringify(m),
});
if (!v.ok) {
  console.error('\nValidation failed:');
  console.error(JSON.stringify(v.errors, null, 2));
  process.exit(1);
}
console.log('\nValidation: clean.');

if (!APPLY) {
  console.log('Dry run — pass --apply to write.');
  process.exit(0);
}

const updated = await slackApi('apps.manifest.update', {
  app_id: APP_ID,
  manifest: JSON.stringify(m),
});
console.log('\nApplied.');
// True when scope changes mean existing installs must re-authorize to get the
// new permissions — expected here since we add scopes. Legacy installs keep
// working on their current tokens; re-auth is only needed for the new scopes.
if (updated.permissions_updated) {
  console.log(
    '⚠️  permissions_updated: existing installs need re-authorization to gain the new scopes (their current tokens keep working).',
  );
}
