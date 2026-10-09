/** Matched-scenario ring — stamped by the deep-link/scroll code when a
 *  scenario is brought into view, then faded back to normal after ~30s
 *  (the CSS box-shadow transition animates the removal). Stamping one row
 *  clears any other ring, so only one "brought to" row is marked at a time. */
const RING_MS = 30_000;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Window event ScenarioRow/ScenarioList listen for — a deep link named
 *  this row id, so whatever fold/filter state it's in, it shows. */
export const REVEAL_SCENARIO = 'janis:reveal-scenario';

export function ringScenario(el: Element | null) {
  if (!el) return;
  document
    .querySelectorAll('.scenario-hit')
    .forEach((n) => n.classList.remove('scenario-hit'));
  el.classList.add('scenario-hit');
  clearTimeout(timers.get(el));
  timers.set(
    el,
    setTimeout(() => el.classList.remove('scenario-hit'), RING_MS),
  );
}

/** "See matched scenario" — bring a row into view from any state it can
 *  hide in: folded inside React state, nested in a closed <details>
 *  group, or filtered out of the list. The event lets the row unfold
 *  and the list drop its filter; then the ring/scroll target the LIVE
 *  element — unfolding swaps the DOM node (one-liner → card), so we
 *  wait until getElementById answers with the same node two frames
 *  running before stamping. */
export function revealScenario(id: string) {
  if (!id) return;
  window.dispatchEvent(new CustomEvent(REVEAL_SCENARIO, { detail: id }));
  const finish = (live: Element) => {
    // Open collapsed ancestors — conv-group cards — so the row has a
    // layout box to scroll to (scrollIntoView no-ops on hidden children).
    let p = live.parentElement;
    while (p) {
      if (p instanceof HTMLDetailsElement) p.open = true;
      p = p.parentElement;
    }
    ringScenario(live);
    live.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  let last: Element | null = null;
  const stamp = (tries: number) => {
    const live = document.getElementById(`sc-${id}`);
    if (live && live === last) return finish(live);
    last = live;
    if (tries > 0) requestAnimationFrame(() => stamp(tries - 1));
    else if (live) finish(live);
  };
  requestAnimationFrame(() => stamp(6));
}
