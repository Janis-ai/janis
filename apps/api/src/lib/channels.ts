import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { channelBindings, channels } from '../db/schema.js';
import { env } from '../env.js';

type ChannelRow = typeof channels.$inferSelect;

export interface ChannelCredentials {
  via?: 'oauth' | 'manual'; // how the channel was created
  page_id?: string; // messenger / instagram
  phone_number_id?: string; // whatsapp
  username?: string; // instagram @handle — for ig.me links
  phone_number?: string; // whatsapp display number (digits only) — for wa.me links
  access_token?: string;
  verify_token?: string;
  greeting?: string; // webchat: first message the widget shows
  accent?: string; // webchat: widget accent color
  title?: string; // webchat: header title (falls back to channel name)
  subtitle?: string; // webchat: header subtext (falls back to agent name)
  position?: 'left' | 'right'; // webchat: which corner the launcher sits in
  logo_url?: string; // webchat: header/bubble logo image
  quick_replies?: string[]; // tappable prompts — webchat chips; reply buttons on Meta greetings
}

export interface AttachmentRef {
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface InboundMessage {
  /** page_id (messenger/ig) or phone_number_id (whatsapp) — identifies the channel */
  objectId: string;
  /** platform user id: PSID or phone number */
  senderId: string;
  text: string;
  /** platform message id (mid / wamid) — dedups the same event arriving via webhook + relay */
  messageId?: string;
  name?: string;
  attachments?: AttachmentRef[];
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

/** Meta attachment type → a mime-like type the UI can dispatch on. */
function metaMime(type: string | undefined): string {
  switch (type) {
    case 'image': return 'image/jpeg';
    case 'video': return 'video/mp4';
    case 'audio': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

/** Human label for an attachment: filename from the URL if it has one, else the type. */
function attachmentName(url: string, type: string | undefined): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (/^[\w.\- ()[\]]{1,80}\.[A-Za-z0-9]{2,8}$/.test(base)) return base;
  } catch {}
  const label = (type ?? 'file').replace(/_/g, ' ');
  return label[0].toUpperCase() + label.slice(1);
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
      const sender = (m.sender as { id?: string })?.id;
      if (!sender) continue;
      const objectId = String((m.recipient as { id?: string })?.id ?? entry.id ?? '');

      // Get Started taps, persistent-menu items and button postbacks arrive
      // as messaging_postbacks, not message events — surface the tapped
      // title as ordinary inbound text so it opens the conversation.
      const postback = m.postback as
        | { title?: string; payload?: string; mid?: string }
        | undefined;
      if (postback) {
        out.push({
          objectId,
          senderId: sender,
          text: postback.title ?? postback.payload ?? 'Get Started',
          messageId: postback.mid,
        });
        continue;
      }

      const msg = m.message as
        | {
            text?: string;
            is_echo?: boolean;
            mid?: string;
            attachments?: { type?: string; payload?: { url?: string } }[];
          }
        | undefined;
      if (!msg || msg.is_echo) continue;
      const attachments = (msg.attachments ?? [])
        .filter((a): a is { type?: string; payload: { url: string } } => !!a.payload?.url)
        .map((a) => ({
          name: attachmentName(a.payload.url, a.type),
          url: a.payload.url,
          type: metaMime(a.type),
          size: 0,
        }));
      if (!msg.text && attachments.length === 0) continue;
      out.push({
        objectId,
        senderId: sender,
        text: msg.text ?? '',
        messageId: msg.mid,
        ...(attachments.length ? { attachments } : {}),
      });
    }

    // WhatsApp Business Cloud API
    const changes = (entry.changes ?? []) as Record<string, unknown>[];
    for (const ch of changes) {
      const value = ch.value as
        | {
            metadata?: { phone_number_id?: string };
            messages?: ({
              id?: string;
              from?: string;
              type?: string;
              text?: { body?: string };
            } & Record<string, unknown>)[];
            contacts?: { wa_id?: string; profile?: { name?: string } }[];
          }
        | undefined;
      if (!value?.messages) continue;
      const phoneId = value.metadata?.phone_number_id ?? '';
      // Media types arrive as wm[type] = {id, mime_type, caption?, filename?}.
      // The media id must be resolved + downloaded via the Graph API with the
      // channel token — the wa-media: sentinel is swapped for a durable
      // /uploads/* URL at ingest (rehostAttachments).
      const WA_MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker']);
      for (const wm of value.messages) {
        if (!wm.from || !wm.type) continue;
        const contact = value.contacts?.find((ct) => ct.wa_id === wm.from);
        const base = {
          objectId: phoneId,
          senderId: wm.from,
          messageId: wm.id,
          name: contact?.profile?.name,
        };
        if (wm.type === 'text') {
          if (!wm.text?.body) continue;
          out.push({ ...base, text: wm.text.body });
          continue;
        }
        // Interactive reply buttons/lists — a tap returns the button title.
        if (wm.type === 'interactive') {
          const r = wm.interactive as
            | { button_reply?: { title?: string }; list_reply?: { title?: string } }
            | undefined;
          const text = r?.button_reply?.title ?? r?.list_reply?.title;
          if (text) out.push({ ...base, text });
          continue;
        }
        if (!WA_MEDIA.has(wm.type)) continue;
        const media = wm[wm.type] as
          | { id?: string; mime_type?: string; caption?: string; filename?: string }
          | undefined;
        if (!media?.id) continue;
        const type = media.mime_type ?? 'application/octet-stream';
        const name = media.filename ?? media.caption ?? attachmentName('', wm.type);
        out.push({
          ...base,
          text: media.caption ?? '',
          attachments: [{ name, url: `wa-media:${media.id}`, type, size: 0 }],
        });
      }
    }
  }
  return out;
}

/**
 * Map our mime-ish attachment type to a platform media kind.
 * Messenger/IG accept image|video|audio|file; WhatsApp image|video|audio|document.
 */
function mediaKind(type: string, whatsapp: boolean): string {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return whatsapp ? 'document' : 'file';
}

/** Absolute URL for a stored attachment — Meta fetches media links server-side. */
function absoluteAttachmentUrl(ref: AttachmentRef): string {
  return ref.url.startsWith('http') ? ref.url : `${env.apiOrigin}${ref.url}`;
}

export interface SendOptions {
  /** Suggested replies — tappable buttons on Messenger/IG quick replies and
   * WhatsApp interactive buttons. 20-char titles; WhatsApp shows max 3. */
  quickReplies?: string[];
}

/** Send a message (text and/or attachments) to a platform user through the channel's credentials. */
export async function sendChannelMessage(
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments?: AttachmentRef[],
  opts?: SendOptions,
): Promise<boolean> {
  // webchat has no push channel — the widget polls for new messages
  if (channel.kind === 'webchat') return true;
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) return false;
  const atts = attachments ?? [];
  const qrs = (opts?.quickReplies ?? []).map((t) => t.trim().slice(0, 20)).filter(Boolean);
  try {
    if (channel.kind === 'whatsapp') {
      const send = async (body: unknown) => {
        const res = await fetch(`${GRAPH}/${creds.phone_number_id}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        return res.ok;
      };
      let ok = true;
      if (text.trim()) {
        const buttons = qrs.slice(0, 3).map((title, i) => ({
          type: 'reply',
          reply: { id: `qr_${i}`, title },
        }));
        ok = await send(
          buttons.length
            ? {
                messaging_product: 'whatsapp',
                to: platformUserId,
                type: 'interactive',
                interactive: { type: 'button', body: { text }, action: { buttons } },
              }
            : { messaging_product: 'whatsapp', to: platformUserId, type: 'text', text: { body: text } },
        );
      }
      for (const a of atts) {
        const kind = mediaKind(a.type, true);
        ok = (await send({
          messaging_product: 'whatsapp',
          to: platformUserId,
          type: kind,
          [kind]: {
            link: absoluteAttachmentUrl(a),
            ...(kind === 'document' ? { filename: a.name } : {}),
          },
        })) && ok;
      }
      return ok;
    }
    // messenger / instagram — page access token
    const send = async (message: unknown) => {
      const res = await fetch(`${GRAPH}/me/messages?access_token=${creds.access_token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: platformUserId }, message }),
      });
      return res.ok;
    };
    let ok = true;
    if (text.trim()) {
      ok = await send(
        qrs.length
          ? {
              text,
              quick_replies: qrs.slice(0, 13).map((title) => ({
                content_type: 'text',
                title,
                payload: title,
              })),
            }
          : { text },
      );
    }
    for (const a of atts) {
      ok = (await send({
        attachment: {
          type: mediaKind(a.type, false),
          payload: { url: absoluteAttachmentUrl(a), is_reusable: true },
        },
      })) && ok;
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Show a typing indicator on Messenger/Instagram while the agent works.
 * Meta clears it automatically on the next message or after ~20s.
 * WhatsApp's Cloud API and the webchat widget have their own mechanisms.
 */
export async function sendChannelTyping(channel: ChannelRow, platformUserId: string): Promise<void> {
  if (channel.kind !== 'messenger' && channel.kind !== 'instagram') return;
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) return;
  try {
    await fetch(`${GRAPH}/me/messages?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: platformUserId },
        sender_action: 'typing_on',
      }),
    });
  } catch {}
}

/** Deliver a message (text and/or attachments) to the end user if the conversation is bound to a hosted channel. */
export async function deliverToChannel(
  db: Db,
  conversationId: string,
  text: string,
  attachments?: AttachmentRef[],
  opts?: SendOptions,
): Promise<void> {
  const [row] = await db
    .select({ binding: channelBindings, channel: channels })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  if (!row || (!text.trim() && !attachments?.length)) return;
  await sendChannelMessage(row.channel, row.binding.platformUserId, text, attachments, opts).catch(() => {});
}

/** Find a channel by the webhook's object id (page_id or phone_number_id). */
export async function findChannelByObjectId(db: Db, objectId: string) {
  const all = await db.select().from(channels);
  return all.find((ch) => {
    const c = ch.credentials as ChannelCredentials;
    return c.page_id === objectId || c.phone_number_id === objectId;
  });
}

/**
 * Enable the page's Get Started button so new visitors get a tap-to-start
 * instead of a blank thread. The tap arrives as a messaging_postback, which
 * opens the conversation → the agent's greeting fires. The messenger profile
 * lives on the Page id; for Instagram it's set on the IG business account id.
 */
export async function setGetStartedButton(
  kind: string,
  creds: ChannelCredentials,
): Promise<void> {
  if ((kind !== 'messenger' && kind !== 'instagram') || !creds.access_token) return;
  const object = kind === 'instagram' ? creds.page_id : 'me';
  if (!object) return;
  await fetch(`${GRAPH}/${object}/messenger_profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      get_started: { payload: 'JANIS_GET_STARTED' },
      greeting: [{ locale: 'default', text: 'Tap Get Started to chat with us.' }],
    }),
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
