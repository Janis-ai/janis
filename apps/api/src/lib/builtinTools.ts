import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  agents,
  agentMembers,
  agentTests,
  agentWidgets,
  alerts,
  alertRules,
  channelBindings,
  channels,
  contactIdentities,
  contacts,
  conversations,
  errorReports,
  helpArticles,
  knowledgeFiles,
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
import { ensureBotKey } from './botKey.js';
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
import { normWidgetRef, WidgetComponent, WidgetState, WidgetToolBinding } from './widgets.js';
import { toolsFor } from './toolExec.js';
import { agentRoleFor, type AgentRole, type AgentScope } from './access.js';
import { backfillSentimentAlerts } from './intent.js';
import { fetchUrlText, normalizeSourceUrl } from './urlSource.js';
import { importHelpCentre } from './helpCentreImport.js';
import { MAX_KNOWLEDGE_SOURCES } from './helpCentreImport.js';
import type { BuilderDraft } from './agentBuilder.js';

/** Context a builtin can reach — matches AgentRunContext in hostedAgent. */
export interface BuiltinCtx {
  db: Db;
  convId: string;
  workspaceId: string;
  /** The agent this conversation belongs to — the concierge for Ask Janis. */
  agent?: { id: string; workspaceId: string };
  /** Embedded merchant-Ask runs pin workspace resolution to the shop's bound
   *  workspace — Shopify staff have no Janis membership to resolve through,
   *  and the session token is already proof of staff status on that shop. */
  pinWorkspaceId?: string;
}

/**
 * Built-in tools — run in-process rather than over HTTP. Enabled per agent via
 * config.builtin_tools; each entry is only offered to the model when its
 * `available()` check passes (e.g. the required platform env key is set, or
 * the agent lives in the operator workspace for account_status).
 *
 * DRIFT WARNING: builtin_tools is an allowlist in agent config — shipping a
 * new concierge builtin does NOT enable it on the Ask Janis agent. After
 * adding an operator-workspace builtin, append its name to the concierge
 * agent's config.builtin_tools in prod, or it silently doesn't exist.
 */
export interface BuiltinTool {
  name: string;
  description: string;
  /** JSON-schema-ish params the model fills, same shape as ToolDef.params. */
  params?: Record<string, string>;
  available: (workspaceId?: string) => boolean;
  /** True for builtins a customer may arm on their own agents (the
   *  "Platform tools" card). Operator-gated tools omit this — they stay
   *  concierge-only no matter which workspace the agent lives in. */
  platform?: boolean;
  /** Offered to UNVERIFIED visitors on the operator concierge — read-only
   *  public tools only (web_search/web_fetch). Everything else is hidden
   *  from unsigned conversations: the model can't call what it can't see,
   *  so a forgotten signedInUser check can't become an info leak. */
  publicAnon?: boolean;
  /** run() parks an approval card — never offered in a suggestion run,
   *  where a draft staging another draft's card is nonsense. */
  parksCard?: true;
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

/** A fabricated resource id passes every syntactic check — verify *_id
 *  args against the tool family's *_list sibling when the agent has one
 *  (gsheets_append → gsheets_list). Fail only when the list ran and the
 *  id isn't in it; a list-tool error can't prove the id is fake, and
 *  {field} placeholders resolve at submit time so they skip the check. */
async function verifyBindingIds(
  ctx: BuiltinCtx,
  agent: typeof agents.$inferSelect,
  defs: ReturnType<typeof toolsFor>,
  toolName: string,
  argMap: Record<string, string> | undefined,
): Promise<string | null> {
  const prefix = toolName.split('_')[0];
  const listDef = defs.find((t) => t.name === `${prefix}_list`);
  if (!listDef || listDef.approval) return null;
  const idArgs = Object.entries(argMap ?? {}).filter(
    ([k, v]) => /_id$/i.test(k) && v && !v.includes('{'),
  );
  if (!idArgs.length) return null;
  const { loadSecretsMap } = await import('./secrets.js');
  const { connectionSecrets } = await import('./connections.js');
  const { callTool } = await import('./toolExec.js');
  const secrets = {
    ...(await loadSecretsMap(ctx.db, agent.id)),
    ...(await connectionSecrets(ctx.db, agent.id)),
  };
  const listing = await callTool(listDef, {}, secrets).catch(() => 'error: unreachable');
  if (listing.startsWith('error')) return null;
  const missing = idArgs.filter(([, v]) => !listing.includes(String(v)));
  if (!missing.length) return null;
  return `${prefix}_list doesn't know ${missing
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ')} — call ${prefix}_list and use a real id from its result, not an invented one`;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Context-pack names come decorated — "Name <agent-uuid> (webchat:chan-uuid)".
 *  A hint the model echoes verbatim must still resolve: strip the
 *  decorations, leaving the bare name (or the bare uuid for id matching). */
function cleanHint(hint: string | undefined): string {
  return String(hint ?? '')
    .replace(/<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>/gi, '')
    .replace(/\([a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/gi, '')
    .trim();
}

/** Executor args arrive as jsonb — object-typed params should already be
 *  objects, but tolerate a JSON string (older rows, manual rows). */
function argObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown;
      return p && typeof p === 'object' && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return (v ?? {}) as Record<string, unknown>;
}

/** argObject variants for nullable + array args — blank/'null' → null. */
function argObjectOrNull(v: unknown): Record<string, unknown> | null {
  if (v == null || v === '' || v === 'null' || v === 'undefined') return null;
  const o = argObject(v);
  return Object.keys(o).length ? o : null;
}

function argObjectArray(v: unknown): unknown[] | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      return Array.isArray(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }
  return Array.isArray(v) ? v : undefined;
}

/** The model spells "no binding" as {"name":"none"} often enough that
 *  erroring on it just burns a retry — treat the sentinel names as absent. */
function toolBindingOrNull(v: WidgetToolBinding | null): WidgetToolBinding | null {
  return v && !['none', 'null', 'n/a'].includes((v.name ?? '').trim().toLowerCase()) ? v : null;
}

/** Resolve which of the visitor's workspaces a concierge tool should act on.
 * Order: explicit `workspace` name hint → the workspace they're currently
 * viewing (the context pack's current_workspace trait) → their only
 * membership → a "which workspace?" result listing the options. adminOnly
 * narrows to workspaces they administer; read-only tools accept any
 * accepted membership. A bad/absent hint is a model-correctable miss, not
 * breakage — like findVisitorConversation it returns a result object, since
 * {"error"} marks the call failed and fires a Run-error alert. */
async function visitorWorkspace(
  ctx: BuiltinCtx,
  user: { id: string; name: string | null },
  hint: string | undefined,
  opts: { adminOnly?: boolean } = {},
): Promise<
  { ws: WorkspaceRow } | { error: string } | { result: string; hint: string; workspaces: string[] }
> {
  // Embedded merchant-Ask: the shop's bound workspace is the whole universe
  // — there's no "which workspace?" ambiguity, and the staff member's Shopify
  // session is the trust (they may hold no Janis membership at all). Member-
  // level tools pass for any verified staff; adminOnly writes still require
  // an admin membership — except on an ownerless auto-provisioned workspace,
  // where no admin exists to defer to and the shop's staff act as operators
  // (same first-redeemer-owns-it model as the magic-link claim path).
  if (ctx.pinWorkspaceId) {
    const [ws] = await ctx.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, ctx.pinWorkspaceId))
      .limit(1);
    if (!ws) return { error: 'the shop\u2019s workspace no longer exists' };
    if (opts.adminOnly) {
      const [adm] = await ctx.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.workspaceId, ws.id),
            eq(memberships.role, 'admin'),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (!adm) {
        const [anyMember] = await ctx.db
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.workspaceId, ws.id), isNotNull(memberships.acceptedAt)))
          .limit(1);
        if (anyMember) {
          return {
            error:
              'this needs workspace admin rights — the workspace owner can grant them via console access (Settings → Team)',
          };
        }
      }
    }
    return { ws };
  }
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
  const needle = cleanHint(hint).toLowerCase();
  if (needle) {
    const hit =
      rows.find(
        (r) => r.ws.name.toLowerCase() === needle || r.ws.name.toLowerCase().includes(needle),
      ) ?? rows.find((r) => needle.includes(r.ws.name.toLowerCase()));
    if (hit) return { ws: hit.ws };
    return {
      result: 'no_matching_workspace',
      hint: `"${hint}" didn't match — pass one of the visitor's workspaces or omit workspace to use the one they're viewing`,
      workspaces: rows.map((r) => r.ws.name),
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
    result: 'ambiguous_workspace',
    hint: `which workspace? ${user.name ?? 'The visitor'} has several — pass one`,
    workspaces: rows.map((r) => r.ws.name),
  };
}

/** Resolve which agent of a workspace a concierge tool should act on.
 * Order: explicit `agent` name hint → the agent selected in the console
 * (the context pack's current_agent trait) → a "which agent?" result
 * listing the options. `current` echoes the console selection so callers
 * can flag when an explicit hint lands on a different (possibly stale)
 * agent. A bad/absent hint is a model-correctable miss — a result object,
 * not {"error"} (call failure + Run-error alert). */
async function visitorAgent(
  ctx: BuiltinCtx,
  ws: WorkspaceRow,
  hint: string | undefined,
): Promise<
  | { agent: typeof agents.$inferSelect; current?: string }
  | { error: string }
  | { result: string; hint: string; agents: string[] }
> {
  const wsAgents = await ctx.db.select().from(agents).where(eq(agents.workspaceId, ws.id));
  const [conv] = await ctx.db
    .select({ userProfile: conversations.userProfile })
    .from(conversations)
    .where(eq(conversations.id, ctx.convId))
    .limit(1);
  const meta = (conv?.userProfile as UserProfile | undefined)?.metadata ?? {};
  const current = String(meta.current_agent ?? '');
  const cleaned = cleanHint(hint);
  const needle = cleaned.toLowerCase();
  if (needle) {
    const agent =
      (UUID.test(cleaned) ? wsAgents.find((a) => a.id === cleaned) : undefined) ??
      wsAgents.find((a) => a.name.toLowerCase() === needle) ??
      wsAgents.find((a) => a.name.toLowerCase().includes(needle)) ??
      wsAgents.find((a) => needle.includes(a.name.toLowerCase()));
    if (agent) return { agent, current: current || undefined };
    return {
      result: 'no_matching_agent',
      hint: `"${hint}" didn't match — pass one of the workspace's agents or omit agent to use the selected one`,
      agents: wsAgents.map((a) => a.name),
    };
  }
  const curHit = current
    ? wsAgents.find((a) => a.name.toLowerCase() === current.toLowerCase())
    : undefined;
  if (curHit) return { agent: curHit };
  if (wsAgents.length === 1) return { agent: wsAgents[0] };
  return {
    result: 'ambiguous_agent',
    hint: `which agent? ${ws.name} has several — pass one`,
    agents: wsAgents.map((a) => a.name),
  };
}

/** Caution appended to a tool result when the resolved agent isn't the one
 *  the visitor has selected — a stale topic can land changes on the wrong
 *  agent, and the model can't see the console selection to notice. */
function offSelectionNote(picked: { agent: { name: string }; current?: string }): string {
  return picked.current && picked.current.toLowerCase() !== picked.agent.name.toLowerCase()
    ? ` NOTE: this targets "${picked.agent.name}" but the visitor's console has "${picked.current}" selected — name the target agent in your reply so they can catch a mix-up, or retry with agent="${picked.current}" if they meant the selected one.`
    : '';
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
  // A name/email/phone search should also match the unified contact — the
  // person often has a real record even when a thread's own userProfile is
  // thin (anonymous webchat, a PSID-only Messenger visitor).
  const contactIds = (
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, ws.id),
          or(
            ilike(contacts.name, pat),
            ilike(contacts.email, pat),
            ilike(contacts.phone, pat),
          ),
        ),
      )
      .limit(25)
  ).map((c) => c.id);
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
          ...(contactIds.length ? [inArray(conversations.contactId, contactIds)] : []),
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

/** The console page the operator is on right now — the concierge context
 *  pack stamps userProfile.metadata.page with the URL they're viewing
 *  ('/conversations/<uuid>', '/agents/<id>/inbox/<uuid>', '/contacts/<uuid>').
 *  "This conversation" / "this user here" resolve through it instead of the
 *  model transcribing a uuid from the prompt — it got it wrong twice in prod. */
async function currentView(
  ctx: BuiltinCtx,
): Promise<{ conversationId?: string; contactId?: string }> {
  const [conv] = await ctx.db
    .select({ userProfile: conversations.userProfile })
    .from(conversations)
    .where(eq(conversations.id, ctx.convId))
    .limit(1);
  const meta = (((conv?.userProfile ?? {}) as UserProfile).metadata ?? {}) as Record<
    string,
    unknown
  >;
  const page = String(meta.page ?? '');
  return {
    conversationId:
      page.match(/\/conversations\/([0-9a-f-]{36})\b/i)?.[1] ??
      page.match(/\/inbox\/([0-9a-f-]{36})\b/i)?.[1],
    contactId: page.match(/\/contacts\/([0-9a-f-]{36})\b/i)?.[1],
  };
}

/** Which conversation a reply-targeting tool (stage_reply / send_reply)
 *  means. The open console page wins over whatever the model passed — it
 *  has sent a bare name and a real-but-wrong uuid before; the page is what
 *  the operator is actually looking at. Only when no conversation page is
 *  open does a uuid-shaped arg pin the target. */
async function resolveReplyTarget(
  ctx: BuiltinCtx,
  rawConversationArg: unknown,
): Promise<{ id: string } | { error: string }> {
  const arg = String(rawConversationArg ?? '').trim();
  const page = (await currentView(ctx)).conversationId;
  if (page && page !== ctx.convId) return { id: page };
  if (/^[0-9a-f-]{36}$/i.test(arg) && arg !== ctx.convId) return { id: arg };
  if (page === ctx.convId || arg === ctx.convId) {
    return {
      error:
        'the open page is this chat, not a customer conversation — ask them to open the conversation to message',
    };
  }
  return { error: 'no conversation open — ask them to open the conversation they mean' };
}

/** Load a conversation + its agent and prove the user can reply in it —
 *  the same scope/role resolution the console session middleware builds:
 *  workspace members carry a hidden-agent list, agent-scoped users carry
 *  grants. Returns the scope so the caller's write path re-enforces it. */
export async function conversationAccess(
  db: Db,
  userId: string,
  convId: string,
): Promise<
  | {
      conv: typeof conversations.$inferSelect;
      agent: typeof agents.$inferSelect;
      scope: AgentScope;
      role: AgentRole;
    }
  | { error: string }
> {
  const [row] = await db
    .select({ conv: conversations, agent: agents })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!row) return { error: 'that conversation does not exist' };
  const { conv, agent } = row;

  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, agent.workspaceId),
        isNotNull(memberships.acceptedAt),
      ),
    )
    .limit(1);

  let scope: AgentScope;
  let workspaceRole: AgentRole;
  if (member) {
    const hiddenRows = await db
      .select({ agentId: agentMembers.agentId })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, userId),
          eq(agents.workspaceId, agent.workspaceId),
          eq(agentMembers.role, 'hidden'),
          isNotNull(agentMembers.acceptedAt),
        ),
      );
    scope = { grants: null, hidden: hiddenRows.map((h) => h.agentId) };
    workspaceRole = member.role as AgentRole;
  } else {
    const granted = await db
      .select({ agentId: agentMembers.agentId, role: agentMembers.role })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, userId),
          eq(agents.workspaceId, agent.workspaceId),
          isNotNull(agentMembers.acceptedAt),
        ),
      );
    const usable = granted.filter((g) => g.role !== 'hidden');
    if (!usable.length) return { error: "you don't have access to that conversation" };
    scope = {
      grants: Object.fromEntries(usable.map((g) => [g.agentId, (g.role ?? 'member') as AgentRole])),
      hidden: [],
    };
    workspaceRole = 'viewer'; // no workspace role — the grant map decides
  }

  const role = await agentRoleFor(db, userId, workspaceRole, scope, agent.id, agent.workspaceId);
  if (!role) return { error: "you don't have access to that conversation" };
  if (role === 'viewer') return { error: "viewers can't send replies" };
  return { conv, agent, scope, role };
}

/** Shared reply composer for stage_reply / send_reply: text + components.
 *  The concierge writes `WIDGET_REF: name` inline in the text instead of
 *  the widgets arg — pull each occurrence into a real ref (optional JSON
 *  data object straight after the name) and strip the token so it never
 *  reaches the customer. Refs resolve through the target agent's saved
 *  components exactly like the suggestion path. */
async function composeReply(
  ctx: BuiltinCtx,
  agent: typeof agents.$inferSelect,
  workspaceId: string,
  convId: string,
  args: Record<string, unknown>,
): Promise<{ text: string; widgets: WidgetComponent[]; failures: string[] }> {
  let text = String(args.text ?? args.message ?? '').trim();
  const rawWidgets: unknown[] = [...(argObjectArray(args.widgets) ?? [])];
  const REF = /WIDGET_REF:\s*([a-z0-9_-]+)\s*(\{[^\n{}]*\})?/gi;
  for (const m of text.matchAll(REF)) {
    let data: Record<string, unknown> | undefined;
    if (m[2]) {
      try {
        data = JSON.parse(m[2]) as Record<string, unknown>;
      } catch {
        /* malformed ref data — resolve bare */
      }
    }
    rawWidgets.push({ ref: m[1], ...(data ? { data } : {}) });
  }
  text = text
    .replace(REF, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const { resolveWidgetRef } = await import('./hostedAgent.js');
  const { loadSecretsMap } = await import('./secrets.js');
  const { connectionSecrets } = await import('./connections.js');
  const agentToolDefs = toolsFor(agent);
  const refSpecs = new Map<string, import('./hostedAgent.js').SavedWidgetDef>();
  for (const w of await ctx.db
    .select({
      name: agentWidgets.name,
      description: agentWidgets.description,
      spec: agentWidgets.spec,
      states: agentWidgets.states,
      tool: agentWidgets.tool,
    })
    .from(agentWidgets)
    .where(eq(agentWidgets.agentId, agent.id))) {
    const spec = WidgetComponent.safeParse(w.spec);
    if (!spec.success) continue;
    const states = z.array(WidgetState).safeParse(w.states ?? []);
    const tool = w.tool ? WidgetToolBinding.safeParse(w.tool) : null;
    refSpecs.set(normWidgetRef(w.name), {
      spec: spec.data,
      states: states.success ? states.data : undefined,
      tool: tool?.success ? tool.data : undefined,
      description: w.description ?? undefined,
    });
  }
  const secrets = {
    ...(await loadSecretsMap(ctx.db, agent.id)),
    ...(await connectionSecrets(ctx.db, agent.id)),
  };
  const runCtx = {
    db: ctx.db,
    convId,
    workspaceId,
    agent,
    suggesting: true as const,
  };
  const widgets: WidgetComponent[] = [];
  const failures: string[] = [];
  for (const w of rawWidgets.slice(0, 3)) {
    const ref = (w as { ref?: unknown }).ref;
    if (typeof ref === 'string') {
      const def = refSpecs.get(normWidgetRef(ref));
      if (!def) {
        failures.push(`"${ref}" is not a saved component on ${agent.name}`);
        continue;
      }
      const spec = await resolveWidgetRef(
        def,
        (w as { data?: Record<string, unknown> }).data,
        agentToolDefs,
        secrets,
        runCtx,
        new Set<string>(),
        undefined,
        undefined,
        ref,
      );
      if (spec) widgets.push(spec);
      else failures.push(`"${ref}" resolved to nothing (bound tool missing, gated, or errored)`);
    } else {
      const spec = WidgetComponent.safeParse(w);
      if (spec.success) widgets.push(spec.data);
      else failures.push(`a component spec failed validation (${spec.error.issues[0]?.message})`);
    }
  }
  return { text, widgets, failures };
}

/** Name for a reply card — the customer's profile name, else email. */
function replyTargetName(conv: typeof conversations.$inferSelect): string {
  const p = (conv.userProfile ?? {}) as UserProfile;
  return p.name ?? p.email ?? 'the customer';
}

/** The visitor-context block a conversation's userProfile carries — for a
 *  signed-in Janis user it's their console context (their agents, their
 *  workspaces, the page they're on); for a customer it's whatever the host
 *  site asserted. This is how "what are their agents" gets answered. */
function visitorContext(
  profile: unknown,
  externalId: string,
): Record<string, unknown> {
  const p = (profile ?? {}) as UserProfile;
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  // Janis context traits carry their <uuid> decorations verbatim — the
  // prompt renders names only, so this is where the concierge actually gets
  // the ids when it needs to mint a link or pin a call to one agent.
  const valCap = meta.janis_account === 'yes' ? 6000 : 300;
  const traits = Object.fromEntries(
    Object.entries(meta)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v) !== '')
      .map(([k, v]) => [k, String(v).slice(0, valCap)]),
  );
  return {
    external_id: externalId,
    name: p.name ?? null,
    email: p.email ?? null,
    identity_verified: p.identity_verified === true,
    ...(p.identity_verified && p.external_id ? { janis_user_id: p.external_id } : {}),
    ...(Object.keys(traits).length ? { traits } : {}),
  };
}

/** The contact block shared by lookup_contact and read_conversation — the
 *  person's record plus every channel identity they're reachable on, so an
 *  answer can tie a conversation back to the human behind it. */
async function contactSummary(db: Db, contact: typeof contacts.$inferSelect) {
  const identities = await db
    .select({
      kind: channels.kind,
      channelName: channels.name,
      platformUserId: contactIdentities.platformUserId,
      optedOutAt: contactIdentities.optedOutAt,
    })
    .from(contactIdentities)
    .innerJoin(channels, eq(contactIdentities.channelId, channels.id))
    .where(eq(contactIdentities.contactId, contact.id));
  return {
    contact_id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    alt_emails: contact.altEmails,
    alt_phones: contact.altPhones,
    tags: contact.tags,
    notes: contact.notes,
    traits: contact.metadata,
    external_ids: contact.externalIds,
    reachable_via: identities.map((i) => ({
      channel: `${i.kind} (${i.channelName})`,
      platform_user_id: i.platformUserId,
      ...(i.optedOutAt ? { opted_out: true } : {}),
    })),
    url: `${env.webOrigin}/contacts/${contact.id}`,
  };
}

/** A contact's linked conversations, newest first — the "has this person
 *  talked to us before" half of the record. */
async function contactConversations(db: Db, contactId: string) {
  const convs = await db
    .select({
      id: conversations.id,
      state: conversations.state,
      agentName: agents.name,
      externalId: conversations.externalId,
      userProfile: conversations.userProfile,
      lastMessageAt: conversations.lastMessageAt,
      lastMessagePreview: conversations.lastMessagePreview,
    })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.contactId, contactId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(10);
  return convs.map((v) => ({
    conversation_id: v.id,
    agent: v.agentName,
    state: v.state,
    last_message_at: v.lastMessageAt,
    last_message_preview: v.lastMessagePreview,
    visitor: visitorContext(v.userProfile, v.externalId),
    url: `${env.webOrigin}/conversations/${v.id}`,
  }));
}

/** Stable stringify for flat exec-args — jsonb sorts keys on read. */
const canonArgs = (o: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/** Deep-canonical form — nested objects sort keys recursively so a jsonb
 *  round-trip (Postgres reorders keys) compares equal. */
const canonDeep = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, i]) => [k, canonDeep(i)]),
        )
      : v;
const canonDeepEq = (a: unknown, b: unknown) =>
  JSON.stringify(canonDeep(a)) === JSON.stringify(canonDeep(b));

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
  /** When set, a pending action matching this predicate is the SAME
   *  proposal being revised — its args are updated in place instead of
   *  stacking a second card the decider could approve stale. */
  reviseMatch?: (p: typeof pendingActions.$inferSelect) => boolean,
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
      (p) => p.toolName === toolName && canonDeepEq(p.args, execArgs),
    )
  ) {
    return 'action_card: an identical card is already awaiting a decision in this chat — point the visitor at it';
  }
  const revise = reviseMatch ? existing.find(reviseMatch) : undefined;
  if (revise) {
    // Guard status in the UPDATE so a decide that lands mid-revise isn't
    // resurrected — zero rows means the card was already decided and a
    // fresh one parks below.
    const [updated] = await ctx.db
      .update(pendingActions)
      .set({ args: execArgs as never })
      .where(and(eq(pendingActions.id, revise.id), eq(pendingActions.status, 'pending')))
      .returning();
    if (updated) {
      if (revise.messageId) {
        const [msg] = await ctx.db
          .select()
          .from(messages)
          .where(eq(messages.id, revise.messageId))
          .limit(1);
        if (msg) {
          const p = (msg.payload ?? {}) as Record<string, unknown>;
          const a = (p.action ?? {}) as Record<string, unknown>;
          const [upd] = await ctx.db
            .update(messages)
            .set({
              payload: {
                ...p,
                action: { ...a, label, args: execArgs, display },
              },
            })
            .where(eq(messages.id, msg.id))
            .returning();
          bus.publish(ctx.workspaceId, { type: 'message', data: toMessage(upd) });
        }
      }
      return 'action_card: the approval card already in this chat was updated with the revised details — the visitor applies or dismisses it there; do not claim the change is done';
    }
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
    gaps_url: `${env.webOrigin}/agents/${agent.id}/knowledge`,
    summary: `Added to ${agent.name}'s knowledge: ${added.map((a) => `"${a.slice(0, 80)}"`).join(', ')}.`,
  });
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information, links, products or answers. Returns titles, URLs and snippets.',
    params: { q: 'search query' },
    platform: true,
    publicAnon: true,
    available: () => env.searchApiKey.length > 0 || env.searchBaseUrl.length > 0,
    run: async (args) => {
      const q = encodeURIComponent(args.q ?? '');
      // the endpoint is gated by a shared secret enforced by an auth shim
      // in the searxng container — Bearer token on every call
      const res = env.searchBaseUrl
        ? await fetch(`${env.searchBaseUrl}/search?q=${q}&format=json`, {
            headers: {
              accept: 'application/json',
              ...(env.searchToken ? { authorization: `Bearer ${env.searchToken}` } : {}),
            },
            signal: AbortSignal.timeout(10_000),
          })
        : await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
            headers: { 'X-Subscription-Token': env.searchApiKey, accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
      if (!res.ok) return `error: search failed (${res.status})`;
      const data = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string }[];
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      const raw = env.searchBaseUrl
        ? (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
        : (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
      return JSON.stringify(raw.slice(0, 5));
    },
  },
  {
    name: 'web_fetch',
    description:
      'Open a web page and read its text. Use after web_search when a live value matters (a stock price, a schedule) — snippets are indexed and can be stale, the page itself is current.',
    params: { url: 'page URL — typically a result returned by web_search' },
    platform: true,
    publicAnon: true,
    available: () => env.searchApiKey.length > 0 || env.searchBaseUrl.length > 0,
    run: async (args) => {
      const url = (args.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) return 'error: url must start with http(s)://';
      try {
        const { text, finalUrl } = await fetchUrlText(url);
        return JSON.stringify({ url: finalUrl, text: text.slice(0, 6000) });
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : 'fetch failed'}`;
      }
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
      // Agent-scoped grants sit in the console switcher alongside member
      // workspaces — a membership-only list makes the concierge deny an
      // "agent access" workspace exists. Report them separately (grant
      // holders can view the named agents, not manage the workspace).
      const memberWsIds = new Set(accepted.map((m) => m.ws.id));
      const grants = await ctx.db
        .select({ workspaceId: agents.workspaceId, wsName: workspaces.name, agentName: agents.name })
        .from(agentMembers)
        .innerJoin(agents, eq(agentMembers.agentId, agents.id))
        .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
        .where(
          and(
            eq(agentMembers.userId, user.id),
            isNotNull(agentMembers.acceptedAt),
            ne(agentMembers.role, 'hidden'),
          ),
        );
      const grantWs = new Map<string, { name: string; agents: string[] }>();
      for (const g of grants) {
        if (memberWsIds.has(g.workspaceId)) continue;
        const e = grantWs.get(g.workspaceId) ?? { name: g.wsName, agents: [] };
        e.agents.push(g.agentName);
        grantWs.set(g.workspaceId, e);
      }
      return JSON.stringify({
        signed_in: true,
        name: user.name,
        email: user.email,
        workspaces: out,
        ...(grantWs.size
          ? {
              agent_access: [...grantWs.values()].map((w) => ({
                workspace: w.name,
                agents: w.agents,
                note: 'agent-scoped access — can view these agents, not a workspace member',
              })),
            }
          : {}),
      });
    },
  },
  {
    name: 'change_plan',
    description:
      "Change the signed-in visitor's Janis subscription plan for a workspace they administer. Paid→paid switches apply immediately with proration; free→paid returns a secure Stripe Checkout link they must open to add a card and confirm; 'free' cancels at period end. Workspaces billed through Shopify get a Shopify charge-approval link instead of Stripe, and 'free' cancels their Shopify subscription immediately. Ask which plan first, and which workspace if they administer more than one.",
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
        return JSON.stringify(
          adminRows.length
            ? {
                result: 'ambiguous_workspace',
                hint: `which workspace? ${user.name ?? 'the visitor'} administers several — pass one`,
                workspaces: adminRows.map((r) => r.ws.name),
              }
            : { error: 'no workspace where the visitor is an admin — billing changes need admin rights' },
        );
      }
      const plan = PLANS[target];
      // Shopify rail — an App Store acquired workspace bills through the
      // Billing API; a Stripe link here is exactly the off-platform billing
      // the app review flags. Paid → Shopify approval URL; free → cancel
      // the AppSubscription outright. (Lazy import: shopifyApp's graph is
      // large and pulls hostedAgent, which loads this file.)
      const { shopifyRailLocked, startBillingSubscription, cancelBillingSubscription } =
        await import('./shopifyApp.js');
      const railShop = await shopifyRailLocked(ctx.db, ws, ws.id);
      if (railShop) {
        if (target === 'free') {
          await cancelBillingSubscription(ctx.db, railShop);
          return JSON.stringify({
            changed: true,
            plan: 'Free',
            note: `${ws.name}'s Shopify subscription was cancelled — it drops to Free now`,
          });
        }
        const { confirmationUrl } = await startBillingSubscription(ctx.db, railShop, target);
        return JSON.stringify({
          changed: false,
          checkout_url: confirmationUrl,
          note: `send the visitor this link — it opens ${plan.name} charge approval in their Shopify admin (billed by Shopify, not Stripe)`,
        });
      }
      const current =
        ws.billingProvider === 'shopify' || ws.stripeSubscriptionId
          ? (ws.plan ?? 'free')
          : 'free';
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
    parksCard: true,
    description:
      "Propose creating a new hosted AI agent — 'take a prompt, get a working agent'. ONLY for signed-in users administering a workspace: if the visitor is not signed in (anonymous chat or voice caller), do NOT offer this — tell them to sign in first instead. Confirm the name and purpose with the visitor, then call this with their description as `purpose` — it is stored verbatim as the agent's builder brief and drives the drafted instructions, greeting, and setup suggestions, exactly as if they had typed it into the Create step. Posts an approval card showing the name + drafted instructions — nothing is created until the visitor approves. On approval the builder's Create page opens for the new agent — do NOT offer channels, the builder covers that next. Ask which workspace only if they administer more than one. If the visitor sends more setup material or corrections while the card is still pending (extra instructions, files, a fuller persona), call this AGAIN with everything merged in — the same card updates in place rather than stacking a second one, so the approval covers the latest details.",
    params: {
      name: 'agent name, e.g. "Acme Support"',
      purpose:
        "the visitor's own description of what the agent should do, in their words — becomes the builder brief; keep their details (audience, scope, domain), don't summarize them away",
      system_prompt:
        'optional fallback instructions when the brief is too thin to draft from — persona, scope, tone, what it should/shouldn\'t do',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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

      const purpose = (args.purpose ?? '').trim().slice(0, 4000);
      const prompt = (args.system_prompt ?? '').trim();
      const greeting = (args.greeting ?? '').trim();
      // Double-fired calls are common (retries, the model re-reading a
      // confirmation as a fresh ask) — a same-name agent created moments
      // ago is almost certainly the same request: return it, don't dupe.
      const [dupe] = await ctx.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, ws.id),
            sql`lower(${agents.name}) = lower(${name})`,
            gt(agents.createdAt, new Date(Date.now() - 15 * 60_000)),
          ),
        )
        .limit(1);
      if (dupe) {
        return JSON.stringify({
          already_created: true,
          agent_id: dupe.id,
          name: dupe.name,
          url: `${env.webOrigin}/agents/${dupe.id}`,
          note: `an agent named ${dupe.name} was just created — this is that same agent; reply with this exact link: [Open ${dupe.name}](${env.webOrigin}/agents/${dupe.id})`,
        });
      }
      // The card carries the brief — the visitor's own purpose text plus
      // the draft the Create step's generator produces from it — so the
      // visitor approves the actual plan, not a text "y". The draft rides
      // in the card: approval is then an instant write, not an LLM call
      // behind a button, and the card shows the instructions that will
      // actually ship (the generator's), not a second concierge draft.
      const { generateDraft } = await import('./agentBuilder.js');
      const draft = purpose ? await generateDraft(purpose).catch(() => null) : null;
      const instructions = draft?.system_prompt ?? prompt;
      return parkConciergeAction(
        ctx,
        'apply_create_agent',
        {
          workspace_id: ws.id,
          name,
          ...(purpose ? { purpose } : {}),
          ...(instructions ? { system_prompt: instructions } : {}),
          ...(draft?.greeting ?? greeting ? { greeting: draft?.greeting ?? greeting } : {}),
          ...(draft ? { draft } : {}),
        },
        `Create agent ${name}`,
        {
          workspace: ws.name,
          name,
          instructions:
            instructions.length > 200 ? `${instructions.slice(0, 200)}…` : instructions || '(default)',
          ...(purpose ? { brief: purpose.length > 200 ? `${purpose.slice(0, 200)}…` : purpose } : {}),
          ...(draft?.greeting ?? greeting ? { greeting: draft?.greeting ?? greeting } : {}),
        },
        // A re-pitch for the same agent name in the same workspace is a
        // revision of the pending card, not a new proposal — the visitor
        // refining their brief mid-approval shouldn't face two cards.
        (p) =>
          p.toolName === 'apply_create_agent' &&
          (p.args as { workspace_id?: unknown }).workspace_id === ws.id &&
          typeof (p.args as { name?: unknown }).name === 'string' &&
          ((p.args as { name: string }).name).toLowerCase() === name.toLowerCase(),
      );
    },
  },
  {
    // Executor for approved create_agent cards — hidden from the model.
    name: 'apply_create_agent',
    description: 'internal — executes an approved create_agent action card',
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
      const name = String(args.name ?? '').trim().slice(0, 120);
      if (!name) return 'error: name is required';
      // A stale approved card must not create a second agent of the same
      // name right after the first — re-run the proposer's dupe check.
      const [dupe] = await ctx.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, wsId),
            sql`lower(${agents.name}) = lower(${name})`,
            gt(agents.createdAt, new Date(Date.now() - 15 * 60_000)),
          ),
        )
        .limit(1);
      if (dupe) {
        return JSON.stringify({
          summary: `${dupe.name} already exists`,
          url: `${env.webOrigin}/agents/${dupe.id}`,
        });
      }
      const prompt = String(args.system_prompt ?? '').trim().slice(0, 5000);
      const greeting = String(args.greeting ?? '').trim().slice(0, 500);
      const purpose = String(args.purpose ?? '').trim().slice(0, 4000);
      // Parked args carry real objects (see decidePendingAction) — the
      // string-typed signature is a lie for nested fields like draft.
      const draft = (args.draft ?? null) as unknown as BuilderDraft | null;
      const [row] = await ctx.db
        .insert(agents)
        .values({
          workspaceId: wsId,
          ownerUserId: user.id,
          name,
          webhookSecret: generateWebhookSecret(),
          hosted: true,
          autoResumeMinutes: 10,
          // Same shape POST /agents/bootstrap writes from a Create-step
          // brief — authored fields on top, review material under
          // config.builder — so a concierge-born agent is
          // indistinguishable from one born on the Create page.
          config: {
            ...(purpose ? { purpose: purpose.slice(0, 2000) } : {}),
            ...(draft?.system_prompt ?? prompt
              ? { system_prompt: draft?.system_prompt ?? prompt }
              : {}),
            ...(draft?.tone ? { tone: draft.tone } : {}),
            ...(draft?.greeting ?? greeting
              ? { greeting: draft?.greeting ?? greeting, greeting_enabled: true }
              : {}),
            builder: {
              ...(purpose ? { description: purpose } : {}),
              ...(draft?.summary ? { summary: draft.summary } : {}),
              ...(draft?.suggested_knowledge?.length
                ? { suggested_knowledge: draft.suggested_knowledge }
                : {}),
              ...(draft?.suggested_templates?.length
                ? { suggested_templates: draft.suggested_templates }
                : {}),
              ...(draft?.suggested_approvals?.length
                ? { suggested_approvals: draft.suggested_approvals }
                : {}),
              ...(draft?.suggested_rules?.length
                ? { suggested_rules: draft.suggested_rules }
                : {}),
              ...(draft?.suggested_questions?.length
                ? { suggested_questions: draft.suggested_questions }
                : {}),
              ...(draft?.suggested_scenarios?.length
                ? { suggested_scenarios: draft.suggested_scenarios }
                : {}),
              ...(draft?.knowledge_need ? { knowledge_need: draft.knowledge_need } : {}),
              ...(draft?.knowledge_need_reason
                ? { knowledge_need_reason: draft.knowledge_need_reason }
                : {}),
              ...(draft?.region_sensitive ? { region_sensitive: true } : {}),
              ...(draft?.domain_risk ? { domain_risk: draft.domain_risk } : {}),
              ...(draft?.suggested_channels?.length
                ? { suggested_channels: draft.suggested_channels }
                : {}),
              generated_at: new Date().toISOString(),
            },
          },
        })
        .returning();
      // Materialize the draft's test checklist — the same insert
      // bootstrap runs, so Try it opens with real scenarios, not an
      // empty chat box.
      if (draft?.suggested_scenarios?.length) {
        await ctx.db
          .insert(agentTests)
          .values(
            draft.suggested_scenarios.map((s) => ({
              workspaceId: wsId,
              agentId: row.id,
              name: s.prompt.slice(0, 120),
              expectation: s.expected,
              turns: [{ role: 'customer' as const, text: s.prompt }] as never,
              category: s.category,
              source: 'generated',
            })),
          )
          .catch(() => undefined);
      }
      // No channel — the builder's Teach/Guide/Abilities/Deploy steps take
      // the operator the rest of the way, including picking channels.
      // Same Slack nicety as the API route — per-agent alert channel when the
      // workspace is connected; best-effort, never blocks creation.
      const inst = await getInstallation(ctx.db, wsId);
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
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.create',
        targetType: 'agent',
        targetId: row.id,
        meta: { name: row.name, hosted: true, via: 'concierge' },
      });
      // Open agent pages on the visitor's workspace refresh over SSE.
      bus.publish(wsId, { type: 'agent', data: { id: row.id } });
      return JSON.stringify({
        summary: `Created ${row.name} — its builder Create page is open now`,
        agent_id: row.id,
        name: row.name,
        url: `${env.webOrigin}/agents/new/${row.id}?step=create`,
        // The rail navigates here itself on approval — no link-click needed.
        open_url: `/agents/new/${row.id}?step=create`,
      });
    },
  },
  {
    name: 'update_agent_brief',
    parksCard: true,
    description:
      "Propose changing an agent's builder brief — the Create-page 'what should this agent do' description — and/or its name. The new brief re-drafts the agent's instructions, tone, greeting, and setup suggestions to match, exactly like editing the brief on the Create page and applying Janis's suggested changes. Posts an approval card — nothing changes until the visitor approves. For small edits to existing instructions (add a rule, fix a phrase) use update_agent instead — this is for redirecting the agent's whole purpose. Admin-only.",
    params: {
      agent: 'agent name (required)',
      purpose:
        'the new builder brief, verbatim — replaces the Create-page description; instructions/greeting/suggestions re-draft from it on approval',
      name: 'optional new agent name — renames the agent',
      workspace: 'workspace name — only needed when ambiguous',
    },
    // Operator-workspace only — same rule as create_agent.
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace, { adminOnly: true });
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;

      const purpose =
        args.purpose !== undefined ? String(args.purpose).trim().slice(0, 4000) : '';
      const rename =
        args.name !== undefined ? String(args.name).trim().slice(0, 120) : '';
      if (args.purpose !== undefined && !purpose) {
        return JSON.stringify({ error: 'purpose cannot be blank' });
      }
      if (args.name !== undefined && !rename) {
        return JSON.stringify({ error: 'name cannot be blank' });
      }
      if (!purpose && (!rename || rename === agent.name)) {
        return JSON.stringify({ error: 'nothing to change — pass purpose and/or name' });
      }
      // Draft now, at propose time — approval becomes an instant write and
      // the card can show the instructions that will actually ship.
      const { generateDraft } = await import('./agentBuilder.js');
      const draft = purpose ? await generateDraft(purpose).catch(() => null) : null;
      const willRename = Boolean(rename && rename !== agent.name);
      return parkConciergeAction(
        ctx,
        'apply_agent_brief',
        {
          workspace_id: ws.id,
          agent_id: agent.id,
          ...(purpose ? { purpose } : {}),
          ...(draft ? { draft } : {}),
          ...(willRename ? { rename } : {}),
        },
        `${willRename ? `Rename ${agent.name} to ${rename}` : 'Update brief'} — ${agent.name}`,
        {
          agent: agent.name,
          ...(willRename ? { name: `${agent.name} → ${rename}` } : {}),
          ...(purpose
            ? { brief: purpose.length > 300 ? `${purpose.slice(0, 300)}…` : purpose }
            : {}),
          ...(draft
            ? {
                'new instructions':
                  (draft.system_prompt ?? '').length > 200
                    ? `${draft.system_prompt!.slice(0, 200)}…`
                    : draft.system_prompt,
              }
            : purpose
              ? { note: 'brief saved — instructions re-draft failed, will stay as-is' }
              : {}),
        },
      );
    },
  },
  {
    // Executor for approved update_agent_brief cards — hidden from the model.
    name: 'apply_agent_brief',
    description: 'internal — executes an approved update_agent_brief action card',
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
      const purpose = String(args.purpose ?? '').trim().slice(0, 4000);
      const rename = String(args.rename ?? '').trim().slice(0, 120);
      const d = (args.draft ?? null) as unknown as BuilderDraft | null;
      if (!purpose && (!rename || rename === agent.name)) return 'error: nothing to change';

      // Mirror the Create page's brief-save + apply-draft writes: purpose +
      // builder.description carry the brief, authored fields adopt the
      // re-draft, suggestion lists replace wholesale. Config edits mark the
      // old scenario suite stale automatically (config-versioned).
      const cur = (agent.config ?? {}) as Record<string, unknown>;
      const curBuilder = (cur.builder ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = {
        ...cur,
        ...(purpose ? { purpose: purpose.slice(0, 2000) } : {}),
        ...(d?.system_prompt ? { system_prompt: d.system_prompt } : {}),
        ...(d?.tone ? { tone: d.tone } : {}),
        ...(d?.greeting ? { greeting: d.greeting, greeting_enabled: true } : {}),
        builder: {
          ...curBuilder,
          ...(purpose ? { description: purpose } : {}),
          ...(d?.summary ? { summary: d.summary } : {}),
          ...(d
            ? {
                suggested_knowledge: d.suggested_knowledge ?? [],
                suggested_templates: d.suggested_templates ?? [],
                suggested_approvals: d.suggested_approvals ?? [],
                suggested_rules: d.suggested_rules ?? [],
                suggested_questions: d.suggested_questions ?? [],
                suggested_scenarios: d.suggested_scenarios ?? [],
                region_sensitive: d.region_sensitive === true,
                generated_at: new Date().toISOString(),
              }
            : {}),
          ...(d?.knowledge_need ? { knowledge_need: d.knowledge_need } : {}),
          ...(d?.knowledge_need_reason
            ? { knowledge_need_reason: d.knowledge_need_reason }
            : {}),
          ...(d?.domain_risk ? { domain_risk: d.domain_risk } : {}),
          ...(d?.suggested_channels?.length
            ? { suggested_channels: d.suggested_channels }
            : {}),
          // A re-draft that now says 'required' clears a stale skip — same
          // rule as the console's apply-draft.
          ...(d?.knowledge_need === 'required' ? { teach_skipped: false } : {}),
        },
      };
      const set: Record<string, unknown> = { config };
      const willRename = Boolean(rename && rename !== agent.name);
      if (willRename) set.name = rename;
      await ctx.db.update(agents).set(set).where(eq(agents.id, agent.id));
      const newName = willRename ? rename : agent.name;
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.config.update',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', fields: ['brief', ...(willRename ? ['name'] : [])] },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        summary: purpose
          ? `Updated ${newName}'s brief${d ? ' and re-drafted its setup to match' : ''}${willRename ? ` (was ${agent.name})` : ''}.`
          : `Renamed ${agent.name} to ${newName}.`,
        agent_id: agent.id,
        name: newName,
        url: `${env.webOrigin}/agents/new/${agent.id}?step=create`,
        open_url: `/agents/new/${agent.id}?step=create`,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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
            // Workspace-wide, not windowed — a pending approval still needs
            // review no matter how old its conversation is.
            ctx.db
              .select({
                convId: pendingActions.conversationId,
                agentId: pendingActions.agentId,
                tool: pendingActions.toolName,
                args: pendingActions.args,
                createdAt: pendingActions.createdAt,
              })
              .from(pendingActions)
              .where(
                and(eq(pendingActions.workspaceId, ws.id), eq(pendingActions.status, 'pending')),
              ),
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
        approvals_pending: pendings.length,
        // Approvals live on the conversation that raised them — hand the
        // visitor these links verbatim; there is no central approvals page.
        pending_approvals: pendings.map((p) => ({
          tool: p.tool,
          agent: wsAgents.find((a) => a.id === p.agentId)?.name ?? null,
          // The proposed call verbatim — describe it from this, never guess.
          args: p.args,
          // Cards on this very rail get pointed at in-chat, not linked.
          ...(p.convId === ctx?.convId
            ? { where: 'this conversation — the approval card is right here in the chat' }
            : { url: `${env.webOrigin}/conversations/${p.convId}` }),
        })),
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
    name: 'inspect_agent',
    description:
      "Read an agent's current setup in the visitor's workspace — tone, greeting, instructions, knowledge note lines, knowledge-source inventory, channels, routing rules, escalation/CSAT settings, procedures, collect-forms, saved components, tool names. ALWAYS call this before proposing a config change that depends on existing values (copying one agent's setup to another, 'what does X know', appending instructions) — never guess or fabricate existing config. To move knowledge to another agent, read it here first, then write it via teach_agent (facts) or add_knowledge_source kind=text (documents). Returns only what an admin sees on the agent's pages — never credentials, headers, secrets, tokens, or channel auth. Read-only — admin-only.",
    params: {
      agent: 'agent name (required)',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      const cfg = (agent.config ?? {}) as AgentConfig;
      const [files, chans, rules, widgets] = await Promise.all([
        ctx.db
          .select({
            name: knowledgeFiles.name,
            status: knowledgeFiles.status,
            chars: sql<number>`length(${knowledgeFiles.text})`,
            sourceUrl: knowledgeFiles.sourceUrl,
            mimeType: knowledgeFiles.mimeType,
            enabled: knowledgeFiles.enabled,
          })
          .from(knowledgeFiles)
          .where(eq(knowledgeFiles.agentId, agent.id)),
        // name + kind only — credentials (OAuth tokens, webhook secrets,
        // API keys) are never surfaced to the transcript, even for admins
        ctx.db
          .select({ id: channels.id, name: channels.name, kind: channels.kind })
          .from(channels)
          .where(eq(channels.agentId, agent.id)),
        ctx.db
          .select({ kind: alertRules.kind, config: alertRules.config })
          .from(alertRules)
          .where(eq(alertRules.agentId, agent.id)),
        ctx.db
          .select({
            name: agentWidgets.name,
            description: agentWidgets.description,
            autoGreet: agentWidgets.autoGreet,
          })
          .from(agentWidgets)
          .where(eq(agentWidgets.agentId, agent.id)),
      ]);
      return JSON.stringify({
        agent: agent.name,
        // Real ids are the corpus console links verify against — without
        // them the model invents a uuid and the link guard strips it.
        agent_id: agent.id,
        url: `${env.webOrigin}/agents/${agent.id}`,
        tone: cfg.tone ?? null,
        greeting: cfg.greeting ?? null,
        greeting_enabled: cfg.greeting_enabled ?? null,
        instructions: cfg.system_prompt ?? null,
        quick_replies: cfg.quick_replies ?? [],
        handoff_enabled: cfg.handoff_enabled ?? null,
        auto_assign: cfg.auto_assign ?? null,
        sla_minutes: cfg.sla_minutes ?? null,
        csat: cfg.csat ?? null,
        knowledge: cfg.knowledge ?? [],
        procedures: (cfg.procedures ?? []).map((p) => ({
          name: p.name,
          when: p.when ?? null,
          steps: p.steps.map((s) => (typeof s === 'string' ? s : { text: s.text, tool: s.tool ?? null })),
        })),
        collect_forms: (cfg.collect_forms ?? []).map((f) => ({
          name: f.name,
          when: f.when ?? null,
          title: f.title ?? null,
          fields: f.fields.map((fld) => ({ name: fld.name, label: fld.label, type: fld.type, required: fld.required ?? false })),
          tags: f.tags ?? [],
          // webhook destinations can embed auth tokens in the URL — report
          // presence, not the value. Email destinations are member-visible.
          webhook_configured: Boolean(f.webhook_url),
          email_notify: f.email ?? null,
        })),
        tools: ((cfg.tools ?? []) as { name?: string }[]).map((t) => t.name).filter(Boolean),
        knowledge_sources: files.map((f) => ({
          name: f.name,
          kind: f.mimeType === 'text/url-site' ? 'site' : f.sourceUrl ? 'url' : 'file',
          status: f.status,
          chars: f.chars,
          enabled: f.enabled,
          source_url: f.sourceUrl,
        })),
        channels: await Promise.all(
          chans.map(async (ch) => {
            if (ch.kind !== 'chatfuel' && ch.kind !== 'manychat') return ch;
            // The URL the visitor pastes into the bot platform — shown on
            // the channel's setup card, so it reads back verbatim here.
            // ensureBotKey mints on demand: a null post_url is an open
            // invitation for the model to compose /bot/<key>/… itself and
            // guess the key (it filled the slot with the channel uuid).
            const key = await ensureBotKey(ctx.db, agent);
            return { ...ch, post_url: `${env.apiOrigin}/bot/${key}/${ch.kind}` };
          }),
        ),
        alert_rules: rules.map((r) => ({ kind: r.kind, config: r.config })),
        components: widgets,
      });
    },
  },
  {
    name: 'select_agent',
    description:
      "Switch the console's focus to an agent — 'select the Jerry bot', 'take me to marcel', 'work on X now'. Stamps the agent as this conversation's current selection (so follow-up 'this agent' asks resolve to it even in Slack) AND navigates the visitor's open console to the agent's page. Immediate, no approval — it's navigation, not a change. For a full settings rundown on the agent follow with inspect_agent. Any member.",
    params: {
      agent: 'agent name (required)',
      workspace: 'workspace name — only needed when ambiguous',
      section:
        'optional console section to land on: inbox | behavior | knowledge | channels | integrations | components | tests | settings — default inbox',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace);
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      // Allowlist — the path is emitted verbatim to SSE clients; never trust
      // free text where a URL is expected.
      const section = ['inbox', 'behavior', 'knowledge', 'channels', 'integrations', 'components', 'tests', 'settings'].includes(
        String(args.section ?? '').toLowerCase(),
      )
        ? String(args.section).toLowerCase()
        : 'inbox';
      const path = `/agents/${agent.id}/${section}`;
      // Stamp the selection on the conversation — the same metadata bag the
      // rail stamps current_agent through, so Slack-side and thread-forked
      // follow-ups resolve "this agent" even though the console's next
      // message restamps from its own selection.
      const stamp = JSON.stringify({ current_agent: agent.name, current_agent_id: agent.id });
      await ctx.db
        .update(conversations)
        .set({
          userProfile: sql`coalesce(${conversations.userProfile}, '{}'::jsonb) || jsonb_build_object('metadata', coalesce(${conversations.userProfile}->'metadata', '{}'::jsonb) || ${stamp}::jsonb)`,
        })
        .where(eq(conversations.id, ctx.convId));
      // Navigate the open console — user_id targets just this person's
      // session; agent_id lets the stream's visibility filter drop the
      // event for members who can't see the target.
      bus.publish(ws.id, {
        type: 'navigate',
        data: { user_id: user.id, agent_id: agent.id, path },
      });
      // open_url persists a console destination on the reply — the rail
      // follows it on incremental polls when the SSE 'navigate' fast path
      // dropped (dead/reconnecting stream).
      return JSON.stringify({
        summary: `focused: ${agent.name} — this conversation now treats ${agent.name} as the selected agent`,
        url: `${env.webOrigin}${path}`,
        open_url: path,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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
    name: 'lookup_contact',
    description:
      "Answer 'who is X / do we have a contact for X / what's this customer's info / tell me about this user here' — find a person in the visitor's workspace Contacts by name, email, phone, tag, or contact UUID. Omit `contact` to look up the person on the page the operator is currently viewing (a Contacts page or the conversation open in their inbox). Returns their full record: names and addresses, tags, notes, traits, external CRM ids, every channel identity they're reachable on, and their linked conversations across agents — each with who the visitor is (signed-in Janis users carry their console context: their agents, workspaces, and the page they're on) plus a console link. Use it whenever a question is about a specific customer or person; to read the actual messages in one of the linked threads, call read_conversation. Read-only — any member.",
    params: {
      contact:
        'name, email, phone, tag, or contact UUID — omit to use the contact behind the page the operator is viewing',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      let q = (args.contact ?? '').trim();
      if (!q) {
        const view = await currentView(ctx);
        if (view.contactId) {
          q = view.contactId;
        } else if (view.conversationId) {
          // "this user here" — the contact behind the thread they're viewing.
          const [vc] = await ctx.db
            .select({ contactId: conversations.contactId, wsId: agents.workspaceId })
            .from(conversations)
            .innerJoin(agents, eq(conversations.agentId, agents.id))
            .where(eq(conversations.id, view.conversationId))
            .limit(1);
          if (!vc) {
            return JSON.stringify({ error: 'the conversation in view no longer exists — pass a name, email, phone, or contact id' });
          }
          if (vc.wsId !== ws.id) {
            return JSON.stringify({
              error: `the conversation in view isn't in ${ws.name} — pass the workspace name it's in`,
            });
          }
          if (!vc.contactId) {
            return JSON.stringify({
              result: 'not_found',
              hint: 'the conversation in view has no linked contact yet — pass a name or email to search instead',
            });
          }
          q = vc.contactId;
        } else {
          return JSON.stringify({
            error: 'no contact or conversation in view — pass a name, email, phone, tag, or contact id to search for',
          });
        }
      }

      if (UUID.test(q)) {
        const [contact] = await ctx.db
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, q), eq(contacts.workspaceId, ws.id)))
          .limit(1);
        if (!contact) {
          return JSON.stringify({
            result: 'not_found',
            hint: `no contact ${q} in ${ws.name} — if it lives in another workspace, pass the workspace name`,
          });
        }
        return JSON.stringify({
          ...(await contactSummary(ctx.db, contact)),
          conversations: await contactConversations(ctx.db, contact.id),
        });
      }

      const pat = `%${q}%`;
      const hits = await ctx.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, ws.id),
            or(
              ilike(contacts.name, pat),
              ilike(contacts.email, pat),
              ilike(contacts.phone, pat),
              sql`exists (select 1 from unnest(${contacts.altEmails}) e where e ilike ${pat})`,
              sql`exists (select 1 from unnest(${contacts.altPhones}) p where p ilike ${pat})`,
              sql`exists (select 1 from unnest(${contacts.tags}) t where t ilike ${pat})`,
            ),
          ),
        )
        .orderBy(desc(contacts.updatedAt))
        .limit(9);
      if (!hits.length) {
        return JSON.stringify({
          result: 'not_found',
          hint: `no contacts matching "${q}" in ${ws.name}`,
          contacts_url: `${env.webOrigin}/contacts`,
        });
      }
      if (hits.length > 1) {
        return JSON.stringify({
          result: 'multiple_matches',
          hint: 'multiple contacts match — be more specific or pass the contact id',
          matches: hits.slice(0, 8).map((h) => ({
            contact_id: h.id,
            name: h.name,
            email: h.email,
            phone: h.phone,
            tags: h.tags,
            url: `${env.webOrigin}/contacts/${h.id}`,
          })),
        });
      }
      const contact = hits[0];
      return JSON.stringify({
        ...(await contactSummary(ctx.db, contact)),
        conversations: await contactConversations(ctx.db, contact.id),
      });
    },
  },
  {
    name: 'read_conversation',
    description:
      "Read what happened in a conversation — 'what did Sam ask about', 'show me the last chat with ann@acme.com', 'what was decided in that thread', 'look at the conversation I'm viewing'. Omit `conversation` to read the thread open on the operator's screen right now. Otherwise resolves one conversation in the visitor's workspace by UUID, customer name/email/phone, or linked contact, and returns its state, agent, channels, assignee, intent/sentiment, who the visitor is (a signed-in Janis user carries their console context: their agents, workspaces, current page), the linked contact record (who this person is across channels), and the latest transcript. To diagnose a stuck or missing reply use debug_conversation; to save what a human resolved as knowledge use teach_from_conversation. Read-only — any member.",
    params: {
      conversation:
        'conversation UUID or customer name/email/phone — omit to read the thread the operator is viewing',
      workspace: 'workspace name — only needed when ambiguous',
      limit: 'max transcript messages to return, default 20 (max 50)',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const resolved = await visitorWorkspace(ctx, user, args.workspace);
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      let q = (args.conversation ?? '').trim();
      if (!q) {
        const view = await currentView(ctx);
        if (!view.conversationId) {
          return JSON.stringify({
            error: 'no conversation in view — pass a conversation id or a customer name/email/phone',
          });
        }
        q = view.conversationId;
      }
      const found = await findVisitorConversation(ctx.db, ws, q);
      if ('error' in found) {
        // A miss is a search outcome, not a tool failure — keep the {"error"}
        // shape (marks the call failed + fires a Run-error alert) for real
        // breakage only.
        return JSON.stringify(
          found.matches?.length
            ? { result: 'multiple_matches', hint: found.error, matches: found.matches }
            : { result: 'not_found', hint: found.error },
        );
      }
      const conv = found.conv;

      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const [agent, bindings, assignee, contact] = await Promise.all([
        ctx.db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, conv.agentId))
          .limit(1)
          .then((r) => r[0]),
        ctx.db
          .select({ kind: channels.kind, name: channels.name })
          .from(channelBindings)
          .innerJoin(channels, eq(channelBindings.channelId, channels.id))
          .where(eq(channelBindings.conversationId, conv.id)),
        conv.assigneeId
          ? ctx.db
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, conv.assigneeId))
              .limit(1)
              .then((r) => r[0])
          : Promise.resolve(undefined),
        conv.contactId
          ? ctx.db
              .select()
              .from(contacts)
              .where(eq(contacts.id, conv.contactId))
              .limit(1)
              .then((r) => r[0])
          : Promise.resolve(undefined),
      ]);

      const recent = await ctx.db
        .select({
          direction: messages.direction,
          text: messages.text,
          payload: messages.payload,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(desc(messages.createdAt))
        .limit(limit * 2);
      const transcript = recent
        .filter((m) => !(m.payload as { internal?: boolean } | null)?.internal)
        .slice(0, limit)
        .reverse()
        .map((m) => ({
          dir: m.direction === 'in' ? 'customer' : m.direction === 'out' ? 'agent' : 'human',
          text: m.text,
          at: m.createdAt,
        }));

      return JSON.stringify({
        conversation_id: conv.id,
        customer:
          (conv.userProfile as { name?: string; email?: string })?.name ??
          (conv.userProfile as { email?: string })?.email ??
          conv.externalId,
        visitor: visitorContext(conv.userProfile, conv.externalId),
        state: conv.state,
        agent: agent?.name,
        channels: bindings.map((b) => `${b.kind} (${b.name})`),
        assignee: assignee?.name ?? null,
        intent: conv.intent,
        sentiment: conv.sentiment,
        csat_score: conv.csatScore,
        created_at: conv.createdAt,
        last_message_at: conv.lastMessageAt,
        url: `${env.webOrigin}/conversations/${conv.id}`,
        contact: contact
          ? await contactSummary(ctx.db, contact)
          : null,
        transcript,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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
      const { detectKnowledgeGaps, filterDismissedGaps, readGapsCache, gapsCacheFresh } = await import(
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
        gaps = filterDismissedGaps(gaps, cfg);
        if (!gaps.length) continue;
        out.push({
          agent: agent.name,
          gaps_url: `${env.webOrigin}/agents/${agent.id}/knowledge`,
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
    name: 'error_reports',
    description:
      "Answer 'what just broke / is the console erroring' — recent self-captured error bundles from the web console and API (message, stack, route, console tail, DOM snapshot). List mode shows the latest reports; pass `id` to read one packet in full (DOM + screenshot are summarised — tell the user to open /errors for the pixel view). Read-only, operator workspace only.",
    params: {
      id: 'report UUID to inspect — omit to list the most recent reports',
      limit: 'how many to list, default 10, max 50',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      // Internal debugging bundles — same sign-in gate as every other
      // workspace-bound concierge tool. The public sales concierge shares
      // this catalog, so without the check any anonymous visitor could ask
      // "what broke" and read stacks/routes/DOM snapshots.
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      if (args.id) {
        const [row] = await ctx.db
          .select()
          .from(errorReports)
          .where(
            and(
              eq(errorReports.id, String(args.id)),
              or(eq(errorReports.workspaceId, ctx.workspaceId), isNull(errorReports.workspaceId)),
            ),
          )
          .limit(1);
        if (!row) return JSON.stringify({ error: 'report not found' });
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        return JSON.stringify({
          id: row.id,
          source: row.source,
          message: row.message,
          stack: row.stack,
          url: row.url,
          created_at: row.createdAt,
          route: payload.route,
          ua: payload.ua,
          viewport: payload.viewport,
          console_tail: payload.console_tail,
          failed_requests: payload.failed_requests,
          settings: payload.settings,
          dom_excerpt: typeof payload.dom === 'string' ? payload.dom.slice(0, 4000) : undefined,
          has_screenshot: typeof payload.screenshot === 'string',
          view_url: `${env.webOrigin}/errors`,
        });
      }
      const rows = await ctx.db
        .select({
          id: errorReports.id,
          source: errorReports.source,
          message: errorReports.message,
          url: errorReports.url,
          payload: errorReports.payload,
          createdAt: errorReports.createdAt,
        })
        .from(errorReports)
        .where(
          or(eq(errorReports.workspaceId, ctx.workspaceId), isNull(errorReports.workspaceId)),
        )
        .orderBy(desc(errorReports.createdAt))
        .limit(limit);
      return JSON.stringify({
        reports: rows.map((r) => ({
          id: r.id,
          source: r.source,
          message: r.message.slice(0, 200),
          route: (r.payload as { route?: string } | null)?.route,
          at: r.createdAt,
        })),
        view_url: `${env.webOrigin}/errors`,
      });
    },
  },
  {
    name: 'teach_agent',
    parksCard: true,
    description:
      "Propose a knowledge entry for an agent in the visitor's workspace — the fix for a recurring gap, so the agent answers it next time. Draft the entry (a factual line the agent can quote, e.g. \"Refunds under $50 are auto-approved within 24h\") and call this as soon as the proposal is reasonable — it posts an approval card in the chat, no verbal confirmation needed. For chat components/widgets the agent renders in conversation, use save_widget — a knowledge entry is text facts, not a component. Admin-only.",
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
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
      const res = await parkConciergeAction(
        ctx,
        'apply_knowledge',
        { workspace_id: ws.id, agent_id: agent.id, entry: freshEntries.join('\n') },
        `Teach ${agent.name}`,
        { agent: agent.name, entry: freshEntries.join('\n') },
      );
      return res + offSelectionNote(picked);
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
    parksCard: true,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
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
      const config = argObject(args.config);
      const [row] = await ctx.db
        .insert(alertRules)
        .values({ agentId: agent.id, kind: kind as never, config })
        .returning();
      if (row.kind === 'sentiment' && (row.config as { enabled?: boolean }).enabled !== false) {
        void backfillSentimentAlerts(ctx.db, agent, row).catch((err) =>
          console.error('[tools] sentiment backfill failed:', err),
        );
      }
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
    parksCard: true,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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
    parksCard: true,
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
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
    parksCard: true,
    description:
      "Propose an agent settings change in the visitor's workspace — rename, instructions/system-prompt changes, tone, greeting text, greeting on/off, quick-reply chips, CSAT survey (enabled/prompt/thanks), handoff re-alert minutes, auto-assign, widget accent colour, or email alerts. Posts an approval card — nothing changes until the visitor approves. Pass ONLY the params the visitor actually asked to change — every param is a real write; filling unrequested fields with current or guessed values makes an unsafe card. For how-do-I questions, answer with a link to the settings page instead of proposing a card. For chat components/widgets the agent shows in conversation, use save_widget instead. Admin-only.",
    params: {
      agent: 'agent name (required)',
      name: 'new agent name — renames the agent',
      instructions_add:
        "append this rule to the agent's instructions — use for 'always do X / never do Y' asks so existing instructions are kept",
      instructions:
        "full replacement instructions/system prompt — only when the visitor asks to rewrite them, not to add a rule",
      tone: 'new tone descriptor, e.g. "warm and concise"',
      greeting: 'new greeting text (blank string disables it)',
      greeting_enabled: 'true/false — send the greeting on new conversations',
      quick_replies: 'comma-separated chips shown in the widget (max 8, each <= 20 chars — Meta limit)',
      csat_enabled: 'true/false — post-resolution satisfaction survey',
      csat_prompt: 'the survey question text',
      csat_thanks: 'the reply sent after a survey answer',
      sla_minutes: 're-alert when a handoff stays unclaimed for N minutes (1-1440)',
      auto_assign: 'true/false — route handoffs to the least-loaded teammate',
      handoff_enabled: 'true/false — let this agent offer or escalate to a human teammate',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      // The model sometimes names an agent from an older topic, not the one
      // the visitor is looking at — the card is still correct to post, but
      // tell the model so its reply can name the target out loud.
      const offSelection = offSelectionNote(picked);

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
      if (args.instructions !== undefined) {
        const text = String(args.instructions).trim().slice(0, 5000);
        if (!text) return JSON.stringify({ error: 'instructions cannot be blank — use instructions_add to append a rule instead' });
        patch.system_prompt = text;
        display.instructions = text.length > 200 ? `${text.slice(0, 200)}… (${text.length} chars)` : text;
      }
      if (args.instructions_add !== undefined) {
        const rule = String(args.instructions_add).trim().slice(0, 2000);
        if (!rule) return JSON.stringify({ error: 'instructions_add cannot be blank' });
        const base = args.instructions !== undefined ? String(patch.system_prompt ?? '') : String(cur.system_prompt ?? '');
        patch.system_prompt = base ? `${base}\n\n${rule}` : rule;
        display['added rule'] = rule.length > 200 ? `${rule.slice(0, 200)}…` : rule;
      }
      if (args.tone !== undefined) {
        patch.tone = String(args.tone).trim().slice(0, 200);
        display.tone = patch.tone || '(cleared)';
      }
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
      if (args.handoff_enabled !== undefined) {
        patch.handoff_enabled = bool(args.handoff_enabled);
        display.handoff = patch.handoff_enabled ? 'on' : 'off';
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
      const fieldCount =
        Object.keys(patch).length +
        (willRename ? 1 : 0) +
        (args.accent !== undefined ? 1 : 0) +
        (emailAlerts !== undefined ? 1 : 0);
      if (fieldCount > 5) {
        return JSON.stringify({
          error: `${fieldCount} settings in one card — send ONLY the field(s) the visitor asked to change (usually one, e.g. just agent + greeting for a greeting change); do not re-send the full form`,
        });
      }
      if (fieldCount === 0) {
        return JSON.stringify({
          error: 'nothing to change — pass at least one of name, greeting, greeting_enabled, quick_replies, csat_*, sla_minutes, auto_assign, handoff_enabled, accent, email_alerts',
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
      const res = await parkConciergeAction(
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
      return res + offSelection;
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
        'system_prompt',
        'tone',
        'greeting',
        'greeting_enabled',
        'quick_replies',
        'csat',
        'sla_minutes',
        'auto_assign',
        'handoff_enabled',
      ];
      const patch = argObject(args.patch);
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
  {
    name: 'save_widget',
    parksCard: true,
    description:
      "Propose saving a chat component on an agent in the visitor's workspace — the same cards/options/form/status/receipt blocks the console's Chat components composer manages. The saved component renders verbatim when the agent emits WIDGET_REF, or pins to the webchat greeting with auto_greet. Use this when the visitor asks to add a widget/component to an agent — NOT update_agent (that's settings: greeting, chips, CSAT). Posts an approval card — nothing is saved until the visitor approves. If the visitor sends corrections while the card is still pending (different fields, a changed binding), call this AGAIN with the revised details — a card for the same component updates in place rather than stacking a second one. Admin-only.",
    params: {
      agent: 'agent name (required)',
      name: 'component handle the agent will reference, e.g. pricing-table (required)',
      spec:
        'the component definition as JSON (required) — e.g. {"type":"cards","items":[{"title":"Pro","price":"$99/mo","select_label":"Choose Pro"}]}. String fields may carry {prop} placeholders the ref data fills — {"type":"status","steps":[{"label":"Received","state":"{received_state}"}]}… — or leave fields static for a fixed component.',
      states:
        'optional JSON array of named spec variants — [{"name":"in_transit","spec":{…full spec…}},{"name":"not_found","spec":{…}}]. The model picks one with {"state":"<name>"} in the ref data.',
      tool:
        'optional JSON object binding the component to one of the agent\'s tools — {"name":"<tool>","args":{"<prop>":"<tool param>"},"props":{"<prop>":"<dotpath into result>"},"items":"<dotpath to rows array>","item_map":{"<item field>":"<row dotpath>"}}. When the agent emits WIDGET_REF: name {"arg":…}, the tool runs and its result fills the component (a READ binding — use GET tools). A form component also takes "submit":{"name":"<tool>","args":{"<tool param>":"<static value or {field} placeholder>"}} — the WRITE side: on visitor submit the tool runs with the posted values. Submit args are usually JUST the resource ids (spreadsheet_id, range) — leave "values" UNSET and the submit writes the form\'s fields in order automatically; a values template is only for a different column order or skipped fields, and must be a JSON array of row arrays with {field} placeholders, e.g. [["{name}","{email}"]]. Args that are resource ids (a spreadsheet_id, list id) must come from a real lookup — call the agent\'s list tool (e.g. gsheets_list) or get the value from the visitor; never invent or placeholder one. Only non-approval tools can bind. A renamed component handle is a different component — its card stacks instead of revising.',
      auto_greet: 'true/false — also pin this component under the webchat greeting',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      const name = normWidgetRef(String(args.name ?? '')).slice(0, 60);
      if (!name) return JSON.stringify({ error: 'name cannot be blank' });
      let rawSpec: unknown;
      if (args.spec && typeof args.spec === 'object') {
        rawSpec = args.spec;
      } else {
        try {
          rawSpec = JSON.parse(String(args.spec ?? ''));
        } catch {
          return JSON.stringify({ error: 'spec must be valid JSON — pass the component definition as a JSON string' });
        }
      }
      const spec = WidgetComponent.safeParse(rawSpec);
      if (!spec.success) {
        return JSON.stringify({
          error: `invalid spec — ${spec.error.issues[0]?.message ?? 'check the schema'}`,
          issues: spec.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      // Optional data bindings — states are named full-spec variants; a
      // bound tool must exist on the agent and not be approval-gated.
      const states = argObjectArray(args.states);
      const statesParsed = z.array(WidgetState).max(12).safeParse(states ?? undefined);
      if (states && !statesParsed.success) {
        return JSON.stringify({ error: `invalid states — ${statesParsed.error.issues[0]?.message}` });
      }
      const toolParsed = WidgetToolBinding.nullable().safeParse(argObjectOrNull(args.tool));
      if (toolParsed.success === false) {
        return JSON.stringify({ error: `invalid tool binding — ${toolParsed.error.issues[0]?.message}` });
      }
      const toolBind = toolBindingOrNull(toolParsed.data);
      if (toolBind) {
        const defs = toolsFor(agent);
        const fakeId =
          (await verifyBindingIds(ctx, agent, defs, toolBind.name ?? '', toolBind.args)) ??
          (toolBind.submit
            ? await verifyBindingIds(ctx, agent, defs, toolBind.submit.name, toolBind.submit.args)
            : null);
        if (fakeId) return JSON.stringify({ error: fakeId });
        const def = toolBind.name ? defs.find((t) => t.name === toolBind.name) : undefined;
        if (toolBind.name && !def)
          return JSON.stringify({ error: `no tool named "${toolBind.name}" on ${agent.name}` });
        if (def?.approval)
          return JSON.stringify({ error: `"${toolBind.name}" is approval-gated — a component can only bind a read tool` });
        // The read slot runs at render — a write tool there fires on every
        // view. Only a form can hold one, and only as its submit tool.
        if (def && spec.data.type !== 'form' && def.method !== 'GET') {
          return JSON.stringify({
            error: `"${toolBind.name}" writes data — only a form can bind it, as its submit tool`,
          });
        }
        // Placeholder args save a component that can never run — both the
        // bracketed kind ("[YOUR_SPREADSHEET_ID]") and the template-y kind
        // ("YOUR_SPREADSHEET_ID_HERE", "INSERT_ID", "TBD"). Fail the call
        // so the model fills a real value or drops the binding — invented
        // ids (404'd sheets) are exactly what the list tools are for.
        const PLACEHOLDER =
          /^\s*(\[[^\]]*\]|<[^>]*>|(YOUR|INSERT|ENTER|PUT|SET|CHOOSE|PICK|REPLACE)[_A-Z0-9]*|TBD|TODO|XXX+|[A-Z][A-Z0-9_]*_(HERE|PLACEHOLDER|REQUIRED|TODO))[\s.]*$/i;
        const placeholderArg = Object.entries({
          ...(toolBind.args ?? {}),
          ...(toolBind.submit?.args ?? {}),
        }).find(([, v]) => typeof v === 'string' && PLACEHOLDER.test(v));
        if (placeholderArg) {
          return JSON.stringify({
            error: `"${toolBind.name ?? toolBind.submit?.name}" arg "${placeholderArg[0]}" is a placeholder (${placeholderArg[1]}) — pass a real value or drop the binding; a component bound to it can never run`,
          });
        }
        // Submit-side: forms only, real tool, never approval-gated — it
        // fires per visitor submit with no further review.
        const sub = toolBind.submit;
        if (sub) {
          if (spec.data.type !== 'form')
            return JSON.stringify({ error: 'a submit binding only applies to form components' });
          const subDef = defs.find((t) => t.name === sub.name);
          if (!subDef) return JSON.stringify({ error: `no tool named "${sub.name}" on ${agent.name}` });
          if (subDef.approval)
            return JSON.stringify({ error: `"${sub.name}" is approval-gated — a submit-side tool must run without review` });
        }
      }
      const autoGreet = ['true', 'yes', 'on', '1'].includes(String(args.auto_greet).toLowerCase());
      // Same name + identical spec already saved → nothing to propose.
      const [existing] = await ctx.db
        .select()
        .from(agentWidgets)
        .where(and(eq(agentWidgets.agentId, agent.id), eq(agentWidgets.name, name)))
        .limit(1);
      if (
        existing &&
        canonDeepEq(existing.spec, spec.data) &&
        canonDeepEq(existing.states ?? null, statesParsed.data ?? null) &&
        canonDeepEq(existing.tool ?? null, toolBind) &&
        existing.autoGreet === autoGreet
      ) {
        return `already_saved: ${agent.name} already has this exact component saved as "${name}" — tell the visitor it's live`;
      }
      const items =
        'items' in spec.data && Array.isArray(spec.data.items)
          ? spec.data.items.length
          : 'rows' in spec.data && Array.isArray(spec.data.rows)
            ? spec.data.rows.length
            : ('steps' in spec.data && Array.isArray(spec.data.steps) ? spec.data.steps.length : 0);
      return parkConciergeAction(
        ctx,
        'apply_save_widget',
        {
          workspace_id: ws.id,
          agent_id: agent.id,
          name,
          spec: spec.data,
          ...(statesParsed.data?.length ? { states: statesParsed.data } : {}),
          ...(toolBind ? { tool: toolBind } : {}),
          auto_greet: String(autoGreet),
        },
        `${existing ? 'Update' : 'Save'} component "${name}" → ${agent.name}`,
        {
          agent: agent.name,
          component: name,
          type: spec.data.type,
          ...(items ? { items } : {}),
          ...(statesParsed.data?.length ? { states: statesParsed.data.map((s) => s.name).join(', ') } : {}),
          ...(toolBind ? { tool: toolBind.name } : {}),
          ...(autoGreet ? { on_open: 'pinned to greeting' } : {}),
        },
        // Re-pitching the same component revises the pending card in
        // place — a stacked second card could approve the stale spec.
        (p) =>
          p.toolName === 'apply_save_widget' &&
          (p.args as { name?: string }).name === name,
      );
    },
  },
  {
    name: 'stage_reply',
    description:
      "Stage a visitor-facing reply onto the draft card of the conversation the operator has open — 'draft a reply to Sam', 'send them a survey that records to the sheet', 'write them a message'. Compose the text yourself and pass any components (inline specs or saved-component refs resolved against that conversation's agent); it lands on their draft card for review and one-click send. The target resolves from the page the operator is viewing right now — never this chat; pass `conversation` only when they clearly mean a thread other than the open one. Admin-only.",
    params: {
      text: 'the reply text to send the customer, verbatim',
      widgets:
        'optional JSON array — inline component specs [{"type":"form",...}] or refs [{"ref":"component-name","data":{…}}] resolved to saved specs on the target agent. Inline specs render as-is but cannot save answers anywhere; a form that must record answers through a tool has to be a saved component with a submit binding (save_widget) — stage it by {"ref": name} after the card is approved',
      conversation: 'conversation id — only needed when they mean a thread other than the open one',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      // Target the open conversation page, not this chat — the page the
      // operator is looking at wins over whatever the model passed.
      const target = await resolveReplyTarget(ctx, args.conversation);
      if ('error' in target) return JSON.stringify(target);
      const [conv] = await ctx.db
        .select()
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(and(eq(conversations.id, target.id), eq(agents.workspaceId, ws.id)))
        .limit(1);
      if (!conv) return JSON.stringify({ error: 'that conversation is not in this workspace' });
      const agent = conv.agents;

      // Components: inline specs validate against the schema; refs resolve
      // through the saved-component catalog + bound-tool machinery the
      // suggestion path uses, so the card shows exactly what will send.
      const { text, widgets, failures } = await composeReply(
        ctx,
        agent,
        ws.id,
        conv.conversations.id,
        args,
      );
      if (!text && !widgets.length) {
        return JSON.stringify({ error: `nothing sendable — ${failures.join('; ') || 'empty draft'}` });
      }

      const { storeSuggestion } = await import('../services/suggestions.js');
      await storeSuggestion(ctx.db, conv.conversations.id, text || '(components only)', 'agent', undefined, {
        ...(widgets.length ? { widgets } : {}),
        ...(args.instruction ? { instruction: String(args.instruction) } : {}),
      });
      return JSON.stringify({
        staged: true,
        conversation_id: conv.conversations.id,
        summary:
          `Staged on the draft card — the operator reviews and sends it there.` +
          (failures.length ? ` Dropped: ${failures.join('; ')}.` : ''),
      });
    },
  },
  {
    name: 'send_reply',
    parksCard: true,
    description:
      "Send a message — text plus optional components — to the person in the conversation the operator has open: 'send Ava the survey', 'message them that it ships Monday', 'reply to this customer'. Posts an approval card; nothing sends until the operator approves, and on approve it goes out as the operator's own reply (taking the thread over from the bot). The target resolves from the console page they have open — never this chat; pass `conversation` only when no conversation page is open. Admin or member access to that conversation's agent required — a teammate with access can send to any thread they can read.",
    params: {
      text: 'the message text to send the customer, verbatim',
      widgets:
        'optional JSON array — inline component specs [{"type":"form",...}] or refs [{"ref":"component-name","data":{…}}] resolved to saved specs on the target agent. Inline specs render as-is but cannot save answers anywhere; a form that must record answers through a tool has to be a saved component with a submit binding (save_widget) — send it by {"ref": name} after the card is approved',
      conversation: 'conversation id — only needed when no conversation page is open',
    },
    available: (ws) => Boolean(env.operatorWorkspaceId) && ws === env.operatorWorkspaceId,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'visitor is not a signed-in Janis user — ask them to sign in first' });
      }
      const target = await resolveReplyTarget(ctx, args.conversation);
      if ('error' in target) return JSON.stringify(target);
      const access = await conversationAccess(ctx.db, user.id, target.id);
      if ('error' in access) return JSON.stringify(access);
      const { conv, agent } = access;

      const { text, widgets, failures } = await composeReply(
        ctx,
        agent,
        agent.workspaceId,
        conv.id,
        args,
      );
      if (!text && !widgets.length) {
        return JSON.stringify({ error: `nothing sendable — ${failures.join('; ') || 'empty message'}` });
      }
      if (conv.state === 'archived') {
        return JSON.stringify({ error: 'that conversation is archived' });
      }
      const name = replyTargetName(conv);
      return parkConciergeAction(
        ctx,
        'apply_send_reply',
        { conversation_id: conv.id, text, widgets },
        `Send to ${name}`,
        {
          to: name,
          ...(text ? { message: text.slice(0, 300) } : {}),
          ...(widgets.length
            ? { components: `${widgets.length} (${widgets.map((w) => w.type).join(', ')})` }
            : {}),
          ...(failures.length ? { dropped: failures.join('; ') } : {}),
        },
        // Re-pitching a send to the same thread revises the pending card —
        // an operator approving the stale one sends the old text.
        (p) =>
          p.toolName === 'apply_send_reply' &&
          (p.args as { conversation_id?: string }).conversation_id === conv.id,
      );
    },
  },
  {
    // Executor for approved send_reply cards — hidden from the model.
    name: 'apply_send_reply',
    description: 'internal — executes an approved send_reply action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) {
        return JSON.stringify({ error: 'the decider is not a signed-in Janis user' });
      }
      const convId = String(args.conversation_id ?? '').trim();
      if (!convId) return JSON.stringify({ error: 'missing conversation_id' });
      // Re-verify at send time — the approver may have lost access (or the
      // page moved) since the card was parked.
      const access = await conversationAccess(ctx.db, user.id, convId);
      if ('error' in access) return JSON.stringify(access);
      const { conv, agent, scope } = access;
      const widgetsParsed = z
        .array(WidgetComponent)
        .max(8)
        .safeParse(argObjectArray(args.widgets) ?? []);
      if (!widgetsParsed.success) {
        return JSON.stringify({ error: `invalid widgets — ${widgetsParsed.error.issues[0]?.message}` });
      }
      const text = String(args.text ?? '').trim();
      const name = replyTargetName(conv);
      const { humanReply, TakeoverError } = await import('../services/takeover.js');
      try {
        const { delivery } = await humanReply(
          ctx.db,
          agent.workspaceId,
          conv.id,
          user,
          text,
          undefined,
          false,
          undefined,
          scope,
          { widgets: widgetsParsed.data },
        );
        if (!delivery.delivered) {
          return `Posted to ${name}'s conversation, but the channel didn't accept it: ${delivery.error ?? 'delivery failed'}.`;
        }
        return `Sent to ${name}.`;
      } catch (err) {
        if (err instanceof TakeoverError) return `error: ${err.message}`;
        throw err;
      }
    },
  },
  {
    // Executor for approved save_widget cards — hidden from the model.
    name: 'apply_save_widget',
    description: 'internal — executes an approved save_widget action card',
    available: () => false,
    run: async (args, ctx) => {
      if (!ctx) return 'error: no conversation context';
      const user = await signedInUser(ctx);
      if (!user) return 'error: the decider is not a signed-in Janis user';
      const wsId = String(args.workspace_id ?? '');
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
        .where(and(eq(agents.id, String(args.agent_id ?? '')), eq(agents.workspaceId, wsId)))
        .limit(1);
      if (!agent) return 'error: agent not found';
      // Re-validate the parked spec — an approved card must never write a
      // shape the composer wouldn't accept.
      const spec = WidgetComponent.safeParse(argObject(args.spec));
      if (!spec.success) return `error: invalid spec — ${spec.error.issues[0]?.message}`;
      const statesParsed = z.array(WidgetState).max(12).safeParse(argObjectArray(args.states));
      const states = statesParsed.success ? statesParsed.data : null;
      const toolParsed = WidgetToolBinding.nullable().safeParse(argObjectOrNull(args.tool));
      const tool = toolParsed.success ? toolBindingOrNull(toolParsed.data) : null;
      if (tool) {
        // Re-verify at decide time — the bound tool must still exist and be
        // a plain read on the target agent; a submit tool likewise.
        const defs = toolsFor(agent);
        const def = tool.name ? defs.find((t) => t.name === tool.name) : undefined;
        if ((tool.name && !def) || def?.approval)
          return `error: bound tool "${tool.name}" is missing or approval-gated on ${agent.name}`;
        const fakeId =
          (await verifyBindingIds(ctx, agent, defs, tool.name ?? '', tool.args)) ??
          (tool.submit
            ? await verifyBindingIds(ctx, agent, defs, tool.submit.name, tool.submit.args)
            : null);
        if (fakeId) return `error: ${fakeId}`;
        if (tool.submit) {
          const subDef = defs.find((t) => t.name === tool.submit!.name);
          if (!subDef || subDef.approval)
            return `error: submit tool "${tool.submit.name}" is missing or approval-gated on ${agent.name}`;
        }
      }
      const name = normWidgetRef(String(args.name ?? '')).slice(0, 60);
      if (!name) return 'error: component name cannot be blank';
      const autoGreet = args.auto_greet === 'true';
      await ctx.db
        .insert(agentWidgets)
        .values({ agentId: agent.id, name, spec: spec.data, states, tool, autoGreet })
        .onConflictDoUpdate({
          target: [agentWidgets.agentId, agentWidgets.name],
          set: { spec: spec.data, states, tool, autoGreet, updatedAt: new Date() },
        });
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.widget.save',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', widget: name },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        ok: true,
        agent: agent.name,
        component: name,
        summary:
          `Saved "${name}" on ${agent.name} — it can show it any time with WIDGET_REF: ${name}` +
          (autoGreet ? ', and it now opens under the webchat greeting.' : '.'),
      });
    },
  },
  {
    name: 'update_channel',
    parksCard: true,
    description:
      "Propose a channel settings change in the visitor's workspace — rename a channel (the console label like 'Bubble', which is also the chat bubble's default header title) or set a bubble channel's header title. Posts an approval card — nothing changes until the visitor approves. Use this when the visitor asks to rename the bubble/channel itself, NOT the agent — that is update_agent's name param. Admin-only.",
    params: {
      channel: 'channel name (required) — the label in the channels list, e.g. "Bubble"',
      name: 'new channel name',
      title: "widget header title text (webchat only; blank string clears it back to the channel name)",
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;

      const hint = args.channel?.trim().toLowerCase();
      const wsChannels = await ctx.db
        .select({ id: channels.id, name: channels.name, kind: channels.kind })
        .from(channels)
        .where(eq(channels.workspaceId, ws.id));
      const channel = hint
        ? wsChannels.find((ch) => ch.name.toLowerCase() === hint) ??
          wsChannels.find((ch) => ch.name.toLowerCase().includes(hint))
        : undefined;
      if (!channel) {
        return JSON.stringify({
          error: `which channel? "${args.channel ?? ''}" didn't match — channels: ${wsChannels.map((ch) => ch.name).join(', ')}`,
        });
      }

      const rename = args.name !== undefined ? String(args.name).trim().slice(0, 80) : '';
      if (args.name !== undefined && !rename) {
        return JSON.stringify({ error: 'name cannot be blank' });
      }
      const title = args.title !== undefined ? String(args.title).trim().slice(0, 120) : undefined;
      if (title !== undefined && channel.kind !== 'webchat') {
        return JSON.stringify({ error: 'title applies to webchat channels' });
      }
      if (!rename && title === undefined) {
        return JSON.stringify({ error: 'nothing to change — pass name or title' });
      }
      const display: Record<string, unknown> = { channel: channel.name };
      if (rename && rename !== channel.name) display.name = `${channel.name} → ${rename}`;
      if (title !== undefined) display.title = title || `(default: channel name)`;
      return parkConciergeAction(
        ctx,
        'apply_channel',
        {
          workspace_id: ws.id,
          channel_id: channel.id,
          ...(rename && rename !== channel.name ? { name: rename } : {}),
          ...(title !== undefined ? { title } : {}),
        },
        `${rename && rename !== channel.name ? 'Rename' : 'Update'} channel "${channel.name}"`,
        display,
      );
    },
  },
  {
    // Executor for approved update_channel cards — hidden from the model.
    name: 'apply_channel',
    description: 'internal — executes an approved update_channel action card',
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
      const [channel] = await ctx.db
        .select()
        .from(channels)
        .where(
          and(eq(channels.id, String(args.channel_id ?? '')), eq(channels.workspaceId, wsId)),
        )
        .limit(1);
      if (!channel) return 'error: channel not found';
      const name = String(args.name ?? '').trim().slice(0, 80);
      const title = args.title !== undefined ? String(args.title).trim().slice(0, 120) : undefined;
      if (title !== undefined && channel.kind !== 'webchat') {
        return 'error: title applies to webchat channels';
      }
      if (!name && title === undefined) return 'error: empty or disallowed patch';
      const creds = { ...((channel.credentials ?? {}) as Record<string, unknown>) };
      if (title !== undefined) {
        if (title === '') delete creds.title;
        else creds.title = title;
      }
      await ctx.db
        .update(channels)
        .set({
          name: name || channel.name,
          credentials: creds,
        })
        .where(eq(channels.id, channel.id));
      invalidateChannelCache();
      const applied = [
        ...(name && name !== channel.name ? ['name'] : []),
        ...(title !== undefined ? ['title'] : []),
      ];
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'channel.update',
        targetType: 'channel',
        targetId: channel.id,
        meta: { via: 'concierge', fields: applied },
      });
      bus.publish(wsId, { type: 'channel', data: { id: channel.id } });
      const newName = name || channel.name;
      return JSON.stringify({
        ok: true,
        channel: newName,
        applied,
        summary:
          name && name !== channel.name
            ? `Renamed channel "${channel.name}" to "${newName}".`
            : `Updated channel "${newName}": ${applied.join(', ')}.`,
      });
    },
  },
  {
    name: 'create_channel',
    parksCard: true,
    description:
      "Propose adding a Bubble (webchat) channel to an existing agent in a workspace the visitor administers — posts an approval card; nothing is created until they approve. Use when the visitor wants web chat / a site widget for an agent — DO NOT describe manual steps when this card can do it. Other kinds (Messenger, email, SMS, WhatsApp) need credential/OAuth setup on the agent's Channels page — link that page instead. Admin-only.",
    params: {
      agent: 'agent name — the agent to put the Bubble on (required)',
      name: "optional channel label — defaults to the agent's name",
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const target = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in target)) return JSON.stringify(target);
      const agent = target.agent;
      const name = (args.name ?? '').trim().slice(0, 80) || agent.name;
      const wsChannels = await ctx.db
        .select({ id: channels.id, name: channels.name, credentials: channels.credentials })
        .from(channels)
        .where(and(eq(channels.agentId, agent.id), eq(channels.kind, 'webchat')));
      // Internal test-chat channels ("Test — …") aren't customer-facing —
      // they must not block a real Bubble from being created.
      const existing = wsChannels.filter(
        (c) => !((c.credentials ?? {}) as Record<string, unknown>).internal,
      );
      if (existing.length) {
        return JSON.stringify({
          error: `${agent.name} already has a Bubble channel ("${existing[0]?.name}") — rename or restyle it with update_channel`,
          url: `${env.webOrigin}/agents/${agent.id}/channels/${existing[0]?.id}`,
        });
      }
      return parkConciergeAction(
        ctx,
        'apply_create_channel',
        { workspace_id: ws.id, agent_id: agent.id, name },
        `Add a Bubble channel to "${agent.name}"`,
        { agent: agent.name, channel: name, kind: 'webchat' },
      );
    },
  },
  {
    // Executor for approved create_channel cards — hidden from the model.
    name: 'apply_create_channel',
    description: 'internal — executes an approved create_channel action card',
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
      const name = String(args.name ?? '').trim().slice(0, 80) || agent.name;
      const [chan] = await ctx.db
        .insert(channels)
        .values({ workspaceId: wsId, agentId: agent.id, kind: 'webchat', name, credentials: {} })
        .returning();
      invalidateChannelCache();
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'channel.create',
        targetType: 'channel',
        targetId: chan.id,
        meta: { name, kind: 'webchat', via: 'concierge' },
      });
      bus.publish(wsId, { type: 'channel', data: { id: chan.id } });
      const url = `${env.webOrigin}/agents/${agent.id}/channels/${chan.id}`;
      return JSON.stringify({
        ok: true,
        channel_id: chan.id,
        url,
        summary: `Bubble channel created on "${agent.name}" — open it: ${url}`,
      });
    },
  },
  {
    name: 'add_knowledge_source',
    parksCard: true,
    description:
      "Propose adding a knowledge SOURCE to an agent in the visitor's workspace — kind=url crawls a web page (and re-crawls it on the refresh cadence, like the console's Websites source), kind=site imports a WHOLE website or help centre as one site row with per-page sources nested under it (Zendesk API → sitemap → link crawl), kind=text saves a pasted document as a file (like an uploaded doc). For a one-line fact use teach_agent instead; for a public help-centre article use draft_article. Posts an approval card — nothing is added until the visitor approves. Admin-only.",
    params: {
      agent: 'agent name (required)',
      kind: 'url | text | site (required)',
      url: 'kind=url: page to crawl, e.g. https://acme.com/faq — kind=site: site/help-centre root to fan out, e.g. https://docs.acme.com',
      refresh_hours: 'kind=url/site: re-crawl cadence in hours, 1-720 (default 24)',
      title: 'kind=text: document name, e.g. "Return policy"',
      content: 'kind=text: the document text',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      const kind = String(args.kind ?? '').trim();
      if (!['url', 'text', 'site'].includes(kind)) {
        return JSON.stringify({ error: `unknown kind "${kind}" — url, site or text` });
      }
      const execArgs: Record<string, unknown> = {
        workspace_id: ws.id,
        agent_id: agent.id,
        kind,
      };
      const display: Record<string, unknown> = { agent: agent.name };
      if (kind === 'url' || kind === 'site') {
        const url = String(args.url ?? '').trim();
        try {
          const u = new URL(url);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
        } catch {
          return JSON.stringify({ error: `a full http(s) url is required for kind=${kind}` });
        }
        const hours = args.refresh_hours !== undefined ? Number(args.refresh_hours) : 24;
        if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
          return JSON.stringify({ error: 'refresh_hours must be 1-720' });
        }
        execArgs.url = url;
        execArgs.refresh_hours = Math.floor(hours);
        display.website = url;
        display.recrawl = `every ${Math.floor(hours)}h`;
        if (kind === 'site') display.scope = 'whole site — pages nest under one site row';
      } else {
        const title = String(args.title ?? '').trim().slice(0, 200);
        const content = String(args.content ?? '').trim();
        if (!title) return JSON.stringify({ error: 'kind=text needs a title' });
        if (!content) return JSON.stringify({ error: 'kind=text needs content — ask the visitor for the text to save' });
        execArgs.title = title;
        execArgs.content = content;
        display.document = title;
        display.size = `${content.length} chars`;
      }
      return parkConciergeAction(
        ctx,
        'apply_knowledge_source',
        execArgs,
        kind === 'url'
          ? `Crawl ${execArgs.url} — ${agent.name}`
          : kind === 'site'
            ? `Crawl site ${execArgs.url} — ${agent.name}`
            : `Save "${execArgs.title}" — ${agent.name}`,
        display,
      );
    },
  },
  {
    // Executor for approved add_knowledge_source cards — hidden from the model.
    name: 'apply_knowledge_source',
    description: 'internal — executes an approved add_knowledge_source action card',
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
      const [{ count }] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeFiles)
        .where(eq(knowledgeFiles.agentId, agent.id));
      if (count >= MAX_KNOWLEDGE_SOURCES) {
        return `error: knowledge source limit reached (${MAX_KNOWLEDGE_SOURCES})`;
      }
      const kind = String(args.kind ?? '');
      if (kind === 'site') {
        // Whole-site import — Zendesk API → sitemap → link crawl; per-page
        // stub rows the sweeper fills on its re-crawl pass.
        let result;
        try {
          result = await importHelpCentre(
            ctx.db,
            wsId,
            agent.id,
            String(args.url ?? ''),
            Number(args.refresh_hours ?? 24) || 24,
          );
        } catch (err) {
          return `error: site import failed — ${err instanceof Error ? err.message : 'import failed'}`;
        }
        await audit(ctx.db, {
          workspaceId: wsId,
          userId: user.id,
          userName: user.name,
          action: 'agent.knowledge_source.add',
          targetType: 'agent',
          targetId: agent.id,
          meta: { via: 'concierge', kind, url: String(args.url ?? ''), discovered: result.discovered },
        });
        bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
        return JSON.stringify({
          ok: true,
          agent: agent.name,
          summary: `Crawling ${args.url} into ${agent.name}'s knowledge — ${result.discovered} pages found via ${result.kind}${result.skipped ? ` (${result.skipped} already imported)` : ''}; they nest under one site row that re-discovers pages on schedule.`,
        });
      }
      let name: string;
      let text: string;
      let sizeBytes: number;
      let sourceUrl: string | null = null;
      let imageUrl: string | null = null;
      let refreshHours: number | null = null;
      let lastFetchedAt: Date | null = null;
      let nextFetchAt: Date | null = null;
      if (kind === 'url') {
        // Same normalization the console applies — /edit links, blob pages.
        const pastedUrl = String(args.url ?? '');
        sourceUrl = normalizeSourceUrl(pastedUrl);
        try {
          const fetched = await fetchUrlText(sourceUrl);
          text = fetched.text;
          sizeBytes = fetched.sizeBytes;
          imageUrl = fetched.imageUrl ?? null;
        } catch (err) {
          return `error: crawl failed — ${err instanceof Error ? err.message : 'fetch failed'}`;
        }
        name = pastedUrl;
        refreshHours = Number(args.refresh_hours ?? 24) || 24;
        lastFetchedAt = new Date();
        nextFetchAt = new Date(lastFetchedAt.getTime() + refreshHours * 3600_000);
      } else if (kind === 'text') {
        name = String(args.title ?? '').trim().slice(0, 200);
        text = String(args.content ?? '');
        sizeBytes = Buffer.byteLength(text, 'utf8');
        if (!name || !text) return 'error: missing title or content';
      } else {
        return 'error: unknown kind';
      }
      const [file] = await ctx.db
        .insert(knowledgeFiles)
        .values({
          workspaceId: wsId,
          agentId: agent.id,
          name,
          mimeType: kind === 'url' ? 'text/url-source' : 'text/plain',
          sizeBytes,
          text,
          sourceUrl,
          imageUrl,
          refreshHours,
          lastFetchedAt,
          nextFetchAt,
        })
        .returning();
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.knowledge_source.add',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', kind, name, file_id: file.id },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        ok: true,
        file_id: file.id,
        agent: agent.name,
        summary:
          kind === 'url'
            ? `Added ${sourceUrl} to ${agent.name}'s knowledge — crawled (${sizeBytes} bytes), re-crawls every ${refreshHours}h.`
            : `Saved "${name}" as a knowledge document on ${agent.name} (${sizeBytes} bytes).`,
      });
    },
  },
  {
    name: 'draft_article',
    parksCard: true,
    description:
      "Propose a help-centre article on an agent in the visitor's workspace — the public KB customers read at /help/{agent}. Drafts by default; pass publish=true to publish immediately. Posts an approval card — nothing is saved until the visitor approves. For internal knowledge the agent quotes in chat, use teach_agent or add_knowledge_source instead. Admin-only.",
    params: {
      agent: 'agent name (required)',
      title: 'article title (required)',
      body: 'article body — markdown (required)',
      category: 'help-centre category, e.g. "Shipping" (default General)',
      publish: 'true/false — publish now instead of saving a draft',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      const title = String(args.title ?? '').trim().slice(0, 200);
      const body = String(args.body ?? '').trim();
      if (!title) return JSON.stringify({ error: 'title is required' });
      if (!body) return JSON.stringify({ error: 'body is required' });
      const publish = ['true', 'yes', 'on', '1'].includes(String(args.publish ?? '').toLowerCase());
      const category = String(args.category ?? '').trim().slice(0, 60) || 'General';
      return parkConciergeAction(
        ctx,
        'apply_article',
        { workspace_id: ws.id, agent_id: agent.id, title, body, category, publish: String(publish) },
        `${publish ? 'Publish' : 'Draft'} "${title}" — ${agent.name}`,
        { agent: agent.name, title, category, status: publish ? 'published' : 'draft', length: `${body.length} chars` },
      );
    },
  },
  {
    // Executor for approved draft_article cards — hidden from the model.
    name: 'apply_article',
    description: 'internal — executes an approved draft_article action card',
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
      const title = String(args.title ?? '').trim().slice(0, 200);
      const body = String(args.body ?? '').trim();
      if (!title || !body) return 'error: missing title or body';
      const publish = args.publish === 'true';
      // Same slugify + -2/-3 uniqueness the console route uses.
      const base =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80) || 'article';
      const existing = await ctx.db
        .select({ slug: helpArticles.slug })
        .from(helpArticles)
        .where(eq(helpArticles.agentId, agent.id));
      const taken = new Set(existing.map((r) => r.slug).filter((s): s is string => Boolean(s)));
      let slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      const [row] = await ctx.db
        .insert(helpArticles)
        .values({
          workspaceId: wsId,
          agentId: agent.id,
          title,
          slug,
          category: String(args.category ?? '').trim().slice(0, 60) || 'General',
          body: body.slice(0, 60_000),
          status: publish ? 'published' : 'draft',
          publishedAt: publish ? new Date() : null,
        })
        .returning();
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: publish ? 'agent.article.publish' : 'agent.article.draft',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', title, slug, article_id: row.id },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      const url = `${env.webOrigin}/help/${agent.id}/${slug}`;
      return JSON.stringify({
        ok: true,
        article_id: row.id,
        slug,
        url: publish ? url : undefined,
        summary: publish
          ? `Published "${title}" on ${agent.name}'s help centre — ${url}`
          : `Saved "${title}" as a draft on ${agent.name}'s help centre — publish it from the agent's Knowledge → Sources.`,
      });
    },
  },
  {
    name: 'save_regression_test',
    parksCard: true,
    description:
      "Propose saving a regression test on an agent in the visitor's workspace — the same kind of test the console's Test tab saves: a customer message is replayed and the judge checks the reply against the expectation. Use when the visitor wants to pin down behavior ('make sure it always does X', 'save this as a test'). Posts an approval card — nothing is saved until the visitor approves. Admin-only.",
    params: {
      agent: 'agent name (required)',
      name: 'short test name, e.g. "refund policy question" (required)',
      customer_message: 'the customer message the test replays (required)',
      expectation: 'what a good reply looks like — the judge checks this (required)',
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
      if (!('ws' in resolved)) return JSON.stringify(resolved);
      const ws = resolved.ws;
      const picked = await visitorAgent(ctx, ws, args.agent);
      if (!('agent' in picked)) return JSON.stringify(picked);
      const agent = picked.agent;
      const name = String(args.name ?? '').trim().slice(0, 120);
      const customerMessage = String(args.customer_message ?? '').trim().slice(0, 2000);
      const expectation = String(args.expectation ?? '').trim().slice(0, 2000);
      if (!name) return JSON.stringify({ error: 'name is required' });
      if (!customerMessage) return JSON.stringify({ error: 'customer_message is required — the message the test replays' });
      if (!expectation) return JSON.stringify({ error: 'expectation is required — describe what a good reply does' });
      return parkConciergeAction(
        ctx,
        'apply_regression_test',
        {
          workspace_id: ws.id,
          agent_id: agent.id,
          name,
          customer_message: customerMessage,
          expectation,
        },
        `Save test "${name}" — ${agent.name}`,
        { agent: agent.name, customer: customerMessage.slice(0, 120), expectation: expectation.slice(0, 200) },
      );
    },
  },
  {
    // Executor for approved save_regression_test cards — hidden from the model.
    name: 'apply_regression_test',
    description: 'internal — executes an approved save_regression_test action card',
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
      const name = String(args.name ?? '').trim().slice(0, 120);
      const customerMessage = String(args.customer_message ?? '').trim().slice(0, 2000);
      const expectation = String(args.expectation ?? '').trim().slice(0, 2000);
      if (!name || !customerMessage || !expectation) return 'error: missing name, customer_message or expectation';
      const [row] = await ctx.db
        .insert(agentTests)
        .values({
          workspaceId: wsId,
          agentId: agent.id,
          name,
          turns: [{ role: 'customer', text: customerMessage }],
          expectation,
          expectationDraft: true,
          source: 'user',
          category: 'general',
        })
        .returning();
      await audit(ctx.db, {
        workspaceId: wsId,
        userId: user.id,
        userName: user.name,
        action: 'agent.test.save',
        targetType: 'agent',
        targetId: agent.id,
        meta: { via: 'concierge', name, test_id: row.id },
      });
      bus.publish(wsId, { type: 'agent', data: { id: agent.id } });
      return JSON.stringify({
        ok: true,
        test_id: row.id,
        agent: agent.name,
        summary: `Saved regression test "${name}" on ${agent.name} — find it under the agent's Test tab.`,
      });
    },
  },
];

/** Builtins enabled on this agent's config AND available in this environment. */
export function enabledBuiltins(
  enabled: string[] | undefined,
  workspaceId?: string,
  /** The conversation's visitor is a verified signed-in Janis user.
   *  Fail-closed default: callers must affirmatively pass true. */
  verified = false,
): BuiltinTool[] {
  // The sales concierge (public webchat) and the operator copilot share
  // one agent and one catalog — available() is workspace-scoped, so
  // without this filter anonymous visitors see the same workspace-bound
  // tools signed-in operators do. Scope the menu by conversation
  // identity instead: unverified visitors keep only publicAnon tools.
  const operatorWs = Boolean(env.operatorWorkspaceId) && workspaceId === env.operatorWorkspaceId;
  return BUILTIN_TOOLS.filter(
    (b) =>
      enabled?.includes(b.name) &&
      b.available(workspaceId) &&
      (verified || !operatorWs || b.publicAnon === true),
  );
}

/** The copilot toolset for embedded merchant-Ask threads — every builtin
 *  that would be offered to the concierge on the operator workspace. Driving
 *  off available() keeps this self-maintaining: new operator-gated builtins
 *  are picked up automatically, env-gated ones (no key configured) drop out. */
export function copilotBuiltins(): BuiltinTool[] {
  return BUILTIN_TOOLS.filter(
    (b) => env.operatorWorkspaceId && b.available(env.operatorWorkspaceId),
  );
}

/** Catalog view for the UI — every builtin, flagging whether it can run now. */
export function builtinCatalog(workspaceId?: string) {
  return BUILTIN_TOOLS.map((b) => ({
    name: b.name,
    description: b.description,
    available: b.available(workspaceId),
    platform: b.platform === true,
  }));
}
