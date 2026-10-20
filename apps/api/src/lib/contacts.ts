import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  alerts,
  campaignSends,
  channelBindings,
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
import type { UserProfile } from '@janis/shared';

type Profile = UserProfile & {
  picture_url?: string;
  /** Host-asserted traits (the /v1 push) — merge into contact.metadata at
   *  the top level. `claimed` is a reserved namespace and gets stripped. */
  traits?: Record<string, unknown>;
  /** Visitor-stated facts (save_user_profile) — merge into
   *  contact.metadata.claimed, never the system-level keys. */
  facts?: Record<string, string>;
};

/**
 * Resolve the (channel, platformUserId) identity to a workspace contact.
 *
 * Order: exact identity → match an existing contact on email or phone
 * ("same person texted, then emailed") → create a fresh contact. Returns the
 * contact id, or null when nothing usable exists. Never throws — contact
 * resolution must not block message ingest.
 */
export async function contactForBinding(
  db: Db,
  input: {
    workspaceId: string;
    channelId: string;
    platformUserId: string;
    profile: Profile;
  },
): Promise<string | null> {
  try {
    const { workspaceId, channelId, platformUserId, profile } = input;

    const [identity] = await db
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.channelId, channelId),
          eq(contactIdentities.platformUserId, platformUserId),
        ),
      )
      .limit(1);
    if (identity) {
      await enrichContact(db, identity.contactId, profile);
      return identity.contactId;
    }

    // Email is a stronger signal than phone for cross-channel merge — check
    // it first. Both are normalized at write (email lowercased).
    const email = profile.email?.trim().toLowerCase();
    const phone = profile.phone?.trim();
    let contactId: string | undefined;
    if (email) {
      const [row] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            // primary or any merged-away secondary address
            sql`(lower(${contacts.email}) = ${email} or ${email} = any(${contacts.altEmails}))`,
          ),
        )
        .limit(1);
      contactId = row?.id;
    }
    if (!contactId && phone) {
      const [row] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            sql`(${contacts.phone} = ${phone} or ${phone} = any(${contacts.altPhones}))`,
          ),
        )
        .limit(1);
      contactId = row?.id;
    }

    if (contactId) {
      await enrichContact(db, contactId, profile);
    } else {
      const [created] = await db
        .insert(contacts)
        .values({
          workspaceId,
          name: profile.name ?? null,
          email: email ?? null,
          phone: phone ?? null,
          avatarUrl: profile.picture_url ?? null,
        })
        .returning({ id: contacts.id });
      contactId = created.id;
    }

    await db
      .insert(contactIdentities)
      .values({ contactId, channelId, platformUserId })
      .onConflictDoNothing();
    return contactId;
  } catch (err) {
    console.error('contactForBinding error:', err);
    return null;
  }
}

/** Fill contact fields the identity didn't previously know — never overwrites
 *  a value a human or an earlier channel set (coalesce(existing, new)).
 *  A differing email/phone isn't lost either — it lands in the alt arrays
 *  so a person can carry several addresses. */
export async function enrichContact(db: Db, contactId: string, profile: Profile): Promise<void> {
  const email = profile.email?.trim().toLowerCase();
  const phone = profile.phone?.trim();
  // `claimed` is the reserved visitor-claims namespace — a host-asserted
  // trait bag must not write into it from the top level.
  const { claimed: _reserved, ...traits } = profile.traits ?? {};
  await db
    .update(contacts)
    .set({
      ...(email ? { email: sql`coalesce(${contacts.email}, ${email})` } : {}),
      ...(phone ? { phone: sql`coalesce(${contacts.phone}, ${phone})` } : {}),
      ...(email
        ? {
            altEmails: sql`case when ${contacts.email} is not null and ${contacts.email} <> ${email} and not (${email} = any(${contacts.altEmails})) then array_append(${contacts.altEmails}, ${email}) else ${contacts.altEmails} end`,
          }
        : {}),
      ...(phone
        ? {
            altPhones: sql`case when ${contacts.phone} is not null and ${contacts.phone} <> ${phone} and not (${phone} = any(${contacts.altPhones})) then array_append(${contacts.altPhones}, ${phone}) else ${contacts.altPhones} end`,
          }
        : {}),
      ...(profile.name ? { name: sql`coalesce(${contacts.name}, ${profile.name})` } : {}),
      ...(profile.picture_url
        ? { avatarUrl: sql`coalesce(${contacts.avatarUrl}, ${profile.picture_url})` }
        : {}),
      ...(Object.keys(traits).length
        ? { metadata: sql`${contacts.metadata} || ${JSON.stringify(traits)}::jsonb` }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/** Visitor-claimed identifiers — save_user_profile and (host-asserted) the
 *  /v1 profile push. Writes onto the contact already bound to the
 *  conversation: the merge leg (contactForBinding matching claimed email
 *  into a DIFFERENT contact) deliberately never runs, so a stranger can't
 *  join someone else's record by typing their address. What does happen is
 *  the form-parity write — claimed fields fill the row's own columns, so a
 *  later VERIFIED inbound from that address merges naturally (the channel
 *  proves the claim for free). `claimed` tags the provenance: a claimed
 *  email is campaign-reachable like a form lead, but the tag lets audiences
 *  exclude it and tells operators the address was asserted, not verified. */
export async function enrichContactClaimed(
  db: Db,
  contactId: string,
  profile: Profile,
): Promise<void> {
  const { facts, ...fields } = profile;
  await enrichContact(db, contactId, fields);
  // Claimed facts merge into metadata.claimed — a jsonb path, not a merge
  // column, so keys can't collide with system-asserted traits.
  if (facts && Object.keys(facts).length) {
    await db
      .update(contacts)
      .set({
        metadata: sql`jsonb_set(${contacts.metadata}, '{claimed}', coalesce(${contacts.metadata}->'claimed', '{}'::jsonb) || ${JSON.stringify(facts)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, contactId));
  }
  if (profile.email?.trim() || profile.phone?.trim()) {
    await db
      .update(contacts)
      .set({
        tags: sql`case when not ('self-reported' = any(${contacts.tags})) then array_append(${contacts.tags}, 'self-reported') else ${contacts.tags} end`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, contactId));
  }
}

/** Find-or-create a contact by email/phone — the import path. Matches on
 *  primary OR alt addresses; on a hit the row's fields enrich (fill + alt
 *  fold) and tags union in. Returns the contact id and whether it was new. */
export async function upsertContactByAddress(
  db: Db,
  input: {
    workspaceId: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    /** External-system identity — {"system":"salesforce","id":"003abc"}.
     *  Matched first when present: CRM re-syncs stay idempotent even when
     *  the person's email/phone changes upstream. */
    external?: { system: string; id: string } | null;
    tags?: string[];
  },
): Promise<{ contactId: string; created: boolean }> {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const extSys = input.external?.system;
  const extId = input.external?.id;
  const matchConds = [
    extSys && extId
      ? sql`${contacts.externalIds}->>${extSys} = ${extId}`
      : undefined,
    email
      ? sql`(lower(${contacts.email}) = ${email} or ${email} = any(${contacts.altEmails}))`
      : undefined,
    phone
      ? sql`(${contacts.phone} = ${phone} or ${phone} = any(${contacts.altPhones}))`
      : undefined,
  ].filter((x): x is NonNullable<typeof x> => !!x);
  const [match] = matchConds.length
    ? await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, input.workspaceId), or(...matchConds)))
        .limit(1)
    : [undefined];

  let contactId: string;
  if (match) {
    contactId = match.id;
    await enrichContact(db, contactId, {
      email: email ?? undefined,
      phone: phone ?? undefined,
      name: input.name ?? undefined,
    });
    if (extSys && extId) {
      // || merges {sys:id} into the map — same-key overwrite is idempotent.
      await db
        .update(contacts)
        .set({
          externalIds: sql`${contacts.externalIds} || jsonb_build_object(${extSys}::text, ${extId}::text)`,
        })
        .where(eq(contacts.id, contactId));
    }
  } else {
    const [created] = await db
      .insert(contacts)
      .values({
        workspaceId: input.workspaceId,
        name: input.name ?? null,
        email,
        phone,
        tags: input.tags ?? [],
        externalIds: extSys && extId ? { [extSys]: extId } : {},
      })
      .returning({ id: contacts.id });
    contactId = created.id;
  }
  if (match && input.tags?.length) {
    // array[...] literal + sql.join — the plain array bind doesn't reach PG
    // as an array through the sql template.
    await db
      .update(contacts)
      .set({
        tags: sql`array(select distinct unnest(${contacts.tags} || array[${sql.join(
          input.tags.map((t) => sql`${t}`),
          sql`, `,
        )}]))`,
      })
      .where(eq(contacts.id, contactId));
  }
  return { contactId, created: !match };
}

/** Link (or re-link) a conversation to its resolved contact. */
export async function linkConversationContact(
  db: Db,
  conversationId: string,
  contactId: string | null,
): Promise<void> {
  if (!contactId) return;
  await db
    .update(conversations)
    .set({ contactId })
    .where(eq(conversations.id, conversationId));
}

/** GDPR erasure (purge mode) — delete the contact AND its threads:
 *  conversations, transcripts, identity joins, campaign sends. Financial
 *  usage rows keep their record with the conversation link scrubbed.
 *  Callers write their own audit row (the actor differs: console admin
 *  vs. a provider webhook). */
export async function purgeContactData(db: Db, contactId: string): Promise<void> {
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.contactId, contactId));
  const convIds = convRows.map((r) => r.id);
  if (convIds.length) {
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
  }
  await db.delete(campaignSends).where(eq(campaignSends.contactId, contactId));
  await db.delete(contactIdentities).where(eq(contactIdentities.contactId, contactId));
  await db.delete(contacts).where(eq(contacts.id, contactId));
}

/** GDPR access bundle — everything we hold on the data subject, one JSON
 *  object. Shared by the console export endpoint and the Shopify
 *  customers/data_request compliance webhook (which fulfils by email). */
export async function contactExportBundle(
  db: Db,
  contact: typeof contacts.$inferSelect,
): Promise<Record<string, unknown>> {
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
  return {
    exported_at: new Date().toISOString(),
    contact,
    identities,
    lists: memberships,
    campaign_sends: sends,
    conversations: convs.map((v) => ({ ...v, messages: byConv.get(v.id) ?? [] })),
  };
}
