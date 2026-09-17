import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channelBindings, channels, conversations } from '../db/schema.js';
import { fetchPlatformProfile } from './channels.js';

type ConversationRow = typeof conversations.$inferSelect;

/** Fetch the conversation's profile picture. Meta CDN urls are signed and
 * expire — on a dead link we re-resolve via the Graph API and persist the
 * fresh url. Returns the upstream Response, or null when unavailable. */
export async function fetchAvatar(db: Db, conv: ConversationRow): Promise<Response | null> {
  const profile = (conv.userProfile ?? {}) as { picture_url?: string; id?: string };
  if (!profile.picture_url) return null;

  let res = await fetch(profile.picture_url, {
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (!res?.ok) {
    const [bound] = await db
      .select({ channel: channels })
      .from(channelBindings)
      .innerJoin(channels, eq(channelBindings.channelId, channels.id))
      .where(eq(channelBindings.conversationId, conv.id))
      .limit(1);
    if (bound && profile.id) {
      const fresh = await fetchPlatformProfile(bound.channel, profile.id);
      if (fresh.picture_url && fresh.picture_url !== profile.picture_url) {
        await db
          .update(conversations)
          .set({ userProfile: { ...profile, ...fresh } })
          .where(eq(conversations.id, conv.id));
        res = await fetch(fresh.picture_url, {
          signal: AbortSignal.timeout(8_000),
        }).catch(() => null);
      }
    }
  }

  return res?.ok ? res : null;
}
