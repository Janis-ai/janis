/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

declare let self: ServiceWorkerGlobalScope;

// Activate new versions immediately — otherwise updated bundles sit
// "waiting" until every tab closes and users see stale builds.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameServerKey(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = (sub.options as { applicationServerKey?: ArrayBuffer | null })
    .applicationServerKey;
  if (!existing) return true;
  const cur = new Uint8Array(existing);
  return cur.length === key.length && cur.every((b, i) => b === key[i]);
}

// Subscribe from inside the worker — Chrome's push service accepts this where
// page-context subscribe() is rejected on some profiles/origins. The page
// posts {method:'activateSubscription'} and awaits a pushSubscription reply.
self.addEventListener('message', (event) => {
  const data = event.data as { method?: string } | undefined;
  if (data?.method !== 'activateSubscription') return;
  event.waitUntil(activatePushSubscription(event));
});

async function activatePushSubscription(event: ExtendableMessageEvent) {
  const reply = (payload: {
    type: string;
    ok: boolean;
    error?: string;
    unsupported?: boolean;
  }) => {
    (event.source as Client | null)?.postMessage(payload);
  };
  try {
    // Safari exposes PushManager only on the window's registration — inside
    // the worker it's undefined (and on iOS it requires a Home Screen app).
    if (!self.registration.pushManager) {
      reply({
        type: 'pushSubscription',
        ok: false,
        unsupported: true,
        error: 'pushManager unavailable in service worker',
      });
      return;
    }
    const { publicKey } = (await (await fetch('/api/push/vapid-key')).json()) as {
      publicKey: string | null;
    };
    if (!publicKey) throw new Error('push not configured');
    const key = urlBase64ToUint8Array(publicKey);
    let sub = await self.registration.pushManager.getSubscription();
    if (sub && !sameServerKey(sub, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key as BufferSource,
    });
    const json = sub.toJSON() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    const res = await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!res.ok) throw new Error(`subscription save failed (${res.status})`);
    reply({ type: 'pushSubscription', ok: true });
  } catch (err) {
    reply({
      type: 'pushSubscription',
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

self.addEventListener('push', (event) => {
  const data = event.data?.json() as
    | { title?: string; body?: string; url?: string; silent?: boolean }
    | undefined;
  event.waitUntil(
    self.registration.showNotification(data?.title ?? 'Janis', {
      body: data?.body ?? '',
      // PNG, not SVG — notification icons don't rasterize reliably everywhere
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // per-user "alert sounds" pref — the API flags this push silent
      silent: data?.silent === true,
      data: { url: data?.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string })?.url ?? '/conversations';
  // Absolute URL — openWindow resolves relative URLs against the SW script
  // URL anyway, but being explicit avoids edge cases in older Chromes.
  const url = new URL(raw, self.location.origin).href;
  const path = new URL(url).pathname + new URL(url).search;
  // Post the deep link to every app window — the page listens and routes
  // client-side. This covers the failure modes navigate()/openWindow can't:
  // a navigate() rejection on uncontrolled clients, and installed-PWA
  // launches where Chrome opens start_url instead of the requested URL.
  const broadcast = async (attempts: number) => {
    for (let i = 0; i < attempts; i++) {
      try {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) w.postMessage({ type: 'janis:open', url: path });
      } catch { /* keep retrying */ }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600));
    }
  };
  event.waitUntil(
    (async () => {
      try {
        // Focus an app window that's already open and navigate it in place —
        // only spawn a new window when nothing is running.
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const target = wins.find((c) => new URL(c.url).origin === self.location.origin) ?? wins[0];
        if (target) {
          // Focus BEFORE navigating — the click is the user gesture Chrome
          // needs to raise the window, and focus() can no-op on a client
          // that's mid-reload.
          await target.focus().catch(() => undefined);
          await (target as WindowClient).navigate(url).catch(() => undefined);
          void broadcast(4); // client-side route covers a failed navigate
          return;
        }
      } catch {
        // matchAll/navigate failures must not eat the click — fall through
      }
      await self.clients.openWindow(url).catch(() => undefined);
      // A cold window (or a PWA that opened at start_url) needs time to boot
      // and attach its message listener — broadcast over ~6 seconds.
      await broadcast(10);
    })(),
  );
});
