/**
 * Voice calls are turn-based: Twilio holds the caller while our webhook
 * returns TwiML, so an agent reply can't be pushed — it has to be *pulled*
 * into the next webhook response. deliverToChannel drops outbound text into
 * the pending queue here; the /voice/turn handler drains or waits on it.
 *
 * In-memory and per-process: fine while Cloud Run stays single-instance
 * (AGENTS.md --max-instances 1). Multi-instance would need a shared queue.
 */
const queues = new Map<string, { pending: string[]; waiters: ((done: boolean) => void)[] }>();

function q(convId: string) {
  let entry = queues.get(convId);
  if (!entry) {
    entry = { pending: [], waiters: [] };
    queues.set(convId, entry);
  }
  return entry;
}

/** Agent/operator reply destined for a live call — spoken next turn. */
export function voiceDeliver(convId: string, text: string): void {
  const entry = q(convId);
  entry.pending.push(text);
  const waiters = entry.waiters.splice(0);
  for (const w of waiters) w(true);
}

/** Wait for outbound text: resolves with everything queued, or [] on timeout. */
export function voiceAwaitReply(convId: string, timeoutMs: number): Promise<string[]> {
  const entry = q(convId);
  if (entry.pending.length) return Promise.resolve(entry.pending.splice(0));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = entry.waiters.indexOf(wake);
      if (i >= 0) entry.waiters.splice(i, 1);
      resolve(entry.pending.splice(0));
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve(entry.pending.splice(0));
    };
    entry.waiters.push(wake);
  });
}

/** Call ended — flush the queue so no waiter leaks. */
export function voiceEndCall(convId: string): void {
  const entry = queues.get(convId);
  if (!entry) return;
  const waiters = entry.waiters.splice(0);
  for (const w of waiters) w(false);
  queues.delete(convId);
}
