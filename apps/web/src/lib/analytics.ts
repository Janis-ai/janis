/** GA4 funnel events — no-op when the tag isn't injected (dev, self-host). */
export function track(event: string, params?: Record<string, string>) {
  (window as { gtag?: (...a: unknown[]) => void }).gtag?.('event', event, params);
}

/** Fire an event at most once per browser — for milestone events
 *  (sign_up, first_agent, channel_connected…) that must not re-fire
 *  on every poll of the onboarding checklist. */
export function trackOnce(key: string, event: string, params?: Record<string, string>) {
  const k = `ga4:${key}`;
  try {
    if (localStorage.getItem(k)) return;
    localStorage.setItem(k, '1');
  } catch {
    // storage unavailable — fire anyway, a dup beats a miss
  }
  track(event, params);
}
