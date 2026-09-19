import type { AgentConfig } from '@janis/shared';
import type { agents, channels } from '../db/schema.js';
import type { ChannelCredentials } from './channels.js';
import { generateGreeting } from './hostedAgent.js';

export const DEFAULT_GREETING = 'Hi! How can we help?';

// Generated greetings are cached per channel so the greeting the webchat
// widget renders at bootstrap matches the one stored on conversation
// creation. An hour keeps them fresh without an LLM call per page load.
const GENERATED_TTL_MS = 60 * 60_000;
const generatedCache = new Map<string, { text: string; at: number }>();

type ChannelRow = Pick<typeof channels.$inferSelect, 'id' | 'name' | 'credentials'>;
type AgentRow = typeof agents.$inferSelect;

/**
 * Resolve the greeting for a channel+agent pair, or null when greetings are
 * disabled. Order: channel override → agent text → generated (hosted) →
 * default. `gen` is injectable for tests.
 */
export async function resolveGreeting(
  channel: ChannelRow,
  agent: AgentRow | null | undefined,
  gen: (a: AgentRow, channelName?: string) => Promise<string | null> = generateGreeting,
): Promise<string | null> {
  const cfg = (agent?.config ?? {}) as AgentConfig;
  if (cfg.greeting_enabled === false) return null;
  const creds = (channel.credentials ?? {}) as ChannelCredentials;
  if (creds.greeting) return creds.greeting;
  if (cfg.greeting) return cfg.greeting;
  if (agent?.hosted) {
    const hit = generatedCache.get(channel.id);
    if (hit && Date.now() - hit.at < GENERATED_TTL_MS) return hit.text;
    const text = await gen(agent, channel.name).catch(() => null);
    if (text) {
      generatedCache.set(channel.id, { text, at: Date.now() });
      return text;
    }
  }
  return DEFAULT_GREETING;
}
