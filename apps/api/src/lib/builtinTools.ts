import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  channelBindings,
  channels,
  conversations,
  memberships,
  messages,
  pendingActions,
  usageEvents,
  users,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import type { UserProfile } from '@janis/shared';
import { env } from '../env.js';
import { invalidateCapCache, messageCap, planFor, PLANS } from './plans.js';
import { llmSpendOverCap } from './usage.js';
import { ensureStripeCustomer, planForPrice, stripe } from './stripe.js';
import { generateWebhookSecret } from './crypto.js';
import { audit } from './audit.js';
import { invalidateChannelCache } from './channels.js';
import {
  createSlackChannel,
  getInstallation,
  inviteWorkspaceMembers,
  sanitizeChannelName,
} from './slack.js';

/** Context a builtin can reach — matches AgentRunContext in hostedAgent. */
export interface BuiltinCtx {
  db: Db;
  convId: string;
  workspaceId: string;
}

/**
 * Built-in tools — run in-process rather than over HTTP. Enabled per agent via
 * config.builtin_tools; each entry is only offered to the model when its
 * `available()` check passes (e.g. the required platform env key is set, or
 * the agent lives in the operator workspace for account_status).
 */
export interface BuiltinTool {
  name: string;
  description: string;
  /** JSON-schema-ish params the model fills, same shape as ToolDef.params. */
  params?: Record<string, string>;
  available: (workspaceId?: string) => boolean;
  run: (args: Record<string, string>, ctx?: BuiltinCtx) => Promise<string>;
}

/** The verified signed-in user behind a concierge conversation, if any. */
async function signedInUser(ctx: BuiltinCtx) {
  const [conv] = await ctx.db
    .select({ userProfile: conversations.userProfile })
    .from(conversations)
    .where(eq(conversations.id, ctx.convId))
    .limit(1);
  const p = (conv?.userProfile ?? {}) as UserProfile;
  const userId = p.identity_verified ? (p.external_id as string | undefined) : undefined;
  if (!userId) return null;
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve which of the visitor's workspaces a concierge tool should act on.
 * Order: explicit `workspace` name hint → the workspace they're currently
 * viewing (the context pack's current_workspace trait) → their only
 * membership → a "which workspace?" error listing the options. adminOnly
 * narrows to workspaces they administer; read-only tools accept any
 * accepted membership. */
async function visitorWorkspace(
  ctx: BuiltinCtx,
  user: { id: string; name: string | null },
  hint: string | undefined,
  opts: { adminOnly?: boolean } = {},
): Promise<{ ws: WorkspaceRow } | { error: string }> {
  const conds = [eq(memberships.userId, user.id), isNotNull(memberships.acceptedAt)];
  if (opts.adminOnly) conds.push(eq(memberships.role, 'admin'));
  const rows = await ctx.db
    .select({ ws: workspaces })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(and(...conds));
  if (!rows.length) {
    return {
      error: opts.adminOnly
        ? 'no workspace where the visitor is an admin — this needs admin rights'
        : 'the visitor has no workspaces',
    };
  }
  const needle = hint?.trim().toLowerCase();
  if (needle) {
    const hit = rows.find(
      (r) => r.ws.name.toLowerCase() === needle || r.ws.name.toLowerCase().includes(needle),
    );
    if (hit) return { ws: hit.ws };
    return {
      error: `no workspace matching "${hint}" — the visitor's workspaces: ${rows.map((r) => r.ws.name).join(', ')}`,
    };
  }
  // Default to the workspace open in their console when the pack named it.
  const [conv] = await ctx.db
    .select({ userProfile: conversations.userProfile })
    .from(conversations)
    .where(eq(conversations.id, ctx.convId))
    .limit(1);
  const meta = (conv?.userProfile as UserProfile | undefined)?.metadata ?? {};
  const cur = String(meta.current_workspace ?? '').toLowerCase();
  const curHit = cur ? rows.find((r) => r.ws.name.toLowerCase() === cur) : undefined;
  if (curHit) return { ws: curHit.ws };
  if (rows.length === 1) return { ws: rows[0].ws };
  return {
    error: `which workspace? ${user.name ?? 'The visitor'} has: ${rows.map((r) => r.ws.name).join(', ')}`,
  };
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information, links, products or answers. Returns titles, URLs and snippets.',
    params: { q: 'search query' },
    available: () => env.searchApiKey.length > 0,
    run: async (args) => {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.q ?? '')}&count=5`,
        {
          headers: { 'X-Subscription-Token': env.searchApiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return `error: search failed (${res.status})`;
      const data = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      const hits = (data.web?.results ?? [])
        .slice(0, 5)
        .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }));
      return JSON.stringify(hits);
    },
  },
  {
    name: 'account_status',
    description:
      'Look up the signed-in visitor\'s Janis account: whether they have a workspace, which plan they\'re on, and how many agents they run. Only works when the visitor is a verified signed-in user — otherwise say they\'re not signed in.',
    // Operator-workspace only — it exposes Janis billing/workspace details, so
    // it must never be offered on customer agents.
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (_args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ signed_in: false, note: 'visitor is not a signed-in Janis user' });
      }
      const mems = await ctx.db
        .select({ acceptedAt: memberships.acceptedAt, ws: workspaces })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, user.id));
      const accepted = mems.filter((m) => m.acceptedAt);
      const out = [] as { name: string; plan: string; agents: number }[];
      for (const m of accepted) {
        const agentRows = await ctx.db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.workspaceId, m.ws.id));
        out.push({
          name: m.ws.name,
          plan: planFor(m.ws.plan).name,
          agents: agentRows.length,
        });
      }
      return JSON.stringify({
        signed_in: true,
        name: user.name,
        email: user.email,
        workspaces: out,
      });
    },
  },
  {
    name: 'change_plan',
    description:
      "Change the signed-in visitor's Janis subscription plan for a workspace they administer. Paid→paid switches apply immediately with proration; free→paid returns a secure Stripe Checkout link they must open to add a card and confirm; 'free' cancels at period end. Ask which plan first, and which workspace if they administer more than one.",
    params: {
      plan: 'free | starter | pro | scale',
      workspace: 'workspace name — required only when the visitor administers more than one',
    },
    // Operator-workspace + Stripe only — it moves real money on Janis
    // subscriptions, so it must never be offered on customer agents.
    available: (ws) =>
      Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId && Boolean(env.stripeSecret),
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const s = stripe();
      if (!s) return JSON.stringify({ error: 'billing is not configured' });
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({
          signed_in: false,
          note: 'visitor is not signed in — billing changes need a signed-in account owner',
        });
      }
      const target = (args.plan ?? '').trim().toLowerCase();
      if (!target || !PLANS[target] || PLANS[target].hidden) {
        return JSON.stringify({
          error: `unknown plan — one of ${Object.keys(PLANS).filter((k) => !PLANS[k].hidden).join(', ')}`,
        });
      }
      // Billing changes require workspace admin, same as the in-app routes.
      const adminRows = await ctx.db
        .select({ ws: workspaces })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.role, 'admin'),
            isNotNull(memberships.acceptedAt),
          ),
        );
      const hint = (args.workspace ?? '').trim().toLowerCase();
      const ws = hint
        ? adminRows.find(
            (r) =>
              r.ws.name.toLowerCase() === hint || r.ws.name.toLowerCase().includes(hint),
          )?.ws
        : adminRows.length === 1
          ? adminRows[0].ws
          : undefined;
      if (!ws) {
        return JSON.stringify({
          error: adminRows.length
            ? `which workspace? ${user.name ?? 'the visitor'} administers: ${adminRows.map((r) => r.ws.name).join(', ')}`
            : 'no workspace where the visitor is an admin — billing changes need admin rights',
        });
      }
      const plan = PLANS[target];
      const current = ws.stripeSubscriptionId ? (ws.plan ?? 'free') : 'free';
      if (current === target) {
        return JSON.stringify({ changed: false, note: `${ws.name} is already on ${plan.name}` });
      }

      // Downgrade: cancel the subscription at period end when one exists,
      // else flip straight to free (mirrors POST /api/billing/downgrade).
      if (target === 'free') {
        if (ws.stripeSubscriptionId) {
          try {
            await s.subscriptions.update(ws.stripeSubscriptionId, {
              cancel_at_period_end: true,
            });
            return JSON.stringify({
              changed: true,
              plan: 'Free',
              at_period_end: true,
              note: `${ws.name} keeps ${planFor(ws.plan).name} until the current period ends, then drops to Free`,
            });
          } catch {
            // subscription already gone on Stripe's side — flip locally
          }
        }
        await ctx.db
          .update(workspaces)
          .set({ plan: 'free', stripeSubscriptionId: null })
          .where(eq(workspaces.id, ws.id));
        invalidateCapCache(ws.id);
        return JSON.stringify({ changed: true, plan: 'Free', at_period_end: false });
      }

      const priceId = env.stripePrices[target];
      if (!priceId) return JSON.stringify({ error: `${plan.name} is not purchasable right now` });
      const meterPrice = env.stripeMeterPrices[target];

      // Paid→paid: swap the plan line item (and the plan's metered-overage
      // item — it differs per plan) in place, with proration. The LLM meter
      // price is shared across plans and stays.
      if (ws.stripeSubscriptionId) {
        const sub = await s.subscriptions.retrieve(ws.stripeSubscriptionId, {
          expand: ['items'],
        });
        const meterIds = new Set(
          Object.values(env.stripeMeterPrices).filter(
            (p): p is string => Boolean(p) && p !== env.stripeMeterPrices.llm,
          ),
        );
        // Match the message-overage item by its *meter*, not the price id —
        // prices get re-created (e.g. moved onto the "Janis message usage"
        // product) while the meter is constant across generations. Price-id
        // matching stays as a fallback when the price fetch fails.
        const meterId = meterPrice
          ? await s.prices
              .retrieve(meterPrice)
              .then((p) => p.recurring?.meter ?? null)
              .catch(() => null)
          : null;
        const baseItem = sub.items.data.find((i) => planForPrice(i.price.id));
        const meterItem = sub.items.data.find(
          (i) => meterIds.has(i.price.id) || (meterId != null && i.price.recurring?.meter === meterId),
        );
        if (baseItem) {
          await s.subscriptionItems.update(baseItem.id, {
            price: priceId,
            proration_behavior: 'create_prorations',
          });
        }
        if (meterItem && meterPrice) {
          await s.subscriptionItems.update(meterItem.id, {
            price: meterPrice,
            proration_behavior: 'create_prorations',
          });
        } else if (!meterItem && meterPrice) {
          await s.subscriptionItems.create({ subscription: sub.id, price: meterPrice });
        }
        await ctx.db
          .update(workspaces)
          .set({ plan: target })
          .where(eq(workspaces.id, ws.id));
        invalidateCapCache(ws.id);
        return JSON.stringify({
          changed: true,
          plan: plan.name,
          note: `${ws.name} is now on ${plan.name} — proration appears on the next invoice`,
        });
      }

      // Free→paid: checkout session — the visitor adds a card and confirms.
      const customerId = await ensureStripeCustomer(s, ctx.db, ws.id, ws, user.email);
      const line_items: { price: string; quantity?: number }[] = [{ price: priceId, quantity: 1 }];
      if (meterPrice) line_items.push({ price: meterPrice });
      if (env.stripeMeterPrices.llm) line_items.push({ price: env.stripeMeterPrices.llm });
      const session = await s.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items,
        metadata: { workspace_id: ws.id, plan: target },
        subscription_data: { metadata: { workspace_id: ws.id, plan: target } },
        success_url: `${env.webOrigin}/billing?upgraded=1`,
        cancel_url: `${env.webOrigin}/billing`,
      });
      return JSON.stringify({
        changed: false,
        checkout_url: session.url,
        note: `send the visitor this secure Stripe checkout link to complete the upgrade to ${plan.name}`,
      });
    },
  },
  {
    name: 'create_agent',
    description:
      "Create a new hosted AI agent in a workspace the signed-in visitor administers — 'take a prompt, get a working agent'. Confirm the name and purpose with the visitor first, then call this with a system_prompt you draft from their description. Creates the agent with a live webchat channel and returns its console URL. Ask which workspace only if they administer more than one.",
    params: {
      name: 'agent name, e.g. "Acme Support"',
      system_prompt:
        'the operating prompt you draft from the visitor\'s description — persona, scope, tone, what it should/shouldn\'t do',
      greeting: 'optional first message the widget sends when a conversation opens',
      workspace: 'workspace name — required only when the visitor administers more than one',
    },
    // Operator-workspace only — it writes to visitor workspaces, so it must
    // never be offered on customer agents.
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const name = (args.name ?? '').trim();
      if (!name) return JSON.stringify({ error: 'name is required' });
      if (name.length > 120) return JSON.stringify({ error: 'name is too long (120 chars max)' });

      // Same gate as POST /api/agents — must administer the target workspace.
      const resolved = await visitorWorkspace(ctx, user, args.workspace, { adminOnly: true });
      if ('error' in resolved) return JSON.stringify(resolved);
      const ws = resolved.ws;
      // Agency children can't grow the fleet — same rule as the API route.
      if (ws.parentWorkspaceId && !ws.stripeSubscriptionId && !ws.connectSubscriptionId) {
        const [parent] = await ctx.db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, ws.parentWorkspaceId))
          .limit(1);
        return JSON.stringify({
          error: `${ws.name} is covered by ${parent?.name ?? 'an agency plan'} — contact ${ws.parentContact ?? 'the account administrator'} to add agents`,
        });
      }

      const prompt = (args.system_prompt ?? '').trim();
      const greeting = (args.greeting ?? '').trim();
      const [row] = await ctx.db
        .insert(agents)
        .values({
          workspaceId: ws.id,
          ownerUserId: user.id,
          name,
          webhookSecret: generateWebhookSecret(),
          hosted: true,
          autoResumeMinutes: 10,
          config: {
            ...(prompt ? { system_prompt: prompt } : {}),
            ...(greeting ? { greeting } : {}),
          },
        })
        .returning();
      // A hosted agent with no channel can't talk to anyone — give it a
      // webchat channel so it's live the moment the link opens.
      const [chan] = await ctx.db
        .insert(channels)
        .values({
          workspaceId: ws.id,
          agentId: row.id,
          kind: 'webchat',
          name: 'Web chat',
          credentials: {},
        })
        .returning();
      invalidateChannelCache();
      // Same Slack nicety as the API route — per-agent alert channel when the
      // workspace is connected; best-effort, never blocks creation.
      const inst = await getInstallation(ctx.db, ws.id);
      if (inst) {
        const slug = sanitizeChannelName(`janis-${row.name}`) || 'janis-agent';
        const { channel } = await createSlackChannel(inst, slug);
        if (channel) {
          const routes = [{ installation_id: inst.id, channel_id: channel.id }];
          await ctx.db
            .update(agents)
            .set({ slackRoutes: routes })
            .where(eq(agents.id, row.id));
          void inviteWorkspaceMembers(ctx.db, inst, channel.id, row.id);
        }
      }
      await audit(ctx.db, {
        workspaceId: ws.id,
        userId: user.id,
        userName: user.name,
        action: 'agent.create',
        targetType: 'agent',
        targetId: row.id,
        meta: { name: row.name, hosted: true, via: 'concierge' },
      });
      return JSON.stringify({
        created: true,
        agent_id: row.id,
        name: row.name,
        url: `${env.webOrigin}/agents/${row.id}`,
        channel_id: chan.id,
        note: 'the agent is live on its webchat channel — send the visitor this link to open it',
      });
    },
  },
  {
    name: 'workspace_stats',
    description:
      "Answer 'how is my workspace doing' questions: conversation volume, containment (how much the agents handled alone), CSAT, open handoffs, and a per-agent breakdown — computed live from the visitor's workspace. Defaults to the last 30 days and the workspace they're currently viewing; pass `days` or `workspace` to change scope. Read-only — any workspace member can use it.",
    params: {
      days: 'look-back window in days, default 30, max 90',
      workspace: 'workspace name — only needed when ambiguous',
      agent: 'optional agent name to scope the stats to one agent',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace);
      if ('error' in resolved) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 90);
      const cutoff = new Date(Date.now() - days * 86_400_000);

      const wsAgents = await ctx.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.workspaceId, ws.id));
      if (!wsAgents.length) {
        return JSON.stringify({
          error: `${ws.name} has no agents yet — offer to create one with create_agent`,
        });
      }
      const agentHint = args.agent?.trim().toLowerCase();
      const scope = agentHint
        ? wsAgents.filter((a) => a.name.toLowerCase().includes(agentHint))
        : wsAgents;
      if (!scope.length) {
        return JSON.stringify({
          error: `no agent matching "${args.agent}" — agents: ${wsAgents.map((a) => a.name).join(', ')}`,
        });
      }
      const scopeIds = scope.map((a) => a.id);

      const convs = await ctx.db
        .select({
          id: conversations.id,
          agentId: conversations.agentId,
          state: conversations.state,
          csatScore: conversations.csatScore,
          csatAskedAt: conversations.csatAskedAt,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(
          and(
            inArray(conversations.agentId, scopeIds),
            gte(conversations.createdAt, cutoff),
          ),
        );
      const convIds = convs.map((v) => v.id);

      const [msgs, convAlerts, pendings] = convIds.length
        ? await Promise.all([
            ctx.db
              .select({
                convId: messages.conversationId,
                direction: messages.direction,
                payload: messages.payload,
              })
              .from(messages)
              .where(inArray(messages.conversationId, convIds)),
            ctx.db
              .select({ convId: alerts.conversationId, type: alerts.type })
              .from(alerts)
              .where(inArray(alerts.conversationId, convIds)),
            ctx.db
              .select({ convId: pendingActions.conversationId, status: pendingActions.status })
              .from(pendingActions)
              .where(inArray(pendingActions.conversationId, convIds)),
          ])
        : [[], [], []];

      // Same contained/escalated semantics as /api/reports/containment.
      const ESCALATING = new Set(['failure', 'help_request', 'handoff_offer', 'custom', 'keyword']);
      const escalatedConvs = new Set(
        convAlerts.filter((a) => ESCALATING.has(a.type)).map((a) => a.convId),
      );
      const replied = new Set<string>();
      const touched = new Set<string>();
      for (const m of msgs) {
        const p = m.payload as { internal?: boolean; via?: string } | undefined;
        if (p?.internal) continue;
        if (m.direction === 'out' && p?.via !== 'operator') replied.add(m.convId);
        if (m.direction === 'human' || p?.via === 'operator') touched.add(m.convId);
      }
      let contained = 0;
      let escalated = 0;
      let noReply = 0;
      for (const v of convs) {
        if (!replied.has(v.id)) noReply++;
        else if (touched.has(v.id) || escalatedConvs.has(v.id)) escalated++;
        else contained++;
      }
      const scores = convs.filter((v) => v.csatScore !== null).map((v) => v.csatScore!);
      const openNow = convs.filter((v) => v.state === 'needs_human').length;
      const perAgent = scope
        .map((a) => {
          const mine = convs.filter((v) => v.agentId === a.id);
          return { agent: a.name, conversations: mine.length };
        })
        .sort((a, b) => b.conversations - a.conversations);

      return JSON.stringify({
        workspace: ws.name,
        plan: ws.plan,
        days,
        agents: scope.length,
        conversations: convs.length,
        contained,
        escalated,
        no_reply: noReply,
        containment_rate: convs.length ? Math.round((contained / convs.length) * 100) : null,
        needs_human_now: openNow,
        approvals_pending: pendings.filter((p) => p.status === 'pending').length,
        csat_prompted: convs.filter((v) => v.csatAskedAt).length,
        csat_answered: scores.length,
        csat_avg: scores.length
          ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100
          : null,
        per_agent: perAgent,
        reports_url: `${env.webOrigin}/reports`,
      });
    },
  },
  {
    name: 'debug_conversation',
    description:
      "Diagnose 'why didn't my agent reply?' — inspect one conversation in the visitor's workspace and report what's blocking it: human takeover, escalation, spend/message caps, missing channel binding, failed webhook deliveries, a pending approval, or an unanswered inbound. Identify the conversation by its UUID (from the console URL) or a search string matching the customer's name/email. Read-only.",
    params: {
      conversation:
        'conversation UUID (the id in /conversations/<id>) or text to match the customer name/email/external id',
      workspace: 'workspace name — only needed when ambiguous',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace);
      if ('error' in resolved) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const q = (args.conversation ?? '').trim();
      if (!q) return JSON.stringify({ error: 'pass a conversation id or a name/email to search for' });

      // Find the conversation inside the visitor's workspace only.
      const wsAgentIds = (
        await ctx.db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.workspaceId, ws.id))
      ).map((a) => a.id);
      if (!wsAgentIds.length) return JSON.stringify({ error: `${ws.name} has no agents` });

      let conv: typeof conversations.$inferSelect | undefined;
      if (UUID.test(q)) {
        [conv] = await ctx.db
          .select()
          .from(conversations)
          .where(and(eq(conversations.id, q), inArray(conversations.agentId, wsAgentIds)))
          .limit(1);
        if (!conv) return JSON.stringify({ error: `no conversation ${q} in ${ws.name}` });
      } else {
        const pat = `%${q}%`;
        const hits = await ctx.db
          .select()
          .from(conversations)
          .where(
            and(
              inArray(conversations.agentId, wsAgentIds),
              or(
                ilike(conversations.externalId, pat),
                ilike(sql`${conversations.userProfile}->>'email'`, pat),
                ilike(sql`${conversations.userProfile}->>'name'`, pat),
              ),
            ),
          )
          .orderBy(desc(conversations.lastMessageAt))
          .limit(6);
        if (!hits.length) return JSON.stringify({ error: `no conversations matching "${q}" in ${ws.name}` });
        if (hits.length > 1) {
          return JSON.stringify({
            error: 'multiple matches — be more specific or use the conversation id',
            matches: hits.slice(0, 5).map((h) => ({
              id: h.id,
              name: (h.userProfile as { name?: string })?.name ?? h.externalId,
              last_message_at: h.lastMessageAt,
            })),
          });
        }
        conv = hits[0];
      }

      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(eq(agents.id, conv.agentId))
        .limit(1);
      const findings: string[] = [];
      const info: Record<string, unknown> = {
        conversation_id: conv.id,
        customer:
          (conv.userProfile as { name?: string; email?: string })?.name ??
          (conv.userProfile as { email?: string })?.email ??
          conv.externalId,
        state: conv.state,
        agent: agent?.name,
        agent_hosted: agent?.hosted,
        url: `${env.webOrigin}/conversations/${conv.id}`,
      };

      // Delivery path first — a reply that can't reach anyone reads as "no reply".
      const bindings = await ctx.db
        .select({ channelId: channelBindings.channelId })
        .from(channelBindings)
        .where(eq(channelBindings.conversationId, conv.id));
      const boundChannels = bindings.length
        ? await ctx.db
            .select({ id: channels.id, kind: channels.kind, name: channels.name })
            .from(channels)
            .where(inArray(channels.id, bindings.map((b) => b.channelId)))
        : [];
      if (!bindings.length) {
        findings.push('no channel binding — replies have no route back to the customer');
      } else if (boundChannels.length < bindings.length) {
        findings.push('a bound channel was deleted — replies to it fail');
      } else {
        info.channels = boundChannels.map((c) => `${c.kind} (${c.name})`);
      }

      // Conversation state — only 'human' silences the agent.
      if (conv.state === 'human') {
        const pause = conv.pauseMinutes ?? agent?.autoResumeMinutes ?? 10;
        const eta =
          pause === -1
            ? 'never — take-over is set to manual release'
            : conv.humanSince
              ? `around ${new Date(conv.humanSince.getTime() + pause * 60_000).toISOString()}`
              : `about ${pause} minutes after the last human message`;
        findings.push(
          `a human took over — the agent is paused (auto-resume ${eta}). ` +
            'That\'s working as intended; archive or wait for auto-resume to hand it back.',
        );
      }
      if (conv.snoozedUntil && conv.snoozedUntil > new Date()) {
        findings.push(`snoozed until ${conv.snoozedUntil.toISOString()} — hidden from queues`);
      }
      if (conv.state === 'needs_human') {
        findings.push('escalated (needs_human) — waiting on an operator; the agent still replies');
      }

      // Engine & hosting.
      const engine = (agent?.config as { engine?: string } | null)?.engine;
      if (engine === 'monitor') findings.push('legacy monitor engine — this agent never replies');
      if (agent && !agent.hosted) {
        const deliveries = await ctx.db
          .select({
            status: webhookDeliveries.status,
            attempts: webhookDeliveries.attempts,
            lastError: webhookDeliveries.lastError,
          })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.agentId, agent.id))
          .orderBy(desc(webhookDeliveries.createdAt))
          .limit(10);
        const failed = deliveries.filter((d) => d.status === 'failed');
        const pendingRetry = deliveries.filter((d) => d.status === 'pending' && d.attempts > 0);
        if (!agent.webhookUrl) {
          findings.push('not a hosted agent and no webhook_url — nothing is answering inbound');
        } else if (failed.length) {
          findings.push(
            `BYO webhook is failing: ${failed[0].lastError ?? 'delivery error'} ` +
              `(${failed.length} failed of last ${deliveries.length} deliveries)`,
          );
        } else if (pendingRetry.length) {
          findings.push(`${pendingRetry.length} webhook deliveries are retrying — the endpoint may be flaky`);
        }
      }

      // Caps — both silence the agent workspace-wide.
      const cap = await messageCap(ctx.db, ws.id);
      if (cap.capped) {
        findings.push(
          `workspace hit its plan message cap (${cap.used}/${cap.plan?.includedMessages ?? '?'} this period) — inbound is dropped until the period rolls or the plan upgrades`,
        );
      }
      const spent = await llmSpendOverCap(ctx.db, ws.id);
      if (spent != null) {
        findings.push(
          `workspace hit its 24h AI spend ceiling ($${(spent / 1e6).toFixed(2)}) — replies resume as spend rolls out of the window`,
        );
      }

      // Open alerts + waiting approvals.
      const openAlerts = await ctx.db
        .select({ type: alerts.type, detail: alerts.detail, createdAt: alerts.createdAt })
        .from(alerts)
        .where(and(eq(alerts.conversationId, conv.id), eq(alerts.status, 'open')));
      for (const a of openAlerts) {
        findings.push(`open ${a.type} alert${a.detail ? `: ${a.detail}` : ''}`);
      }
      const pending = await ctx.db
        .select({ toolName: pendingActions.toolName, createdAt: pendingActions.createdAt })
        .from(pendingActions)
        .where(and(eq(pendingActions.conversationId, conv.id), eq(pendingActions.status, 'pending')));
      for (const p of pending) {
        findings.push(`the agent asked approval to run "${p.toolName}" — it's waiting on an operator`);
      }

      // Unanswered inbound + whether generation ever ran on it.
      const recent = await ctx.db
        .select({ direction: messages.direction, createdAt: messages.createdAt, payload: messages.payload })
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(desc(messages.createdAt))
        .limit(20);
      const lastIn = recent.find((m) => m.direction === 'in');
      const lastOut = recent.find(
        (m) =>
          (m.direction === 'out' || m.direction === 'human') &&
          !(m.payload as { internal?: boolean })?.internal,
      );
      if (lastIn && (!lastOut || lastOut.createdAt < lastIn.createdAt)) {
        const waitMin = Math.round((Date.now() - lastIn.createdAt.getTime()) / 60_000);
        findings.push(`the last customer message (${waitMin} min ago) never got a reply`);
        const [llm] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.conversationId, conv.id),
              eq(usageEvents.kind, 'llm_tokens'),
              gt(usageEvents.createdAt, lastIn.createdAt),
            ),
          );
        if (agent?.hosted && !Number(llm?.count ?? 0)) {
          findings.push(
            'no LLM call ran for that message — the reply never started (check the items above, or it may have hit a crash/lock stall)',
          );
        }
      } else if (lastIn) {
        info.last_reply = lastOut?.createdAt;
      }

      return JSON.stringify({
        ...info,
        verdict:
          findings[0] ??
          'nothing blocking — the conversation looks healthy; if the customer still reports silence it may be a channel delivery issue',
        findings,
      });
    },
  },
  {
    name: 'knowledge_gaps',
    description:
      "Answer 'what topics are my agents failing at' — clusters of recurring customer questions that forced a handoff, with counts, sample questions and the answers humans gave. Use this before offering fixes; 'already_covered' gaps have a knowledge entry now. Read-only — any member. Defaults to the workspace they're viewing; pass `agent` to scope to one.",
    params: {
      workspace: 'workspace name — only needed when ambiguous',
      agent: 'optional agent name — otherwise covers all workspace agents',
      days: 'look-back window in days, default 30, max 90',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace);
      if ('error' in resolved) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 90);

      const wsAgents = await ctx.db
        .select()
        .from(agents)
        .where(eq(agents.workspaceId, ws.id));
      const hint = args.agent?.trim().toLowerCase();
      const scope = hint
        ? wsAgents.filter((a) => a.name.toLowerCase().includes(hint))
        : wsAgents;
      if (!scope.length) {
        return JSON.stringify({
          error: `no agent matching "${args.agent}" — agents: ${wsAgents.map((a) => a.name).join(', ')}`,
        });
      }

      // Lazy import — knowledgeGaps pulls llmFor from hostedAgent, which
      // imports this module; deferring avoids a load-time cycle.
      const { detectKnowledgeGaps, readGapsCache, gapsCacheFresh } = await import(
        '../services/knowledgeGaps.js'
      );

      const out: {
        agent: string;
        gaps_url: string;
        gaps: {
          theme: string;
          times_failed: number;
          sample_questions: string[];
          human_resolutions: string[];
          now_handled: number;
          already_covered: boolean;
        }[];
      }[] = [];
      for (const agent of scope.slice(0, 10)) {
        const cfg = (agent.config ?? {}) as Record<string, unknown> & {
          dismissed_gaps?: string[];
          dismissed_gap_times?: Record<string, string>;
        };
        let gaps;
        const cached = readGapsCache(cfg);
        if (gapsCacheFresh(cached)) {
          gaps = cached!.gaps;
        } else {
          gaps = await detectKnowledgeGaps(ctx.db, agent.id, { days });
          await ctx.db
            .update(agents)
            .set({ config: { ...cfg, gaps_cache: { at: new Date().toISOString(), gaps } } })
            .where(eq(agents.id, agent.id));
        }
        // Same dismissal rules as the console — operator-covered clusters
        // stay hidden unless the question recurs after the dismissal.
        const dismissed = new Set(cfg.dismissed_gaps ?? []);
        const times = cfg.dismissed_gap_times ?? {};
        const qKey = (q: string) => q.toLowerCase().slice(0, 60);
        gaps = gaps.filter((g) => {
          const covered =
            dismissed.has(g.key) ||
            (g.questions.length > 0 && g.questions.every((q) => dismissed.has(qKey(q))));
          if (!covered) return true;
          const ts = [g.key, ...g.questions.map(qKey)]
            .map((k) => times[k])
            .filter((t): t is string => !!t)
            .map(Date.parse)
            .filter(Number.isFinite);
          if (!ts.length) return false; // legacy dismissal — never resurface
          return Date.parse(g.last_seen) > Math.max(...ts);
        });
        if (!gaps.length) continue;
        out.push({
          agent: agent.name,
          gaps_url: `${env.webOrigin}/agents/${agent.id}?tab=behavior`,
          gaps: gaps.slice(0, 5).map((g) => ({
            theme: g.questions[0] ?? g.key,
            times_failed: g.count,
            sample_questions: g.questions.slice(0, 3),
            human_resolutions: g.resolutions.slice(0, 2),
            now_handled: g.handled.length,
            already_covered: g.added,
          })),
        });
      }
      return JSON.stringify(
        out.length
          ? { workspace: ws.name, days, agents: out }
          : {
              workspace: ws.name,
              days,
              gaps: [],
              note: 'no recurring failures detected — either the agents are handling their conversations or there is not enough traffic yet',
            },
      );
    },
  },
  {
    name: 'teach_agent',
    description:
      "Add a knowledge entry to an agent in the visitor's workspace — the fix for a recurring gap, so the agent answers it next time. Draft the entry (a factual line the agent can quote, e.g. \"Refunds under $50 are auto-approved within 24h\"), show it to the visitor and only call this once they confirm. Admin-only.",
    params: {
      agent: 'agent name (required)',
      entry: 'the confirmed knowledge entry text — one line per fact',
      workspace: 'workspace name — only needed when ambiguous',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace, { adminOnly: true });
      if ('error' in resolved) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const hint = args.agent?.trim().toLowerCase();
      const wsAgents = await ctx.db
        .select()
        .from(agents)
        .where(eq(agents.workspaceId, ws.id));
      const agent = hint
        ? wsAgents.find((a) => a.name.toLowerCase() === hint) ??
          wsAgents.find((a) => a.name.toLowerCase().includes(hint))
        : undefined;
      if (!agent) {
        return JSON.stringify({
          error: `which agent? "${args.agent ?? ''}" didn't match — agents: ${wsAgents.map((a) => a.name).join(', ')}`,
        });
      }
      const entry = String(args.entry ?? '').trim();
      if (!entry) return JSON.stringify({ error: 'entry text is required' });
      if (!agent.hosted) {
        return JSON.stringify({
          error: `${agent.name} isn't a hosted agent — knowledge entries only apply to Janis-hosted agents`,
        });
      }

      // Same normalisation as the Behavior-tab approve route: split lines,
      // strip list/markdown decoration, dedupe.
      const cfg = (agent.config ?? {}) as Record<string, unknown> & { knowledge?: unknown };
      const entries = entry
        .split('\n')
        .map((l) => l.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
        .filter(Boolean);
      const knowledge = Array.isArray(cfg.knowledge) ? [...(cfg.knowledge as string[])] : [];
      const added: string[] = [];
      for (const e of entries) {
        if (!knowledge.includes(e)) {
          knowledge.push(e);
          added.push(e);
        }
      }
      if (!added.length) {
        return JSON.stringify({ ok: true, note: 'that entry already exists — nothing added', agent: agent.name });
      }
      // Keep the cached gap set stable — only "added" flags move.
      const { readGapsCache, markGapsAdded } = await import('../services/knowledgeGaps.js');
      const cache = readGapsCache(cfg);
      const gaps_cache = cache
        ? { ...cache, gaps: markGapsAdded(cache.gaps, knowledge) }
        : undefined;
      await ctx.db
        .update(agents)
        .set({ config: { ...cfg, knowledge, ...(gaps_cache ? { gaps_cache } : {}) } })
        .where(eq(agents.id, agent.id));
      await audit(ctx.db, {
        workspaceId: ws.id,
        userId: user.id,
        userName: user.name,
        action: 'agent.knowledge.add',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', entries: added },
      });
      return JSON.stringify({
        ok: true,
        added,
        agent: agent.name,
        knowledge_count: knowledge.length,
        gaps_url: `${env.webOrigin}/agents/${agent.id}?tab=behavior`,
      });
    },
  },
];

/** Builtins enabled on this agent's config AND available in this environment. */
export function enabledBuiltins(
  enabled: string[] | undefined,
  workspaceId?: string,
): BuiltinTool[] {
  return BUILTIN_TOOLS.filter((b) => enabled?.includes(b.name) && b.available(workspaceId));
}

/** Catalog view for the UI — every builtin, flagging whether it can run now. */
export function builtinCatalog(workspaceId?: string) {
  return BUILTIN_TOOLS.map((b) => ({
    name: b.name,
    description: b.description,
    available: b.available(workspaceId),
  }));
}
