import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GREETING, resolveGreeting } from './greeting.js';
import type { agents, channels } from '../db/schema.js';

type AgentRow = typeof agents.$inferSelect;
const ch = (credentials: Record<string, unknown> = {}, id = 'ch1') =>
  ({ id, name: 'Web widget', credentials }) as Pick<
    typeof channels.$inferSelect,
    'id' | 'name' | 'credentials'
  >;
const agent = (config: Record<string, unknown> = {}, hosted = false) =>
  ({ name: 'Bot', hosted, config }) as AgentRow;

describe('resolveGreeting', () => {
  it('returns null when greetings are disabled', async () => {
    expect(await resolveGreeting(ch(), agent({ greeting_enabled: false }))).toBeNull();
    // disabled wins even over configured text
    expect(
      await resolveGreeting(ch({ greeting: 'chan' }), agent({ greeting_enabled: false, greeting: 'x' })),
    ).toBeNull();
  });

  it('channel greeting overrides agent greeting', async () => {
    expect(
      await resolveGreeting(ch({ greeting: 'Channel hi' }), agent({ greeting: 'Agent hi' })),
    ).toBe('Channel hi');
    expect(await resolveGreeting(ch(), agent({ greeting: 'Agent hi' }))).toBe('Agent hi');
  });

  it('blank greeting on a BYOK agent falls back to the default', async () => {
    expect(await resolveGreeting(ch(), agent({}))).toBe(DEFAULT_GREETING);
    expect(await resolveGreeting(ch(), null)).toBe(DEFAULT_GREETING);
  });

  it('blank greeting on a hosted agent generates and caches per channel', async () => {
    const gen = vi.fn().mockResolvedValue('Hey there, welcome to Acme!');
    const a = agent({}, true);
    expect(await resolveGreeting(ch(), a, gen)).toBe('Hey there, welcome to Acme!');
    expect(await resolveGreeting(ch(), a, gen)).toBe('Hey there, welcome to Acme!');
    expect(gen).toHaveBeenCalledTimes(1); // second call served from cache
    // a different channel gets its own generation
    expect(await resolveGreeting(ch({}, 'ch2'), a, gen)).toBe('Hey there, welcome to Acme!');
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default when generation fails', async () => {
    const gen = vi.fn().mockResolvedValue(null);
    expect(await resolveGreeting(ch({}, 'ch3'), agent({}, true), gen)).toBe(DEFAULT_GREETING);
    const boom = vi.fn().mockRejectedValue(new Error('llm down'));
    expect(await resolveGreeting(ch({}, 'ch4'), agent({}, true), boom)).toBe(DEFAULT_GREETING);
  });

  it('configured text never triggers generation', async () => {
    const gen = vi.fn();
    await resolveGreeting(ch({ greeting: 'static' }), agent({}, true), gen);
    await resolveGreeting(ch(), agent({ greeting: 'static' }, true), gen);
    expect(gen).not.toHaveBeenCalled();
  });
});
