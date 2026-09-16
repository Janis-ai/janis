import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { channelBindings, channels } from '../db/schema.js';

type ChannelRow = typeof channels.$inferSelect;

export interface ChannelCredentials {
  via?: 'oauth' | 'manual'; // how the channel was created
  page_id?: string; // messenger / instagram
  phone_number_id?: string; // whatsapp
  username?: string; // instagram @handle — for ig.me links
  phone_number?: string; // whatsapp display number (digits only) — for wa.me links
  access_token?: string;
  verify_token?: string;
}

export interface InboundMessage {
  /** page_id (messenger/ig) or phone_number_id (whatsapp) — identifies the channel */
  objectId: string;
  /** platform user id: PSID or phone number */
  senderId: string;
  text: string;
  name?: string;
}

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 of raw body with app secret). */
export function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signature: string | undefined,
): boolean {
  if (!appSecret) return true; // not configured — dev mode
  if (!signature?.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return (
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}

/**
 * Normalize a Meta webhook payload into inbound messages.
 * Handles Messenger + Instagram (entry[].messaging[]) and WhatsApp
 * (entry[].changes[].value.messages[]).
 */
export function parseMetaWebhook(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];

  for (const entry of entries as Record<string, unknown>[]) {
    // Messenger / Instagram
    const messaging = (entry.messaging ?? []) as Record<string, unknown>[];
    for (const m of messaging) {
      const msg = m.message as { text?: string; is_echo?: boolean } | undefined;
      const sender = (m.sender as { id?: string })?.id;
      if (!msg?.text || msg.is_echo || !sender) continue;
      out.push({
        objectId: String((m.recipient as { id?: string })?.id ?? entry.id ?? ''),
        senderId: sender,
        text: msg.text,
      });
    }

    // WhatsApp Business Cloud API
    const changes = (entry.changes ?? []) as Record<string, unknown>[];
    for (const ch of changes) {
      const value = ch.value as
        | {
            metadata?: { phone_number_id?: string };
            messages?: { from?: string; type?: string; text?: { body?: string } }[];
            contacts?: { wa_id?: string; profile?: { name?: string } }[];
          }
        | undefined;
      if (!value?.messages) continue;
      const phoneId = value.metadata?.phone_number_id ?? '';
      for (const wm of value.messages) {
        if (wm.type !== 'text' || !wm.text?.body || !wm.from) continue;
        const contact = value.contacts?.find((ct) => ct.wa_id === wm.from);
        out.push({
          objectId: phoneId,
          senderId: wm.from,
          text: wm.text.body,
          name: contact?.profile?.name,
        });
      }
    }
  }
  return out;
}

/** Send a text message to a platform user through the channel's credentials. */
export async function sendChannelMessage(
  channel: ChannelRow,
  platformUserId: string,
  text: string,
): Promise<boolean> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) return false;
  try {
    if (channel.kind === 'whatsapp') {
      const res = await fetch(`${GRAPH}/${creds.phone_number_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: platformUserId,
          type: 'text',
          text: { body: text },
        }),
      });
      return res.ok;
    }
    // messenger / instagram — page access token
    const res = await fetch(`${GRAPH}/me/messages?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: platformUserId },
        message: { text },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Deliver text to the end user if the conversation is bound to a hosted channel. */
export async function deliverToChannel(
  db: Db,
  conversationId: string,
  text: string,
): Promise<void> {
  const [row] = await db
    .select({ binding: channelBindings, channel: channels })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  if (!row || !text.trim()) return;
  await sendChannelMessage(row.channel, row.binding.platformUserId, text).catch(() => {});
}

/** Find a channel by the webhook's object id (page_id or phone_number_id). */
export async function findChannelByObjectId(db: Db, objectId: string) {
  const all = await db.select().from(channels);
  return all.find((ch) => {
    const c = ch.credentials as ChannelCredentials;
    return c.page_id === objectId || c.phone_number_id === objectId;
  });
}

/** URL where a customer can open a chat with this channel's identity. */
export function channelChatUrl(channel: ChannelRow): string | undefined {
  const c = channel.credentials as ChannelCredentials;
  if (channel.kind === 'messenger' && c.page_id) return `https://m.me/${c.page_id}`;
  if (channel.kind === 'instagram' && c.username) return `https://ig.me/m/${c.username}`;
  if (channel.kind === 'whatsapp' && c.phone_number) return `https://wa.me/${c.phone_number}`;
  return undefined;
}

/**
 * Best-effort end-user profile lookup on the Graph API. Meta never exposes
 * email; WhatsApp has no profile endpoint (name comes in the webhook), so it
 * returns {}. Failures return {} — never block message ingest on this.
 */
export async function fetchPlatformProfile(
  channel: ChannelRow,
  platformUserId: string,
): Promise<Partial<UserProfile>> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token || channel.kind === 'whatsapp') return {};
  const fields =
    channel.kind === 'instagram'
      ? 'name,username,profile_pic'
      : 'first_name,last_name,profile_pic';
  try {
    const res = await fetch(
      `${GRAPH}/${platformUserId}?fields=${fields}&access_token=${creds.access_token}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return {};
    const d = (await res.json()) as {
      name?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
      profile_pic?: string;
    };
    const name =
      d.name ?? ([d.first_name, d.last_name].filter(Boolean).join(' ') || undefined);
    return {
      name,
      first_name: d.first_name,
      last_name: d.last_name,
      username: d.username,
      picture_url: d.profile_pic,
      profile_fetched_at: new Date().toISOString(),
    };
  } catch {
    return {};
  }
}

/**
 * Backfill chat-link identifiers (IG username, WA display number) from the
 * Graph API for channels created before they were stored. Persists on success.
 */
export async function resolveChatIdentity(db: Db, channel: ChannelRow): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) return;
  let fields = '';
  if (channel.kind === 'instagram' && !creds.username) fields = 'username';
  if (channel.kind === 'whatsapp' && !creds.phone_number) fields = 'display_phone_number';
  if (!fields) return;
  const id = creds.page_id ?? creds.phone_number_id;
  if (!id) return;
  try {
    const res = await fetch(
      `${GRAPH}/${id}?fields=${fields}&access_token=${creds.access_token}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { username?: string; display_phone_number?: string };
    const next: ChannelCredentials = { ...creds };
    if (data.username) next.username = data.username;
    if (data.display_phone_number) {
      next.phone_number = data.display_phone_number.replace(/\D/g, '');
    }
    if (next.username === creds.username && next.phone_number === creds.phone_number) return;
    await db
      .update(channels)
      .set({ credentials: next })
      .where(eq(channels.id, channel.id));
    channel.credentials = next;
  } catch {
    // best-effort — link just won't render
  }
}
