import { useEffect, useState, type PointerEvent } from 'react';

/** localStorage-backed boolean (same pattern as useSticky, but lives in
 *  lib so non-page components like Layout don't import a page file). */
export function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => localStorage.getItem(key) === '1');
  return [
    v,
    (n: boolean) => {
      setV(n);
      localStorage.setItem(key, n ? '1' : '0');
    },
  ];
}

/** Read a stored panel width the way usePanelWidth clamps it — for
 *  sibling code that needs the live value without owning the state. */
export function storedPanelWidth(key: string, def: number, lo: number, hi: number): number {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? 'null') as { w?: number; vw?: number } | null;
    if (s && s.vw === window.innerWidth && Number.isFinite(s.w))
      return Math.min(hi, Math.max(lo, s.w!));
  } catch { /* plain-number legacy or junk */ }
  return def;
}

/** Draggable panel edge — the stored width plus props to spread on a
 *  .grip element. Pointermove updates live; double-click resets to the
 *  default. body.panel-resize freezes transitions + text selection for
 *  the drag's duration. `max` may be a function — evaluated per move so a
 *  grip can clamp against live layout (sibling widths, conv floor). */
export function usePanelWidth(
  key: string,
  def: number,
  min: number,
  max: number | (() => number),
  /** -1 for grips on the LEFT edge of a right-side panel — moving the
   *  pointer left grows it (the delta sign inverts). */
  sign = 1,
) {
  const [w, setW] = useState(() => {
    // A user-set width is only honored at the window size it was dragged
    // at — a resize re-optimizes the panes, so stored values carry the
    // viewport they were set against and miss when it changes.
    try {
      const s = JSON.parse(localStorage.getItem(key) ?? 'null') as { w?: number; vw?: number } | null;
      const cap = typeof max === 'function' ? Number.MAX_SAFE_INTEGER : max;
      if (s && s.vw === window.innerWidth && Number.isFinite(s.w) && (s.w ?? 0) >= min)
        return Math.min(cap, s.w!);
    } catch { /* plain-number legacy or junk */ }
    return def;
  });
  useEffect(() => {
    const onR = () => setW(def);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [def]);
  const set = (n: number) => {
    setW(n);
    localStorage.setItem(key, JSON.stringify({ w: n, vw: window.innerWidth }));
    window.dispatchEvent(new Event('panel-resize'));
  };
  const gripProps = {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = w;
      document.body.classList.add('panel-resize');
      const mv = (ev: PointerEvent | globalThis.PointerEvent) => {
        const cap = typeof max === 'function' ? max() : max;
        set(Math.min(cap, Math.max(min, startW + sign * (ev.clientX - startX))));
      };
      const up = () => {
        document.body.classList.remove('panel-resize');
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    },
    onDoubleClick: () => set(def),
  };
  return { width: w, setWidth: set, gripProps };
}
