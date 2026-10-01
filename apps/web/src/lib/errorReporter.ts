// Self-captured error bundles — window errors, unhandled rejections and API
// failures get packaged (DOM snapshot, screenshot, console tail, settings)
// and posted to /api/error-report, where they land in the console's /errors
// page and the concierge's error_reports tool can triage them.
import { toPng } from 'html-to-image';

const consoleTail: string[] = [];
const failedRequests: { url: string; status?: number; error?: string; at: string }[] = [];
const seen = new Map<string, number>();
let installed = false;
let inFlight = false;

function pushTail(line: string) {
  consoleTail.push(line);
  if (consoleTail.length > 60) consoleTail.shift();
}

/** api/client.ts calls this on non-2xx — context, not a trigger. */
export function noteApiFailure(url: string, status?: number, error?: string) {
  failedRequests.push({ url, status, error, at: new Date().toISOString() });
  if (failedRequests.length > 20) failedRequests.shift();
}

function domSnapshot(): string | undefined {
  try {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll('script, link[rel="stylesheet"]')) el.remove();
    return clone.outerHTML.slice(0, 200_000);
  } catch {
    return undefined;
  }
}

async function screenshot(): Promise<string | undefined> {
  try {
    const url = await toPng(document.body, { pixelRatio: 0.5, skipFonts: true });
    return url.length < 600_000 ? url : undefined;
  } catch {
    return undefined;
  }
}

function settings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (const k of Object.keys(localStorage)) out[`local:${k}`] = localStorage.getItem(k);
    for (const k of Object.keys(sessionStorage)) out[`session:${k}`] = sessionStorage.getItem(k);
  } catch {
    // storage can throw in private contexts — partial is fine
  }
  return out;
}

export async function reportClientError(
  message: string,
  opts: { stack?: string; trigger?: string } = {},
): Promise<void> {
  // One report per error signature per minute, one in flight at a time —
  // a render-loop error must not DOS the ingest endpoint.
  const sig = `${message.slice(0, 120)}|${opts.stack?.split('\n')[1] ?? ''}`;
  if (Date.now() - (seen.get(sig) ?? 0) < 60_000 || inFlight) return;
  seen.set(sig, Date.now());
  if (seen.size > 100) seen.clear();
  inFlight = true;
  try {
    const shot = await screenshot();
    await fetch('/api/error-report', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: message.slice(0, 2000),
        stack: opts.stack?.slice(0, 10_000),
        url: location.href.slice(0, 2000),
        payload: {
          route: location.pathname,
          ua: navigator.userAgent.slice(0, 500),
          viewport: `${innerWidth}x${innerHeight}`,
          trigger: opts.trigger,
          dom: domSnapshot(),
          screenshot: shot,
          console_tail: [...consoleTail],
          failed_requests: [...failedRequests],
          settings: settings(),
        },
      }),
    });
  } catch {
    // Reporting must never break the app it's reporting on.
  } finally {
    inFlight = false;
  }
}

export function installErrorReporter() {
  if (installed) return;
  installed = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => {
    pushTail(`error: ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ').slice(0, 500)}`);
    origError(...a);
  };
  console.warn = (...a: unknown[]) => {
    pushTail(`warn: ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ').slice(0, 500)}`);
    origWarn(...a);
  };
  window.addEventListener('error', (e) => {
    void reportClientError(e.message || 'window.onerror', {
      stack: e.error instanceof Error ? e.error.stack : undefined,
      trigger: 'window.onerror',
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    void reportClientError(r instanceof Error ? r.message : String(r), {
      stack: r instanceof Error ? r.stack : undefined,
      trigger: 'unhandledrejection',
    });
  });
}
