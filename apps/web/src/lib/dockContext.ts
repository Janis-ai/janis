import { createContext, useContext } from 'react';

export type DockTab = 'copilot' | 'test';

/** A scenario verdict — matches AskJanis's verdictFor contract. */
export interface TestVerdict {
  expectation?: string | null;
  result: 'pass' | 'fail' | 'unreviewed' | 'fixed_recheck' | null;
  verdict(r: 'pass' | 'fail'): void;
}

/** Handler functions a page hands the shared test chat. They live behind a
 *  ref the page rewrites every render, so call-through never goes stale and
 *  updating them doesn't cost Layout a state change. */
export interface TestHandlers {
  verdictFor?(
    customerText: string | undefined,
    replyText?: string,
    turns?: { role: 'customer' | 'agent'; text: string }[],
  ): TestVerdict | null;
  onCorrect?(ctx: {
    agentText: string;
    customerText?: string;
    turns?: { role: 'customer' | 'agent'; text: string }[];
  }): void;
  onSaveTest?(ctx: {
    agentText: string;
    customerText?: string;
    turns?: { role: 'customer' | 'agent'; text: string }[];
  }): void;
  onCustomerMessage?(text: string): void;
  /** The header's history/new-chat controls switched test conversations —
   *  the builder uses it to reset its config-drift notice. `fresh` is true
   *  for a brand-new visitor, false when resuming a saved thread. */
  onVisitorChange?(visitor: string, fresh: boolean): void;
}

/** Everything a page contributes to the shared test chat. `handlers` is a
 *  ref (fresh closures without re-rendering Layout); the rest are values
 *  that affect what renders. */
export interface TestWiring {
  channelId?: string;
  focusSignal?: number;
  seed?: { text: string; nonce: number } | null;
  /** Extra text after "Testing <agent>" in the dock header — the builder's
   *  "includes drafts · running: X" detail, when either applies. */
  statusText?: string | null;
  handlers: { current: TestHandlers };
}

/**
 * The unified right-edge dock: Layout owns the strip, the panel chrome, the
 * tab switch — and ONE mounted test-chat instance, so it survives navigation.
 * Pages (the builder) portal header chrome into `testSlot` and hand the chat
 * its wiring via `setTestWiring`; without a provider the chat runs on
 * Layout's fallback handlers.
 */
export interface DockCtx {
  open: boolean;
  tab: DockTab;
  /** Whether the current page has an agent the Test tab can exercise. */
  testAvailable: boolean;
  /** True while a page (the builder) portals test chrome into the slot and
   *  drives the chat's wiring — Layout hides its default test header then. */
  testProvided: boolean;
  /** Portal target for the page's test-panel chrome (status row, notices).
   *  Null while the dock is closed — the content only exists when the
   *  panel is open. */
  testSlot: HTMLElement | null;
  setOpen(open: boolean): void;
  openTab(tab: DockTab): void;
  /** The builder reports that it supplies the test tab's chrome + wiring. */
  setTestProvided(v: boolean): void;
  /** The page's wiring for the shared test chat — null clears it (the
   *  fallback handlers take over without the chat remounting). */
  testWiring: TestWiring | null;
  setTestWiring(w: TestWiring | null): void;
  /** Visitor id the shared test chat is keyed to — Layout owns and persists
   *  it so builder and fallback surfaces ride the same thread. */
  testVisitor: string | null;
  setTestVisitor(v: string): void;
  /** A prompt waiting to be sent into the test chat (?rail=test&q= or a
   *  concierge "run this" link) — the consumer clears it. */
  testSeed: { text: string; nonce: number } | null;
  clearTestSeed(): void;
}

export const DockContext = createContext<DockCtx | null>(null);

export function useDock(): DockCtx | null {
  return useContext(DockContext);
}
