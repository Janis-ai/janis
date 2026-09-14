import { EventEmitter } from 'node:events';
import type { StreamEvent } from '@janis/shared';

// In-process pub/sub for SSE. Single-node by design — swap for Redis pub/sub
// if the API ever scales horizontally.
class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(workspaceId: string, event: StreamEvent) {
    this.emitter.emit(workspaceId, event);
  }

  subscribe(workspaceId: string, listener: (event: StreamEvent) => void): () => void {
    this.emitter.on(workspaceId, listener);
    return () => this.emitter.off(workspaceId, listener);
  }
}

export const bus = new Bus();
