import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  campaignSends,
  channelBindings,
  channels,
  contactIdentities,
  contactListMembers,
  contactLists,
  contacts,
  conversations,
  messages,
  slackThreads,
  suggestions,
  typingState,
  usageEvents,
  viewers,
} from '../db/schema.js';
import { sessionAuth, adminOnly, type SessionEnv } from '../middleware/sessionAuth.js';
import { audit } from '../lib/audit.js';
import { segmentConditions, type CampaignSegment } from '../lib/campaigns.js';

const boolParam = (v: string | undefined) =>
  v === '1' || v === 'true' ? true : undefined;
const intParam = (v: string | undefined) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

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
    alt_emails: r.altEmails,
    alt_phones: r.altPhones,
    tags: r.tags,
    external_ids: r.externalIds,
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
    // Filter params mirror CampaignSegment fields — the same rules a smart
    // list stores, so "save this view as a list" is lossless.
    const seg: CampaignSegment = {
      q: c.req.query('q')?.trim() || undefined,
      list_id: c.req.query('list_id') || undefined,
      channel_id: c.req.query('channel_id') || undefined,
      agent_id: c.req.query('agent_id') || undefined,
      tags: c.req.query('tag')?.split(',').map((t) => t.trim()).filter(Boolean),
      has_email: boolParam(c.req.query('has_email')),
      has_phone: boolParam(c.req.query('has_phone')),
      active_within_days: intParam(c.req.query('active_within_days')),
      never_replied: boolParam(c.req.query('never_replied')),
    };
    const conds = await segmentConditions(db, workspaceId, seg);
    const rows = await db
      .select({
        contact: contacts,
        convCount: sql<number>`count(distinct ${conversations.id})::int`,
        lastMessageAt: sql<Date | null>`max(${conversations.lastMessageAt})`,
      })
      .from(contacts)
      .leftJoin(conversations, eq(conversations.contactId, contacts.id))
      .where(and(...conds))
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
        // postgres-js returns aggregate timestamps as strings, PGlite as
        // Date — coerce rather than trusting the driver.
        last_message_at: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
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

    // Possible duplicates — same email, phone, or non-generic name on
    // another workspace contact. With no signals at all (e.g. a
    // Messenger-PSID-only contact), there are no candidates — never
    // return the whole workspace.
    const matchConds = [
      contact.email ? sql`lower(${contacts.email}) = lower(${contact.email})` : undefined,
      contact.phone ? eq(contacts.phone, contact.phone) : undefined,
      contact.name && !['unknown', ''].includes(contact.name.trim().toLowerCase())
        ? sql`lower(${contacts.name}) = lower(${contact.name})`
        : undefined,
    ];
    const dupes = matchConds.some(Boolean)
      ? await db
          .select({
            id: contacts.id,
            name: contacts.name,
            email: contacts.email,
            phone: contacts.phone,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              ne(contacts.id, contact.id),
              or(...matchConds.filter((x) => x !== undefined)),
            ),
          )
          .limit(10)
      : [];

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
        match:
          contact.email && d.email?.toLowerCase() === contact.email.toLowerCase()
            ? 'same email'
            : contact.phone && d.phone === contact.phone
              ? 'same phone'
              : 'same name',
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
        // Secondary addresses — replace whole arrays (UI edits the list).
        alt_emails: z.array(z.string().email().max(320)).max(20).optional(),
        alt_phones: z.array(z.string().max(40)).max(20).optional(),
        tags: z.array(z.string().min(1).max(80)).max(50).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.email !== undefined) patch.email = body.email?.toLowerCase() ?? null;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.alt_emails !== undefined) {
        patch.altEmails = body.alt_emails.map((e) => e.toLowerCase());
      }
      if (body.alt_phones !== undefined) patch.altPhones = body.alt_phones;
      if (body.tags !== undefined) {
        patch.tags = [...new Set(body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
      }
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
      await db
        .update(campaignSends)
        .set({ contactId: keepId })
        .where(eq(campaignSends.contactId, dropId));
      const d = drop[0];
      const k = keep[0];
      // Differing email/phone fold into the alt arrays — a person keeps
      // every address they've written from, not just the primary.
      const altEmails = new Set([...k.altEmails, ...d.altEmails]);
      const altPhones = new Set([...k.altPhones, ...d.altPhones]);
      const email = k.email ?? d.email;
      const phone = k.phone ?? d.phone;
      if (d.email && d.email !== email) altEmails.add(d.email);
      if (d.phone && d.phone !== phone) altPhones.add(d.phone);
      await db
        .update(contacts)
        .set({
          name: k.name ?? d.name,
          email,
          phone,
          altEmails: [...altEmails],
          altPhones: [...altPhones],
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
        // Record what the merge discarded — the losing email/phone/name are
        // otherwise unrecoverable once the row is gone.
        meta: {
          merged_id: dropId,
          discarded: {
            // name has no alt list — a differing dropped name is only
            // preserved here and in the merged notes trail.
            name: k.name && d.name && k.name !== d.name ? d.name : null,
          },
        },
      });
      return c.json({ ok: true, contact_id: keepId });
    },
  );

  // GET /api/contacts/:id/export — GDPR access: everything we hold on the
  // data subject, one JSON bundle. Admin-only.
  app.get('/:id/export', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, c.req.param('id')), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!contact) return c.json({ error: 'not found' }, 404);
    const [identities, convs, sends, memberships] = await Promise.all([
      db.select().from(contactIdentities).where(eq(contactIdentities.contactId, contact.id)),
      db
        .select()
        .from(conversations)
        .where(eq(conversations.contactId, contact.id))
        .limit(500),
      db.select().from(campaignSends).where(eq(campaignSends.contactId, contact.id)),
      db
        .select({ listId: contactListMembers.listId, name: contactLists.name })
        .from(contactListMembers)
        .innerJoin(contactLists, eq(contactListMembers.listId, contactLists.id))
        .where(eq(contactListMembers.contactId, contact.id)),
    ]);
    const msgs = convs.length
      ? await db
          .select()
          .from(messages)
          .where(inArray(messages.conversationId, convs.map((v) => v.id)))
          .orderBy(messages.createdAt)
      : [];
    const byConv = new Map<string, typeof msgs>();
    for (const m of msgs) {
      const list = byConv.get(m.conversationId) ?? [];
      list.push(m);
      byConv.set(m.conversationId, list);
    }
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'contact.export',
      targetType: 'contact',
      targetId: contact.id,
      meta: { conversations: convs.length },
    });
    c.header('content-disposition', `attachment; filename="contact-${contact.id}.json"`);
    return c.json({
      exported_at: new Date().toISOString(),
      contact,
      identities,
      lists: memberships,
      campaign_sends: sends,
      conversations: convs.map((v) => ({ ...v, messages: byConv.get(v.id) ?? [] })),
    });
  });

  // DELETE /api/contacts/:id — GDPR erasure. Default keeps the anonymized
  // conversation shells (agent analytics intact); ?mode=purge deletes the
  // conversations and their transcripts too. Billing rows (usage_events)
  // keep their record with the contact link scrubbed. Admin-only.
  app.delete('/:id', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const contactId = c.req.param('id');
    const purge = c.req.query('mode') === 'purge';
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!contact) return c.json({ error: 'not found' }, 404);

    const convRows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.contactId, contactId));
    const convIds = convRows.map((r) => r.id);

    if (purge && convIds.length) {
      // Financial records stay (legal retention) but lose the link.
      await db
        .update(usageEvents)
        .set({ conversationId: null })
        .where(inArray(usageEvents.conversationId, convIds));
      for (const t of [messages, alerts, suggestions, typingState, slackThreads] as const) {
        await db.delete(t).where(inArray(t.conversationId, convIds));
      }
      await db.delete(viewers).where(inArray(viewers.conversationId, convIds));
      await db.delete(channelBindings).where(inArray(channelBindings.conversationId, convIds));
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    } else {
      // Unlink, don't delete — the transcript survives without a person.
      await db
        .update(conversations)
        .set({ contactId: null })
        .where(eq(conversations.contactId, contactId));
    }
    await db.delete(campaignSends).where(eq(campaignSends.contactId, contactId));
    await db.delete(contactIdentities).where(eq(contactIdentities.contactId, contactId));
    await db.delete(contacts).where(eq(contacts.id, contactId));

    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'contact.delete',
      targetType: 'contact',
      targetId: contactId,
      meta: { mode: purge ? 'purge' : 'unlink', conversations: convIds.length },
    });
    return c.json({ ok: true, mode: purge ? 'purge' : 'unlink' });
  });

  return app;
}
