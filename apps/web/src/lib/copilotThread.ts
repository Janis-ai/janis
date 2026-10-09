/** Ask Janis copilot thread selection — which concierge chat the rail is
 *  showing survives reloads. null = the default shared thread (the
 *  pre-threading u:<id> conversation); a t<rand> key scopes to its own. */

const KEY = 'janis.copilot-thread';

export function readCopilotThread(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function storeCopilotThread(thread: string | null) {
  try {
    if (thread) localStorage.setItem(KEY, thread);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the in-memory selection still applies */
  }
}

/** Server-side the key scopes a u: participant (u:<id>:<key>) — THREAD_RE
 *  requires the leading 't' and lowercase-alnum body. */
export function freshCopilotThread(): string {
  return (
    't' +
    (
      crypto.randomUUID?.() ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 22)}`
    )
      .replace(/-/g, '')
      .slice(0, 20)
  );
}
