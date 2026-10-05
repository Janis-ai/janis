import { describe, expect, it } from 'vitest';
import { agentPathParam, agentSlug, janisBrain } from './agentContext';

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

  it('never treats the /agents/new builder as an agent — the rail URL-sync '
    + 'stamps ?agent=<test-rail id> on navigations, which used to resolve '
    + 'the builder to an existing agent', () => {
    expect(agentPathParam('/agents/new')).toBeUndefined();
    expect(agentPathParam(`/agents/new/${uuid}`)).toBeUndefined();
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
