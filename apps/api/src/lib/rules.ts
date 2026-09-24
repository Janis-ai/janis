import type { AlertType, IngestEvent } from '@janis/shared';
import type { alertRules } from '../db/schema.js';

type RuleRow = typeof alertRules.$inferSelect;
type RuleConfig = { keywords?: string[]; inactivity_minutes?: number; enabled?: boolean };

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

/** Inactivity rules → minutes threshold. Evaluated by the sweeper. */
export function inactivityThresholds(rules: RuleRow[]): number[] {
  return rules
    .filter((r) => r.kind === 'inactivity' && (r.config as RuleConfig).enabled !== false)
    .map((r) => (r.config as RuleConfig).inactivity_minutes ?? 15);
}
