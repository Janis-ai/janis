import { describe, expect, it } from 'vitest';
import type { IngestEvent } from '@janis/shared';
import { evaluateActions, evaluateEvent, inactivityThresholds, intentMatches, pickAutoAssignee } from './rules.js';
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

  it('does not fire failure when failure rule absent but other rules exist', () => {
    const rules = [rule('keyword', { enabled: true, keywords: ['x'] })];
    expect(evaluateEvent(evt({ type: 'failure' }), rules)).toHaveLength(0);
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
      { assignTo: 'u1', tag: 'billing' },
      { assignTo: undefined, tag: 'legal' },
    ]);
    expect(evaluateActions(evt({ type: 'message_in', text: 'hello' }), rules)).toEqual([]);
    // non-inbound events never trigger actions
    expect(evaluateActions(evt({ type: 'message_out', text: 'refund' }), rules)).toEqual([]);
  });

  it('skips keyword rules with no actions attached', () => {
    const rules = [rule('keyword', { enabled: true, keywords: ['refund'] })];
    expect(evaluateActions(evt({ type: 'message_in', text: 'refund' }), rules)).toEqual([]);
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
    expect(actions).toEqual([{ assignTo: 'u1', tag: undefined, ruleId: 'r1', next: 1 }]);
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
