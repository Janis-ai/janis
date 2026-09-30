import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  contactListMembers,
  contactLists,
  contacts,
  crmActivityQueue,
  crmConnections,
} from '../db/schema.js';
import { upsertContactByAddress } from './contacts.js';
import { recordSuppression } from './deliverability.js';
import { decryptSecret } from './secrets.js';
import { enqueueJob } from './jobs.js';

/** CRM read connector — v1 is HubSpot private-app tokens polling the Search
 *  API on a lastmodifieddate watermark. Read-only by design: identity and
 *  opt-out flow CRM → Janis, never the reverse, and a positive upstream
 *  consent value can never clear a Janis opt-out. */

const HUBSPOT_SEARCH = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const PROPS = ['email', 'phone', 'firstname', 'lastname', 'hs_email_optout'];
const PAGE_CAP = 20; // 20 × 100 = 2000 contacts per run; watermark resumes

interface HubSpotContact {
  id: string;
  properties: {
    email?: string | null;
    phone?: string | null;
    firstname?: string | null;
    lastname?: string | null;
    lastmodifieddate?: string;
    hs_email_optout?: string | null;
  };
}

/** The synced contacts land in one stable list per connection — campaign
 *  audiences pick it like any other list, and membership stays fresh. */
async function ensureSyncList(db: Db, conn: typeof crmConnections.$inferSelect) {
  if (conn.listId) return conn.listId;
  const [list] = await db
    .insert(contactLists)
    .values({ workspaceId: conn.workspaceId, name: `${conn.provider} sync` })
    .returning();
  await db
    .update(crmConnections)
    .set({ listId: list.id })
    .where(eq(crmConnections.id, conn.id));
  return list.id;
}

export async function syncHubSpotConnection(
  db: Db,
  conn: typeof crmConnections.$inferSelect,
): Promise<{ synced: number }> {
  const { token } = JSON.parse(decryptSecret(conn.credentialsEnc)) as { token: string };
  const listId = await ensureSyncList(db, conn);
  let after: string | undefined;
  let maxModified = conn.watermark?.getTime() ?? 0;
  let synced = 0;

  for (let page = 0; page < PAGE_CAP; page++) {
    const filters = conn.watermark
      ? [
          {
            propertyName: 'lastmodifieddate',
            operator: 'GT',
            value: String(conn.watermark.getTime()),
          },
        ]
      : [];
    const res = await fetch(HUBSPOT_SEARCH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: PROPS,
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`hubspot search ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: HubSpotContact[];
      paging?: { next?: { after?: string } };
    };
    const batch = data.results ?? [];
    if (!batch.length) break;

    for (const c of batch) {
      const p = c.properties ?? {};
      const modified = p.lastmodifieddate ? new Date(p.lastmodifieddate).getTime() : 0;
      if (modified > maxModified) maxModified = modified;
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || undefined;
      if (!p.email && !p.phone) continue; // unreachable — nothing to sync into
      const { contactId } = await upsertContactByAddress(db, {
        workspaceId: conn.workspaceId,
        name,
        email: p.email,
        phone: p.phone,
        external: { system: 'hubspot', id: c.id },
        tags: ['crm:hubspot'],
      });
      // Stable list membership — idempotent insert.
      await db
        .insert(contactListMembers)
        .values({ listId, contactId })
        .onConflictDoNothing();
      // One-way consent: upstream opt-out suppresses; nothing upstream
      // can ever clear a Janis suppression.
      if (p.email && p.hs_email_optout === 'true') {
        await recordSuppression(db, {
          workspaceId: conn.workspaceId,
          address: p.email,
          kind: 'email',
          reason: 'manual',
          source: 'hubspot:hs_email_optout',
        });
      }
      synced++;
    }
    after = data.paging?.next?.after;
    if (!after) break;
  }

  await db
    .update(crmConnections)
    .set({
      watermark: maxModified ? new Date(maxModified) : conn.watermark,
      lastSyncedAt: new Date(),
      lastError: null,
      syncedCount: sql`${crmConnections.syncedCount} + ${synced}`,
    })
    .where(eq(crmConnections.id, conn.id));
  return { synced };
}

/* ------------------------------------------------------------------ */
/* Activity write-back — append-only notes/tasks onto CRM contacts.    */
/* ------------------------------------------------------------------ */

export type CrmActivityKind =
  | 'campaign_sent'
  | 'campaign_failed'
  | 'campaign_reply'
  | 'conversion'
  | 'human_reply'
  | 'opt_out';

/** Record an activity event for CRM write-back. No-ops when the workspace
 *  has no enabled write-back connection — the gate check is one indexed
 *  read, cheap enough to call from every send/reply hot path. Idempotent:
 *  (contact, kind, ref) is unique so retries and double-stamps collapse. */
export async function queueCrmActivity(
  db: Db,
  args: {
    workspaceId: string;
    contactId: string;
    kind: CrmActivityKind;
    refId: string;
    summary: string;
    occurredAt?: Date;
  },
): Promise<void> {
  if (!args.contactId) return;
  const [enabled] = await db
    .select({ id: crmConnections.id })
    .from(crmConnections)
    .where(
      and(
        eq(crmConnections.workspaceId, args.workspaceId),
        eq(crmConnections.enabled, true),
        eq(crmConnections.activityWriteback, true),
      ),
    )
    .limit(1);
  if (!enabled) return;
  await db
    .insert(crmActivityQueue)
    .values({
      workspaceId: args.workspaceId,
      contactId: args.contactId,
      kind: args.kind,
      refId: args.refId,
      summary: args.summary.slice(0, 2000),
      ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
    })
    .onConflictDoNothing();
}

const HS_NOTES = 'https://api.hubapi.com/crm/v3/objects/notes';
// HubSpot-defined association type: note → contact.
const NOTE_TO_CONTACT = 202;

async function postHubSpotNote(token: string, hsContactId: string, body: string, at: Date) {
  const res = await fetch(HS_NOTES, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { hs_note_body: body, hs_timestamp: at.toISOString() },
      associations: [
        { to: { id: hsContactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`hubspot note ${res.status}: ${err.slice(0, 200)}`);
  }
}

const WB_BATCH = 100;
const WB_MAX_ATTEMPTS = 5;
const KIND_LABEL: Record<string, string> = {
  campaign_sent: 'Campaign send',
  campaign_failed: 'Campaign send failed',
  campaign_reply: 'Campaign reply',
  conversion: 'Conversion',
  human_reply: 'Human agent reply',
  opt_out: 'Opted out',
};

/** Drain pending queue rows for one connection onto CRM contact records.
 *  Rows for contacts the CRM doesn't know (no external_ids anchor) are
 *  stamped synced and dropped — write-back never creates CRM contacts. */
export async function runCrmWriteback(db: Db, conn: typeof crmConnections.$inferSelect) {
  if (!conn.enabled || !conn.activityWriteback) return;
  const { token } = JSON.parse(decryptSecret(conn.credentialsEnc)) as { token: string };
  const rows = await db
    .select({ row: crmActivityQueue, ext: contacts.externalIds })
    .from(crmActivityQueue)
    .innerJoin(contacts, eq(crmActivityQueue.contactId, contacts.id))
    .where(and(eq(crmActivityQueue.workspaceId, conn.workspaceId), isNull(crmActivityQueue.syncedAt)))
    .orderBy(asc(crmActivityQueue.occurredAt))
    .limit(WB_BATCH);

  let firstError: string | null = null;
  for (const { row, ext } of rows) {
    const hsId = (ext as Record<string, string> | null)?.[conn.provider];
    const done = async (attempts = row.attempts + 1) =>
      db
        .update(crmActivityQueue)
        .set({ syncedAt: new Date(), attempts })
        .where(eq(crmActivityQueue.id, row.id));
    if (!hsId) {
      await done(); // Janis-only contact — nothing upstream to write to
      continue;
    }
    try {
      if (conn.provider !== 'hubspot') throw new Error(`write-back for ${conn.provider} not implemented`);
      await postHubSpotNote(
        token,
        hsId,
        `Janis · ${KIND_LABEL[row.kind] ?? row.kind}\n${row.summary}`,
        row.occurredAt,
      );
      await done();
    } catch (e) {
      firstError ??= (e as Error).message;
      if (row.attempts + 1 >= WB_MAX_ATTEMPTS) await done(row.attempts + 1); // dead-letter
      else await db.update(crmActivityQueue).set({ attempts: row.attempts + 1 }).where(eq(crmActivityQueue.id, row.id));
    }
  }
  await db
    .update(crmConnections)
    .set({ lastError: firstError?.slice(0, 500) ?? null })
    .where(eq(crmConnections.id, conn.id));
  if (firstError && rows.length) throw new Error(firstError);
}

/** Job handler — loads the connection, runs its provider's sync, reschedules.
 *  Every periodic CRM sync is a self-rescheduling job rather than sweeper
 *  inline work: per-connection failure isolation + backoff for free. */
export async function runCrmSyncJob(db: Db, connectionId: string): Promise<void> {
  const [conn] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.id, connectionId))
    .limit(1);
  if (!conn || !conn.enabled) return;
  try {
    if (conn.provider !== 'hubspot') throw new Error(`unsupported provider ${conn.provider}`);
    await syncHubSpotConnection(db, conn);
  } catch (e) {
    await db
      .update(crmConnections)
      .set({ lastError: (e as Error).message.slice(0, 500), lastSyncedAt: new Date() })
      .where(eq(crmConnections.id, conn.id));
    throw e;
  }
  // Self-reschedule — 15 min cadence, idempotent by watermark.
  await enqueueJob(db, {
    workspaceId: conn.workspaceId,
    type: 'crm.sync',
    payload: { connection_id: conn.id },
    runAt: new Date(Date.now() + 15 * 60_000),
  });
}

/** Job entry point — load the connection, drain, self-reschedule. On batch
 *  failure the error is already on the connection row; we just back off to
 *  an hour instead of the 15-minute cadence rather than dead-lettering. */
export async function runCrmWritebackJob(db: Db, connectionId: string): Promise<void> {
  const [conn] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.id, connectionId))
    .limit(1);
  if (!conn || !conn.enabled || !conn.activityWriteback) return;
  let failed = false;
  try {
    await runCrmWriteback(db, conn);
  } catch {
    failed = true;
  }
  await enqueueJob(db, {
    workspaceId: conn.workspaceId,
    type: 'crm.writeback',
    payload: { connection_id: conn.id },
    runAt: new Date(Date.now() + (failed ? 60 : 15) * 60_000),
  });
}
