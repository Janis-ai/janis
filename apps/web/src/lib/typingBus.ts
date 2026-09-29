export interface TypingPing {
  conversation_id: string;
  name?: string;
  kind?: 'visitor' | 'agent' | 'operator';
  // set when the typer is a signed-in Janis user (rail/test chat) — the
  // console suppresses visitor-typing dots when it's the viewer themselves
  user_id?: string | null;
}

/**
 * Ephemeral visitor-typing signals from the SSE stream — kept out of React
 * Query since they expire in seconds and must not trigger transcript refetches.
 * useStream publishes; chat surfaces subscribe by conversation id.
 */
const listeners = new Set<(p: TypingPing) => void>();

export const typingBus = {
  publish(p: TypingPing) {
    listeners.forEach((fn) => fn(p));
  },
  subscribe(fn: (p: TypingPing) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export interface PresencePing {
  conversation_id: string;
  viewers: { id: string; name: string | null }[];
}

/**
 * Co-presence signals — which teammates have a conversation open right now.
 * Server publishes on viewer-set change; a stale entry clears client-side
 * when its TTL lapses (see ConversationPage's expiry timer).
 */
const presenceListeners = new Set<(p: PresencePing) => void>();

export const presenceBus = {
  publish(p: PresencePing) {
    presenceListeners.forEach((fn) => fn(p));
  },
  subscribe(fn: (p: PresencePing) => void) {
    presenceListeners.add(fn);
    return () => {
      presenceListeners.delete(fn);
    };
  },
};
