import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contactListMembers, contactLists, crmConnections } from '../db/schema.js';
import { upsertContactByAddress } from './contacts.js';
import { recordSuppression } from './deliverability.js';
import { decryptSecret } from './secrets.js';

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
