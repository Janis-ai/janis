/**
 * Voice calls are turn-based: Twilio holds the caller while our webhook
 * returns TwiML, so an agent reply can't be pushed — it has to be *pulled*
 * into the next webhook response. deliverToChannel drops outbound text into
 * the voice_queue table; the /voice/turn handler drains it. The queue lives in
 * Postgres so the turn webhook can land on any instance — a local emitter
 * still wakes same-instance waiters immediately to keep latency low.
 */
import { EventEmitter } from 'node:events';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { voiceQueue } from '../db/schema.js';

const wakeEmitter = new EventEmitter();
wakeEmitter.setMaxListeners(0);
const POLL_MS = 300;

/** Agent/operator reply destined for a live call — spoken next turn. */
export async function voiceDeliver(db: Db, convId: string, text: string): Promise<void> {
  await db.insert(voiceQueue).values({ conversationId: convId, text });
  wakeEmitter.emit(`wake:${convId}`);
}

async function drain(db: Db, convId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(voiceQueue)
    .where(eq(voiceQueue.conversationId, convId))
    .orderBy(asc(voiceQueue.id));
  if (!rows.length) return [];
  await db.delete(voiceQueue).where(inArray(voiceQueue.id, rows.map((r) => r.id)));
  return rows.map((r) => r.text);
}

/** Wait for outbound text: resolves with everything queued, or [] on timeout
 * / call end. Polls Postgres; same-instance inserts wake it instantly. */
export async function voiceAwaitReply(db: Db, convId: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const immediate = await drain(db, convId);
  if (immediate.length) return immediate;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    const woke = await new Promise<'wake' | 'end' | 'poll'>((resolve) => {
      const cleanup = () => {
        wakeEmitter.off(`wake:${convId}`, onWake);
        wakeEmitter.off(`end:${convId}`, onEnd);
      };
      const onWake = () => (cleanup(), resolve('wake'));
      const onEnd = () => (cleanup(), resolve('end'));
      wakeEmitter.once(`wake:${convId}`, onWake);
      wakeEmitter.once(`end:${convId}`, onEnd);
      setTimeout(() => (cleanup(), resolve('poll')), Math.min(POLL_MS, remaining));
    });
    if (woke === 'end') return [];
    const rows = await drain(db, convId);
    if (rows.length) return rows;
  }
}

/** Call ended — flush the queue and wake waiters so no request leaks. */
export async function voiceEndCall(db: Db, convId: string): Promise<void> {
  await db.delete(voiceQueue).where(eq(voiceQueue.conversationId, convId));
  wakeEmitter.emit(`end:${convId}`);
}
