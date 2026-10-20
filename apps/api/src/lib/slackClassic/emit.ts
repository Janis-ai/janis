// Bridge: Janis-native traffic → legacy-shaped events → classic Slack.
//
// In the old stack, wordhopapi POSTed these events to wordhop-slack's
// /wordhopapi/receive. For bots that run entirely on the new stack (hosted
// LLM agents and engine:'dialogflow' Messenger bots), nothing produces them —
// so a classic-mode install would sit silent. This module synthesizes the
// same event shapes and dispatches them in-process via dispatchClassicEvent.
//
// Emitted mapping (hop.js verbatim):
//   message_in                 → 'chat message'            (transcript line)
//   message_out (non-flagged)  → 'bot message'             (transcript line)
//   DF intent matched          → 'custom alert message'    (member DM gates decide)
//   assistance keywords        → 'live chat request message'
//   DF fallback / send failure → 'failure log'
//   conv → 'human' / 'active'  → classic channel doc paused sync
//
// Events are per-conversation serialized (emits for one conv run in order)
// and never throw into the caller — Slack is a side channel, not the reply
// path.

import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  agents,
  slackInstallations,
  workspaces,
  type conversations,
} from '../../db/schema.js';
import { dispatchClassicEvent } from './index.js';
import type { ClassicResult, EventType, Installation, LegacyEvent } from './types.js';
import { syncClassicChannelState } from './channels.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

// Per-conversation emit chain — preserves transcript ordering without
// blocking the ingest path.
const emitQueue = new Map<string, Promise<void>>();

function enqueue(convId: string, task: () => Promise<void>): void {
  const prior = emitQueue.get(convId) ?? Promise.resolve();
  const next = prior.then(task).catch((err) => {
    console.error('[classic-emit]', err instanceof Error ? err.message : err);
  });
  emitQueue.set(convId, next);
  void next.finally(() => {
    if (emitQueue.get(convId) === next) emitQueue.delete(convId);
  });
}

// The customer-facing id the j-channel is keyed on — externalId is stored
// namespaced ('messenger:<psid>'); legacy channel docs used the raw id.
export function sourceChannelFor(conv: ConversationRow): string {
  const idx = conv.externalId.indexOf(':');
  return idx >= 0 ? conv.externalId.slice(idx + 1) : conv.externalId;
}

// Agents get their legacy client_key back on import; Janis-native bots fall
// back to a stable synthetic key so prefs/channel docs still scope correctly.
function clientKeyFor(agent: AgentRow): string {
  const meta = (agent.metadata ?? {}) as { legacy_client_key?: string };
  return meta.legacy_client_key ?? `janis-${agent.id}`;
}

let installsCache = new Map<string, { at: number; installs: Installation[]; plan: string }>();
const INSTALLS_TTL = 60_000;
// Test seam — same as dispatchClassicEvent's dry opt: records decisions
// without Slack calls. Unset in production.
let emitDry = false;

async function classicInstallsFor(
  db: Db,
  workspaceId: string,
): Promise<{ installs: Installation[]; plan: string }> {
  const hit = installsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < INSTALLS_TTL) {
    return { installs: hit.installs, plan: hit.plan };
  }
  const rows = await db
    .select()
    .from(slackInstallations)
    .where(and(eq(slackInstallations.workspaceId, workspaceId), eq(slackInstallations.mode, 'classic')));
  const [ws] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const out = { installs: rows, plan: ws?.plan ?? 'free' };
  installsCache.set(workspaceId, { at: Date.now(), ...out });
  return out;
}

/** Test seam — install flips must take effect immediately in tests. */
export function resetEmitCache(): void {
  installsCache = new Map();
}

/** Test seam — dry dispatch + queue drain so tests can await the fire-and-
 *  forget path and inspect decisions. */
export function setEmitDry(dry: boolean): void {
  emitDry = dry;
}

export async function drainEmitQueue(): Promise<void> {
  while (emitQueue.size) {
    await Promise.allSettled([...emitQueue.values()]);
  }
}

/**
 * Dispatch one legacy-shaped event at every classic install on the agent's
 * workspace. Fire-and-forget by contract: call through `emitClassicFor*`
 * helpers (they enqueue + swallow), or await this directly in tests.
 */
export async function dispatchClassicForAgent(
  db: Db,
  agent: AgentRow,
  type: EventType,
  fields: LegacyEvent,
): Promise<ClassicResult[]> {
  const { installs, plan } = await classicInstallsFor(db, agent.workspaceId);
  const out: ClassicResult[] = [];
  for (const install of installs) {
    const msg: LegacyEvent = {
      client_key: clientKeyFor(agent),
      team: install.teamId,
      team_ids: [install.teamId],
      bot_name: agent.name,
      dialogflow: (agent.config as { engine?: string }).engine === 'dialogflow' ? true : undefined,
      ...fields,
    };
    out.push(
      await dispatchClassicEvent(db, install, type, msg, { workspacePlan: plan, dry: emitDry }),
    );
  }
  return out;
}

// New-stack profiles store picture_url; the legacy renderers read
// profile_pic/image. Also stamps id — legacy docs carried the PSID there.
function legacyUserProfile(conv: ConversationRow): Record<string, unknown> {
  const p = (conv.userProfile ?? {}) as Record<string, unknown>;
  return {
    ...p,
    id: p.id ?? sourceChannelFor(conv),
    profile_pic: p.profile_pic ?? p.picture_url,
  };
}

// Fire-and-forget swallows ClassicResult — surface real failures. Suppressed
// reasons stay debug-only noise (routine gates), errors get logged.
function logEmitProblems(type: string, results: ClassicResult[]): void {
  for (const r of results) {
    for (const e of r.errors) console.error(`[classic-emit] ${type}: ${e}`);
  }
}

/** Inbound customer message → 'chat message' transcript flush. */
export function emitInboundLine(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  text: string | null,
  extra: LegacyEvent = {},
): void {
  const channel = sourceChannelFor(conv);
  enqueue(conv.id, async () => {
    const results = await dispatchClassicForAgent(db, agent, 'chat message', {
      channel,
      type: 'message',
      text: text ?? undefined,
      ts: Date.now() / 1000,
      user: channel,
      user_profile: legacyUserProfile(conv),
      ...extra,
    });
    logEmitProblems('chat message', results);
  });
}

/** Agent/operator outbound line → 'bot message' transcript post. */
export function emitOutboundLine(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  text: string | null,
  metadata?: Record<string, unknown>,
): void {
  const channel = sourceChannelFor(conv);
  enqueue(conv.id, async () => {
    const results = await dispatchClassicForAgent(db, agent, 'bot message', {
      channel,
      text: text ?? undefined,
      ts: Date.now() / 1000,
      ...(metadata ? { metadata } : {}),
    });
    logEmitProblems('bot message', results);
  });
}

/** DF/alerts event — 'custom alert message' | 'live chat request message' | 'failure log'. */
export function emitAlertEvent(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  type: EventType,
  fields: LegacyEvent,
): void {
  const channel = sourceChannelFor(conv);
  enqueue(conv.id, async () => {
    const results = await dispatchClassicForAgent(db, agent, type, {
      channel,
      paused: conv.state === 'human',
      user_profile: legacyUserProfile(conv),
      ...fields,
    });
    logEmitProblems(type, results);
  });
}

/** Human takeover/release → mirror conv state onto the j-channel doc. */
export async function syncClassicPaused(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  paused: boolean,
): Promise<void> {
  const { installs } = await classicInstallsFor(db, agent.workspaceId);
  const source = sourceChannelFor(conv);
  for (const install of installs) {
    await syncClassicChannelState(db, install.id, source, { paused }).catch((err) =>
      console.error('[classic-emit] pause sync:', err instanceof Error ? err.message : err),
    );
  }
}
