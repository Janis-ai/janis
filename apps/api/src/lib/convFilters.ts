import { and, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts, channelBindings, channels, conversations } from '../db/schema.js';
import { agentScopeCond, type AgentScope } from './access.js';

/** Filter groups — 'unread'/'starred' are flags, 'snoozed' is a
 * pseudo-state orthogonal to lifecycle, and the rest of the signals are
 * open-alert kinds. Values inside a group OR together; groups AND. */
export const CONV_STATES = ['active', 'needs_human', 'human', 'archived', 'snoozed'] as const;
export const CONV_FLAGS = ['unread', 'starred'] as const;
export const CONV_SIGNALS = ['handoff_offer', 'failure', 'overdue'] as const;

const csvIn = (allowed: readonly string[]) =>
  z
    .string()
    .max(200)
    .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => allowed.includes(v)))
    .optional();

/** Query params shared by the conversation list and search endpoints.
 * `state` is the legacy single-select (v1 API + deep links); `states`,
 * `flags` and `signals` are the multi-select csv params the console's
 * filter popover speaks — a legacy `state` folds into the same buckets. */
export const convListQuery = z.object({
  state: z
    .enum(['active', 'needs_human', 'human', 'archived', 'snoozed', 'unread', 'starred', 'handoff_offer', 'failure', 'overdue'])
    .optional(),
  states: csvIn(CONV_STATES),
  flags: csvIn(CONV_FLAGS),
  signals: csvIn(CONV_SIGNALS),
  agent_id: z.string().uuid().optional(),
  attention: z.enum(['1', 'true']).optional(), // needs_human OR has open alerts
  assignee: z.enum(['me']).optional(), // only conversations assigned to the caller
  // Reports drill-down: ?intent=support groups by classified topic
  // ('unclassified' = intent is null); ?from/?to bound created_at — a plain
  // YYYY-MM-DD `to` is inclusive (shifts to exclusive end-of-day).
  intent: z.string().trim().min(1).max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]|$)/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]|$)/).optional(),
  // Cursor pagination: `${epochMs}_${uuid}` of the last row's sort key
  // (coalesce(last_message_at, created_at), id). Stable under new arrivals —
  // new rows sort ahead of the cursor, never inside a fetched window.
  cursor: z
    .string()
    .regex(/^\d+_[0-9a-fA-F-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Internal test-channel conversations — the externalId carries ':test:'
 * (kind:test:<channelId>:<participant>); the binding check catches legacy
 * threads written before the namespacing. These ride the real pipeline for
 * takeover/alert testing but must not drive the Inbox badge. */
export const TEST_CONV = sql`(
  ${conversations.externalId} like '%:test:%'
  or exists (
    select 1 from ${channelBindings}
    inner join ${channels} on ${channels.id} = ${channelBindings.channelId}
    where ${channelBindings.conversationId} = ${conversations.id}
      and ${channels.credentials}->>'internal' = 'true'
  )
)`;

/** Merchant-ask threads — a Shopify staff member talking to their own agent
 *  from the embedded app's Ask tab. Not a customer conversation: excluded
 *  from inbox lists, unread/attention badges, and search everywhere. */
export const MERCHANT_CONV = sql`coalesce(${conversations.userProfile}->>'kind', '') = 'merchant_ask'`;

/** WHERE conditions for conversation listing — workspace scope + filters.
 * Shared by /api/conversations and /api/search so filters behave identically. */
export function convListConditions(
  q: z.infer<typeof convListQuery> & { q?: string },
  workspaceId: string,
  userId: string,
  scope?: AgentScope,
): SQL[] {
  const scoped = agentScopeCond(scope ?? null);
  const conditions: SQL[] = [
    eq(agents.workspaceId, workspaceId),
    ...(scoped ? [scoped] : []),
    sql`not ${MERCHANT_CONV}`,
  ];
  // Legacy single-select `state` folds into the same buckets the csv params
  // feed — ?state=unread and ?flags=unread are the same filter.
  const states = new Set(q.states ?? []);
  const flags = new Set(q.flags ?? []);
  const signals = new Set(q.signals ?? []);
  if (q.state === 'unread' || q.state === 'starred') flags.add(q.state);
  else if (q.state === 'handoff_offer' || q.state === 'failure' || q.state === 'overdue')
    signals.add(q.state);
  else if (q.state) states.add(q.state);

  // State group — lifecycle states OR together; 'snoozed' rides along as the
  // pseudo-state (anything snoozed into the future, whatever its real state)
  const stateOrs: SQL[] = [];
  const lifecycle = [...states].filter(
    (s): s is Exclude<(typeof CONV_STATES)[number], 'snoozed'> => s !== 'snoozed',
  );
  if (lifecycle.length) stateOrs.push(inArray(conversations.state, lifecycle));
  if (states.has('snoozed')) stateOrs.push(sql`${conversations.snoozedUntil} > now()`);
  if (stateOrs.length) conditions.push(or(...stateOrs)!);

  // Flags — unread/starred OR together
  const flagOrs: SQL[] = [];
  if (flags.has('unread')) flagOrs.push(eq(conversations.isUnread, true));
  if (flags.has('starred')) flagOrs.push(eq(conversations.isStarred, true));
  if (flagOrs.length) conditions.push(or(...flagOrs)!);

  // Signals — open-alert kinds OR together, whatever the lifecycle state.
  // 'overdue' keeps its compound definition: still waiting on a human past
  // the agent's SLA (config.sla_minutes, default 15) — same as the Reports
  // handoff card.
  const openAlertOf = (type: string) =>
    sql`exists (
      select 1 from ${alerts}
      where ${alerts.conversationId} = ${conversations.id}
        and ${alerts.status} = 'open'
        and ${alerts.type} = ${type}
    )`;
  const signalOrs: SQL[] = [];
  if (signals.has('handoff_offer')) signalOrs.push(openAlertOf('handoff_offer'));
  if (signals.has('failure')) signalOrs.push(openAlertOf('failure'));
  if (signals.has('overdue'))
    signalOrs.push(
      and(
        eq(conversations.state, 'needs_human'),
        sql`exists (
          select 1 from ${alerts}
          where ${alerts.conversationId} = ${conversations.id}
            and ${alerts.status} = 'open'
            and ${alerts.createdAt} < now() - interval '1 minute' * coalesce((${agents.config} ->> 'sla_minutes')::int, 15)
        )`,
      )!,
    );
  if (signalOrs.length) conditions.push(or(...signalOrs)!);

  // archived hidden only in the unfiltered browse view — an explicit
  // selection (any state/flag/signal), a topic drill-down, or a text
  // search shows them. Search covers everything like Slack: archived is
  // a list-view concept, not a search exclusion.
  const searching = !!q.q?.trim();
  if (!stateOrs.length && !flagOrs.length && !signalOrs.length && !q.intent && !q.from && !q.to && !searching)
    conditions.push(ne(conversations.state, 'archived'));
  // actively-snoozed conversations hide from every queue except when Snoozed
  // (or Archived — archive wins over snooze) is among the selected states;
  // drill-downs and text searches count everything, snoozed or not
  if (!states.has('snoozed') && !states.has('archived') && !q.intent && !q.from && !q.to && !searching) {
    conditions.push(
      sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
    );
  }
  if (q.agent_id) conditions.push(eq(conversations.agentId, q.agent_id));
  if (q.intent)
    conditions.push(
      q.intent === 'unclassified'
        ? isNull(conversations.intent)
        : eq(conversations.intent, q.intent),
    );
  if (q.from) {
    const d = new Date(q.from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(conversations.createdAt, d));
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!Number.isNaN(d.getTime()))
      conditions.push(
        lt(conversations.createdAt, /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(d.getTime() + 86_400_000) : d),
      );
  }
  if (q.assignee === 'me') conditions.push(eq(conversations.assigneeId, userId));
  if (q.attention) {
    conditions.push(inArray(conversations.state, ['needs_human', 'human']));
  }
  return conditions;
}
