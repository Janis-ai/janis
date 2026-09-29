import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, contactIdentities, contacts, conversations } from '../db/schema.js';
import { sessionAuth, adminOnly, type SessionEnv } from '../middleware/sessionAuth.js';
import { audit } from '../lib/audit.js';

/**
 * Unified customer records. A contact collects every channel identity
 * (Messenger PSID, SMS/WhatsApp number, email, webchat visitor) that resolves
 * to the same person; conversations link via contact_id so the inbox answers
 * "has this person talked to us before" across channels.
 */
export function contactRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  const toContact = (r: typeof contacts.$inferSelect, counts?: { identities: number; conversations: number }) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    avatar_url: null as string | null, // raw CDN urls stay server-side
    has_avatar: Boolean(r.avatarUrl),
    notes: r.notes,
    identities: counts?.identities,
    conversations: counts?.conversations,
    created_at: r.createdAt.toISOString(),
  });

  // GET /api/contacts?q= — search name/email/phone, newest activity first
  app.get('/', async (c) => {
    const workspaceId = c.get('workspaceId');
    const q = c.req.query('q')?.trim();
    const rows = await db
      .select({
        contact: contacts,
        convCount: sql<number>`count(distinct ${conversations.id})::int`,
        lastMessageAt: sql<Date | null>`max(${conversations.lastMessageAt})`,
      })
      .from(contacts)
      .leftJoin(conversations, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(contacts.workspaceId, workspaceId),
          q
            ? or(
                sql`${contacts.name} ilike ${'%' + q + '%'}`,
                sql`${contacts.email} ilike ${'%' + q + '%'}`,
                sql`${contacts.phone} ilike ${'%' + q + '%'}`,
              )
            : undefined,
        ),
      )
      .groupBy(contacts.id)
      .orderBy(sql`max(${conversations.lastMessageAt}) desc nulls last`, desc(contacts.createdAt))
      .limit(100);
    const identityCounts = rows.length
      ? await db
          .select({ contactId: contactIdentities.contactId, n: sql<number>`count(*)::int` })
          .from(contactIdentities)
          .where(inArray(contactIdentities.contactId, rows.map((r) => r.contact.id)))
          .groupBy(contactIdentities.contactId)
      : [];
    const idCount = new Map(identityCounts.map((r) => [r.contactId, r.n]));
    return c.json({
      contacts: rows.map((r) => ({
        ...toContact(r.contact, { identities: idCount.get(r.contact.id) ?? 0, conversations: r.convCount }),
        last_message_at: r.lastMessageAt?.toISOString() ?? null,
      })),
    });
  });

  // GET /api/contacts/:id — contact + identities + conversation history
  app.get('/:id', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, c.req.param('id')), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!contact) return c.json({ error: 'not found' }, 404);

    const [identities, convs] = await Promise.all([
      db
        .select({
          id: contactIdentities.id,
          platformUserId: contactIdentities.platformUserId,
          channelId: contactIdentities.channelId,
          channelKind: channels.kind,
          channelName: channels.name,
        })
        .from(contactIdentities)
        .innerJoin(channels, eq(contactIdentities.channelId, channels.id))
        .where(eq(contactIdentities.contactId, contact.id)),
      db
        .select({
          id: conversations.id,
          state: conversations.state,
          agentName: agents.name,
          lastMessageAt: conversations.lastMessageAt,
          lastMessagePreview: conversations.lastMessagePreview,
        })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(eq(conversations.contactId, contact.id))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(50),
    ]);

    // Possible duplicates — same email or phone on another workspace contact.
    const dupes = await db
      .select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, workspaceId),
          ne(contacts.id, contact.id),
          or(
            contact.email ? sql`lower(${contacts.email}) = lower(${contact.email})` : undefined,
            contact.phone ? eq(contacts.phone, contact.phone) : undefined,
          ),
        ),
      )
      .limit(10);

    return c.json({
      contact: toContact(contact),
      identities: identities.map((i) => ({
        id: i.id,
        platform_user_id: i.platformUserId,
        channel_id: i.channelId,
        channel_kind: i.channelKind,
        channel_name: i.channelName,
      })),
      conversations: convs.map((v) => ({
        id: v.id,
        state: v.state,
        agent_name: v.agentName,
        last_message_at: v.lastMessageAt?.toISOString() ?? null,
        last_message_preview: v.lastMessagePreview,
      })),
      possible_duplicates: dupes.map((d) => ({
        id: d.id,
        name: d.name,
        email: d.email,
        phone: d.phone,
      })),
    });
  });

  // PATCH /api/contacts/:id — edit name/email/phone/notes
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().max(200).nullable().optional(),
        email: z.string().email().max(320).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        notes: z.string().max(10_000).nullable().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.email !== undefined) patch.email = body.email?.toLowerCase() ?? null;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.notes !== undefined) patch.notes = body.notes;
      const [row] = await db
        .update(contacts)
        .set(patch)
        .where(and(eq(contacts.id, c.req.param('id')), eq(contacts.workspaceId, c.get('workspaceId'))))
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ contact: toContact(row) });
    },
  );

  // POST /api/contacts/:id/merge {other_id} — fold the other contact into this
  // one: identities + conversations re-point, empty fields fill, other row
  // goes away. Admin-only — it rewrites customer history.
  app.post(
    '/:id/merge',
    adminOnly,
    zValidator('json', z.object({ other_id: z.string().uuid() })),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const keepId = c.req.param('id');
      const { other_id: dropId } = c.req.valid('json');
      if (keepId === dropId) return c.json({ error: 'same contact' }, 400);

      const [keep, drop] = await Promise.all([
        db
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, keepId), eq(contacts.workspaceId, workspaceId)))
          .limit(1),
        db
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, dropId), eq(contacts.workspaceId, workspaceId)))
          .limit(1),
      ]);
      if (!keep[0] || !drop[0]) return c.json({ error: 'not found' }, 404);

      // Identity rows that would collide on (channel, platform_user_id) can
      // only exist if the same identity was attached to both — just delete
      // the duplicate's copies before re-pointing the rest.
      await db.execute(sql`
        delete from contact_identities d
        using contact_identities k
        where d.contact_id = ${dropId}
          and k.contact_id = ${keepId}
          and k.channel_id = d.channel_id
          and k.platform_user_id = d.platform_user_id
      `);
      await db
        .update(contactIdentities)
        .set({ contactId: keepId })
        .where(eq(contactIdentities.contactId, dropId));
      await db
        .update(conversations)
        .set({ contactId: keepId })
        .where(eq(conversations.contactId, dropId));
      const d = drop[0];
      const k = keep[0];
      await db
        .update(contacts)
        .set({
          name: k.name ?? d.name,
          email: k.email ?? d.email,
          phone: k.phone ?? d.phone,
          avatarUrl: k.avatarUrl ?? d.avatarUrl,
          notes: [k.notes, d.notes].filter(Boolean).join('\n') || null,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, keepId));
      await db.delete(contacts).where(eq(contacts.id, dropId));

      await audit(db, {
        workspaceId,
        userId: c.get('user').id,
        userName: c.get('user').name,
        action: 'contact.merge',
        targetType: 'contact',
        targetId: keepId,
        meta: { merged_id: dropId },
      });
      return c.json({ ok: true, contact_id: keepId });
    },
  );

  return app;
}
