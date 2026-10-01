import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  agentMembers,
  alerts,
  alertRules,
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
import { AgentConfig } from '@janis/shared';
import { env } from '../env.js';
import { invalidateCapCache, messageCap, planFor, PLANS } from './plans.js';
import { llmSpendOverCap } from './usage.js';
import { ensureStripeCustomer, planForPrice, stripe } from './stripe.js';
import { generateWebhookSecret } from './crypto.js';
import { audit } from './audit.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';
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
  /** The agent this conversation belongs to — the concierge for Ask Janis. */
  agent?: { id: string; workspaceId: string };
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

/** Accepted members of a workspace, for name → id resolution in rules. */
async function workspaceMembers(db: Db, wsId: string) {
  return db
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.workspaceId, wsId), isNotNull(memberships.acceptedAt)));
}

/** Find one conversation inside a workspace by UUID or a customer name/
 *  email/external-id search string. Shared by the concierge's conversation
 *  tools — debug (read), teach-from (write) and assign. */
async function findVisitorConversation(
  db: Db,
  ws: WorkspaceRow,
  q: string,
): Promise<
  | { conv: typeof conversations.$inferSelect }
  | { error: string; matches?: { id: string; name: string; last_message_at: Date | null }[] }
> {
  const wsAgentIds = (
    await db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, ws.id))
  ).map((a) => a.id);
  if (!wsAgentIds.length) return { error: `${ws.name} has no agents` };

  if (UUID.test(q)) {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, q), inArray(conversations.agentId, wsAgentIds)))
      .limit(1);
    if (!conv) return { error: `no conversation ${q} in ${ws.name}` };
    return { conv };
  }
  const pat = `%${q}%`;
  const hits = await db
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
  if (!hits.length) return { error: `no conversations matching "${q}" in ${ws.name}` };
  if (hits.length > 1) {
    return {
      error: 'multiple matches — be more specific or use the conversation id',
      matches: hits.slice(0, 5).map((h) => ({
        id: h.id,
        name: (h.userProfile as { name?: string })?.name ?? h.externalId,
        last_message_at: h.lastMessageAt,
      })),
    };
  }
  return { conv: hits[0] };
}

/** Stable stringify for flat exec-args — jsonb sorts keys on read. */
const canonArgs = (o: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/** Park a concierge action as an approval card in the rail. Unlike
 *  requestToolApproval (customer-facing gated tools) this pages nobody — the
 *  decider is the operator already reading the chat, so no alert, no Slack
 *  post, no needs_human flip. The card renders because internal channels keep
 *  internal messages that carry payload.action. */
async function parkConciergeAction(
  ctx: BuiltinCtx,
  toolName: string,
  execArgs: Record<string, unknown>,
  label: string,
  display: Record<string, unknown>,
): Promise<string> {
  const conciergeAgentId = ctx.agent?.id;
  if (!conciergeAgentId) return 'error: no agent context';
  const existing = await ctx.db
    .select()
    .from(pendingActions)
    .where(
      and(eq(pendingActions.conversationId, ctx.convId), eq(pendingActions.status, 'pending')),
    );
  if (
    existing.some(
      // jsonb normalises key order — compare args with sorted keys, not raw
      // string equality.
      (p) =>
        p.toolName === toolName &&
        canonArgs(p.args as Record<string, unknown>) === canonArgs(execArgs),
    )
  ) {
    return 'action_card: an identical card is already awaiting a decision in this chat — point the visitor at it';
  }
  const [action] = await ctx.db
    .insert(pendingActions)
    .values({
      workspaceId: ctx.workspaceId,
      agentId: conciergeAgentId,
      conversationId: ctx.convId,
      toolName,
      // A builtin descriptor, not a webhook ToolDef — decidePendingAction
      // dispatches on the `builtin` key into BUILTIN_TOOLS.
      tool: { builtin: toolName } as never,
      args: execArgs as never,
    })
    .returning();
  const [row] = await ctx.db
    .insert(messages)
    .values({
      conversationId: ctx.convId,
      direction: 'human',
      text: label,
      flags: { action_request: true },
      payload: {
        internal: true,
        event: 'action proposed',
        action: {
          id: action.id,
          tool: toolName,
          label,
          args: execArgs,
          display,
          status: 'pending',
        },
      },
    })
    .returning();
  await ctx.db
    .update(pendingActions)
    .set({ messageId: row.id })
    .where(eq(pendingActions.id, action.id));
  bus.publish(ctx.workspaceId, { type: 'message', data: toMessage(row) });
  return 'action_card: an approval card was posted to the chat — the visitor applies or dismisses it there; do not claim the change is done';
}

/** The teach_agent write path — shared by the apply_knowledge executor. */
async function applyKnowledgeEntries(
  db: Db,
  wsId: string,
  agent: typeof agents.$inferSelect,
  entry: string,
  user: { id: string; name: string | null },
): Promise<string> {
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
    return JSON.stringify({
      ok: true,
      note: 'that entry already exists — nothing added',
      agent: agent.name,
      summary: `Already in ${agent.name}'s knowledge — nothing added.`,
    });
  }
  // Keep the cached gap set stable — only "added" flags move.
  const { readGapsCache, markGapsAdded } = await import('../services/knowledgeGaps.js');
  const cache = readGapsCache(cfg);
  const gaps_cache = cache
    ? { ...cache, gaps: markGapsAdded(cache.gaps, knowledge) }
    : undefined;
  await db
    .update(agents)
    .set({ config: { ...cfg, knowledge, ...(gaps_cache ? { gaps_cache } : {}) } })
    .where(eq(agents.id, agent.id));
  await audit(db, {
    workspaceId: wsId,
    userId: user.id,
    userName: user.name,
    action: 'agent.knowledge.add',
    targetType: 'agent',
    targetId: agent.id,
    meta: { via: 'concierge', entries: added },
  });
  // Open agent pages on the visitor's workspace refresh over SSE.
  bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
  return JSON.stringify({
    ok: true,
    added,
    agent: agent.name,
    knowledge_count: knowledge.length,
    gaps_url: `${env.webOrigin}/agents/${agent.id}?tab=behavior`,
    summary: `Added to ${agent.name}'s knowledge: ${added.map((a) => `"${a.slice(0, 80)}"`).join(', ')}.`,
  });
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
        bus.publish(ws.id, { type: 'workspace', data: { id: ws.id } });
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
        bus.publish(ws.id, { type: 'workspace', data: { id: ws.id } });
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
      // Open agent pages on the visitor's workspace refresh over SSE.
      bus.publish(ws.id, { type: 'agent', data: { id: row.id } });
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
      const found = await findVisitorConversation(ctx.db, ws, q);
      if ('error' in found) return JSON.stringify(found);
      const conv = found.conv;

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
      "Propose a knowledge entry for an agent in the visitor's workspace — the fix for a recurring gap, so the agent answers it next time. Draft the entry (a factual line the agent can quote, e.g. \"Refunds under $50 are auto-approved within 24h\") and call this as soon as the proposal is reasonable — it posts an approval card in the chat, no verbal confirmation needed. Admin-only.",
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
      // Normalise now so the card shows exactly what would land — split
      // lines, strip list/markdown decoration (mirrors the approve route).
      const entries = entry
        .split('\n')
        .map((l) => l.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
        .filter(Boolean);
      if (!entries.length) return JSON.stringify({ error: 'entry text is required' });
      // Already known — a re-ask after an earlier approval parks nothing;
      // tell the concierge it's covered rather than stacking a card that
      // would no-op on approve.
      const known = new Set(
        Array.isArray((agent.config as { knowledge?: unknown } | null)?.knowledge)
          ? ((agent.config as { knowledge: string[] }).knowledge ?? [])
          : [],
      );
      const freshEntries = entries.filter((e) => !known.has(e));
      if (!freshEntries.length) {
        return 'already_known: every proposed line is already in that agent\'s knowledge — tell the visitor it\'s already covered';
      }
      return parkConciergeAction(
        ctx,
        'apply_knowledge',
        { workspace_id: ws.id, agent_id: agent.id, entry: freshEntries.join('\n') },
        `Teach ${agent.name}`,
        { agent: agent.name, entry: freshEntries.join('\n') },
      );
    },
  },
  {
    // Executor for approved teach_agent cards — available() is false so the
    // model never sees it; decidePendingAction dispatches here by name.
    name: 'apply_knowledge',
    description: 'internal — executes an approved teach_agent action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) return 'error: the decider is not a signed-in Janis user';
      const wsId = String(args.workspace_id ?? '');
      const agentId = String(args.agent_id ?? '');
      // Re-verify at decide time — the approver must still administer the
      // target workspace.
      const [member] = await ctx.db
        .select({ id: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.workspaceId, wsId),
            isNotNull(memberships.acceptedAt),
            eq(memberships.role, 'admin'),
          ),
        )
        .limit(1);
      if (!member) return 'error: needs admin rights on the target workspace';
      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, wsId)))
        .limit(1);
      if (!agent) return 'error: agent not found';
      if (!agent.hosted) return `error: ${agent.name} isn't a hosted agent`;
      return applyKnowledgeEntries(ctx.db, wsId, agent, String(args.entry ?? ''), user);
    },
  },
  {
    name: 'add_routing_rule',
    description:
      "Propose an alert/routing rule on an agent in the visitor's workspace — the same rules the Escalation tab manages: keyword match → assign/alert, inactivity timeout → assign/alert, auto_assign round-robin pool, or failure/handoff_request/custom_alert notifications. Posts an approval card — nothing is created until the visitor approves. Admin-only.",
    params: {
      agent: 'agent name (required)',
      kind: 'keyword | inactivity | auto_assign | failure | handoff_request | custom_alert (required)',
      keywords: 'keyword kind: comma-separated words/phrases to match',
      intents: 'optional: comma-separated intent labels that fire the rule',
      inactivity_minutes: 'inactivity kind: minutes of silence before firing (1-1440)',
      assign_to: 'keyword/inactivity kinds: teammate name to assign the conversation to',
      assignees: 'auto_assign kind: comma-separated teammate names for the round-robin pool',
      tag: 'optional: tag to add to the conversation when the rule fires',
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
      const wsAgents = await ctx.db.select().from(agents).where(eq(agents.workspaceId, ws.id));
      const agent = hint
        ? wsAgents.find((a) => a.name.toLowerCase() === hint) ??
          wsAgents.find((a) => a.name.toLowerCase().includes(hint))
        : undefined;
      if (!agent) {
        return JSON.stringify({
          error: `which agent? "${args.agent ?? ''}" didn't match — agents: ${wsAgents.map((a) => a.name).join(', ')}`,
        });
      }
      const kind = String(args.kind ?? '').trim();
      if (!['keyword', 'inactivity', 'auto_assign', 'failure', 'handoff_request', 'custom_alert'].includes(kind)) {
        return JSON.stringify({ error: `unknown kind "${kind}" — keyword, inactivity, auto_assign, failure, handoff_request or custom_alert` });
      }

      const members = await workspaceMembers(ctx.db, ws.id);
      const memberOf = (name: string) => {
        const h = name.trim().toLowerCase();
        return (
          members.find((m) => m.name.toLowerCase() === h) ??
          members.find((m) => m.name.toLowerCase().split(' ')[0] === h) ??
          members.find((m) => m.name.toLowerCase().includes(h))
        );
      };
      const csv = (v: unknown) =>
        String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

      const config: Record<string, unknown> = { enabled: true };
      const display: Record<string, unknown> = { agent: agent.name, kind };
      if (kind === 'keyword') {
        const kws = csv(args.keywords);
        if (!kws.length) return JSON.stringify({ error: 'keyword rules need keywords — ask which words should fire it' });
        config.keywords = kws;
        display.keywords = kws.join(', ');
      }
      if (kind === 'inactivity') {
        const mins = Number(args.inactivity_minutes);
        if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
          return JSON.stringify({ error: 'inactivity rules need inactivity_minutes (1-1440)' });
        }
        config.inactivity_minutes = mins;
        display.after = `${mins} min quiet`;
      }
      if (kind === 'keyword' || kind === 'inactivity') {
        const ints = csv(args.intents);
        if (ints.length) {
          config.intents = ints;
          display.intents = ints.join(', ');
        }
        if (args.assign_to) {
          const m = memberOf(String(args.assign_to));
          if (!m) {
            return JSON.stringify({
              error: `"${args.assign_to}" isn't a workspace member — teammates: ${members.map((x) => x.name).join(', ')}`,
            });
          }
          config.assign_to = m.id;
          display.assign_to = m.name;
        }
      }
      if (kind === 'auto_assign') {
        const names = csv(args.assignees);
        if (!names.length) return JSON.stringify({ error: 'auto_assign needs assignees — which teammates should take turns?' });
        const ids: string[] = [];
        const bad: string[] = [];
        for (const n of names) {
          const m = memberOf(n);
          if (m) ids.push(m.id);
          else bad.push(n);
        }
        if (bad.length) {
          return JSON.stringify({
            error: `${bad.join(', ')} not in the workspace — teammates: ${members.map((x) => x.name).join(', ')}`,
          });
        }
        config.assignees = ids;
        display.assignees = names.join(', ');
      }
      if (args.tag) {
        config.tag = String(args.tag).slice(0, 60);
        display.tag = config.tag;
      }
      const label =
        kind === 'keyword'
          ? `Route "${(config.keywords as string[]).join(', ')}"${display.assign_to ? ` → ${display.assign_to}` : ''}`
          : kind === 'inactivity'
            ? `Nudge after ${config.inactivity_minutes} min quiet${display.assign_to ? ` → ${display.assign_to}` : ''}`
            : kind === 'auto_assign'
              ? `Round-robin → ${display.assignees}`
              : `Alert on ${kind.replace(/_/g, ' ')}`;
      return parkConciergeAction(
        ctx,
        'apply_routing_rule',
        { workspace_id: ws.id, agent_id: agent.id, kind, config },
        `${label} — ${agent.name}`,
        display,
      );
    },
  },
  {
    // Executor for approved add_routing_rule cards — hidden from the model.
    name: 'apply_routing_rule',
    description: 'internal — executes an approved add_routing_rule action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) return 'error: the decider is not a signed-in Janis user';
      const wsId = String(args.workspace_id ?? '');
      const [member] = await ctx.db
        .select({ id: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.workspaceId, wsId),
            isNotNull(memberships.acceptedAt),
            eq(memberships.role, 'admin'),
          ),
        )
        .limit(1);
      if (!member) return 'error: needs admin rights on the target workspace';
      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, String(args.agent_id ?? '')), eq(agents.workspaceId, wsId)))
        .limit(1);
      if (!agent) return 'error: agent not found';
      const kind = String(args.kind ?? '');
      const config = (args.config ?? {}) as unknown as Record<string, unknown>;
      const [row] = await ctx.db
        .insert(alertRules)
        .values({ agentId: agent.id, kind: kind as never, config })
        .returning();
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.rule.add',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', kind, config },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        ok: true,
        rule_id: row.id,
        agent: agent.name,
        kind,
        summary: `Added a ${kind.replace(/_/g, ' ')} rule to ${agent.name}.`,
      });
    },
  },
  {
    name: 'teach_from_conversation',
    description:
      "Teach an agent from a real conversation — 'that rescue was good, add it to the bot's knowledge'. Call with just `conversation` (uuid or customer name/email) to read the transcript first, then call again with `entry` — one line per fact the human resolved — to post a Teach card against that conversation's agent. Admin-only to park.",
    params: {
      conversation: 'conversation UUID or customer name/email (required)',
      entry: 'the confirmed knowledge entry text — one line per fact (omit to read the transcript first)',
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
      const q = (args.conversation ?? '').trim();
      if (!q) return JSON.stringify({ error: 'pass a conversation id or a name/email to search for' });
      const found = await findVisitorConversation(ctx.db, ws, q);
      if ('error' in found) return JSON.stringify(found);
      const conv = found.conv;
      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(eq(agents.id, conv.agentId))
        .limit(1);
      if (!agent) return JSON.stringify({ error: 'conversation has no agent' });
      if (!agent.hosted) {
        return JSON.stringify({
          error: `${agent.name} isn't a hosted agent — knowledge entries only apply to Janis-hosted agents`,
        });
      }
      const customer =
        (conv.userProfile as { name?: string; email?: string })?.name ??
        (conv.userProfile as { email?: string })?.email ??
        conv.externalId;
      const entry = String(args.entry ?? '').trim();
      if (!entry) {
        // Read mode — hand the concierge the transcript so it can draft the
        // entry from what the human actually resolved.
        const recent = await ctx.db
          .select({ direction: messages.direction, text: messages.text, payload: messages.payload })
          .from(messages)
          .where(eq(messages.conversationId, conv.id))
          .orderBy(desc(messages.createdAt))
          .limit(30);
        const transcript = recent
          .filter((m) => !(m.payload as { internal?: boolean } | null)?.internal)
          .reverse()
          .slice(-20)
          .map((m) => ({ dir: m.direction === 'in' ? 'customer' : m.direction === 'out' ? 'agent' : 'human', text: m.text }));
        return JSON.stringify({
          conversation_id: conv.id,
          customer,
          agent: agent.name,
          url: `${env.webOrigin}/conversations/${conv.id}`,
          transcript,
          next: 'draft one knowledge line per fact the human supplied, then call again with entry to post the approval card',
        });
      }
      // Normalise now so the card shows exactly what would land (mirrors
      // teach_agent — strip list/markdown decoration).
      const entries = entry
        .split('\n')
        .map((l) => l.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
        .filter(Boolean);
      if (!entries.length) return JSON.stringify({ error: 'entry text is required' });
      const known = new Set(
        Array.isArray((agent.config as { knowledge?: unknown } | null)?.knowledge)
          ? ((agent.config as { knowledge: string[] }).knowledge ?? [])
          : [],
      );
      const freshEntries = entries.filter((e) => !known.has(e));
      if (!freshEntries.length) {
        return 'already_known: every proposed line is already in that agent\'s knowledge — tell the visitor it\'s already covered';
      }
      return parkConciergeAction(
        ctx,
        'apply_knowledge',
        {
          workspace_id: ws.id,
          agent_id: agent.id,
          entry: freshEntries.join('\n'),
          source_conversation: conv.id,
        },
        `Teach ${agent.name}`,
        {
          agent: agent.name,
          entry: freshEntries.join('\n'),
          source: `from ${customer}'s chat`,
          url: `${env.webOrigin}/conversations/${conv.id}`,
        },
      );
    },
  },
  {
    name: 'assign_conversation',
    description:
      "Assign a conversation in the visitor's workspace to a teammate — 'put that waiting one on me' or 'give it to Ann'. Posts an approval card; on approve the inbox assigns it and refreshes live. Any member can propose.",
    params: {
      conversation: 'conversation UUID or customer name/email (required)',
      assignee: "teammate name — 'me' assigns the approver (default: me)",
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
      const found = await findVisitorConversation(ctx.db, ws, q);
      if ('error' in found) return JSON.stringify(found);
      const conv = found.conv;
      const [agent] = await ctx.db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, conv.agentId))
        .limit(1);
      const members = await workspaceMembers(ctx.db, ws.id);
      const assigneeHint = (args.assignee ?? 'me').trim().toLowerCase();
      const assignee =
        assigneeHint === 'me'
          ? { id: user.id, name: user.name ?? 'you' }
          : members.find((m) => m.name?.toLowerCase() === assigneeHint) ??
            members.find((m) => (m.name ?? '').toLowerCase().includes(assigneeHint));
      if (!assignee) {
        return JSON.stringify({
          error: `"${args.assignee}" isn't a member of ${ws.name} — members: ${members.map((m) => m.name).join(', ')}`,
        });
      }
      const customer =
        (conv.userProfile as { name?: string; email?: string })?.name ??
        (conv.userProfile as { email?: string })?.email ??
        conv.externalId;
      if (conv.assigneeId === assignee.id) {
        return JSON.stringify({
          error: `${customer}'s conversation is already assigned to ${assignee.name}`,
        });
      }
      return parkConciergeAction(
        ctx,
        'apply_assignment',
        {
          workspace_id: ws.id,
          conversation_id: conv.id,
          assignee_id: assignee.id,
        },
        `Assign ${customer}`,
        {
          conversation: customer,
          agent: agent?.name,
          assignee: assignee.name,
          url: `${env.webOrigin}/conversations/${conv.id}`,
        },
      );
    },
  },
  {
    // Executor for approved assign_conversation cards — hidden from the model.
    name: 'apply_assignment',
    description: 'internal — executes an approved assign_conversation action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) return 'error: the decider is not a signed-in Janis user';
      const wsId = String(args.workspace_id ?? '');
      const [member] = await ctx.db
        .select({ id: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.workspaceId, wsId),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (!member) return 'error: needs workspace membership';
      const wsAgentIds = (
        await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, wsId))
      ).map((a) => a.id);
      if (!wsAgentIds.length) return 'error: workspace has no agents';
      const [conv] = await ctx.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, String(args.conversation_id ?? '')),
            inArray(conversations.agentId, wsAgentIds),
          ),
        )
        .limit(1);
      if (!conv) return 'error: conversation not found in that workspace';
      const assigneeId = String(args.assignee_id ?? '');
      const [stillMember] = await ctx.db
        .select({ id: memberships.userId, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(
          and(
            eq(memberships.userId, assigneeId),
            eq(memberships.workspaceId, wsId),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (!stillMember) return 'error: the assignee is no longer a member of that workspace';
      await ctx.db
        .update(conversations)
        .set({ assigneeId })
        .where(eq(conversations.id, conv.id));
      const customer =
        (conv.userProfile as { name?: string; email?: string })?.name ??
        (conv.userProfile as { email?: string })?.email ??
        conv.externalId;
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'conversation.assign',
        targetType: 'conversation',
        targetId: conv.id,
        meta: { via: 'concierge', assignee: assigneeId },
      });
      bus.publish(wsId, {
        type: 'conversation',
        data: { id: conv.id, state: conv.state },
      });
      return JSON.stringify({
        ok: true,
        summary: `Assigned ${customer}'s conversation to ${stillMember.name ?? 'the teammate'}.`,
      });
    },
  },
  {
    name: 'update_agent',
    description:
      "Propose an agent settings change in the visitor's workspace — rename, greeting text, greeting on/off, quick-reply chips, CSAT survey (enabled/prompt/thanks), handoff re-alert minutes, auto-assign, widget accent colour, or email alerts. Posts an approval card — nothing changes until the visitor approves. Admin-only.",
    params: {
      agent: 'agent name (required)',
      name: 'new agent name — renames the agent',
      greeting: 'new greeting text (blank string disables it)',
      greeting_enabled: 'true/false — send the greeting on new conversations',
      quick_replies: 'comma-separated chips shown in the widget (max 8)',
      csat_enabled: 'true/false — post-resolution satisfaction survey',
      csat_prompt: 'the survey question text',
      csat_thanks: 'the reply sent after a survey answer',
      sla_minutes: 're-alert when a handoff stays unclaimed for N minutes (1-1440)',
      auto_assign: 'true/false — route handoffs to the least-loaded teammate',
      accent: 'widget accent/bubble colour, e.g. #635bff (webchat only)',
      email_alerts: "true/false — email the approver this agent's escalation alerts",
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
      const wsAgents = await ctx.db.select().from(agents).where(eq(agents.workspaceId, ws.id));
      const agent = hint
        ? wsAgents.find((a) => a.name.toLowerCase() === hint) ??
          wsAgents.find((a) => a.name.toLowerCase().includes(hint))
        : undefined;
      if (!agent) {
        return JSON.stringify({
          error: `which agent? "${args.agent ?? ''}" didn't match — agents: ${wsAgents.map((a) => a.name).join(', ')}`,
        });
      }

      // Flat params → nested config patch. Only these keys ever reach the
      // card — the executor re-validates with the shared schema anyway.
      const patch: Record<string, unknown> = {};
      const display: Record<string, unknown> = { agent: agent.name };
      // agents.name is a column, not config — it travels as its own exec arg
      // so the patch stays AgentConfig-shaped for the executor's validation.
      const rename = args.name !== undefined ? String(args.name).trim().slice(0, 80) : '';
      if (args.name !== undefined) {
        if (!rename) return JSON.stringify({ error: 'name cannot be blank' });
        if (rename !== agent.name) display.name = `${agent.name} → ${rename}`;
      }
      const bool = (v: unknown) => ['true', 'yes', 'on', '1'].includes(String(v).toLowerCase());
      const cur = (agent.config ?? {}) as Record<string, unknown>;
      const curCsat = (cur.csat ?? {}) as Record<string, unknown>;
      if (args.greeting !== undefined) {
        patch.greeting = String(args.greeting).slice(0, 500);
        display.greeting = patch.greeting || '(disabled)';
      }
      if (args.greeting_enabled !== undefined) {
        patch.greeting_enabled = bool(args.greeting_enabled);
        display.greeting = patch.greeting_enabled ? 'on' : 'off';
      }
      if (args.quick_replies !== undefined) {
        const qr = String(args.quick_replies).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
        patch.quick_replies = qr;
        display.quick_replies = qr.join(', ') || '(none)';
      }
      const csatPatch: Record<string, unknown> = {};
      if (args.csat_enabled !== undefined) {
        csatPatch.enabled = bool(args.csat_enabled);
        display.csat = csatPatch.enabled ? 'on' : 'off';
      }
      if (args.csat_prompt !== undefined) {
        csatPatch.prompt = String(args.csat_prompt).slice(0, 500);
        display.csat_prompt = csatPatch.prompt;
      }
      if (args.csat_thanks !== undefined) {
        csatPatch.thanks = String(args.csat_thanks).slice(0, 500);
        display.csat_thanks = csatPatch.thanks;
      }
      if (Object.keys(csatPatch).length) {
        patch.csat = { ...curCsat, ...csatPatch };
      }
      if (args.sla_minutes !== undefined) {
        const mins = Number(args.sla_minutes);
        if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
          return JSON.stringify({ error: 'sla_minutes must be 1-1440' });
        }
        patch.sla_minutes = mins;
        display.re_alert_after = `${mins} min`;
      }
      if (args.auto_assign !== undefined) {
        patch.auto_assign = bool(args.auto_assign);
        display.auto_assign = patch.auto_assign ? 'on' : 'off';
      }
      // Widget accent lives on the webchat channel's credentials, not
      // agents.config — it travels as its own exec arg like `rename`.
      const accent = args.accent !== undefined ? String(args.accent).trim().slice(0, 40) : '';
      if (args.accent !== undefined) {
        if (accent && !/^#[0-9a-f]{3,8}$/i.test(accent)) {
          return JSON.stringify({ error: 'accent must be a hex colour like #635bff' });
        }
        display.accent = accent || '(default)';
      }
      // Email alerts are the approver's own per-agent notify override — an
      // agent_members write, also outside agents.config.
      const emailAlerts = args.email_alerts !== undefined ? bool(args.email_alerts) : undefined;
      if (emailAlerts !== undefined) display.email_alerts = emailAlerts ? 'on' : 'off';
      const willRename = rename !== '' && rename !== agent.name;
      if (
        !Object.keys(patch).length &&
        !willRename &&
        args.accent === undefined &&
        emailAlerts === undefined
      ) {
        return JSON.stringify({
          error: 'nothing to change — pass at least one of name, greeting, greeting_enabled, quick_replies, csat_*, sla_minutes, auto_assign, accent, email_alerts',
        });
      }
      const extras =
        !Object.keys(patch).length && !willRename
          ? accent
            ? 'Recolour'
            : 'Update'
          : willRename && !Object.keys(patch).length
            ? 'Rename'
            : 'Update';
      return parkConciergeAction(
        ctx,
        'apply_agent_config',
        {
          workspace_id: ws.id,
          agent_id: agent.id,
          patch,
          ...(willRename ? { rename } : {}),
          ...(args.accent !== undefined ? { accent } : {}),
          ...(emailAlerts !== undefined ? { email_alerts: String(emailAlerts) } : {}),
        },
        `${extras} ${agent.name}`,
        display,
      );
    },
  },
  {
    // Executor for approved update_agent cards — hidden from the model.
    name: 'apply_agent_config',
    description: 'internal — executes an approved update_agent action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) return 'error: the decider is not a signed-in Janis user';
      const wsId = String(args.workspace_id ?? '');
      const [member] = await ctx.db
        .select({ id: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.workspaceId, wsId),
            isNotNull(memberships.acceptedAt),
            eq(memberships.role, 'admin'),
          ),
        )
        .limit(1);
      if (!member) return 'error: needs admin rights on the target workspace';
      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, String(args.agent_id ?? '')), eq(agents.workspaceId, wsId)))
        .limit(1);
      if (!agent) return 'error: agent not found';
      // Re-validate the proposed patch against the shared schema — an
      // approved card must never write keys the console wouldn't accept.
      const ALLOWED = [
        'greeting',
        'greeting_enabled',
        'quick_replies',
        'csat',
        'sla_minutes',
        'auto_assign',
      ];
      const patch = (args.patch ?? {}) as unknown as Record<string, unknown>;
      const clean = Object.fromEntries(
        Object.entries(patch).filter(([k]) => ALLOWED.includes(k)),
      );
      const rename = String(args.rename ?? '').trim().slice(0, 80);
      const accent = args.accent !== undefined ? String(args.accent).trim().slice(0, 40) : null;
      const emailAlerts =
        args.email_alerts !== undefined ? args.email_alerts === 'true' : undefined;
      if (
        !Object.keys(clean).length &&
        !rename &&
        accent === null &&
        emailAlerts === undefined
      ) {
        return 'error: empty or disallowed patch';
      }
      if (accent !== null && accent !== '' && !/^#[0-9a-f]{3,8}$/i.test(accent)) {
        return 'error: accent must be a hex colour like #635bff';
      }
      if (Object.keys(clean).length) {
        const check = AgentConfig.partial().safeParse(clean);
        if (!check.success) return `error: invalid settings — ${check.error.issues[0]?.message}`;
      }
      const set: Record<string, unknown> = {};
      if (Object.keys(clean).length) set.config = { ...(agent.config as object), ...clean };
      if (rename && rename !== agent.name) set.name = rename;
      if (Object.keys(set).length) {
        await ctx.db.update(agents).set(set).where(eq(agents.id, agent.id));
      }
      const applied = [...Object.keys(clean), ...(rename && rename !== agent.name ? ['name'] : [])];
      if (accent !== null) {
        // Widget accent is channel credentials, not agent config — repaint
        // every webchat channel the agent fronts.
        const webChans = await ctx.db
          .select({ id: channels.id, credentials: channels.credentials })
          .from(channels)
          .where(and(eq(channels.agentId, agent.id), eq(channels.kind, 'webchat')));
        for (const ch of webChans) {
          const creds = { ...((ch.credentials ?? {}) as Record<string, unknown>) };
          if (accent === '') delete creds.accent;
          else creds.accent = accent;
          await ctx.db
            .update(channels)
            .set({ credentials: creds })
            .where(eq(channels.id, ch.id));
        }
        invalidateChannelCache();
        applied.push('accent');
      }
      if (emailAlerts !== undefined) {
        // The decider's own per-agent notify override — null fields inherit
        // their workspace prefs, so merge only the email flag.
        const [self] = await ctx.db
          .select({ notifyPrefs: agentMembers.notifyPrefs })
          .from(agentMembers)
          .where(
            and(eq(agentMembers.agentId, agent.id), eq(agentMembers.userId, user.id)),
          )
          .limit(1);
        const prefs = { ...((self?.notifyPrefs ?? {}) as Record<string, unknown>), email: emailAlerts };
        await ctx.db
          .insert(agentMembers)
          .values({ agentId: agent.id, userId: user.id, notifyPrefs: prefs, acceptedAt: new Date() })
          .onConflictDoUpdate({
            target: [agentMembers.agentId, agentMembers.userId],
            set: { notifyPrefs: prefs },
          });
        applied.push('email_alerts');
      }
      if (!applied.length) return 'error: nothing to change';
      const newName = rename && rename !== agent.name ? rename : agent.name;
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.config.update',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', fields: applied },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        ok: true,
        agent: newName,
        applied,
        summary:
          applied.length === 1 && applied[0] === 'name'
            ? `Renamed ${agent.name} to ${newName}.`
            : `Updated ${newName}: ${applied.join(', ')}.`,
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
