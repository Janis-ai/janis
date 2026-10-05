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

const key = (agentId: string) => `janis.seen-steps.${agentId}`;

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

/** Steps that can never be "finished" — knowledge and abilities grow
 *  forever, so they mark engagement (⊙) rather than completion (✓). */
export const OPEN_ENDED_STEPS = new Set(['teach', 'abilities']);
/** "Done" only counts once the user has actually seen the generated
 *  work — the draft writes instructions at create time, but Guide it's
 *  ✓ should mean the human reviewed them, not that a draft exists. */
export const SEEN_GATED_STEPS = new Set(['guide']);
/** Abilities is never "not needed" — it's a core capability surface, so
 *  'na' still renders as available (○/⊙), never the + opt-in mark. */
const NEVER_NA_STEPS = new Set(['abilities']);

export type StepGlyph = 'check' | 'dot-ok' | 'dot-accent' | 'dot' | 'circle' | 'plus';

/** Resolves the mark for a build step:
 *  done      → ✓, ⊙ for open-ended steps, ○ for done-but-unseen gated
 *              steps (guide)
 *  pending   → ⊙ accent if it's the recommended next, ⊙ if seen, else ○
 *  na        → + (addable), ⊙ if engaged — but never + for abilities */
export function stepGlyph(
  key: string,
  state: 'done' | 'pending' | 'na' | undefined,
  opts: { seen: boolean; isNext: boolean },
): StepGlyph {
  if (state === 'done') {
    if (OPEN_ENDED_STEPS.has(key)) return 'dot-ok';
    if (SEEN_GATED_STEPS.has(key) && !opts.seen) return 'circle';
    return 'check';
  }
  if (state === 'na')
    return opts.seen ? 'dot' : NEVER_NA_STEPS.has(key) ? 'circle' : 'plus';
  if (opts.isNext) return 'dot-accent';
  return opts.seen ? 'dot' : 'circle';
}
