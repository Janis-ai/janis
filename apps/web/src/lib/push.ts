import { api } from '../api/client';

/** Fired whenever this tab changes the push subscription — Settings and the
 * banner both listen so their Enable/Disable state stays in sync regardless
 * of which surface toggled it. */
export const PUSH_CHANGE_EVENT = 'janis-push-change';
const DISABLED_KEY = 'janis.push.disabled';

function notifyPushChange() {
  window.dispatchEvent(new Event(PUSH_CHANGE_EVENT));
}

/** Explicit user disable — the banner's auto re-subscribe respects this so
 * "Disable" in Settings isn't silently undone on the next page load. */
export function isPushDisabled() {
  return localStorage.getItem(DISABLED_KEY) === '1';
}
export function markPushDisabled() {
  localStorage.setItem(DISABLED_KEY, '1');
}
function clearPushDisabled() {
  localStorage.removeItem(DISABLED_KEY);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameServerKey(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = (sub.options as { applicationServerKey?: ArrayBuffer | null }).applicationServerKey;
  if (!existing) return true; // can't compare — assume it matches
  const cur = new Uint8Array(existing);
  return cur.length === key.length && cur.every((b, i) => b === key[i]);
}

/** The current device's push subscription, if one exists. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.pushManager ? reg.pushManager.getSubscription() : null;
}

/**
 * Ask the service worker to create + save the subscription (the legacy Janis
 * flow). Resolves on success; rejects on timeout (old SW without the handler)
 * or with the SW's reported error.
 */
function subscribeViaWorker(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      reject(new Error('sw-timeout'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; ok?: boolean; error?: string; unsupported?: boolean }
        | undefined;
      if (data?.type !== 'pushSubscription') return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      if (data.ok) resolve();
      else if (data.unsupported) reject(new Error('sw-unsupported'));
      else reject(new Error(data.error ?? 'subscription failed in service worker'));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    // Post via both the controlling worker and ready.active — covers the case
    // where the page isn't yet controlled or ready resolves to a different
    // registration than the controller (legacy Janis did the same).
    navigator.serviceWorker.controller?.postMessage({ method: 'activateSubscription' });
    void navigator.serviceWorker.ready.then((reg) => {
      reg.active?.postMessage({ method: 'activateSubscription' });
    });
  });
}

/** Report a subscribe failure to the API so it lands in server logs. */
function reportSubscribeFailure(error: unknown, context: string) {
  void api('/api/push/subscribe-failed', {
    method: 'POST',
    body: JSON.stringify({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      context,
    }),
  }).catch(() => {});
}

/** Subscribe this device to Janis push notifications. Returns false if unsupported. */
export async function subscribeToPush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

  // pushManager.subscribe() can't prompt for permission — especially inside
  // the worker, where 'default' auto-denies as NotAllowedError. Request it
  // here so every caller (banner, Settings) gets the complete flow.
  if ('Notification' in window) {
    if (Notification.permission === 'denied') {
      throw new Error(
        'Notifications are blocked for this site — enable them in your browser site settings first.',
      );
    }
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        throw new Error('Notification permission was declined — allow notifications when prompted.');
      }
    }
  }

  try {
    // Worker-context subscribe — Chrome's push service accepts this where the
    // page-context call below gets rejected (AbortError) on some profiles.
    await subscribeViaWorker(15_000);
    clearPushDisabled();
    notifyPushChange();
    return true;
  } catch (err) {
    // 'sw-timeout' = old SW without the handler; 'sw-unsupported' = browser
    // without worker-context PushManager (Safari) — fall through to the
    // page-context subscribe for both.
    if (!(err instanceof Error && (err.message === 'sw-timeout' || err.message === 'sw-unsupported'))) {
      reportSubscribeFailure(err, 'worker');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('AbortError')) {
        throw new Error(
          "The browser's push service rejected the registration. This is usually environmental — a VPN/firewall/ad-blocker blocking the push service, or push services disabled in the browser. Try another browser or network.",
        );
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  // Fallback for an older service worker that lacks activateSubscription.
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/vapid-key');
  if (!publicKey) return false;

  const reg = await navigator.serviceWorker.ready;
  if (!reg.pushManager) return false; // e.g. Safari iOS in a regular tab
  const key = urlBase64ToUint8Array(publicKey) as BufferSource;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameServerKey(sub, urlBase64ToUint8Array(publicKey))) {
    // Bound to an old VAPID key — pushes would be rejected; re-subscribe.
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (err) {
      // A corrupt push registration sticks to the SW registration —
      // re-register the worker and retry once before blaming the environment.
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
      await reg.unregister();
      const fresh = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      try {
        sub = await fresh.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      } catch (retryErr) {
        reportSubscribeFailure(retryErr, 'page-fallback');
        if (retryErr instanceof DOMException && retryErr.name === 'AbortError') {
          throw new Error(
            "The browser's push service rejected the registration. This is usually environmental — a VPN/firewall/ad-blocker blocking the push service, or push services disabled in the browser (e.g. Brave needs 'Use Google services for push messaging' under brave://settings/privacy). Try another browser or network.",
          );
        }
        throw retryErr;
      }
    }
  }
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  clearPushDisabled();
  notifyPushChange();
  return true;
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = reg.pushManager ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api('/api/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
    notifyPushChange();
  }
}
