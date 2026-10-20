import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPathParam,
  agentSlug,
  agentUnscoped,
  clearLastAgent,
  contextAgentStale,
  forgetLastAgent,
  janisBrain,
  lastAgentId,
  setLastAgent,
} from './agentContext';

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

describe('per-workspace agent memory', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  beforeEach(() => store.clear());

  const wsA = 'ws-aaa';
  const wsB = 'ws-bbb';
  const agent1 = '7b90d58b-2253-495e-bc61-a575bf958c5b';
  const agent2 = 'a4b7f9cf-90b8-4e47-8d9f-d5ea4b6f1f9f';

  it('remembers the agent per workspace — switching restores each side', () => {
    setLastAgent(agent1, wsA);
    setLastAgent(agent2, wsB);
    expect(lastAgentId(wsA)).toBe(agent1);
    expect(lastAgentId(wsB)).toBe(agent2);
  });

  it('explicit unscope blocks auto-select; evicting a stale id does not', () => {
    clearLastAgent(wsA);
    expect(agentUnscoped(wsA)).toBe(true);
    expect(lastAgentId(wsA)).toBeNull();
    forgetLastAgent(wsA);
    expect(agentUnscoped(wsA)).toBe(false);
  });

  it('a fresh set overwrites the unscoped marker', () => {
    clearLastAgent(wsA);
    setLastAgent(agent1, wsA);
    expect(agentUnscoped(wsA)).toBe(false);
    expect(lastAgentId(wsA)).toBe(agent1);
  });

  it('migrates the legacy single key into the current workspace only', () => {
    store.set('janis:last-agent', agent1);
    expect(lastAgentId(wsA)).toBe(agent1);
    expect(store.get('janis:last-agent')).toBeUndefined();
    expect(lastAgentId(wsB)).toBeNull(); // not leaked to the other workspace
  });

  it('rejects non-uuid values regardless of source', () => {
    setLastAgent('acme-returns', wsA);
    expect(lastAgentId(wsA)).toBeNull();
  });
});
