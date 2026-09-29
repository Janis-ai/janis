/**
 * Who's looking at a conversation right now — in-memory, ~20s TTL refreshed
 * by client heartbeats. Collision detection: co-viewers see each other before
 * both reply to the same thread. Entries expire on read; a stale heartbeat
 * just drops out of the next broadcast.
 */
const TTL_MS = 20_000;

export interface Viewer {
  id: string;
  name: string | null;
}

const viewers = new Map<string, Map<string, { name: string | null; expires: number }>>();

function sweep(convId: string): Map<string, { name: string | null; expires: number }> {
  let map = viewers.get(convId);
  if (!map) {
    map = new Map();
    viewers.set(convId, map);
  }
  const now = Date.now();
  for (const [uid, v] of map) {
    if (v.expires < now) map.delete(uid);
  }
  if (!map.size) viewers.delete(convId);
  return map;
}

/** Record a viewing heartbeat. Returns the viewer set + whether it changed. */
export function markViewing(
  convId: string,
  userId: string,
  name: string | null,
): { viewers: Viewer[]; changed: boolean } {
  const map = sweep(convId);
  const before = new Set(map.keys());
  map.set(userId, { name, expires: Date.now() + TTL_MS });
  viewers.set(convId, map); // re-attach — sweep() drops fully-expired maps
  const after = new Set(map.keys());
  const changed =
    before.size !== after.size || [...after].some((id) => !before.has(id));
  return {
    viewers: [...map.entries()].map(([id, v]) => ({ id, name: v.name })),
    changed,
  };
}
