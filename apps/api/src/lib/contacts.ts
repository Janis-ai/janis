import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contactIdentities, contacts, conversations } from '../db/schema.js';
import type { UserProfile } from '@janis/shared';

type Profile = UserProfile & { picture_url?: string };

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
async function enrichContact(db: Db, contactId: string, profile: Profile): Promise<void> {
  const email = profile.email?.trim().toLowerCase();
  const phone = profile.phone?.trim();
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
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
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
