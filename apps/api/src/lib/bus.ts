import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { busEvents } from '../db/schema.js';
import type { StreamEvent } from '@janis/shared';

/** Unique id for this process — rows it publishes are skipped by its own
 * tailer so subscribers never see an event twice. */
export const INSTANCE_ID = randomUUID();

/** How far back the tailer starts on boot (publishes in flight during
 * startup are nice-to-have; SSE clients reconnect and refetch anyway). */
const POLL_MS = 500;

class Bus {
  private emitter = new EventEmitter();
  private db: Db | null = null;
  private cursor = 0;
  private tailing = false;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /** Attach Postgres so publishes relay to every other instance via the
   * bus_events table. Call once at boot; without it the bus is local-only
   * (tests that never init a Db still work). */
  attachDb(db: Db) {
    this.db = db;
    void this.tail();
  }

  publish(workspaceId: string, event: StreamEvent) {
    this.emitter.emit(workspaceId, event);
    const db = this.db;
    if (db) {
      void db
        .insert(busEvents)
        .values({ workspaceId, origin: INSTANCE_ID, event })
        .catch(() => {}); // relay is best-effort; local delivery already happened
    }
  }

  subscribe(workspaceId: string, listener: (event: StreamEvent) => void): () => void {
    this.emitter.on(workspaceId, listener);
    return () => this.emitter.off(workspaceId, listener);
  }

  /** Poll bus_events and re-emit rows published by other instances. One
   * loop per process regardless of subscriber count. */
  private async tail() {
    if (this.tailing || !this.db) return;
    this.tailing = true;
    const db = this.db;
    const [max] = await db
      .select({ id: sql<number>`coalesce(max(${busEvents.id}), 0)` })
      .from(busEvents)
      .catch(() => [{ id: 0 }]);
    this.cursor = max?.id ?? 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const rows = await db
          .select()
          .from(busEvents)
          .where(gt(busEvents.id, this.cursor))
          .orderBy(busEvents.id)
          .limit(500);
        for (const row of rows) {
          this.cursor = Math.max(this.cursor, row.id);
          if (row.origin === INSTANCE_ID) continue;
          this.emitter.emit(row.workspaceId, row.event as StreamEvent);
        }
      } catch {
        // transient db error — keep polling
      }
    }
  }
}

export const bus = new Bus();
