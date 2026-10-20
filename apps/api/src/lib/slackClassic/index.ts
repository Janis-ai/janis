// Classic-mode entry: the /wordhopapi/receive equivalent. Dispatch order and
// gates mirror slack_bot.js (parity doc §1-§2).

import { eq, sql } from 'drizzle-orm';
import {
  agents,
  slackInstallations,
  workspaces,
} from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type {
  ClassicConfig,
  ClassicCtx,
  ClassicResult,
  EventType,
  Installation,
  LegacyEvent,
} from './types.js';
import { isPro } from './gates.js';
import { processMessageAndAlert } from './alerts.js';
import {
  flushTranscript,
  lifecycleFanOut,
  sendFullTranscriptWarning,
  sendMessageToChannel,
} from './transcript.js';
import { classicSay } from './store.js';
import { slackApi } from '../slack.js';

export * from './types.js';
export * from './gates.js';
export * from './strings.js';
export * from './profiles.js';
export * from './attachments.js';
export * from './buttons.js';
export * as store from './store.js';
export * as channels from './channels.js';
export * as transcript from './transcript.js';
export * as alerts from './alerts.js';
export * as training from './training.js';

const LIFECYCLE_TYPES = new Set([
  'inactive channels message',
  'resumed channels message',
  'inactive processing channels message',
  'stopped processing channels message',
  'stopped transcribing channels message',
]);

// isPro against the new-stack integration record: explicit classicConfig.pro
// flag first (set by the import tooling), then the stripe linkage snapshot,
// then the workspace plan as the last resort.
export function classicIsPro(install: Installation, workspacePlan?: string): boolean {
  const cfg = install.classicConfig as ClassicConfig;
  if (typeof cfg.pro === 'boolean') return cfg.pro;
  if (cfg.subscription || cfg.stripe_customer) return isPro(cfg);
  if (!workspacePlan) return false;
  return workspacePlan !== 'free' && workspacePlan !== 'basic';
}

// Resolve which installation should handle a legacy event by client_key —
// agents.metadata.legacy_client_key (set by the import tooling) → workspace
// → classic-mode installation.
export async function resolveInstallationByClientKey(
  db: Db,
  clientKey: string,
): Promise<{ install: Installation; workspacePlan: string } | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  if (!agent) return null;
  const installs = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.workspaceId, agent.workspaceId))
    .orderBy(slackInstallations.createdAt);
  const install = installs.find((i) => i.mode === 'classic') ?? installs[0];
  if (!install) return null;
  const [ws] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);
  return { install, workspacePlan: ws?.plan ?? 'free' };
}

// makeClassicCtx — shared context for event dispatch AND inbound relay paths
// (slash commands, channel messages, callbacks). dry mode simulates Slack.
export function makeClassicCtx(
  db: Db,
  install: Installation,
  result: ClassicResult,
  opts: { workspacePlan?: string; dry?: boolean } = {},
): ClassicCtx {
  const cfg = install.classicConfig as ClassicConfig;
  const pro = classicIsPro(install, opts.workspacePlan);
  const janisbot = (cfg.janisbot ?? {}) as { fb_app_id?: string; platform?: string };
  const isMessengerNoFb =
    (janisbot.fb_app_id == null || janisbot.fb_app_id === '') && janisbot.platform === 'messenger';
  let drySeq = 0;
  return {
    db,
    install,
    pro,
    isMessengerNoFb,
    result,
    dry: opts.dry === true,
    say: async (m) => {
      if (opts.dry) {
        const ts = `dry.${++drySeq}`;
        result.posted.push({ channel: String(m.channel ?? ''), ts, kind: 'dry', payload: m });
        return { ok: true, channel: String(m.channel ?? ''), ts, message: m };
      }
      return classicSay(install.botToken, m);
    },
    api: async <T = Record<string, unknown>>(
      token: string,
      method: string,
      body: Record<string, unknown>,
    ): Promise<T & { ok: boolean; error?: string }> => {
      if (opts.dry) {
        // Deterministic Slack simulation for shadow replay — every API call
        // succeeds with a synthesized resource so decision paths run verbatim.
        result.posted.push({
          channel: String(body.channel ?? ''),
          ts: '',
          kind: `api:${method}`,
          payload: body,
        });
        if (method === 'conversations.open') {
          return { ok: true, channel: { id: `D.dry.${body.users}` } } as unknown as T & {
            ok: boolean;
            error?: string;
          };
        }
        if (method === 'conversations.create') {
          return {
            ok: true,
            channel: { id: `C.dry.${++drySeq}`, name: String(body.name ?? 'j-dry') },
          } as unknown as T & { ok: boolean; error?: string };
        }
        if (method === 'conversations.info' || method === 'conversations.list') {
          return { ok: true, channel: { id: body.channel, name: 'j-dry' }, channels: [] } as unknown as T & {
            ok: boolean;
            error?: string;
          };
        }
        return { ok: true, dry: true } as unknown as T & { ok: boolean; error?: string };
      }
      return slackApi(token, method, body) as Promise<T & { ok: boolean; error?: string }>;
    },
  };
}

// dispatchClassicEvent — the receive-handler body, verbatim gate order:
// migrated stand-down → alert types w/ isPro → generic Pro gate → handlers.
export async function dispatchClassicEvent(
  db: Db,
  install: Installation,
  type: EventType,
  msg: LegacyEvent,
  opts: { workspacePlan?: string; dry?: boolean } = {},
): Promise<ClassicResult> {
  const result: ClassicResult = { posted: [], suppressed: [], errors: [] };
  if (install.migrated !== true && install.mode !== 'classic') {
    // Not a classic-mode installation — nothing to render. (migrated=true is
    // how installs imported from wordhop-slack arrive.)
    result.suppressed.push({ reason: 'not classic mode' });
    return result;
  }

  const ctx = makeClassicCtx(db, install, result, opts);
  const { pro, isMessengerNoFb } = ctx;
  msg.text = msg.text ?? '';

  // ── Alert family (before the generic Pro gate) ──────────────────────────
  if (type === 'failure log') {
    await processMessageAndAlert(ctx, 'showLog', msg);
    return result;
  }
  if (type === 'live chat request message' && pro) {
    await processMessageAndAlert(ctx, 'showLiveChat', msg);
    return result;
  }
  if (type === 'custom alert message' && pro) {
    await processMessageAndAlert(ctx, 'showCustomAlert', msg);
    return result;
  }

  // ── Lifecycle messages (pre-Pro-gate in legacy) ─────────────────────────
  if (LIFECYCLE_TYPES.has(type)) {
    await lifecycleFanOut(ctx, msg, type);
    return result;
  }
  if (type === 'link to full transcript') {
    await sendFullTranscriptWarning(ctx, msg, type);
    return result;
  }
  if (type === 'channel update') {
    if (msg.show_warning === true) {
      await sendFullTranscriptWarning(ctx, msg, type);
    }
    return result;
  }

  // ── Generic Pro gate: `slack_integration && !isPro → return` — a null
  // integration falls through (verbatim quirk); our install always exists,
  // so non-Pro classic installs stop here.
  if (!pro) {
    result.suppressed.push({ reason: 'not pro' });
    return result;
  }

  if (type === 'chat message') {
    // DF training-attachment enrichment (findApiAiResponseAndWriteAttachment)
    // is TODO — needs the DF client; the line still posts without the menu.
    await flushTranscript(ctx, msg, msg.messages ?? undefined);
    return result;
  }
  if (type === 'bot message') {
    let metadata: any = msg.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    if (metadata) {
      if (metadata.slack_user) msg.slack_user = metadata.slack_user;
      if (metadata.team) msg.team = metadata.team;
      if (metadata.agent_team) msg.agent_team = metadata.agent_team;
      if (metadata.ts) msg.ts = parseFloat(metadata.ts);
      if (metadata.quick_replies) msg.quick_replies = metadata.quick_replies;
    }
    const { sendBotMessageResponse } = await import('./transcript.js');
    const { getTranscriptChannel } = await import('./channels.js');
    const channel = await getTranscriptChannel({
      ...ctx,
      sourceChannel: String(msg.channel),
      clientKey: msg.client_key,
      json: msg,
      type: 'botMessage',
      pro,
      isMessengerNoFb,
    });
    if (channel) await sendBotMessageResponse(ctx, msg as any, channel);
    return result;
  }
  if (type === 'dialogflow_message') {
    const message = msg.data?.message;
    if (message) {
      msg.messages = [message];
      msg.channel = message.channel;
      if (message.ts) msg.ts = message.ts;
    }
    msg.type = 'dialogflow_message';
    await flushTranscript(ctx, msg, msg.messages);
    return result;
  }
  if (type === 'bulk messages') {
    await flushTranscript(ctx, msg);
    return result;
  }
  if (type === 'engage users') {
    for (const channelId of msg.channels ?? []) {
      await sendMessageToChannel(ctx, channelId, (msg.message ?? msg.text ?? '') as string);
    }
    return result;
  }
  if (type === 'chat response' || type === 'user typing') {
    if (msg.type === 'user_typing') return result;
    const res = await ctx.say(msg as any);
    if (!res.ok) result.errors.push(`chat response: ${res.error ?? 'failed'}`);
    return result;
  }

  result.suppressed.push({ reason: `no handler matched type=${type}` });
  return result;
}

// The intake path used by routes/slackClassic.ts: resolve install by
// client_key → dispatch. Shadow callers get the full decision back.
export async function handleLegacyEvent(
  db: Db,
  type: EventType,
  msg: LegacyEvent,
  opts: { dry?: boolean } = {},
): Promise<ClassicResult & { handled: boolean }> {
  const clientKey = (msg.client_key ?? (msg.bot as any)?.client_key) as string | undefined;
  if (!clientKey) {
    return { handled: false, posted: [], suppressed: [{ reason: 'no client_key' }], errors: [] };
  }
  const resolved = await resolveInstallationByClientKey(db, clientKey);
  if (!resolved) {
    return { handled: false, posted: [], suppressed: [{ reason: 'no installation' }], errors: [] };
  }
  const result = await dispatchClassicEvent(db, resolved.install, type, msg, {
    workspacePlan: resolved.workspacePlan,
    dry: opts.dry,
  });
  return { handled: true, ...result };
}
