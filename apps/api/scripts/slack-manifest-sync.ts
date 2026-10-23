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
 *   - bot scopes: union of existing + required, minus v1-era scope names that
 *     fail modern validation
 *   - user scopes: union of existing + required, same v1 cleanup
 *   - redirect_urls: union (never removes)
 *   - bot_events: union (never removes)
 *   - request URLs: REPLACED with ours — legacy surfaces keep working via the
 *     fan-out to wordhop-slack (events with no install row, non-classic
 *     interactions, and unresolved commands all forward verbatim)
 *   - slash_commands: ALL repoint at /slack/commands — the endpoint serves
 *     classic-mode installs natively and forwards everything else to
 *     wordhop-slack
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
  'commands', // slash command surface (/pause /resume → native, rest → legacy)
  'users:read',
  'users:read.email',
  'app_mentions:read', // required companion to the app_mention bot event
  // Classic-mode extras:
  'im:read',    // conversations.info on D… channels (member DM resolution)
  'files:read', // files.sharedPublicURL for files_uploaded
  'team:read',  // team_join event companion
  // wordhop-slack extras:
  'mpim:read',   // mpim.list
  'files:write', // files.upload / sharedPublicURL as the bot
];

// User-token scopes — wordhop-slack runs conversations.kick/leave/invite/
// replies and chat.postMessage/files.upload as the installer.
const REQUIRED_USER_SCOPES = [
  'chat:write',
  'files:write',
  'channels:manage', // kick/invite/leave on public transcript channels
  'groups:write',    // same on private channels
  'im:write',
  'mpim:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
];

// v1-era scope names that either fail manifest validation outright or map to
// nothing the code actually calls (links:* — no unfurl handlers).
const LEGACY_SCOPE_NAMES = new Set([
  'bot',
  'commands',
  'chat:write:bot',
  'chat:write:user',
  'files:write:user',
  'channels:write',
  'incoming-webhook',
  'identify',
  'read',
  'post',
  'search:read',
  'links:read',
  'links:write',
]);

const REQUIRED_BOT_EVENTS = [
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'app_mention', // @janis → concierge question, answered in-thread
  // Classic-mode workspace sync (slack_bot.js 1275-1458) — dispatched only
  // for mode='classic' installs; new-mode installs ignore them.
  'member_joined_channel',
  'member_left_channel',
  'channel_deleted',
  'channel_rename',
  'channel_created',
  'channel_archive',
  'channel_unarchive',
  'channel_marked',
  'channel_history_changed',
  'team_join',
  'app_uninstalled', // wordhop-slack cleans up install state
  'file_shared',     // files_uploaded / file_shared handlers
];

const REDIRECT_URL = `${API_ORIGIN}/slack/oauth/callback`;
// Legacy OAuth callback — wordhop-slack's own Add-to-Slack flow
// (createOauthEndpoints → /oauth) uses SLACK_REDIRECT_URI, defaulting to the
// slackbot.janis.ai custom domain.
const LEGACY_REDIRECT_URLS = [
  'https://slackbot.janis.ai/oauth',
  'https://wordhop-slack.herokuapp.com/oauth',
];
const EVENTS_URL = `${API_ORIGIN}/slack/events`;
const INTERACTIONS_URL = `${API_ORIGIN}/slack/interactions`;
const COMMANDS_URL = `${API_ORIGIN}/slack/commands`;

// Every command wordhop-slack's slash_command handler understands (see
// src/slack_bot.js controller.on('slash_command')). All point at the new API —
// classic-mode installs are served natively, everything else is forwarded
// verbatim to wordhop-slack.
const REQUIRED_COMMANDS: { command: string; description: string }[] = [
  { command: '/wordhop', description: 'Janis assistant commands' },
  { command: '/pause', description: 'Pause the bot in this channel' },
  { command: '/resume', description: 'Resume the bot in this channel' },
  { command: '/broadcast', description: 'Send a message to all users' },
  { command: '/bot', description: 'Send a message as the bot' },
  { command: '/say', description: 'Send a message as the bot' },
  { command: '/blast', description: 'Broadcast a message' },
  { command: '/pause_s', description: 'Pause the bot in this channel' },
  { command: '/resume_s', description: 'Resume the bot in this channel' },
  { command: '/broadcast_s', description: 'Send a message to all users' },
  { command: '/pause_qa', description: 'Pause the bot in this channel' },
  { command: '/resume_qa', description: 'Resume the bot in this channel' },
  { command: '/bot_s', description: 'Send a message as the bot' },
  { command: '/say_s', description: 'Send a message as the bot' },
];

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
  const data = (await res.json()) as { ok: boolean; error?: string; errors?: unknown; [k: string]: unknown };
  if (!data.ok) {
    const detail = data.errors ? ` ${JSON.stringify(data.errors)}` : '';
    throw new Error(`${method} failed: ${data.error}${detail}`);
  }
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

const existingScopes = new Set(
  (m.oauth_config.scopes.bot ?? []).filter((s) => !LEGACY_SCOPE_NAMES.has(s)),
);
for (const s of REQUIRED_BOT_SCOPES) existingScopes.add(s);
m.oauth_config.scopes.bot = [...existingScopes];

// v1-era leftovers fail modern validation — translate or drop:
//   commands                → moved to bot scopes above
//   bot                     → v2 expresses it via features.bot_user
//   chat:write:user         → user scope 'chat:write'
//   files:write:user        → user scope 'files:write'
//   channels:write          → user scope 'channels:manage'
const userScopes = (m.oauth_config.scopes.user ?? [])
  .filter((s) => !LEGACY_SCOPE_NAMES.has(s) || s === 'chat:write:user' || s === 'files:write:user' || s === 'channels:write')
  .map((s) =>
    s === 'chat:write:user' ? 'chat:write'
    : s === 'files:write:user' ? 'files:write'
    : s === 'channels:write' ? 'channels:manage'
    : s,
  );
const userScopeSet = new Set(userScopes);
for (const s of REQUIRED_USER_SCOPES) userScopeSet.add(s);
m.oauth_config.scopes.user = [...userScopeSet];

// http:// redirect URLs are rejected — the https equivalents already exist.
// Ours goes FIRST: installs that mint no redirect_uri (the Slack directory /
// Marketplace "Add to Slack" button) land on the first registered URL —
// leaving a legacy URL first would route new customers into old Janis.
const existingRedirects = new Set(
  (m.oauth_config.redirect_urls ?? []).filter((u) => u.startsWith('https://')),
);
for (const u of LEGACY_REDIRECT_URLS) existingRedirects.add(u);
existingRedirects.delete(REDIRECT_URL);
m.oauth_config.redirect_urls = [REDIRECT_URL, ...existingRedirects];

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

// Every command the classic handler understands gets registered and points
// at the new API — classic installs are served natively, everything else is
// forwarded verbatim to wordhop-slack.
const features = (m.features ??= {}) as {
  bot_user?: unknown;
  slash_commands?: {
    command?: string;
    url?: string;
    description?: string;
    should_escape?: boolean;
    usage_hint?: string;
  }[];
};
// Bot user must exist for the xoxb token Slack issues on install.
features.bot_user ??= { display_name: 'Janis', always_online: true };
const cmds = (features.slash_commands ??= []);
for (const req of REQUIRED_COMMANDS) {
  const cmd = cmds.find((c) => c.command === req.command);
  if (cmd) {
    cmd.url = COMMANDS_URL;
  } else {
    cmds.push({ command: req.command, url: COMMANDS_URL, description: req.description });
  }
}
for (const cmd of cmds) cmd.should_escape ??= false;

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
diff(
  'slash_commands',
  (before as { features?: { slash_commands?: unknown } }).features?.slash_commands,
  (m as { features?: { slash_commands?: unknown } }).features?.slash_commands,
);

const staleCmds = ((m as { features?: { slash_commands?: { command?: string; url?: string }[] } }).features?.slash_commands ?? [])
  .filter((c) => c.url !== COMMANDS_URL).length;
if (staleCmds) console.log(`\n${staleCmds} slash command(s) still point at legacy.`);

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
