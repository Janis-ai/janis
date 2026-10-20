// Postgres-side equivalents of the mongoStorage reads/writes the classic
// pipeline depends on (parity doc §11).

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  slackClassicChannels,
  slackClassicPrefs,
  conversations,
  messages,
  memberships,
  users,
  agents,
} from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { ClassicChannelRow } from './types.js';
import type { ClassicPrefsSettings } from './gates.js';
import { slackApi } from '../slack.js';
import type { Installation } from './types.js';

// ── j-channel registry (Mongo `channels` doc where is_wordhop_channel) ──────

export async function getClassicChannelBySource(
  db: Db,
  installationId: string,
  sourceChannel: string,
): Promise<ClassicChannelRow | undefined> {
  const [row] = await db
    .select()
    .from(slackClassicChannels)
    .where(
      and(
        eq(slackClassicChannels.installationId, installationId),
        eq(slackClassicChannels.sourceChannel, String(sourceChannel)),
      ),
    )
    .limit(1);
  return row;
}

export async function getClassicChannelBySlackId(
  db: Db,
  slackChannelId: string,
): Promise<ClassicChannelRow | undefined> {
  const [row] = await db
    .select()
    .from(slackClassicChannels)
    .where(eq(slackClassicChannels.slackChannelId, slackChannelId))
    .limit(1);
  return row;
}

export async function getClassicChannelByName(
  db: Db,
  installationId: string,
  name: string,
): Promise<ClassicChannelRow | undefined> {
  const [row] = await db
    .select()
    .from(slackClassicChannels)
    .where(
      and(
        eq(slackClassicChannels.installationId, installationId),
        eq(slackClassicChannels.name, name),
      ),
    )
    .limit(1);
  return row;
}

export async function saveClassicChannel(
  db: Db,
  values: Partial<ClassicChannelRow> & { installationId: string; sourceChannel: string },
): Promise<void> {
  if (!values.slackChannelId || !values.name) {
    // Partial write (pause latches, ts bumps) — update the existing row only;
    // a bare INSERT would trip NOT NULL on slack_channel_id/name.
    await db
      .update(slackClassicChannels)
      .set(values as any)
      .where(
        and(
          eq(slackClassicChannels.installationId, values.installationId),
          eq(slackClassicChannels.sourceChannel, String(values.sourceChannel)),
        ),
      );
    return;
  }
  await db
    .insert(slackClassicChannels)
    .values(values as any)
    .onConflictDoUpdate({
      target: [slackClassicChannels.installationId, slackClassicChannels.sourceChannel],
      set: values as any,
    });
}

// ── Member prefs (the per-DM channel doc's custom_alerts + severities) ──────

export async function getClassicPrefs(
  db: Db,
  installationId: string,
  slackUserId: string,
  clientKey: string,
): Promise<ClassicPrefsSettings> {
  const rows = await db
    .select()
    .from(slackClassicPrefs)
    .where(
      and(
        eq(slackClassicPrefs.installationId, installationId),
        eq(slackClassicPrefs.slackUserId, slackUserId),
      ),
    );
  // Legacy DM-doc semantics: doc-level fields (the '__dm__' shell row) apply
  // underneath the per-client_key row as the fall-through.
  const dm = rows.find((r) => r.clientKey === DM_SENTINEL);
  const own = rows.find((r) => r.clientKey === clientKey);
  return { ...((dm?.settings ?? {}) as ClassicPrefsSettings), ...((own?.settings ?? {}) as ClassicPrefsSettings) };
}

// ── DM shell state (broadcasting / filtertype / bot_context) ───────────────
// Legacy stores these on the member's DM channel doc — not per-bot. We keep a
// sentinel row (client_key='__dm__') that never collides with per-bot prefs.

export const DM_SENTINEL = '__dm__';

export interface MemberShell {
  broadcasting?: boolean;
  filtertype?: string;
  botContext?: { client_key?: string; name?: string };
  dmChannelId?: string | null;
}

export async function getMemberShellState(
  db: Db,
  installationId: string,
  slackUserId: string,
): Promise<MemberShell | null> {
  const [row] = await db
    .select()
    .from(slackClassicPrefs)
    .where(
      and(
        eq(slackClassicPrefs.installationId, installationId),
        eq(slackClassicPrefs.slackUserId, slackUserId),
        eq(slackClassicPrefs.clientKey, DM_SENTINEL),
      ),
    )
    .limit(1);
  if (!row) return null;
  const s = row.settings as Record<string, unknown>;
  const shell = (s.shell ?? {}) as Record<string, unknown>;
  // Legacy keeps broadcasting/filtertype/bot_context as TOP-LEVEL doc fields
  // (they're stateDefault keys); shell.* is where our setMemberShellState
  // writes them. Read both — top-level state writes win on reset since
  // resets delete the stale shell key.
  return {
    broadcasting: s.broadcasting === true || shell.broadcasting === true,
    filtertype:
      typeof s.filtertype === 'string' && s.filtertype !== ''
        ? s.filtertype
        : typeof shell.filtertype === 'string'
          ? shell.filtertype
          : undefined,
    botContext: (s.bot_context ?? shell.bot_context) as MemberShell['botContext'],
    dmChannelId: row.dmChannelId,
  };
}

// setMemberDocSettings — write the member's DM-doc settings wholesale
// (the __dm__ row). Used by botSettingsMessage's doSave path which mutates
// the doc's custom_alerts / severity fields in place, verbatim.
export async function setMemberDocSettings(
  db: Db,
  installationId: string,
  slackUserId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(slackClassicPrefs)
    .where(
      and(
        eq(slackClassicPrefs.installationId, installationId),
        eq(slackClassicPrefs.slackUserId, slackUserId),
        eq(slackClassicPrefs.clientKey, DM_SENTINEL),
      ),
    )
    .limit(1);
  if (existing) {
    await db.update(slackClassicPrefs).set({ settings }).where(eq(slackClassicPrefs.id, existing.id));
  } else {
    await db.insert(slackClassicPrefs).values({ installationId, slackUserId, clientKey: DM_SENTINEL, settings });
  }
}

// resolveAgentDf — client_key → agent + DF project + service account.
// Shared by sendToUser, the training-menu enrichment, and the meta-bot
// shell's SA resolution.
export async function resolveAgentDf(
  ctx: { db: Db },
  clientKey: string,
): Promise<{
  agent: { id: string; config: unknown; metadata?: unknown };
  project: string;
  lang?: string;
  sa: { client_email: string; private_key: string; project_id: string };
} | null> {
  const { agents } = await import('../../db/schema.js');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  if (!agent) return null;
  const cfg = (agent.config ?? {}) as { dialogflow?: { project?: string; lang?: string } };
  if (!cfg.dialogflow?.project) return null;
  const { loadSecretsMap } = await import('../secrets.js');
  const secrets = await loadSecretsMap(ctx.db, agent.id);
  let sa: { client_email: string; private_key: string; project_id: string };
  try {
    sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
  } catch {
    return null;
  }
  if (!sa?.client_email || !sa?.private_key || !sa?.project_id) return null;
  return { agent, project: cfg.dialogflow.project, lang: cfg.dialogflow.lang, sa };
}

export async function setMemberShellState(
  db: Db,
  installationId: string,
  slackUserId: string,
  patch: Partial<MemberShell> & { reset?: boolean },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(slackClassicPrefs)
    .where(
      and(
        eq(slackClassicPrefs.installationId, installationId),
        eq(slackClassicPrefs.slackUserId, slackUserId),
        eq(slackClassicPrefs.clientKey, DM_SENTINEL),
      ),
    )
    .limit(1);
  const prev = ((existing?.settings ?? {}) as Record<string, unknown>);
  const shell = patch.reset
    ? {}
    : { ...((prev.shell ?? {}) as Record<string, unknown>) };
  if (patch.broadcasting !== undefined) shell.broadcasting = patch.broadcasting;
  if (patch.filtertype !== undefined) shell.filtertype = patch.filtertype;
  if (patch.botContext !== undefined) shell.bot_context = patch.botContext;
  const settings = { ...prev, shell };
  if (existing) {
    await db
      .update(slackClassicPrefs)
      .set({ settings })
      .where(eq(slackClassicPrefs.id, existing.id));
  } else {
    await db.insert(slackClassicPrefs).values({
      installationId,
      slackUserId,
      clientKey: DM_SENTINEL,
      settings,
    });
  }
}

// setLoggingSeverity/setUserUpsetSeverity/setHelpNeededSeverity/
// setCustomAlertSeverity (slack_bot.js 8909-9110) — parse the severity reply
// and write the level onto the member's DM-doc-level settings (the __dm__
// row, which getClassicPrefs merges underneath per-bot rows).
const MUTE_WORDS = ['mute', 'shut up', 'shut the fuck up', 'quiet', 'stop'];
const LEVEL_TEXT: Record<string, string[]> = {
  'no response': [':mute:', ':speak_no_evil:', ':speak_no_evil::speak_no_evil:', ':speak_no_evil::speak_no_evil::speak_no_evil:'],
  'urgent matter': [':mute:', ':scream:', ':scream::scream:', ':scream::scream::scream:'],
  'help requested': [':mute:', ':information_desk_person::skin-tone-2:'],
  'custom alert': [':mute:', ':bell:'],
};
const FILTER_FIELD: Record<string, string> = {
  'no response': 'logSeverityLevel',
  'urgent matter': 'userUpsetSeverityLevel',
  'help requested': 'helpNeededSeverityLevel',
  'custom alert': 'customAlertSeverityLevel',
};

export async function setMemberFilterSeverity(
  db: Db,
  installationId: string,
  slackUserId: string,
  shell: MemberShell,
  input: string,
): Promise<boolean> {
  const filtertype = shell.filtertype;
  if (!filtertype) return false;
  const texts = LEVEL_TEXT[filtertype];
  const field = FILTER_FIELD[filtertype];
  if (!texts || !field) return false;
  const trimmed = input.trim();
  let level: number | null = null;
  if (MUTE_WORDS.includes(trimmed.toLowerCase()) || trimmed === texts[0]) level = 0;
  else {
    for (let i = 1; i < texts.length; i++) {
      if (trimmed === texts[i]) level = i;
    }
  }
  if (level == null) return false;
  const max = texts.length - 1;
  if (level > max) level = max;
  // Write doc-level on the DM row (merged under per-bot prefs verbatim).
  const [existing] = await db
    .select()
    .from(slackClassicPrefs)
    .where(
      and(
        eq(slackClassicPrefs.installationId, installationId),
        eq(slackClassicPrefs.slackUserId, slackUserId),
        eq(slackClassicPrefs.clientKey, DM_SENTINEL),
      ),
    )
    .limit(1);
  const settings = {
    ...((existing?.settings ?? {}) as Record<string, unknown>),
    [field]: level,
    shell: {
      ...(((existing?.settings ?? {}) as Record<string, unknown>).shell as Record<string, unknown> ?? {}),
      filtertype: null,
    },
  };
  if (existing) {
    await db.update(slackClassicPrefs).set({ settings }).where(eq(slackClassicPrefs.id, existing.id));
  } else {
    await db.insert(slackClassicPrefs).values({ installationId, slackUserId, clientKey: DM_SENTINEL, settings });
  }
  return true;
}

// Fan-out candidates: every workspace member resolvable to a Slack user id,
// with their DM channel + prefs rows. This is the Postgres equivalent of
// getChannelsWithJanis (all member DM channel docs).
export async function classicMembersFor(
  db: Db,
  installation: Installation,
): Promise<
  {
    slackUserId: string;
    dmChannelId: string | null;
    prefs: { clientKey: string; settings: ClassicPrefsSettings }[];
  }[]
> {
  const memberRows = await db
    .select({ slackUserId: users.slackUserId, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, installation.workspaceId));

  const prefsRows = await db
    .select()
    .from(slackClassicPrefs)
    .where(eq(slackClassicPrefs.installationId, installation.id));

  const byUser = new Map<
    string,
    { dmChannelId: string | null; prefs: { clientKey: string; settings: ClassicPrefsSettings }[] }
  >();
  for (const p of prefsRows) {
    const entry = byUser.get(p.slackUserId) ?? { dmChannelId: null, prefs: [] };
    if (p.dmChannelId) entry.dmChannelId = p.dmChannelId;
    if (p.clientKey !== '*') {
      entry.prefs.push({ clientKey: p.clientKey, settings: p.settings as ClassicPrefsSettings });
    }
    byUser.set(p.slackUserId, entry);
  }

  const out: {
    slackUserId: string;
    dmChannelId: string | null;
    prefs: { clientKey: string; settings: ClassicPrefsSettings }[];
  }[] = [];
  const seen = new Set<string>();
  for (const m of memberRows) {
    if (!m.slackUserId) continue;
    seen.add(m.slackUserId);
    const entry = byUser.get(m.slackUserId) ?? { dmChannelId: null, prefs: [] };
    out.push({ slackUserId: m.slackUserId, dmChannelId: entry.dmChannelId, prefs: entry.prefs });
  }
  // Legacy: a member's DM channel doc was itself proof of membership — the
  // prefs row is our equivalent, so a Slack id with any prefs on this
  // install counts even without a users.slackUserId link (a member can be
  // on several Slack teams but carries only one global id).
  for (const [slackUserId, entry] of byUser) {
    if (seen.has(slackUserId)) continue;
    out.push({ slackUserId, dmChannelId: entry.dmChannelId, prefs: entry.prefs });
  }
  return out;
}

export async function setMemberDmChannel(
  db: Db,
  installationId: string,
  slackUserId: string,
  dmChannelId: string,
): Promise<void> {
  // Stored on the member's wildcard row — one DM channel per member per team.
  await db
    .insert(slackClassicPrefs)
    .values({
      installationId,
      slackUserId,
      clientKey: '*',
      dmChannelId,
      settings: {},
    })
    .onConflictDoUpdate({
      target: [
        slackClassicPrefs.installationId,
        slackClassicPrefs.slackUserId,
        slackClassicPrefs.clientKey,
      ],
      set: { dmChannelId },
    });
}

// ── Transcript backlog (Mongo `messages` docs → Postgres messages rows) ──────

// Find the conversation for a legacy sourceChannel (PSID etc.). New
// externalIds are namespaced `kind:<participant>` — match on the suffix.
export async function conversationForSource(
  db: Db,
  workspaceId: string,
  sourceChannel: string,
): Promise<typeof conversations.$inferSelect | undefined> {
  const [row] = await db
    .select({ conv: conversations })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        sql`${conversations.externalId} LIKE ${'%:' + sourceChannel}`,
      ),
    )
    .limit(1);
  return row?.conv;
}

// getBulkMessages' fetch: last 21 docs for the channel, newest first.
export async function fetchBacklog(
  db: Db,
  conversationId: string,
): Promise<(typeof messages.$inferSelect)[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(sql`${messages.payload}->>'processed_in_transcript'`),
        // Internal notes (failure/custom-alert/handoff flags, payload.internal)
        // are 'out' rows too — legacy kept them out of the j-channel; they
        // surface via DM alerts instead. 'human' rows stay: operator lines
        // and takeover notices are real transcript lines.
        sql`(${messages.direction} <> 'out' OR (
          coalesce(${messages.flags}->>'failure', 'false') = 'false'
          AND coalesce(${messages.flags}->>'help_requested', 'false') = 'false'
          AND coalesce(${messages.flags}->>'custom_alert', 'false') = 'false'
          AND coalesce(${messages.flags}->>'handoff_offer', 'false') = 'false'
          AND coalesce(${messages.flags}->>'handoff_cancelled', 'false') = 'false'
          AND coalesce(${messages.flags}->>'resolved', 'false') = 'false'
          AND coalesce(${messages.payload}->>'internal', 'false') = 'false'
        ))`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(21);
}

export async function markProcessed(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(messages)
    .set({ payload: sql`${messages.payload} || '{"processed_in_transcript":true}'::jsonb` })
    .where(inArray(messages.id, ids));
}

// ── Slack primitives used by the pipeline ───────────────────────────────────

// botSay / bot.say equivalent — chat.postMessage in legacy attachments format.
export async function classicSay(
  token: string,
  message: Record<string, unknown>,
): Promise<{ ok: boolean; channel?: string; ts?: string; message?: any; error?: string }> {
  // botSay's empty-message guard (verbatim): no text AND no attachments → skip.
  const text = (message.text as string) ?? '';
  const atts = message.attachments as any[] | undefined;
  if (text.trim() === '' && (!atts || atts.length === 0)) {
    return { ok: true };
  }
  const res = await slackApi(token, 'chat.postMessage', message);
  return res as any;
}

// Open (or return) a member's App DM channel — mongoStorage DM docs' job.
export async function openDmChannel(
  token: string,
  slackUserId: string,
): Promise<string | null> {
  const res = await slackApi<{ channel?: { id?: string } }>(
    token,
    'conversations.open',
    { users: slackUserId },
  );
  return res.ok && res.channel?.id ? res.channel.id : null;
}
