import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeToPush, unsubscribeFromPush, isPushDisabled } from '../lib/push';
import { isStandalone } from '../lib/install';

const DISMISS_KEY = 'janis.pushBanner.dismissed';

function isTouchDevice() {
  return 'ontouchstart' in window || 'onmsgesturechange' in window;
}

function isTrustedOrigin() {
  const host = window.location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('janis.ai') ||
    host.endsWith('.run.app')
  );
}

/**
 * Legacy Janis notification banner — nudges users to activate desktop
 * notifications while permission is undecided, points at site settings when
 * blocked, and silently re-syncs the push subscription on every load once
 * granted (self-heals devices whose subscription never reached the server).
 */
export default function PushBanner() {
  const [state, setState] = useState<'hidden' | 'prompt' | 'denied'>('hidden');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const cooldownUntil = useRef(0);

  const activate = useCallback(async () => {
    if (busyRef.current || Date.now() < cooldownUntil.current) return;
    busyRef.current = true;
    cooldownUntil.current = Date.now() + 60_000; // don't spam a rejecting push service
    setBusy(true);
    setError('');
    try {
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') return;
      }
      if (await subscribeToPush()) setState('hidden');
      else setError('Push is not configured on this server.');
    } catch (err) {
      setError("Couldn't enable — check this site's notification settings in your browser.");
      console.error('push activation failed:', err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const supported =
      'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!supported || !isTrustedOrigin()) return;
    // Suppress on touch devices — except installed PWAs, where push works.
    if (isTouchDevice() && !isStandalone()) return;
    if (sessionStorage.getItem(DISMISS_KEY)) return;

    const apply = (perm: string) => {
      if (perm === 'granted') {
        setState('hidden');
        // Always re-activate on load: reuses the existing subscription and
        // re-POSTs it (silent server-side), healing devices whose subscription
        // never reached the server — unless the user explicitly disabled push
        // in Settings (janis.push.disabled), which must not be undone.
        if (!isPushDisabled()) void activate();
      } else {
        setState(perm === 'denied' ? 'denied' : 'prompt');
        // Blocked permission leaves a dead endpoint — clear it like legacy did.
        if (perm === 'denied') void unsubscribeFromPush().catch(() => {});
      }
    };

    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'notifications' as PermissionName })
        .then((res) => {
          apply(res.state);
          res.onchange = () => apply(res.state);
        })
        .catch(() => apply(Notification.permission));
    } else {
      apply(Notification.permission);
    }
  }, [activate]);

  if (state === 'hidden') return null;

  return (
    <div className="push-banner">
      <span>
        {state === 'denied'
          ? 'Notifications are blocked — enable them for this site in your browser settings to get agent alerts.'
          : 'Get actionable alerts from your agents when you activate desktop notifications.'}
        {error && <span className="push-banner-error"> {error}</span>}
      </span>
      {state === 'prompt' && (
        <button className="btn primary" disabled={busy} onClick={() => void activate()}>
          {busy ? 'Activating…' : 'Activate'}
        </button>
      )}
      <button
        className="push-banner-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1');
          setState('hidden');
        }}
      >
        ×
      </button>
    </div>
  );
}
