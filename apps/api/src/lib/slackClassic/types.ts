// Shared types for the classic-mode port.

import type { slackInstallations, slackClassicChannels } from '../../db/schema.js';

export type Installation = typeof slackInstallations.$inferSelect;
export type ClassicChannelRow = typeof slackClassicChannels.$inferSelect;

// The legacy event envelope — fields are a superset of what wordhopapi emits
// (docs/legacy-slack-parity.md §10). Kept intentionally loose.
export interface LegacyEvent {
  channel?: string;
  sourceChannel?: string;
  client_key?: string;
  bot_name?: string;
  botName?: string;
  team_ids?: string[];
  team?: string | { id: string };
  sourceTeam?: string | { id: string };
  paused?: boolean;
  custom_alert?: boolean;
  help_requested?: boolean;
  reply?: string | Record<string, unknown>;
  user_profile?: Record<string, unknown>;
  text?: string;
  message?: string;
  type?: string;
  ts?: number;
  apiai_key?: string;
  dialogflow?: boolean;
  is_oneclick?: boolean;
  count?: number;
  docSentiment?: { score?: number };
  isFailure?: boolean;
  customAlertTitle?: string;
  error?: unknown;
  messages?: any[];
  channels?: string[];
  metadata?: string | Record<string, unknown>;
  slack_user?: string;
  agent_team?: string;
  quick_replies?: { title: string }[];
  attachments?: any[];
  display_text?: string;
  menu?: any;
  data?: { message?: any };
  address?: string;
  trainingEnabled?: boolean;
  ts_estimated?: boolean;
  [k: string]: unknown;
}

export type EventType =
  | 'chat message'
  | 'bot message'
  | 'dialogflow_message'
  | 'bulk messages'
  | 'custom alert message'
  | 'live chat request message'
  | 'failure log'
  | 'channel update'
  | 'link to full transcript'
  | 'stopped transcribing channels message'
  | 'stopped processing channels message'
  | 'inactive channels message'
  | 'inactive processing channels message'
  | 'resumed channels message'
  | 'engage users'
  | 'chat response'
  | 'user typing'
  | string;

// classicConfig jsonb on slack_installations.
export interface ClassicConfig {
  pro?: boolean;
  teamDomain?: string;
  botUserId?: string;
  // Legacy client_keys this team's bots subscribe to — used to resolve which
  // agent a legacy event belongs to when the body only carries client_key.
  subscriptions?: string[];
  stripe_customer?: { delinquent?: boolean } | null;
  subscription?: {
    status?: string;
    plan?: { id?: string };
    trial_end?: number;
  } | null;
  [k: string]: unknown;
}

// Result of one classic dispatch — returned for shadow/dry-run inspection.
export interface ClassicResult {
  posted: { channel: string; ts?: string; kind: string; payload?: unknown }[];
  suppressed: { channel?: string; reason: string }[];
  errors: string[];
}

export interface SayRes {
  ok: boolean;
  channel?: string;
  ts?: string;
  message?: any;
  error?: string;
}

// Shared pipeline context — every classic handler gets posting through
// ctx.say/ctx.api so shadow mode can compute the full decision set without
// touching Slack (dry=true → payloads captured in result.posted, no calls).
export interface ClassicCtx {
  db: import('../../db/client.js').Db;
  install: Installation;
  pro: boolean;
  isMessengerNoFb?: boolean;
  result: ClassicResult;
  /** Shadow-replay mode: Slack calls are simulated AND non-Slack external
   *  sends (Chatfuel broadcast API, ManyChat sendFlow) record instead of
   *  fetching. */
  dry?: boolean;
  say(msg: Record<string, unknown>): Promise<SayRes>;
  api<T = Record<string, unknown>>(
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T & { ok: boolean; error?: string }>;
}
