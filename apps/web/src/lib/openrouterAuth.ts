/** OpenRouter OAuth (PKCE) — "Connect account" for the Engine tab.
 *  No client registration: the challenge is the credential. We redirect to
 *  openrouter.ai/auth, come back to /llm/callback with ?code, exchange it
 *  for a user-scoped API key, stash it in sessionStorage, and return to the
 *  agent page which picks it up on mount. */

const VERIFIER_KEY = 'or:verifier';
const RETURN_KEY = 'or:return';
const RESULT_KEY = 'or:key';
const ERR_KEY = 'or:error';

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Redirect the browser to OpenRouter's authorize page. Never returns. */
export async function connectOpenRouter(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(RETURN_KEY, window.location.href);
  const cb = `${window.location.origin}/llm/callback`;
  window.location.href =
    `https://openrouter.ai/auth?callback_url=${encodeURIComponent(cb)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&key_label=Janis`;
}

/** On /llm/callback: exchange ?code for an API key, then bounce back to the
 *  page that started the flow. */
export async function finishOpenRouterCallback(): Promise<void> {
  const code = new URLSearchParams(window.location.search).get('code');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const back = sessionStorage.getItem(RETURN_KEY) ?? '/';
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  if (!code || !verifier) {
    sessionStorage.setItem(ERR_KEY, 'missing authorization code');
    window.location.replace(back);
    return;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const data = (await res.json()) as { key?: string; error?: string };
    if (res.ok && data.key) sessionStorage.setItem(RESULT_KEY, data.key);
    else sessionStorage.setItem(ERR_KEY, data.error ?? `exchange failed (${res.status})`);
  } catch (e) {
    sessionStorage.setItem(ERR_KEY, e instanceof Error ? e.message : 'exchange failed');
  }
  window.location.replace(back);
}

/** One-shot read of the key/error produced by the callback. */
export function consumeOpenRouterResult(): { key?: string; error?: string } {
  const key = sessionStorage.getItem(RESULT_KEY) ?? undefined;
  const error = sessionStorage.getItem(ERR_KEY) ?? undefined;
  sessionStorage.removeItem(RESULT_KEY);
  sessionStorage.removeItem(ERR_KEY);
  return { key, error };
}
