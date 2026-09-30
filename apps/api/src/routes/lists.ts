import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contactListMembers, contactLists, contacts } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { upsertContactByAddress } from '../lib/contacts.js';
import { audit } from '../lib/audit.js';

const MAX_IMPORT_ROWS = 5_000;

/** Minimal RFC4180 reader — quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      cur.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(field);
      field = '';
      if (cur.some((f) => f.trim() !== '')) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some((f) => f.trim() !== '')) rows.push(cur);
  return rows;
}

function normalizePhone(p: string): string {
  const s = p.replace(/[^\d+]/g, '');
  return s.startsWith('+') ? s : s.length ? `+${s}` : s;
}

/** Contact lists — static audiences for campaigns. Members can read;
 *  mutations are admin-only (import is bulk contact creation). */
export function listRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select({
        id: contactLists.id,
        name: contactLists.name,
        createdAt: contactLists.createdAt,
        members: sql<number>`count(${contactListMembers.contactId})::int`,
      })
      .from(contactLists)
      .leftJoin(contactListMembers, eq(contactListMembers.listId, contactLists.id))
      .where(eq(contactLists.workspaceId, c.get('workspaceId')))
      .groupBy(contactLists.id)
      .orderBy(asc(contactLists.name));
    return c.json({
      lists: rows.map((r) => ({
        id: r.id,
        name: r.name,
        members: r.members,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.post('/', adminOnly, zValidator('json', z.object({ name: z.string().min(1).max(120) })), async (c) => {
    const [row] = await db
      .insert(contactLists)
      .values({ workspaceId: c.get('workspaceId'), name: c.req.valid('json').name })
      .returning();
    return c.json({ list: { id: row.id, name: row.name, members: 0 } }, 201);
  });

  app.delete('/:id', adminOnly, async (c) => {
    const [row] = await db
      .delete(contactLists)
      .where(and(eq(contactLists.id, c.req.param('id')), eq(contactLists.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'list.delete',
      targetType: 'contact_list',
      targetId: row.id,
      meta: { name: row.name },
    });
    return c.json({ ok: true });
  });

  // GET /:id/members — who is in this list (contact rows, not just ids).
  app.get('/:id/members', async (c) => {
    const [list] = await db
      .select({ id: contactLists.id })
      .from(contactLists)
      .where(and(eq(contactLists.id, c.req.param('id')), eq(contactLists.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!list) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        phone: contacts.phone,
        tags: contacts.tags,
      })
      .from(contactListMembers)
      .innerJoin(contacts, eq(contactListMembers.contactId, contacts.id))
      .where(eq(contactListMembers.listId, list.id))
      .orderBy(asc(contacts.name))
      .limit(2_000);
    return c.json({ members: rows });
  });

  app.post(
    '/:id/members',
    adminOnly,
    zValidator('json', z.object({ contact_id: z.string().uuid() })),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const listId = c.req.param('id');
      const contactId = c.req.valid('json').contact_id;
      const [list] = await db
        .select({ id: contactLists.id })
        .from(contactLists)
        .where(and(eq(contactLists.id, listId), eq(contactLists.workspaceId, workspaceId)))
        .limit(1);
      if (!list) return c.json({ error: 'not found' }, 404);
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      if (!contact) return c.json({ error: 'contact not found' }, 404);
      await db
        .insert(contactListMembers)
        .values({ listId, contactId })
        .onConflictDoNothing();
      return c.json({ ok: true });
    },
  );

  app.delete('/:id/members/:contactId', adminOnly, async (c) => {
    const [list] = await db
      .select({ id: contactLists.id })
      .from(contactLists)
      .where(and(eq(contactLists.id, c.req.param('id')), eq(contactLists.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!list) return c.json({ error: 'not found' }, 404);
    await db
      .delete(contactListMembers)
      .where(
        and(
          eq(contactListMembers.listId, list.id),
          eq(contactListMembers.contactId, c.req.param('contactId')),
        ),
      );
    return c.json({ ok: true });
  });

  // POST /import — {list_id} or {name} + csv text. Columns (header row):
  // name, email, phone, tags (;-separated). Email or phone required per row.
  // Matches existing contacts on email/phone (primary or alt), enriches
  // rather than duplicating, and joins every resolved row to the list.
  app.post(
    '/import',
    adminOnly,
    zValidator(
      'json',
      z.object({
        list_id: z.string().uuid().optional(),
        name: z.string().min(1).max(120).optional(),
        csv: z.string().min(1).max(4_000_000),
      }),
    ),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { list_id, name, csv } = c.req.valid('json');
      let listId = list_id;
      if (listId) {
        const [list] = await db
          .select({ id: contactLists.id })
          .from(contactLists)
          .where(and(eq(contactLists.id, listId), eq(contactLists.workspaceId, workspaceId)))
          .limit(1);
        if (!list) return c.json({ error: 'list not found' }, 404);
      } else {
        if (!name) return c.json({ error: 'name or list_id required' }, 400);
        const [row] = await db
          .insert(contactLists)
          .values({ workspaceId, name })
          .returning({ id: contactLists.id });
        listId = row.id;
      }

      const rows = parseCsv(csv);
      if (rows.length < 2) return c.json({ error: 'csv needs a header row and at least one data row' }, 400);
      const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
      const col = (n: string) => header.indexOf(n);
      const iName = col('name') >= 0 ? col('name') : col('full_name');
      const iFirst = col('first_name');
      const iLast = col('last_name');
      const iEmail = col('email');
      const iPhone = col('phone');
      const iTags = col('tags');
      if (iEmail < 0 && iPhone < 0) {
        return c.json({ error: 'csv needs an email or phone column' }, 400);
      }
      const dataRows = rows.slice(1);
      if (dataRows.length > MAX_IMPORT_ROWS) {
        return c.json({ error: `csv exceeds ${MAX_IMPORT_ROWS} rows` }, 400);
      }

      let created = 0;
      let matched = 0;
      let skipped = 0;
      for (const r of dataRows) {
        const email = (r[iEmail] ?? '').trim().toLowerCase();
        const phone = normalizePhone((r[iPhone] ?? '').trim());
        if (!email && !phone) {
          skipped++;
          continue;
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          skipped++;
          continue;
        }
        const nameVal =
          (iName >= 0 ? r[iName]?.trim() : '') ||
          [r[iFirst]?.trim(), r[iLast]?.trim()].filter(Boolean).join(' ').trim() ||
          null;
        const tags =
          iTags >= 0
            ? (r[iTags] ?? '').split(';').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20)
            : [];
        const { contactId, created: isNew } = await upsertContactByAddress(db, {
          workspaceId,
          name: nameVal,
          email: email || null,
          phone: phone || null,
          tags,
        });
        await db
          .insert(contactListMembers)
          .values({ listId: listId!, contactId })
          .onConflictDoNothing();
        if (isNew) created++;
        else matched++;
      }
      await audit(db, {
        workspaceId,
        userId: c.get('user').id,
        userName: c.get('user').name,
        action: 'list.import',
        targetType: 'contact_list',
        targetId: listId,
        meta: { created, matched, skipped, rows: dataRows.length },
      });
      return c.json({ list_id: listId, created, matched, skipped });
    },
  );

  return app;
}
