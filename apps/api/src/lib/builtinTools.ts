import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, conversations, memberships, users, workspaces } from '../db/schema.js';
import type { UserProfile } from '@janis/shared';
import { env } from '../env.js';
import { invalidateCapCache, planFor, PLANS } from './plans.js';
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
            (r) => r.ws.name.toLowerCase() === hint || r.ws.name.toLowerCase().includes(hint),
          )?.ws
        : adminRows.length === 1
          ? adminRows[0].ws
          : undefined;
      if (!ws) {
        return JSON.stringify({
          error: adminRows.length
            ? `which workspace? ${user.name} administers: ${adminRows.map((r) => r.ws.name).join(', ')}`
            : 'no workspace where the visitor is an admin — creating an agent needs admin rights',
        });
      }
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
