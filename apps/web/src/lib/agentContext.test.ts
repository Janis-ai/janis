import { describe, expect, it } from 'vitest';
import { agentSlug } from './agentContext';

describe('agentSlug', () => {
  it('matches the slug shape concierge links emit', () => {
    expect(agentSlug('Acme Returns')).toBe('acme-returns');
    expect(agentSlug('Acme  Returns!')).toBe('acme-returns');
    expect(agentSlug("Mike's Bot")).toBe('mike-s-bot');
    expect(agentSlug('  padded  ')).toBe('padded');
  });
});
