import { describe, expect, it } from 'vitest';
import { agentPathParam, agentSlug, contextAgentStale, janisBrain } from './agentContext';

describe('agentSlug', () => {
  it('matches the slug shape concierge links emit', () => {
    expect(agentSlug('Acme Returns')).toBe('acme-returns');
    expect(agentSlug('Acme  Returns!')).toBe('acme-returns');
    expect(agentSlug("Mike's Bot")).toBe('mike-s-bot');
    expect(agentSlug('  padded  ')).toBe('padded');
  });
});

describe('agentPathParam', () => {
  const uuid = '7b90d58b-2253-495e-bc61-a575bf958c5b';

  it('reads the agent segment of /agents/:id paths', () => {
    expect(agentPathParam(`/agents/${uuid}`)).toBe(uuid);
    expect(agentPathParam(`/agents/${uuid}/knowledge`)).toBe(uuid);
    expect(agentPathParam('/agents/acme-returns/knowledge')).toBe('acme-returns');
    expect(agentPathParam('/agents')).toBeUndefined();
    expect(agentPathParam('/conversations')).toBeUndefined();
  });

  it('never treats bare /agents/new as an agent — the rail URL-sync '
    + 'stamps ?agent=<test-rail id> on navigations, which used to resolve '
    + 'the builder to an existing agent', () => {
    expect(agentPathParam('/agents/new')).toBeUndefined();
  });

  it('treats /agents/new/:id edit mode as that agent — the build nav '
    + 'should track the agent being built', () => {
    expect(agentPathParam(`/agents/new/${uuid}`)).toBe(uuid);
  });
});

describe('contextAgentStale', () => {
  const uuid = '7b90d58b-2253-495e-bc61-a575bf958c5b';
  const other = 'a4b7f9cf-90b8-4e47-8d9f-d5ea4b6f1f9f';

  it('flags a persisted agent absent from the workspace list', () => {
    // prod bug: switching to a grant-scoped workspace kept the previous
    // workspace's last-agent → inbox queried a foreign id → "No
    // conversations" until an agent page overwrote it.
    expect(contextAgentStale(uuid, [{ id: other }])).toBe(true);
    expect(contextAgentStale(uuid, [])).toBe(true);
  });

  it('trusts a stored id while the list is loading or when present', () => {
    expect(contextAgentStale(uuid, undefined)).toBe(false);
    expect(contextAgentStale(uuid, [{ id: uuid }, { id: other }])).toBe(false);
    expect(contextAgentStale(null, [{ id: uuid }])).toBe(false);
  });
});

describe('janisBrain', () => {
  const agent = (hosted: boolean, engine?: 'hosted' | 'dialogflow' | 'monitor') => ({
    hosted,
    config: engine ? { engine } : {},
  });

  it('is true only for hosted agents on the default engine', () => {
    expect(janisBrain(agent(true))).toBe(true); // no engine key = hosted LLM
    expect(janisBrain(agent(true, 'hosted'))).toBe(true);
  });

  it('is false for migrated BYOK engines — Janis carries the inbox, not the brain', () => {
    expect(janisBrain(agent(true, 'dialogflow'))).toBe(false);
    expect(janisBrain(agent(true, 'monitor'))).toBe(false);
  });

  it('is false for external-webhook agents and empty input', () => {
    expect(janisBrain(agent(false))).toBe(false);
    expect(janisBrain(agent(false, 'monitor'))).toBe(false);
    expect(janisBrain(null)).toBe(false);
    expect(janisBrain(undefined)).toBe(false);
  });
});
