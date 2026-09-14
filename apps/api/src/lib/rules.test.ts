import { describe, expect, it } from 'vitest';
import type { IngestEvent } from '@janis/shared';
import { evaluateEvent, inactivityThresholds } from './rules.js';
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
