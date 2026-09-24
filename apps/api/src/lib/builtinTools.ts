import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, memberships, users, workspaces } from '../db/schema.js';
import type { UserProfile } from '@janis/shared';
import { env } from '../env.js';
import { planFor } from './plans.js';

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
      const [conv] = await ctx.db
        .select({ userProfile: conversations.userProfile })
        .from(conversations)
        .where(eq(conversations.id, ctx.convId))
        .limit(1);
      const p = (conv?.userProfile ?? {}) as UserProfile;
      const userId = p.identity_verified ? (p.external_id as string | undefined) : undefined;
      if (!userId) {
        return JSON.stringify({ signed_in: false, note: 'visitor is not a signed-in Janis user' });
      }
      const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return JSON.stringify({ signed_in: false, note: 'account not found' });
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
