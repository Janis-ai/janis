import { useState, type PointerEvent } from 'react';

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
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : def;
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
    const n = Number(localStorage.getItem(key));
    const cap = typeof max === 'function' ? Number.MAX_SAFE_INTEGER : max;
    return Number.isFinite(n) && n >= min ? Math.min(cap, n) : def;
  });
  const set = (n: number) => {
    setW(n);
    localStorage.setItem(key, String(n));
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
