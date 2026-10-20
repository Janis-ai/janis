/** Campaign-attribution capture — the first page load that carries utm_*
 *  params stashes them; the next successful auth fires a single
 *  'signup_attribution' track event server-side and clears the stash.
 *  localStorage survives the OAuth round-trip and the verify-email hop. */
import { api } from '../api/client';

const KEY = 'janis:utm';
const FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
type Utm = Partial<Record<(typeof FIELDS)[number], string>>;

export function captureUtm() {
  try {
    const q = new URLSearchParams(window.location.search);
    const utm: Utm = {};
    for (const f of FIELDS) {
      const v = q.get(f);
      if (v) utm[f] = v.slice(0, 200);
    }
    // only overwrite when the URL actually carries params — a plain
    // revisit must not wipe a stash captured on the campaign landing
    if (Object.keys(utm).length) localStorage.setItem(KEY, JSON.stringify(utm));
  } catch {
    // storage unavailable — attribution is best-effort
  }
}

export function fireUtmAttribution() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    localStorage.removeItem(KEY);
    const meta = JSON.parse(raw) as Utm;
    void api('/api/track', {
      method: 'POST',
      body: JSON.stringify({ event: 'signup_attribution', meta }),
    }).catch(() => {});
  } catch {
    // never block the UI on attribution
  }
}
