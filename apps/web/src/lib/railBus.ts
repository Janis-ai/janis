export interface RailRequest {
  channelId: string;
  label: string;
  agentId?: string; // for ?rail=test&agent=… deeplinks
}

/**
 * The right rail is one slot — Ask Janis and the agent test chat share it.
 * Pages (e.g. AgentDetail's "Test agent" button) publish a request here and
 * Layout swaps the rail content, closing whatever was open.
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
};
