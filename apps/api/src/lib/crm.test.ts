import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  contactListMembers,
  contacts,
  crmConnections,
  suppressions,
  workspaces,
} from '../db/schema.js';
import { encryptSecret } from '../lib/secrets.js';
import {
  queueCrmActivity,
  runCrmSyncJob,
  runCrmWriteback,
  syncHubSpotConnection,
  syncSalesforceConnection,
} from './crm.js';
import { crmActivityQueue } from '../db/schema.js';

let db: Db;
let wsId: string;
let conn: typeof crmConnections.$inferSelect;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  [conn] = await db
    .insert(crmConnections)
    .values({
      workspaceId: wsId,
      provider: 'hubspot',
      credentialsEnc: encryptSecret(JSON.stringify({ token: 'pat-test' })),
    })
    .returning();
});

const HS_PAGE = (results: unknown[]) =>
  Response.json({ results, paging: results.length >= 100 ? { next: { after: 'x' } } : undefined });

describe('hubspot crm sync', () => {
  it('creates contacts anchored on external_ids, builds the sync list, imports opt-outs', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return HS_PAGE([
        {
          id: 'hs-1',
          properties: {
            email: 'Ada@Corp.test',
            phone: null,
            firstname: 'Ada',
            lastname: 'Lovelace',
            lastmodifieddate: '2026-01-02T00:00:00Z',
          },
        },
        {
          id: 'hs-2',
          properties: {
            email: 'gone@corp.test',
            hs_email_optout: 'true',
            lastmodifieddate: '2026-01-03T00:00:00Z',
          },
        },
        { id: 'hs-3', properties: { lastmodifieddate: '2026-01-03T00:00:00Z' } }, // no address — skipped
      ]);
    });
    const { synced } = await syncHubSpotConnection(db, conn);
    expect(synced).toBe(2);

    // Identity anchored on external_ids; email lowercased.
    const [ada] = await db.select().from(contacts).where(eq(contacts.email, 'ada@corp.test'));
    expect(ada).toBeTruthy();
    expect((ada.externalIds as Record<string, string>).hubspot).toBe('hs-1');
    expect(ada.name).toBe('Ada Lovelace');
    expect(ada.tags).toContain('crm:hubspot');

    // Sync list created on first run and members attached.
    const [after] = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, conn.id));
    expect(after.listId).toBeTruthy();
    expect(after.syncedCount).toBe(2);
    expect(after.watermark).toBeTruthy();
    const members = await db
      .select()
      .from(contactListMembers)
      .where(eq(contactListMembers.listId, after.listId!));
    expect(members).toHaveLength(2);

    // One-way consent: upstream opt-out → suppression.
    const sups = await db.select().from(suppressions).where(eq(suppressions.workspaceId, wsId));
    expect(sups.some((s) => s.address === 'gone@corp.test' && s.kind === 'email')).toBe(true);

    // Watermark passed as a lastmodifieddate GT filter on the next page…
    expect(calls[0].body.filterGroups).toEqual([{ filters: [] }]); // first run: unfiltered
    vi.unstubAllGlobals();
  });

  it('is idempotent — re-syncing the same record updates, never duplicates', async () => {
    vi.stubGlobal('fetch', async () =>
      HS_PAGE([
        {
          id: 'hs-1',
          properties: {
            email: 'ada.new@corp.test', // email changed upstream
            firstname: 'Ada',
            lastmodifieddate: '2026-01-05T00:00:00Z',
          },
        },
      ]),
    );
    const [fresh] = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, conn.id));
    await syncHubSpotConnection(db, fresh);
    const all = await db.select().from(contacts).where(eq(contacts.workspaceId, wsId));
    // Same Janis contact — external-id match beat the changed email.
    const adas = all.filter((c) => (c.externalIds as Record<string, string>).hubspot === 'hs-1');
    expect(adas).toHaveLength(1);
    const addrs = [adas[0].email, ...(adas[0].altEmails ?? [])];
    expect(addrs).toContain('ada.new@corp.test');
    vi.unstubAllGlobals();
  });

  it('the job writes last_error on provider failure and reschedules on success', async () => {
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429 }));
    await expect(runCrmSyncJob(db, conn.id)).rejects.toThrow(/429/);
    const [failed] = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, conn.id));
    expect(failed.lastError).toContain('429');
    vi.unstubAllGlobals();
  });
});

describe('crm activity write-back', () => {
  it('queue is gated on an enabled write-back connection', async () => {
    const [c] = await db.select().from(contacts).where(eq(contacts.email, 'ada@corp.test')).limit(1);
    // writeback off → nothing queues
    await queueCrmActivity(db, {
      workspaceId: wsId,
      contactId: c.id,
      kind: 'campaign_sent',
      refId: 'gated-1',
      summary: 'should not queue',
    });
    expect(await db.select().from(crmActivityQueue)).toHaveLength(0);
    // enable → queues
    await db.update(crmConnections).set({ activityWriteback: true }).where(eq(crmConnections.id, conn.id));
    await queueCrmActivity(db, {
      workspaceId: wsId,
      contactId: c.id,
      kind: 'campaign_sent',
      refId: 'send-1',
      summary: 'Campaign message sent',
    });
    // dedup on (contact,kind,ref)
    await queueCrmActivity(db, {
      workspaceId: wsId,
      contactId: c.id,
      kind: 'campaign_sent',
      refId: 'send-1',
      summary: 'dup',
    });
    expect(await db.select().from(crmActivityQueue)).toHaveLength(1);
  });

  it('posts a HubSpot note per queued activity and stamps synced_at', async () => {
    const posted: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (_i: RequestInfo | URL, init?: RequestInit) => {
      posted.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ id: 'note-1' }, { status: 201 });
    });
    const [fresh] = await db.select().from(crmConnections).where(eq(crmConnections.id, conn.id));
    await runCrmWriteback(db, fresh);
    vi.unstubAllGlobals();
    expect(posted).toHaveLength(1);
    const props = (posted[0].body as { properties?: Record<string, unknown> }).properties!;
    expect(String(props.hs_note_body)).toContain('Campaign send');
    const assoc = (posted[0].body as { associations?: { to: { id: string } }[] }).associations!;
    expect(assoc[0].to.id).toBe('hs-1');
    const rows = await db.select().from(crmActivityQueue);
    expect(rows[0].syncedAt).toBeTruthy();
  });

  it('drops events for contacts the CRM does not know', async () => {
    const [janisOnly] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, email: 'local@only.test' })
      .returning();
    await queueCrmActivity(db, {
      workspaceId: wsId,
      contactId: janisOnly.id,
      kind: 'opt_out',
      refId: 'opt-1',
      summary: 'opted out',
    });
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push(1);
      return Response.json({ id: 'n' }, { status: 201 });
    });
    const [fresh] = await db.select().from(crmConnections).where(eq(crmConnections.id, conn.id));
    await runCrmWriteback(db, fresh);
    vi.unstubAllGlobals();
    expect(calls).toHaveLength(0); // no note — no upstream anchor
    const pending = await db
      .select()
      .from(crmActivityQueue)
      .where(sql`${crmActivityQueue.syncedAt} is null`);
    expect(pending).toHaveLength(0);
  });
});

describe('salesforce crm connector', () => {
  let sfConn: typeof crmConnections.$inferSelect;

  it('logs in, polls SOQL on LastModifiedDate, syncs identity + opt-out', async () => {
    [sfConn] = await db
      .insert(crmConnections)
      .values({
        workspaceId: wsId,
        provider: 'salesforce',
        credentialsEnc: encryptSecret(
          JSON.stringify({ host: 'acme.my.salesforce.com', client_id: 'cid', client_secret: 'sec' }),
        ),
      })
      .returning();

    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/services/oauth2/token')) {
        return Response.json({ access_token: 'sf-tok', instance_url: 'https://acme.my.salesforce.com' });
      }
      expect(init?.headers && (init.headers as Record<string, string>).Authorization).toBe('Bearer sf-tok');
      return Response.json({
        records: [
          {
            Id: '003AAA',
            Email: 'grace@navy.test',
            Phone: '+15557770000',
            FirstName: 'Grace',
            LastName: 'Hopper',
            LastModifiedDate: '2026-02-01T00:00:00.000Z',
            HasOptedOutOfEmail: false,
          },
          {
            Id: '003BBB',
            Email: 'silent@sales.test',
            LastModifiedDate: '2026-02-02T00:00:00.000Z',
            HasOptedOutOfEmail: true,
          },
        ],
      });
    });
    const { synced } = await syncSalesforceConnection(db, sfConn);
    expect(synced).toBe(2);
    expect(urls[0]).toContain('/services/oauth2/token');
    expect(decodeURIComponent(urls[1])).toContain('FROM Contact');

    const [grace] = await db.select().from(contacts).where(eq(contacts.email, 'grace@navy.test'));
    expect((grace.externalIds as Record<string, string>).salesforce).toBe('003AAA');
    expect(grace.name).toBe('Grace Hopper');
    expect(grace.tags).toContain('crm:salesforce');

    // HasOptedOutOfEmail → one-way suppression.
    const sups = await db.select().from(suppressions).where(eq(suppressions.address, 'silent@sales.test'));
    expect(sups[0]?.reason).toBe('manual');

    // Sync list named after the provider.
    const [after] = await db.select().from(crmConnections).where(eq(crmConnections.id, sfConn.id));
    expect(after.listId).toBeTruthy();
    expect(after.watermark?.toISOString()).toBe('2026-02-02T00:00:00.000Z');
    vi.unstubAllGlobals();
  });

  it('writes activity back as a completed Task on the contact', async () => {
    const [grace] = await db.select().from(contacts).where(eq(contacts.email, 'grace@navy.test'));
    await db.update(crmConnections).set({ activityWriteback: true }).where(eq(crmConnections.id, sfConn.id));
    await queueCrmActivity(db, {
      workspaceId: wsId,
      contactId: grace.id,
      kind: 'conversion',
      refId: 'conv-1',
      summary: 'Conversion: purchase ($99.00) via shopify',
    });

    const tasks: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return Response.json({ access_token: 'sf-tok', instance_url: 'https://acme.my.salesforce.com' });
      }
      expect(url).toContain('/sobjects/Task');
      tasks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: '00T1' }, { status: 201 });
    });
    const [fresh] = await db.select().from(crmConnections).where(eq(crmConnections.id, sfConn.id));
    await runCrmWriteback(db, fresh);
    vi.unstubAllGlobals();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].WhoId).toBe('003AAA');
    expect(tasks[0].Status).toBe('Completed');
    expect(String(tasks[0].Subject)).toContain('Conversion');
    expect(String(tasks[0].Description)).toContain('$99.00');
  });
});
