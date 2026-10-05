import { describe, expect, it } from 'vitest';
import { agentSlug, janisBrain } from './agentContext';

describe('agentSlug', () => {
  it('matches the slug shape concierge links emit', () => {
    expect(agentSlug('Acme Returns')).toBe('acme-returns');
    expect(agentSlug('Acme  Returns!')).toBe('acme-returns');
    expect(agentSlug("Mike's Bot")).toBe('mike-s-bot');
    expect(agentSlug('  padded  ')).toBe('padded');
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
