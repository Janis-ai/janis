import { describe, expect, it } from 'vitest';
import type { IngestEvent } from '@janis/shared';
import { evaluateActions, evaluateEvent, inactivityThresholds, intentMatches, pickAutoAssignee, selfAssignOnly } from './rules.js';
import type { alertRules } from '../db/schema.js';

const rule = (
  kind: string,
  config: Record<string, unknown>,
): typeof alertRules.$inferSelect =>
  ({ id: 'r1', agentId: 'a1', kind, config, createdAt: new Date() }) as never;

const evt = (e: Partial<IngestEvent> & { type: IngestEvent['type'] }): IngestEvent =>
  ({ conversation_id: 'c1', ...e }) as IngestEvent;

describe('evaluateEvent', () => {
  it('fires defaults when no rules configured', () => {
    expect(evaluateEvent(evt({ type: 'failure', reason: 'boom' }), [])).toEqual([
      { type: 'failure', detail: 'boom' },
    ]);
    expect(evaluateEvent(evt({ type: 'handoff_request' }), [])).toHaveLength(1);
    expect(evaluateEvent(evt({ type: 'message_in', text: 'hi' }), [])).toHaveLength(0);
  });

  it('respects disabled rules', () => {
    const rules = [rule('failure', { enabled: false })];
    expect(evaluateEvent(evt({ type: 'failure' }), rules)).toHaveLength(0);
  });

  it('matches keywords case-insensitively on inbound messages', () => {
    const rules = [rule('keyword', { enabled: true, keywords: ['Refund', 'lawyer'] })];
    expect(evaluateEvent(evt({ type: 'message_in', text: 'I want a REFUND' }), rules)).toEqual([
      { type: 'keyword', detail: 'matched "Refund"' },
    ]);
    expect(evaluateEvent(evt({ type: 'message_in', text: 'hello' }), rules)).toHaveLength(0);
    // keywords only apply to inbound
    expect(evaluateEvent(evt({ type: 'message_out', text: 'refund processed' }), rules)).toHaveLength(0);
  });

  it('fires unconfigured kinds by default — unrelated rules cannot swallow them', () => {
    const rules = [rule('keyword', { enabled: true, keywords: ['x'] })];
    // a keyword rule existing must NOT kill the failure/handoff/custom defaults
    expect(evaluateEvent(evt({ type: 'failure' }), rules)).toHaveLength(1);
    expect(evaluateEvent(evt({ type: 'handoff_request' }), rules)).toHaveLength(1);
    expect(evaluateEvent(evt({ type: 'custom_alert', alert_type: 'x' }), rules)).toHaveLength(1);
  });

  it('a disabled-only kind is silenced but other kinds still default-fire', () => {
    const rules = [
      rule('failure', { enabled: false }),
      rule('handoff_request', { enabled: false }),
      rule('custom_alert', { enabled: false }),
      rule('keyword', { enabled: true, keywords: ['x'] }),
    ];
    expect(evaluateEvent(evt({ type: 'failure' }), rules)).toHaveLength(0);
    expect(evaluateEvent(evt({ type: 'handoff_request' }), rules)).toHaveLength(0);
    expect(evaluateEvent(evt({ type: 'handoff_offer' }), rules)).toHaveLength(0);
    expect(evaluateEvent(evt({ type: 'custom_alert', alert_type: 'x' }), rules)).toHaveLength(0);
    // ...but a kind with NO rule at all still defaults on
    const onlyDisabledFailure = [rule('failure', { enabled: false })];
    expect(evaluateEvent(evt({ type: 'handoff_request' }), onlyDisabledFailure)).toHaveLength(1);
  });
});

describe('inactivityThresholds', () => {
  it('collects minutes from enabled inactivity rules', () => {
    const rules = [
      rule('inactivity', { enabled: true, inactivity_minutes: 10 }),
      rule('inactivity', { enabled: false, inactivity_minutes: 5 }),
      rule('keyword', { enabled: true, keywords: ['x'] }),
    ];
    expect(inactivityThresholds(rules)).toEqual([10]);
  });
});

describe('evaluateActions', () => {
  it('returns assign/tag actions for matching keyword rules', () => {
    const rules = [
      rule('keyword', { enabled: true, keywords: ['refund'], assign_to: 'u1', tag: 'billing' }),
      rule('keyword', { enabled: true, keywords: ['lawyer'], tag: 'legal' }),
    ];
    expect(
      evaluateActions(evt({ type: 'message_in', text: 'I want a refund and a lawyer' }), rules),
    ).toEqual([
      { assignTo: 'u1', tag: 'billing', ruleId: 'r1', kind: 'keyword' },
      { assignTo: undefined, tag: 'legal', ruleId: 'r1', kind: 'keyword' },
    ]);
    expect(evaluateActions(evt({ type: 'message_in', text: 'hello' }), rules)).toEqual([]);
    // non-inbound events never trigger actions
    expect(evaluateActions(evt({ type: 'message_out', text: 'refund' }), rules)).toEqual([]);
  });

  it('skips keyword rules with no actions attached', () => {
    const rules = [rule('keyword', { enabled: true, keywords: ['refund'] })];
    expect(evaluateActions(evt({ type: 'message_in', text: 'refund' }), rules)).toEqual([]);
  });

  it('routes alert-typed events through their kind\'s rules', () => {
    const rules = [
      rule('handoff_request', { enabled: true, assign_to: 'oncall1', tag: 'escalated' }),
      rule('handoff_request', { enabled: false, assign_to: 'oncall2' }), // disabled — no action
      rule('custom_alert', { enabled: true, tag: 'custom-tag' }),
      rule('failure', { enabled: true, assignees: ['ops1'], next: 0 }),
    ];
    expect(evaluateActions(evt({ type: 'handoff_request' }), rules)).toEqual([
      { assignTo: 'oncall1', tag: 'escalated', ruleId: 'r1', kind: 'handoff_request' },
    ]);
    expect(evaluateActions(evt({ type: 'handoff_offer' }), rules)).toEqual([
      { assignTo: 'oncall1', tag: 'escalated', ruleId: 'r1', kind: 'handoff_request' },
    ]);
    expect(evaluateActions(evt({ type: 'custom_alert', alert_type: 'x' }), rules)).toEqual([
      { assignTo: undefined, tag: 'custom-tag', ruleId: 'r1', kind: 'custom_alert' },
    ]);
    expect(evaluateActions(evt({ type: 'failure' }), rules)).toEqual([
      { assignTo: 'ops1', tag: undefined, ruleId: 'r1', kind: 'failure', next: 1 },
    ]);
    // non-alert events still produce nothing
    expect(evaluateActions(evt({ type: 'resolve' }), rules)).toEqual([]);
  });
});

describe('pickAutoAssignee', () => {
  it('returns a fixed assignee', () => {
    const rules = [rule('auto_assign', { enabled: true, assign_to: 'u9' })];
    expect(pickAutoAssignee(rules)).toEqual({ userId: 'u9', ruleId: 'r1', next: 0 });
  });

  it('round-robins through the assignees pool', () => {
    const rules = [rule('auto_assign', { enabled: true, assignees: ['u1', 'u2'], next: 0 })];
    expect(pickAutoAssignee(rules)).toEqual({ userId: 'u1', ruleId: 'r1', next: 1 });
    const advanced = [rule('auto_assign', { enabled: true, assignees: ['u1', 'u2'], next: 3 })];
    expect(pickAutoAssignee(advanced)).toEqual({ userId: 'u2', ruleId: 'r1', next: 2 });
  });

  it('returns null when disabled or pool empty', () => {
    expect(pickAutoAssignee([rule('auto_assign', { enabled: false, assignees: ['u1'] })])).toBeNull();
    expect(pickAutoAssignee([rule('auto_assign', { enabled: true })])).toBeNull();
    expect(pickAutoAssignee([rule('keyword', { enabled: true, keywords: ['x'] })])).toBeNull();
  });
});

describe('group-expanded pools', () => {
  const groups = [{ id: 'g1', memberIds: ['u3', 'u4'] }];

  it('expands group rosters into the rotation pool', () => {
    const rules = [
      rule('auto_assign', { enabled: true, assignees: ['u1'], group_ids: ['g1'], next: 0 }),
    ];
    expect(pickAutoAssignee(rules, groups)).toEqual({ userId: 'u1', ruleId: 'r1', next: 1 });
    const advanced = [
      rule('auto_assign', { enabled: true, assignees: ['u1'], group_ids: ['g1'], next: 1 }),
    ];
    expect(pickAutoAssignee(advanced, groups)).toEqual({ userId: 'u3', ruleId: 'r1', next: 2 });
  });

  it('ignores unknown group ids and dedupes overlapping rosters', () => {
    const rules = [
      rule('auto_assign', {
        enabled: true,
        assignees: ['u1', 'u3'],
        group_ids: ['g1', 'g-missing'],
        next: 0,
      }),
    ];
    // pool: u1, u3(explicit), u3,u4(group) → deduped u1,u3,u4
    expect(pickAutoAssignee(rules, groups)?.userId).toBe('u1');
    const at2 = [
      rule('auto_assign', { enabled: true, assignees: ['u1', 'u3'], group_ids: ['g1'], next: 2 }),
    ];
    expect(pickAutoAssignee(at2, groups)?.userId).toBe('u4');
  });

  it('rotates the pool on non-auto_assign rules via evaluateActions', () => {
    const rules = [
      rule('keyword', { enabled: true, keywords: ['refund'], assignees: ['u1'], group_ids: ['g1'] }),
    ];
    const actions = evaluateActions(evt({ type: 'message_in', text: 'refund please' }), rules, groups);
    expect(actions).toEqual([
      { assignTo: 'u1', tag: undefined, ruleId: 'r1', kind: 'keyword', next: 1 },
    ]);
  });
});

describe('intentMatches', () => {
  it('matches rules whose intents list names the label', () => {
    const rules = [
      rule('intent', { enabled: true, intents: ['billing', 'shipping'] }),
      rule('intent', { enabled: true, intents: ['sales'] }),
      rule('intent', { enabled: false, intents: ['billing'] }),
      rule('keyword', { enabled: true, intents: ['billing'] }),
    ];
    expect(intentMatches(rules, 'Billing').map((r) => r.kind)).toEqual(['intent', 'keyword']);
    expect(intentMatches(rules, 'billing', 'intent')).toHaveLength(1);
    expect(intentMatches(rules, 'missing')).toHaveLength(0);
  });
});

describe('selfAssignOnly', () => {
  it('allows adding self to an unrouted rule', () => {
    expect(selfAssignOnly({ enabled: true, keywords: ['x'] }, { enabled: true, keywords: ['x'], assign_to: 'me' }, 'me')).toBe(true);
  });
  it('allows joining/leaving a rotation pool', () => {
    const prev = { enabled: true, assignees: ['u1', 'u2'], next: 1 };
    expect(selfAssignOnly(prev, { ...prev, assignees: ['u1', 'u2', 'me'] }, 'me')).toBe(true);
    expect(selfAssignOnly({ ...prev, assignees: ['u1', 'me', 'u2'] }, prev, 'me')).toBe(true);
  });
  it('self-assigning a fixed-owner rule rotates with them', () => {
    // assign_to: u1 → assignees: [u1, me] — self-only diff
    expect(selfAssignOnly({ enabled: true, assign_to: 'u1' }, { enabled: true, assignees: ['u1', 'me'] }, 'me')).toBe(true);
  });
  it('rejects touching another member', () => {
    expect(selfAssignOnly({ enabled: true, assign_to: 'u1' }, { enabled: true, assign_to: 'me' }, 'me')).toBe(false);
    expect(selfAssignOnly({ enabled: true, assignees: ['u1', 'me'] }, { enabled: true, assignees: ['me'] }, 'me')).toBe(false);
  });
  it('rejects any non-assign field change', () => {
    expect(selfAssignOnly({ enabled: true, keywords: ['x'] }, { enabled: false, keywords: ['x'], assign_to: 'me' }, 'me')).toBe(false);
    expect(selfAssignOnly({ enabled: true, next: 1 }, { enabled: true, next: 2, assign_to: 'me' }, 'me')).toBe(false);
    expect(selfAssignOnly({ enabled: true }, { enabled: true, group_ids: ['g1'], assign_to: 'me' }, 'me')).toBe(false);
  });
});
