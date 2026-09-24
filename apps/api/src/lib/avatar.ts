import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channelBindings, channels, conversations } from '../db/schema.js';
import { fetchPlatformProfile } from './channels.js';
import { getUpload } from './uploads.js';

type ConversationRow = typeof conversations.$inferSelect;

// Slack fetches icon_url per message at ingest time with a short fuse —
// without a cache, 20 seeded messages = 20 upstream Meta fetches and the
// icon silently falls back to the default. Single instance (max-instances
// 1), so an in-process TTL cache is enough.
const cache = new Map<string, { bytes: ArrayBuffer; type: string; exp: number }>();
const TTL_MS = 10 * 60_000;

/** Fetch the conversation's profile picture. Meta CDN urls are signed and
 * expire — on a dead link we re-resolve via the Graph API and persist the
 * fresh url. Returns bytes+content type, or null when unavailable. */
export async function fetchAvatar(
  db: Db,
  conv: ConversationRow,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const hit = cache.get(conv.id);
  if (hit && hit.exp > Date.now()) return { bytes: hit.bytes, type: hit.type };

  const profile = (conv.userProfile ?? {}) as { picture_url?: string; id?: string };
  if (!profile.picture_url) return null;

  // Janis-local avatars (a signed-in user's /uploads/ image on a webchat
  // thread) live in the uploads table — serve the row, not an HTTP self-call.
  if (profile.picture_url.startsWith('/uploads/')) {
    const row = await getUpload(db, profile.picture_url.slice('/uploads/'.length));
    if (!row) return null;
    const bytes = row.data.buffer.slice(
      row.data.byteOffset,
      row.data.byteOffset + row.data.byteLength,
    ) as ArrayBuffer;
    cache.set(conv.id, { bytes, type: row.type, exp: Date.now() + TTL_MS });
    return { bytes, type: row.type };
  }

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

  if (!res?.ok) return null;
  const bytes = await res.arrayBuffer();
  const type = res.headers.get('content-type') ?? 'image/jpeg';
  cache.set(conv.id, { bytes, type, exp: Date.now() + TTL_MS });
  return { bytes, type };
}
