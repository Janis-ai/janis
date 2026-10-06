import { useSyncExternalStore } from 'react';

/** Per-agent "has the user opened this build step" — UI-only state kept in
 *  localStorage. Powers the ⊙ mark: Teach it and Abilities are open-ended
 *  capabilities (you can always add more knowledge/tools), so a ✓ "done"
 *  is the wrong claim — the honest states are ○ unseen, ⊙ engaged, + not
 *  needed, ✓ only for steps that can genuinely complete (create/guide/
 *  try/deploy). */

const EMPTY: Set<string> = new Set();
const listeners = new Set<() => void>();
let version = 0;
const cache = new Map<string, { v: number; set: Set<string> }>();

const key = (agentId: string) => `janis.seen-steps.v2.${agentId}`;

function read(agentId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(agentId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function snapshot(agentId: string): Set<string> {
  const c = cache.get(agentId);
  if (c && c.v === version) return c.set;
  const set = read(agentId);
  cache.set(agentId, { v: version, set });
  return set;
}

export function markStepSeen(agentId: string, step: string) {
  const cur = read(agentId);
  if (cur.has(step)) return;
  cur.add(step);
  try {
    localStorage.setItem(key(agentId), JSON.stringify([...cur]));
  } catch {
    /* private-mode quota — seen just won't persist */
  }
  version += 1;
  for (const l of listeners) l();
}

export function useSeenSteps(agentId?: string): Set<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => (agentId ? snapshot(agentId) : EMPTY),
    () => EMPTY,
  );
}

export type StepGlyph = 'check' | 'check-muted' | 'half' | 'circle';

/** Marks carry meaning, not visited-ness — one rule across every step:
 *  done    → ✓  a human confirmed or acted
 *  na      → ✓  muted — explicitly not needed (skip/not needed)
 *  partial → ◐  something exists but is unconfirmed or needs a look
 *              (Janis draft not reviewed, suggestions not connected,
 *              tested but open gaps)
 *  pending → ○  nothing exists yet
 *  "Seen" no longer feeds the mark — it still drives the Next button. */
export function stepGlyph(
  _key: string,
  state: 'done' | 'partial' | 'pending' | 'na' | undefined,
): StepGlyph {
  if (state === 'done') return 'check';
  if (state === 'na') return 'check-muted';
  if (state === 'partial') return 'half';
  return 'circle';
}
