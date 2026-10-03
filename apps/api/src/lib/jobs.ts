import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  campaigns,
  campaignSends,
  channels,
  jobs,
  knowledgeFiles,
  workspaces,
} from '../db/schema.js';
import { sendOutbound } from './outbound.js';
import { refreshKnowledgeSource } from './urlSource.js';
import { dispatchCampaignStep, stepStragglersExist } from './campaigns.js';
import { checkSendPolicy, policyFor } from './sendPolicy.js';
import { queueCrmActivity, runCrmSyncJob, runCrmWritebackJob } from './crm.js';
import { runScheduledEval } from './evalRuns.js';

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
const DEFER_RETRY_MS = 15 * 60_000;

async function runOutboundSend(db: Db, workspaceId: string, p: OutboundSendJob): Promise<void> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, p.channelId))
    .limit(1);
  if (!channel || channel.workspaceId !== workspaceId) {
    throw new Error('channel gone or wrong workspace');
  }

  // Lazy cancel/pause + suppression re-check at send time — a job enqueued
  // hours ago still honors a pause/resume/cancel or a bounce-suppression
  // written since it queued. Campaign sends stamp the outcome on their row.
  const stamp = async (
    status: typeof campaignSends.$inferSelect.status,
    error?: string,
  ) => {
    if (p.campaignSendId) {
      await db
        .update(campaignSends)
        .set({ status, ...(error ? { error } : {}) })
        .where(eq(campaignSends.id, p.campaignSendId));
    }
  };
  const defer = async (runAt: Date) => {
    await enqueueJob(db, { workspaceId, type: 'outbound.send', payload: { ...p }, runAt });
  };

  if (p.campaignSendId) {
    const [send] = await db
      .select({ status: campaigns.status })
      .from(campaignSends)
      .innerJoin(campaigns, eq(campaignSends.campaignId, campaigns.id))
      .where(eq(campaignSends.id, p.campaignSendId))
      .limit(1);
    if (!send || send.status === 'cancelled' || send.status === 'done' || send.status === 'failed') {
      await stamp('skipped_cancelled');
      return;
    }
    if (send.status === 'paused') {
      // The row stays 'pending' — stamp the reason so an operator looking at
      // the campaign sees *why* it hasn't gone out, not a mystery hold.
      await stamp('pending', 'held — campaign is paused');
      await defer(new Date(Date.now() + DEFER_RETRY_MS));
      return;
    }
  }

  const [ws] = await db
    .select({ config: workspaces.config })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const decision = await checkSendPolicy(db, {
    workspaceId,
    channelKind: channel.kind,
    recipient: p.to,
    policy: policyFor(ws?.config),
  });
  if (!decision.ok) {
    if ('deferUntil' in decision) {
      // Quiet-hours defer — the send stays pending but explains itself.
      // A later attempt overwrites this note on the real outcome.
      await stamp(
        'pending',
        `held for quiet hours — retrying ${decision.deferUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      );
      await defer(decision.deferUntil);
      return;
    }
    await stamp(`skipped_${decision.skip}`, `send policy: ${decision.skip}`);
    return;
  }

  const r = await sendOutbound(
    db,
    channel,
    { id: p.senderId ?? '', name: p.senderName },
    { to: p.to, text: p.text, subject: p.subject, template: p.template },
  );
  if (p.campaignSendId) {
    const [stamped] = await db
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
      .where(eq(campaignSends.id, p.campaignSendId))
      .returning({ contactId: campaignSends.contactId });
    if (stamped?.contactId) {
      await queueCrmActivity(db, {
        workspaceId,
        contactId: stamped.contactId,
        kind: r.error ? 'campaign_failed' : 'campaign_sent',
        refId: p.campaignSendId,
        summary: r.error
          ? `Campaign message failed to ${p.to}: ${r.error}`
          : `Campaign message sent to ${p.to}`,
      }).catch(() => {}); // write-back must never kill a send
    }
  }
  if (r.error) throw new Error(r.error);
}

/** One URL-backed knowledge file re-crawl — enqueued by sweepKnowledge so
 *  slow fetches run off the sweeper tick (and retry on failure). */
async function runKnowledgeRefresh(db: Db, workspaceId: string, p: { fileId?: string }) {
  const [file] = await db
    .select()
    .from(knowledgeFiles)
    .where(eq(knowledgeFiles.id, p.fileId ?? ''))
    .limit(1);
  if (!file || file.workspaceId !== workspaceId) {
    throw new Error('knowledge file gone or wrong workspace');
  }
  await refreshKnowledgeSource(db, file);
}

type JobRow = typeof jobs.$inferSelect;
const HANDLERS: Record<
  string,
  (db: Db, workspaceId: string, payload: never, job: JobRow) => Promise<void>
> = {
  'outbound.send': (db, ws, p) => runOutboundSend(db, ws, p as unknown as OutboundSendJob),
  'knowledge.refresh': (db, ws, p) => runKnowledgeRefresh(db, ws, p as { fileId?: string }),
  'campaign.step': async (db, ws, p) => {
    const { campaignId, stepIndex } = p as { campaignId: string; stepIndex: number };
    // Paused campaigns hold their step chain — re-check rather than
    // dispatch or drop; resume re-arms it. Cancelled/finished ends it.
    const [camp] = await db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (camp?.status === 'paused') {
      await enqueueJob(db, {
        workspaceId: ws,
        type: 'campaign.step',
        payload: { campaignId, stepIndex },
        runAt: new Date(Date.now() + DEFER_RETRY_MS),
      });
      return;
    }
    if (!camp || camp.status !== 'sending') return;
    await dispatchCampaignStep(db, campaignId, stepIndex);
    // Rolling re-check: late-landing sends (retry delays) and contacts
    // enrolled into a continuous campaign after this step ran must still
    // get stepped. Recheck in 5 min until no stragglers remain.
    if (await stepStragglersExist(db, campaignId, stepIndex)) {
      await enqueueJob(db, {
        workspaceId: ws,
        type: 'campaign.step',
        payload: { campaignId, stepIndex },
        runAt: new Date(Date.now() + 5 * 60_000),
      });
    }
  },
  'crm.sync': async (db, _ws, p) => {
    const { connection_id } = p as { connection_id?: string };
    if (!connection_id) throw new Error('crm.sync job missing connection_id');
    await runCrmSyncJob(db, connection_id);
  },
  'crm.writeback': async (db, _ws, p) => {
    const { connection_id } = p as { connection_id?: string };
    if (!connection_id) throw new Error('crm.writeback job missing connection_id');
    await runCrmWritebackJob(db, connection_id);
  },
  'eval.run': async (db, ws, p, job) => {
    const { agentId } = p as { agentId?: string };
    if (!agentId) throw new Error('eval.run job missing agentId');
    // Suites can outrun the 5-minute stale reclaim — bump run_at between
    // tests so a healthy long run isn't re-claimed mid-flight.
    await runScheduledEval(db, ws, agentId, () =>
      db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id)),
    );
  },
  'eval.triage': async (db, ws, p, job) => {
    const { agentId, batchId } = p as { agentId?: string; batchId?: string };
    if (!agentId || !batchId) throw new Error('eval.triage job missing agentId/batchId');
    const { triageRegression } = await import('./evalTriage.js');
    await triageRegression(db, ws, agentId, batchId, () =>
      db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id)),
    );
  },
};

const MAX_ATTEMPTS = 5;
const BATCH = 50;
// Handlers run in a bounded pool — campaign fan-outs of thousands would
// otherwise serialize one send per loop iteration per sweep tick.
const JOB_CONCURRENCY = 8;

/** Drain due jobs — called under the sweeper leader lock each tick. Claim-
 *  first semantics: status flips running before the handler runs, so a crash
 *  leaves the row 'running' (reclaimed on the next pass when attempts <
 *  MAX, else surfaced as failed). Claims all due rows first, then runs
 *  handlers JOB_CONCURRENCY-wide. */
export async function runJobs(db: Db): Promise<number> {
  const claimed: (typeof jobs.$inferSelect)[] = [];
  for (let i = 0; i < BATCH; i++) {
    // Claim one due job atomically; leader lock means no cross-instance race,
    // but SKIP LOCKED keeps intra-instance overlap safe too.
    const raw = (await db.execute(sql`
      update jobs set status = 'running', attempts = attempts + 1
      where id = (
        select id from jobs
        where (status = 'pending' and run_at <= now())
           or (status = 'running' and attempts < ${MAX_ATTEMPTS}
               and run_at <= now() - interval '5 minutes')
        order by run_at limit 1
        for update skip locked
      )
      returning id
    `)) as unknown;
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as
      | { id: string }[]
      | undefined;
    const claimedRow = rows?.[0];
    if (!claimedRow) break;
    // db.execute returns raw snake_case keys — re-select through drizzle for
    // the mapped row (workspace_id → workspaceId). Skipping this once made
    // every outbound.send job die with 'channel gone or wrong workspace'.
    const [job] = await db.select().from(jobs).where(eq(jobs.id, claimedRow.id));
    if (job) claimed.push(job);
  }
  if (!claimed.length) return 0;

  let next = 0;
  const runOne = async (job: (typeof claimed)[number]) => {
    const handler = HANDLERS[job.type];
    try {
      if (!handler) throw new Error(`unknown job type ${job.type}`);
      await handler(db, job.workspaceId, job.payload as never, job);
      await db
        .update(jobs)
        .set({ status: 'done', finishedAt: new Date(), lastError: null })
        .where(eq(jobs.id, job.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The claim's UPDATE already counted this run — job.attempts IS this
      // attempt's number; adding one would dead-letter a retry early.
      const attempts = job.attempts;
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
  };
  await Promise.all(
    Array.from({ length: Math.min(JOB_CONCURRENCY, claimed.length) }, async () => {
      while (next < claimed.length) await runOne(claimed[next++]);
    }),
  );
  return claimed.length;
}
