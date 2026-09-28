import type { AlertType, IngestEvent } from '@janis/shared';
import type { alertRules } from '../db/schema.js';

type RuleRow = typeof alertRules.$inferSelect;
type RuleConfig = {
  keywords?: string[];
  inactivity_minutes?: number;
  enabled?: boolean;
  /** Actions — on a trigger, assign the conversation and/or tag it. */
  assign_to?: string;
  tag?: string;
  /** auto_assign: round-robin pool + cursor */
  assignees?: string[];
  next?: number;
};

/** Effects a fired rule applies to the conversation. */
export interface RuleAction {
  assignTo?: string;
  tag?: string;
}

export interface TriggeredAlert {
  type: AlertType;
  detail: string | null;
}

/**
 * Decide which alerts a single ingest event should fire for an agent.
 * Explicit event types (failure / handoff_request / custom_alert) always fire —
 * they're the agent asking for help. keyword rules only inspect message_in text.
 */
export function evaluateEvent(event: IngestEvent, rules: RuleRow[]): TriggeredAlert[] {
  const triggered: TriggeredAlert[] = [];
  const enabled = rules.filter((r) => (r.config as RuleConfig).enabled !== false);

  const ruleOn = (kind: RuleRow['kind']) => enabled.some((r) => r.kind === kind);
  const alwaysFire = rules.length === 0; // no rules configured → sensible defaults

  switch (event.type) {
    case 'failure':
      if (alwaysFire || ruleOn('failure')) {
        triggered.push({ type: 'failure', detail: event.reason ?? event.text ?? null });
      }
      break;
    case 'handoff_request':
      if (alwaysFire || ruleOn('handoff_request')) {
        triggered.push({ type: 'help_request', detail: event.reason ?? 'Agent requested handoff' });
      }
      break;
    case 'handoff_offer':
      // Offers ride the handoff rule toggle — a workspace that disabled
      // handoff alerts doesn't want offer alerts either.
      if (alwaysFire || ruleOn('handoff_request')) {
        triggered.push({ type: 'handoff_offer', detail: event.reason ?? 'Agent offered a human' });
      }
      break;
    case 'custom_alert':
      if (alwaysFire || ruleOn('custom_alert')) {
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
 * Side-effects attached to rules that fired for this event — keyword matches
 * can route the thread (assign/tag) alongside their alert. Inactivity
 * actions are applied by the sweeper, which owns that trigger.
 */
export function evaluateActions(event: IngestEvent, rules: RuleRow[]): RuleAction[] {
  if (event.type !== 'message_in') return [];
  const text = event.text.toLowerCase();
  const actions: RuleAction[] = [];
  for (const r of rules) {
    const cfg = r.config as RuleConfig;
    if (r.kind !== 'keyword' || cfg.enabled === false) continue;
    const hit = (cfg.keywords ?? []).some((k) => k.length > 0 && text.includes(k.toLowerCase()));
    if (hit && (cfg.assign_to || cfg.tag)) {
      actions.push({ assignTo: cfg.assign_to, tag: cfg.tag });
    }
  }
  return actions;
}

/**
 * auto_assign rule → who owns a brand-new conversation. `assign_to` is a
 * fixed owner; `assignees` is a round-robin pool whose cursor (`next`) the
 * caller persists back onto the rule config.
 */
export function pickAutoAssignee(
  rules: RuleRow[],
): { userId: string; ruleId: string; next: number } | null {
  const rule = rules.find(
    (r) => r.kind === 'auto_assign' && (r.config as RuleConfig).enabled !== false,
  );
  if (!rule) return null;
  const cfg = rule.config as RuleConfig;
  if (cfg.assign_to) return { userId: cfg.assign_to, ruleId: rule.id, next: cfg.next ?? 0 };
  const pool = (cfg.assignees ?? []).filter(Boolean);
  if (!pool.length) return null;
  const at = (cfg.next ?? 0) % pool.length;
  return { userId: pool[at], ruleId: rule.id, next: at + 1 };
}

/** Side-effects of an agent's inactivity rules, applied when it fires. */
export function inactivityActions(rules: RuleRow[]): RuleAction[] {
  return rules
    .filter((r) => r.kind === 'inactivity' && (r.config as RuleConfig).enabled !== false)
    .map((r) => {
      const cfg = r.config as RuleConfig;
      return { assignTo: cfg.assign_to, tag: cfg.tag };
    })
    .filter((a) => a.assignTo || a.tag);
}

/** Inactivity rules → minutes threshold. Evaluated by the sweeper. */
export function inactivityThresholds(rules: RuleRow[]): number[] {
  return rules
    .filter((r) => r.kind === 'inactivity' && (r.config as RuleConfig).enabled !== false)
    .map((r) => (r.config as RuleConfig).inactivity_minutes ?? 15);
}
