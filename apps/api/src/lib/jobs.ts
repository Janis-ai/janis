import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaignSends, channels, jobs } from '../db/schema.js';
import { sendOutbound } from './outbound.js';

/** Job payload for 'outbound.send' — one recipient's send, replayable. */
export interface OutboundSendJob {
  channelId: string;
  to: string;
  text: string;
  subject?: string;
  template?: { name: string; language?: string; bodyParams?: string[] };
  senderId?: string;
  senderName?: string;
  /** Campaign row to stamp with the outcome when this send belongs to one. */
  campaignSendId?: string;
}

export async function enqueueJob(
  db: Db,
  job: {
    workspaceId: string;
    type: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      workspaceId: job.workspaceId,
      type: job.type,
      payload: job.payload ?? {},
      ...(job.runAt ? { runAt: job.runAt } : {}),
    })
    .returning({ id: jobs.id });
  return row.id;
}

/** One queued outbound send — a broadcast/campaign recipient. The channel
 *  may have been deleted since enqueue; that job fails permanently. */
async function runOutboundSend(db: Db, workspaceId: string, p: OutboundSendJob): Promise<void> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, p.channelId))
    .limit(1);
  if (!channel || channel.workspaceId !== workspaceId) {
    throw new Error('channel gone or wrong workspace');
  }
  const r = await sendOutbound(
    db,
    channel,
    { id: p.senderId ?? '', name: p.senderName },
    { to: p.to, text: p.text, subject: p.subject, template: p.template },
  );
  if (p.campaignSendId) {
    await db
      .update(campaignSends)
      .set({
        status: r.error
          ? r.error === 'recipient has opted out (STOP)'
            ? 'skipped_opted_out'
            : 'failed'
          : 'sent',
        error: r.error,
        conversationId: r.conversationId,
        sentAt: r.error ? null : new Date(),
      })
      .where(eq(campaignSends.id, p.campaignSendId));
  }
  if (r.error) throw new Error(r.error);
}

const HANDLERS: Record<string, (db: Db, workspaceId: string, payload: never) => Promise<void>> = {
  'outbound.send': (db, ws, p) => runOutboundSend(db, ws, p as unknown as OutboundSendJob),
};

const MAX_ATTEMPTS = 5;
const BATCH = 50;

/** Drain due jobs — called under the sweeper leader lock each tick. Claim-
 *  first semantics: status flips running before the handler runs, so a crash
 *  leaves the row 'running' (reclaimed on the next pass when attempts <
 *  MAX, else surfaced as failed). */
export async function runJobs(db: Db): Promise<number> {
  let ran = 0;
  for (let i = 0; i < BATCH; i++) {
    // Claim one due job atomically; leader lock means no cross-instance race,
    // but SKIP LOCKED keeps intra-instance overlap safe too.
    const claimed = (await db.execute(sql`
      update jobs set status = 'running', attempts = attempts + 1
      where id = (
        select id from jobs
        where (status = 'pending' and run_at <= now())
           or (status = 'running' and attempts < ${MAX_ATTEMPTS}
               and run_at <= now() - interval '5 minutes')
        order by run_at limit 1
        for update skip locked
      )
      returning *
    `)) as unknown;
    const rows = (Array.isArray(claimed) ? claimed : (claimed as { rows?: unknown[] }).rows) as
      | (typeof jobs.$inferSelect)[]
      | undefined;
    const job = rows?.[0];
    if (!job) break;
    const handler = HANDLERS[job.type];
    try {
      if (!handler) throw new Error(`unknown job type ${job.type}`);
      await handler(db, job.workspaceId, job.payload as never);
      await db
        .update(jobs)
        .set({ status: 'done', finishedAt: new Date(), lastError: null })
        .where(eq(jobs.id, job.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      await db
        .update(jobs)
        .set(
          attempts >= MAX_ATTEMPTS
            ? { status: 'failed', lastError: msg, finishedAt: new Date() }
            : {
                status: 'pending',
                lastError: msg,
                runAt: new Date(Date.now() + 10_000 * 2 ** attempts),
              },
        )
        .where(eq(jobs.id, job.id));
    }
    ran++;
  }
  return ran;
}
