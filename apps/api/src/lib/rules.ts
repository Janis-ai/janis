import type { AlertType, IngestEvent } from '@janis/shared';
import type { alertRules, memberGroups } from '../db/schema.js';

export type RuleRow = typeof alertRules.$inferSelect;
export type GroupRef = Pick<typeof memberGroups.$inferSelect, 'id' | 'memberIds'>;
export type RuleConfig = {
  keywords?: string[];
  /** intent rules: classifier topic labels that fire the rule */
  intents?: string[];
  inactivity_minutes?: number;
  /** csat rules: fire when a survey score lands at or below this (1–5) */
  max_score?: number;
  enabled?: boolean;
  /** Actions — on a trigger, assign the conversation and/or tag it. */
  assign_to?: string;
  tag?: string;
  /** Rotation pool — explicit member ids plus roster members from
   *  group_ids; `next` is the round-robin cursor persisted on the rule. */
  assignees?: string[];
  group_ids?: string[];
  next?: number;
};

/** Effects a fired rule applies to the conversation. */
export interface RuleAction {
  assignTo?: string;
  tag?: string;
  /** Set when a rotation pool picked the assignee — caller persists the
   *  cursor back onto the rule config. */
  ruleId?: string;
  next?: number;
}

export interface TriggeredAlert {
  type: AlertType;
  detail: string | null;
}

/** A rule's assignment pool — explicit member ids ∪ roster members. */
export function rulePool(cfg: RuleConfig, groups: GroupRef[]): string[] {
  const pool = [...(cfg.assignees ?? [])];
  for (const gid of cfg.group_ids ?? []) {
    const g = groups.find((x) => x.id === gid);
    if (g) pool.push(...g.memberIds);
  }
  return [...new Set(pool.filter(Boolean))];
}

/** Who a fired rule assigns: a fixed owner wins; otherwise the rotation
 *  pool (members + groups) advances its cursor, returned for the caller
 *  to persist onto the rule config. */
export function pickRuleAssignee(
  rule: RuleRow,
  groups: GroupRef[],
): { userId: string; next?: number } | null {
  const cfg = rule.config as RuleConfig;
  if (cfg.assign_to) return { userId: cfg.assign_to };
  const pool = rulePool(cfg, groups);
  if (!pool.length) return null;
  const at = (cfg.next ?? 0) % pool.length;
  return { userId: pool[at], next: at + 1 };
}

/** Actions a fired rule carries, with any pool rotation resolved. */
export function ruleAction(rule: RuleRow, groups: GroupRef[]): RuleAction {
  const cfg = rule.config as RuleConfig;
  const pick = pickRuleAssignee(rule, groups);
  return {
    assignTo: pick?.userId,
    tag: cfg.tag,
    ...(pick?.next !== undefined ? { ruleId: rule.id, next: pick.next } : {}),
  };
}

export function ruleEnabled(rule: RuleRow): boolean {
  return (rule.config as RuleConfig).enabled !== false;
}

/**
 * Non-admin members may edit a rule's routing ONLY to add/remove themselves.
 * Returns true when prev→next is identical in every field except assign_to/
 * assignees, and the set difference touches only userId. (joining a fixed
 * owner's rule moves both into the rotation pool — assign_to → assignees —
 * which is still a self-only diff.)
 */
export function selfAssignOnly(prev: RuleConfig, next: RuleConfig, userId: string): boolean {
  // JSONB doesn't preserve object key order — canonicalize before comparing.
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  const rest = (c: RuleConfig) => {
    const { assign_to: _at, assignees: _as, ...r } = c;
    return canon(r);
  };
  if (JSON.stringify(rest(prev)) !== JSON.stringify(rest(next))) return false;
  const ids = (c: RuleConfig) =>
    new Set([c.assign_to, ...(c.assignees ?? [])].filter((x): x is string => Boolean(x)));
  const before = ids(prev);
  const after = ids(next);
  for (const id of before) if (!after.has(id) && id !== userId) return false;
  for (const id of after) if (!before.has(id) && id !== userId) return false;
  return true;
}

/**
 * Decide which alerts a single ingest event should fire for an agent.
 * Explicit event types (failure / handoff_request / custom_alert) fire by
 * default — they're the agent asking for help — and stay on until the
 * workspace configures that KIND: an enabled rule of the kind keeps it
 * firing, a kind whose rules exist but are all disabled is explicitly
 * silenced. Rules of unrelated kinds can never swallow a default.
 * keyword rules only inspect message_in text.
 */
export function evaluateEvent(event: IngestEvent, rules: RuleRow[]): TriggeredAlert[] {
  const triggered: TriggeredAlert[] = [];
  const enabled = rules.filter(ruleEnabled);

  const ruleOn = (kind: RuleRow['kind']) => enabled.some((r) => r.kind === kind);
  const fires = (kind: RuleRow['kind']) =>
    ruleOn(kind) || !rules.some((r) => r.kind === kind);

  switch (event.type) {
    case 'failure':
      if (fires('failure')) {
        triggered.push({ type: 'failure', detail: event.reason ?? event.text ?? null });
      }
      break;
    case 'handoff_request':
      if (fires('handoff_request')) {
        triggered.push({ type: 'help_request', detail: event.reason ?? 'Agent requested handoff' });
      }
      break;
    case 'handoff_offer':
      // Offers ride the handoff rule toggle — a workspace that disabled
      // handoff alerts doesn't want offer alerts either.
      if (fires('handoff_request')) {
        triggered.push({ type: 'handoff_offer', detail: event.reason ?? 'Agent offered a human' });
      }
      break;
    case 'custom_alert':
      if (fires('custom_alert')) {
        triggered.push({ type: 'custom', detail: event.alert_type });
      }
      break;
    case 'message_in': {
      const keywords = enabled
        .filter((r) => r.kind === 'keyword')
        .flatMap((r) => (r.config as RuleConfig).keywords ?? [])
        .filter((k) => k.length > 0);
      const text = event.text.toLowerCase();
      const matched = keywords.find((k) => text.includes(k.toLowerCase()));
      if (matched) triggered.push({ type: 'keyword', detail: `matched "${matched}"` });
      break;
    }
    default:
      break;
  }
  return triggered;
}

/**
 * Side-effects attached to rules that fired for this event. keyword rules
 * match on message_in text; alert-typed events (handoff / failure /
 * custom_alert) route through every enabled rule of that kind — a
 * "handoff → assign on-call" rule's assign/tag must apply alongside its
 * alert, not get dropped because only keywords carried routing.
 * Inactivity actions are applied by the sweeper, which owns that trigger.
 */
export function evaluateActions(
  event: IngestEvent,
  rules: RuleRow[],
  groups: GroupRef[] = [],
): RuleAction[] {
  const matched: RuleRow[] = [];
  if (event.type === 'message_in') {
    const text = event.text.toLowerCase();
    for (const r of rules) {
      const cfg = r.config as RuleConfig;
      if (r.kind !== 'keyword' || cfg.enabled === false) continue;
      const hit = (cfg.keywords ?? []).some((k) => k.length > 0 && text.includes(k.toLowerCase()));
      if (hit) matched.push(r);
    }
  } else {
    const kind = EVENT_RULE_KIND[event.type];
    if (kind) {
      matched.push(...rules.filter((r) => r.kind === kind && ruleEnabled(r)));
    }
  }
  return matched
    .map((r) => ruleAction(r, groups))
    .filter((a) => a.assignTo || a.tag);
}

/** Ingest event type → the rule kind that carries its routing. Offers ride
 *  the handoff kind just like their alert toggle does. */
const EVENT_RULE_KIND: Partial<Record<IngestEvent['type'], RuleRow['kind']>> = {
  handoff_request: 'handoff_request',
  handoff_offer: 'handoff_request',
  failure: 'failure',
  custom_alert: 'custom_alert',
};

/**
 * auto_assign rule → who owns a brand-new conversation. `assign_to` is a
 * fixed owner; the assignees/group_ids pool round-robins, its cursor
 * (`next`) persisted back onto the rule config by the caller.
 */
export function pickAutoAssignee(
  rules: RuleRow[],
  groups: GroupRef[] = [],
): { userId: string; ruleId: string; next: number } | null {
  const rule = rules.find((r) => r.kind === 'auto_assign' && ruleEnabled(r));
  if (!rule) return null;
  const cfg = rule.config as RuleConfig;
  if (cfg.assign_to) return { userId: cfg.assign_to, ruleId: rule.id, next: cfg.next ?? 0 };
  const pool = rulePool(cfg, groups);
  if (!pool.length) return null;
  const at = (cfg.next ?? 0) % pool.length;
  return { userId: pool[at], ruleId: rule.id, next: at + 1 };
}

/** Side-effects of an agent's inactivity rules, applied when it fires. */
export function inactivityActions(rules: RuleRow[], groups: GroupRef[] = []): RuleAction[] {
  return rules
    .filter((r) => r.kind === 'inactivity' && ruleEnabled(r))
    .map((r) => ruleAction(r, groups))
    .filter((a) => a.assignTo || a.tag);
}

/** Inactivity rules → minutes threshold. Evaluated by the sweeper. */
export function inactivityThresholds(rules: RuleRow[]): number[] {
  return rules
    .filter((r) => r.kind === 'inactivity' && ruleEnabled(r))
    .map((r) => (r.config as RuleConfig).inactivity_minutes ?? 15);
}

/** Rules that react to a classified topic label — intent-kind rules alert;
 *  intents on other kinds stay silent routing (legacy behavior). */
export function intentMatches(
  rules: RuleRow[],
  intent: string,
  kind?: RuleRow['kind'],
): RuleRow[] {
  const label = intent.toLowerCase();
  return rules.filter((r) => {
    if (kind !== undefined && r.kind !== kind) return false;
    if (!ruleEnabled(r)) return false;
    return ((r.config as RuleConfig).intents ?? []).some((i) => i.toLowerCase() === label);
  });
}
