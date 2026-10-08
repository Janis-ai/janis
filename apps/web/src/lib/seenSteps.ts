import { useSyncExternalStore } from 'react';
import type { BuildStatus } from '../api/hooks';

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

/** The live state line under a step mark — the same text the builder
 *  rail shows as its subtitle and the nav carries in its tooltips, so
 *  both surfaces answer "what state is this step in" identically. */
export function stepSubtitle(key: string, status: BuildStatus): string {
  const st = status.steps[key as keyof BuildStatus['steps']];
  switch (key) {
    case 'create':
      return 'brief saved';
    case 'teach':
      // Notes are one list row — "3 sources" for three note lines misreads
      // as three documents; call them what they are.
      return status.knowledge.sources
        ? status.knowledge.sources === status.knowledge.notes
          ? `${status.knowledge.notes} note${status.knowledge.notes > 1 ? 's' : ''}`
          : `${status.knowledge.sources} source${status.knowledge.sources > 1 ? 's' : ''}`
        : st === 'na'
          ? status.teach_skipped
            ? 'skipped'
            : 'not needed'
          : 'no sources yet';
    case 'guide':
      return st === 'done' ? 'reviewed' : st === 'partial' ? 'drafted — take a look' : 'nothing yet';
    case 'abilities':
      return status.abilities
        ? `${status.abilities} tool${status.abilities > 1 ? 's' : ''}`
        : st === 'done'
          ? // 'done' with zero tools = marked none needed, say so.
            'marked as not needed'
          : st === 'partial'
            ? 'suggested — none connected'
            : st === 'na'
              ? 'none needed'
              : 'nothing connected';
    case 'try': {
      const t = status.test_scenarios;
      if (t?.total) {
        const bits = [
          t.failing
            ? `${t.failing} of ${t.total} failing`
            : `${t.passing} of ${t.total} passing`,
          ...(t.unrun ? [`${t.unrun} not run yet`] : []),
          ...(t.fixed ? [`${t.fixed} fixed — re-run to confirm`] : []),
          ...(t.stale ? [`${t.stale} stale`] : []),
        ];
        // Safety can't hide inside a healthy-sounding total — an elevated
        // agent must earn its mark on the hard cases, not office hours.
        // Safety stays a fraction (space), the total spells out "of N" —
        // a bare "4/5" alone reads ambiguous on the step card.
        return t.safety_total
          ? `safety ${t.safety_checked}/${t.safety_total} · ${bits.join(' · ')}`
          : bits.join(' · ');
      }
      return status.test_conversations
        ? status.open_gaps
          ? `${status.open_gaps} open gap${status.open_gaps > 1 ? 's' : ''}`
          : 'tested'
        : 'not tested yet';
    }
    case 'deploy':
      return status.channels
        ? status.live_conversations
          ? `${status.channels} channel${status.channels > 1 ? 's' : ''} live`
          : 'added · no messages yet'
        : 'no channels yet';
    default:
      return '';
  }
}
