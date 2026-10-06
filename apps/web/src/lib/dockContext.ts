import { createContext, useContext } from 'react';

export type DockTab = 'copilot' | 'test';

/**
 * The unified right-edge dock: Layout owns the strip, the panel chrome and
 * the tab switch; pages provide the Test tab's content via a portal into
 * `testSlot` (or fall back to a plain test chat) and drive it through this
 * context — open/close, tab choice, a seeded test prompt, a Copilot draft.
 */
export interface DockCtx {
  open: boolean;
  tab: DockTab;
  /** Whether the current page has an agent the Test tab can exercise. */
  testAvailable: boolean;
  /** True while a page (the builder) portals wired test content into the
   *  slot — Layout hides its fallback AskJanis then. */
  testProvided: boolean;
  /** Portal target for the page's test-panel content. Null while the dock
   *  is closed — the content only exists when the panel is open. */
  testSlot: HTMLElement | null;
  setOpen(open: boolean): void;
  openTab(tab: DockTab): void;
  /** The builder reports that it renders the test tab's content. */
  setTestProvided(v: boolean): void;
  /** A prompt waiting to be sent into the test chat (?rail=test&q= or a
   *  concierge "run this" link) — the consumer clears it. */
  testSeed: { text: string; nonce: number } | null;
  clearTestSeed(): void;
}

export const DockContext = createContext<DockCtx | null>(null);

export function useDock(): DockCtx | null {
  return useContext(DockContext);
}
