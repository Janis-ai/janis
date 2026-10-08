/** Matched-scenario ring — stamped by the deep-link/scroll code when a
 *  scenario is brought into view, then faded back to normal after ~30s
 *  (the CSS box-shadow transition animates the removal). Stamping one row
 *  clears any other ring, so only one "brought to" row is marked at a time. */
const RING_MS = 30_000;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

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
