import { describe, expect, it, vi } from 'vitest';
import { matchPromptsSemantically, normalizePrompt, promptsSimilar } from './promptMatch.js';

const g = globalThis as Record<string, unknown>;

vi.mock('./hostedAgent.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./hostedAgent.js')>();
  return {
    ...orig,
    complete: vi.fn(async () => ({ text: (g.__matchReply as string) ?? '{}' })),
  };
});

describe('normalizePrompt', () => {
  it('folds case, punctuation, accents, and whitespace', () => {
    expect(normalizePrompt('  Do you LIKE cheese?!  ')).toBe('do you like cheese');
    expect(normalizePrompt('Café   menu—what’s  on?')).toBe('cafe menu what s on');
  });

  it('returns empty for punctuation-only input', () => {
    expect(normalizePrompt('…?!')).toBe('');
  });
});

describe('promptsSimilar', () => {
  it('matches after normalization alone', () => {
    expect(promptsSimilar('Where are you located?', 'where are you located')).toBe(true);
  });

  it('matches typos within the edit-distance bound', () => {
    expect(promptsSimilar('do you like cheese', 'do you like chese')).toBe(true);
    expect(promptsSimilar('what are your opening hours', 'what are your opening hors')).toBe(true);
  });

  it('matches reorders sharing most content words', () => {
    expect(promptsSimilar('cheese pizza delivery options', 'options for cheese pizza delivery')).toBe(true);
  });

  it('rejects paraphrases that share few content words — the semantic tier’s job', () => {
    expect(promptsSimilar('do you like cheese', 'are you a fan of cheese')).toBe(false);
  });

  it('rejects clearly different prompts', () => {
    expect(promptsSimilar('do you like cheese', 'what time do you close')).toBe(false);
    expect(promptsSimilar('do you deliver to Brooklyn', 'do you deliver to Queens')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(promptsSimilar('', 'anything')).toBe(false);
    expect(promptsSimilar('   ', '   ')).toBe(false);
  });
});

describe('matchPromptsSemantically', () => {
  it('maps input indices to scenario indices from the model JSON', async () => {
    g.__matchReply = '{"1": 2, "2": null}';
    const out = await matchPromptsSemantically(
      { provider: 'openai', model: 'm' } as never,
      ['are you a fan of cheese', 'when do you shut'],
      ['where are you', 'do you like cheese', 'hours?'],
    );
    expect(out).toEqual({ 0: 1, 1: null });
  });

  it('returns {} when the model emits no JSON object', async () => {
    g.__matchReply = 'I cannot help with that';
    const out = await matchPromptsSemantically({ provider: 'openai', model: 'm' } as never, ['x'], ['y']);
    expect(out).toEqual({});
  });

  it('returns {} without calling the model on empty inputs', async () => {
    const { complete } = await import('./hostedAgent.js');
    (complete as ReturnType<typeof vi.fn>).mockClear();
    expect(await matchPromptsSemantically({} as never, [], ['y'])).toEqual({});
    expect(await matchPromptsSemantically({} as never, ['x'], [])).toEqual({});
    expect(complete).not.toHaveBeenCalled();
  });
});
