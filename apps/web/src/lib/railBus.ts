export interface RailRequest {
  channelId: string;
  label: string;
  agentId?: string; // for ?rail=test&agent=… deeplinks
  // Seed the Ask Janis rail with a question — sent automatically on open.
  // Discovery cards and ?rail=ask&q= deeplinks use this.
  seed?: string;
  // Prefill the Copilot composer without sending — the owner reviews the
  // draft (e.g. a behavioral correction from "Correct this") before it
  // goes to the concierge.
  draft?: string;
  // Seed into the TEST tab instead — the concierge's "run this" links
  // (?rail=test&agent=<id>&q=…) and scenario runs use it.
  q?: string;
}

/**
 * The right dock is one slot — Copilot and the agent test chat share it.
 * Pages (e.g. AgentDetail's "Test agent" button) publish a request here and
 * Layout swaps the dock content, closing whatever was open.
 */
const listeners = new Set<(r: RailRequest) => void>();

export const railBus = {
  publish(r: RailRequest) {
    listeners.forEach((fn) => fn(r));
  },
  subscribe(fn: (r: RailRequest) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** "Send to Copilot" — opens the dock on the Copilot tab with a draft the
   *  owner reviews before it goes to the concierge. */
  copilotDraft(text: string) {
    this.publish({ channelId: '', label: 'Copilot', draft: text });
  },
};
