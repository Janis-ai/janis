import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import { env } from '../env.js';
import { emitChatResponse } from './legacySocket.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';

type ChannelRow = typeof channels.$inferSelect;

export interface ChannelCredentials {
  via?: 'oauth' | 'manual' | 'legacy'; // how the channel was created
  page_id?: string; // messenger / instagram
  // migrated legacy bots: a page-inbox human reply (standby echo) pauses the
  // bot; the pause lapses after takeover_timeout minutes (legacy ~5)
  takeover_from_page_inbox?: boolean;
  takeover_timeout?: number;
  // legacy bots: Meta app id to pass thread control to ("stop chat" trigger)
  secondary_receiver_id?: string;
  // legacy ManyChat bots: bearer token for api.manychat.com sends
  manychat_token?: string;
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
  // webchat: HMAC-SHA256 key for host-signed identity assertions — when set,
  // a `sig` on the widget's user payload proves the host vouched for it
  identity_secret?: string;
  // webchat: legacy flag — operator identity is now governed by each
  // operator's show_identity profile setting; this field is ignored
  show_operator?: boolean;
  // webchat: console test-chat channel — works through the real /chat
  // pipeline but is hidden from the Integrations channel list
  internal?: boolean;
  // messenger: cached Meta Persona ids per operator user id — recreated
  // when the operator's display name or avatar changes
  personas?: Record<string, { id: string; name: string; avatar: string }>;
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
  /** Event arrived on Meta's `standby` feed — another app is the thread's
   *  primary receiver (handover protocol), so this app cannot send until it
   *  takes thread control. */
  standby?: boolean;
  /** Event was a Meta postback — a Get Started/menu/button tap rather than
   *  typed text. New conversations opened this way get the greeting as the
   *  opener; typed first messages go straight to the agent's answer. */
  postback?: boolean;
  name?: string;
  /** Identity asserted by the embedding host (webchat): session-authenticated
   *  or HMAC-signed payloads carry verified=true; anything else is a claim.
   *  `via` marks where the identity came from. `janisUser` is set when a
   *  verified claim's id is a real Janis user — those re-key the conversation
   *  onto the user exactly like a session identity does. */
  user?: {
    id?: string;
    name?: string;
    email?: string;
    verified?: boolean;
    via?: 'session' | 'claim';
    janisUser?: boolean;
    /** Janis-local avatar path (/uploads/…) when the identity resolves to a
     *  real Janis user — becomes the conversation's picture_url. */
    avatarUrl?: string;
  };
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
    // Messenger / Instagram — `messaging` when this app owns the thread,
    // `standby` when another app is the primary receiver (handover
    // protocol): same event shape, flagged so the route can pull thread
    // control before replying.
    const feed = [
      ...((entry.messaging ?? []) as Record<string, unknown>[]).map((m) => ({
        m,
        standby: false,
      })),
      ...((entry.standby ?? []) as Record<string, unknown>[]).map((m) => ({
        m,
        standby: true,
      })),
    ];
    for (const { m, standby } of feed) {
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
          postback: true,
          ...(standby ? { standby } : {}),
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
        ...(standby ? { standby } : {}),
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

/** Result of a push-channel send attempt. `mid` is the platform message id
 *  when the channel accepted it; `error` is the operator-readable failure
 *  when the channel rejected it. A null result from sendChannelMessage means
 *  the channel has no push at all (webchat — the widget polls). */
export interface SendResult {
  mid: string | null;
  error: string | null;
  /** false when retrying deterministically re-fails — a closed 24h window or
   *  a dead token won't fix itself until the underlying state changes */
  retryable: boolean;
}

/** Format a Meta Graph API error body for operators, and classify whether a
 *  retry can succeed. Adds a hint when the failure is the closed 24-hour
 *  messaging window — the common case: Messenger code 10/subcode 2018278, or
 *  551 "person isn't available"; WhatsApp 131047 "re-engagement required" /
 *  131026 undeliverable. Auth/permission errors (190, 200-range) are
 *  permanent until the channel is reconnected; rate limits and 5xx are
 *  retryable. */
function metaError(data: unknown, status: number): { text: string; retryable: boolean } {
  const e = (data as
    | { error?: { message?: string; code?: number; error_subcode?: number } }
    | null)?.error;
  if (!e?.message) {
    return { text: `Meta rejected the send (HTTP ${status})`, retryable: status >= 500 };
  }
  const code = e.code ?? 0;
  const sub = e.error_subcode ? `/${e.error_subcode}` : '';
  const windowClosed =
    code === 551 ||
    code === 131047 ||
    code === 131026 ||
    e.error_subcode === 2018278 ||
    e.error_subcode === 2018001;
  const permanent =
    windowClosed ||
    code === 190 || // access token expired/invalid
    code === 10 || // permission denied — covers the subcode'd window error too
    (code >= 200 && code < 300);
  return {
    text:
      `Meta rejected the send (error ${code || status}${sub}): ${e.message}` +
      (windowClosed
        ? ' — the 24-hour messaging window has likely closed; the customer must message again first (on WhatsApp, send an approved template)'
        : ''),
    retryable: !permanent,
  };
}

export interface SendOptions {
  /** Suggested replies — tappable buttons on Messenger/IG quick replies and
   * WhatsApp interactive buttons. 20-char titles; WhatsApp shows max 3. */
  quickReplies?: string[];
  /** Message row to stamp with Meta's message_id after a successful send —
   * lets the webhook echo of our own delivery be deduped by mid. */
  messageId?: string;
  /** Operator display name prefixed on human replies for text-only channels
   * ("*Bob:* hi" on WhatsApp). On Messenger it names the Persona instead. */
  senderName?: string;
  /** Operator user id — Messenger resolves/caches a Persona per operator. */
  senderId?: string;
  /** Operator avatar — Personas require a profile picture URL; without one
   * the message falls back to the inline name prefix. */
  senderAvatar?: string | null;
}

/** Send a message (text and/or attachments) to a platform user through the channel's credentials. */
/** Resolve the operator's Messenger Persona — reuse the cached id while the
 * name/avatar match, otherwise create a fresh one and persist it on the
 * channel credentials. Returns null when no avatar exists (Personas require
 * a profile picture) or Meta refuses — callers fall back to a text prefix. */
async function resolvePersona(
  db: Db,
  channel: ChannelRow,
  creds: ChannelCredentials,
  opts: SendOptions,
): Promise<string | null> {
  const key = opts.senderId!;
  const name = opts.senderName!.slice(0, 50);
  const avatar = opts.senderAvatar
    ? opts.senderAvatar.startsWith('http')
      ? opts.senderAvatar
      : `${env.apiOrigin}${opts.senderAvatar}`
    : null;
  if (!avatar) return null;
  const cached = creds.personas?.[key];
  if (cached && cached.name === name && cached.avatar === avatar) return cached.id;
  try {
    const res = await fetch(`${GRAPH}/me/personas?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, profile_picture_url: avatar }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!res.ok || !data?.id) return cached?.id ?? null;
    const personas = { ...(creds.personas ?? {}), [key]: { id: data.id, name, avatar } };
    creds.personas = personas;
    await db
      .update(channels)
      .set({ credentials: { ...creds } })
      .where(eq(channels.id, channel.id))
      .catch(() => {});
    return data.id;
  } catch {
    return cached?.id ?? null;
  }
}

export async function sendChannelMessage(
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments?: AttachmentRef[],
  opts?: SendOptions,
  db?: Db,
): Promise<SendResult | null> {
  // webchat has no push channel — the widget polls for new messages
  if (channel.kind === 'webchat') return null;
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) {
    return {
      mid: null,
      error: 'channel has no access token — reconnect it under Integrations',
      retryable: false,
    };
  }
  const atts = attachments ?? [];
  // Operator attribution on human replies — Meta renders the sender as the
  // page/business, so the name goes inline in the text instead.
  const named =
    opts?.senderName && text.trim()
      ? channel.kind === 'whatsapp'
        ? `*${opts.senderName}:* ${text}`
        : `${opts.senderName}: ${text}`
      : text;
  const qrs = (opts?.quickReplies ?? []).map((t) => t.trim().slice(0, 20)).filter(Boolean);
  if (channel.kind === 'whatsapp') {
    const send = async (body: unknown): Promise<SendResult> => {
      try {
        const res = await fetch(`${GRAPH}/${creds.phone_number_id}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await res.json().catch(() => null)) as
          | { messages?: { id?: string }[] }
          | null;
        if (!res.ok) {
          const e = metaError(data, res.status);
          return { mid: null, error: e.text, retryable: e.retryable };
        }
        return { mid: data?.messages?.[0]?.id ?? null, error: null, retryable: true };
      } catch (e) {
        return {
          mid: null,
          error: `WhatsApp send failed: ${e instanceof Error ? e.message : e}`,
          retryable: true,
        };
      }
    };
    let mid: string | null = null;
    let error: string | null = null;
    let retryable = true;
    if (named.trim()) {
      const buttons = qrs.slice(0, 3).map((title, i) => ({
        type: 'reply',
        reply: { id: `qr_${i}`, title },
      }));
      const r = await send(
        buttons.length
          ? {
              messaging_product: 'whatsapp',
              to: platformUserId,
              type: 'interactive',
              interactive: { type: 'button', body: { text: named }, action: { buttons } },
            }
          : { messaging_product: 'whatsapp', to: platformUserId, type: 'text', text: { body: named } },
      );
      mid = r.mid ?? mid;
      if (r.error && !error) {
        error = r.error;
        retryable = r.retryable;
      }
    }
    for (const a of atts) {
      const kind = mediaKind(a.type, true);
      const r = await send({
        messaging_product: 'whatsapp',
        to: platformUserId,
        type: kind,
        [kind]: {
          link: absoluteAttachmentUrl(a),
          ...(kind === 'document' ? { filename: a.name } : {}),
        },
      });
      mid = r.mid ?? mid;
      if (r.error && !error) {
        error = r.error;
        retryable = r.retryable;
      }
    }
    return { mid, error, retryable };
  }
  // messenger / instagram — page access token. Meta echoes our sends back
  // as webhook events; the returned message_id is stamped on the stored
  // row so midSeen can recognise the echo.
  // Messenger renders real per-message identity via Personas (name + avatar
  // annotate the bubble); Instagram/WhatsApp keep the inline name prefix.
  let personaId =
    channel.kind === 'messenger' && db && opts?.senderId && opts?.senderName
      ? await resolvePersona(db, channel, creds, opts)
      : null;
  const send = async (message: unknown): Promise<SendResult> => {
    try {
      const res = await fetch(`${GRAPH}/me/messages?access_token=${creds.access_token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: platformUserId },
          message,
          ...(personaId ? { persona_id: personaId } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => null)) as { message_id?: string } | null;
      if (!res.ok) {
        const e = metaError(data, res.status);
        return { mid: null, error: e.text, retryable: e.retryable };
      }
      return { mid: data?.message_id ?? null, error: null, retryable: true };
    } catch (e) {
      return {
        mid: null,
        error: `Meta send failed: ${e instanceof Error ? e.message : e}`,
        retryable: true,
      };
    }
  };
  const textMessage = (body: string) =>
    qrs.length
      ? {
          text: body,
          quick_replies: qrs.slice(0, 13).map((title) => ({
            content_type: 'text',
            title,
            payload: title,
          })),
        }
      : { text: body };
  let mid: string | null = null;
  let error: string | null = null;
  let retryable = true;
  if (named.trim()) {
    // Always the prefixed text — Meta accepts persona_id but silently drops
    // persona rendering for a growing list of recipients/surfaces (admins
    // viewing the thread see plain page identity), so the inline name is the
    // only dependable attribution. persona_id still rides along when it
    // resolves — where it renders, the annotation backs the prefix.
    const r = await send(textMessage(named));
    if (!r.mid && personaId) {
      // persona deleted or rejected server-side — retry without it
      personaId = null;
      const retry = await send(textMessage(named));
      mid = retry.mid;
      const e = retry.error ?? r.error;
      if (e) {
        error = e;
        retryable = retry.error !== null ? retry.retryable : r.retryable;
      }
    } else {
      mid = r.mid;
      if (r.error) {
        error = r.error;
        retryable = r.retryable;
      }
    }
  }
  for (const a of atts) {
    const r = await send({
      attachment: {
        type: mediaKind(a.type, false),
        payload: { url: absoluteAttachmentUrl(a), is_reusable: true },
      },
    });
    mid = r.mid ?? mid;
    if (r.error && !error) {
      error = r.error;
      retryable = r.retryable;
    }
  }
  return { mid, error, retryable };
}

/** Channel binding for a conversation — channel row + the platform user id. */
export async function channelBindingFor(
  db: Db,
  conversationId: string,
): Promise<{ channel: ChannelRow; platformUserId: string } | undefined> {
  const [row] = await db
    .select({ binding: channelBindings, channel: channels })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  return row ? { channel: row.channel, platformUserId: row.binding.platformUserId } : undefined;
}

/** Meta handover protocol: pull the thread to this channel's app so it can send. */
export async function takeThreadControl(
  channel: ChannelRow,
  platformUserId: string,
): Promise<void> {
  if (channel.kind !== 'messenger' && channel.kind !== 'instagram') return;
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token) return;
  try {
    await fetch(`${GRAPH}/me/take_thread_control?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: platformUserId }, metadata: 'janis takeover' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

/** Meta handover protocol: hand the thread back to another receiver app. */
export async function passThreadControlTo(
  channel: ChannelRow,
  platformUserId: string,
  targetAppId: string,
): Promise<void> {
  if (channel.kind !== 'messenger' && channel.kind !== 'instagram') return;
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.access_token || !targetAppId) return;
  try {
    await fetch(`${GRAPH}/me/pass_thread_control?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: platformUserId },
        target_app_id: targetAppId,
        metadata: 'JANIS_SENDING_RESUME',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

/** Hand the thread back to the channel's configured secondary receiver, if any. */
export async function releaseThreadControl(channel: ChannelRow, platformUserId: string): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  if (creds.secondary_receiver_id) {
    await passThreadControlTo(channel, platformUserId, creds.secondary_receiver_id);
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

/** What the push channel did with a send attempt. `delivered` is true only
 *  when delivery is actually known — the platform returned a message id, the
 *  SDK socket acknowledged it, or the channel has no push (webchat polls, so
 *  storing the row IS the delivery). `error` carries the operator-readable
 *  failure (e.g. Meta's closed 24-hour window) for the console receipt. */
export interface ChannelDelivery {
  delivered: boolean;
  error?: string;
  /** false when retrying can't succeed until state changes (closed 24h
   *  window, dead token) — the console hides the retry affordance */
  retryable?: boolean;
}

/** Stamp the delivery outcome onto the stored message row and republish it
 *  so open console views update without waiting for a refetch. */
async function stampDelivery(
  db: Db,
  workspaceId: string | undefined,
  messageId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const [upd] = await db
    .update(messages)
    .set({ payload: sql`payload || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(messages.id, messageId))
    .returning()
    .catch(() => []);
  if (upd && workspaceId) {
    bus.publish(workspaceId, { type: 'message', data: toMessage(upd) });
  }
}

/** Deliver a message (text and/or attachments) to the end user if the conversation is bound to a hosted channel. */
export async function deliverToChannel(
  db: Db,
  conversationId: string,
  text: string,
  attachments?: AttachmentRef[],
  opts?: SendOptions,
): Promise<ChannelDelivery> {
  const [row] = await db
    .select({ binding: channelBindings, channel: channels, conv: conversations })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  if (!row || (!text.trim() && !attachments?.length)) return { delivered: true };
  // Self-hosted SDK bots receive operator/agent messages over their
  // registered socket — the channel binding is transcript bookkeeping only.
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, row.conv.agentId))
    .limit(1);
  if (agent && (await emitChatResponse(agent, row.binding.platformUserId, text))) {
    if (opts?.messageId) {
      await stampDelivery(db, agent.workspaceId, opts.messageId, { delivered: true });
    }
    return { delivered: true };
  }
  const result = await sendChannelMessage(row.channel, row.binding.platformUserId, text, attachments, opts, db).catch(
    (e) => ({ mid: null, error: `send failed: ${e instanceof Error ? e.message : e}`, retryable: true }),
  );
  // null = no push channel (webchat) — the widget pulls on its next poll.
  // Stamp it anyway so the transcript knows the message made it to the
  // channel — the console's "Delivered" receipt follows it regardless of
  // where the reply was sent from.
  if (!result) {
    if (opts?.messageId) {
      await stampDelivery(db, agent?.workspaceId, opts.messageId, { delivered: true });
    }
    return { delivered: true };
  }
  if (opts?.messageId) {
    const patch: Record<string, unknown> = {};
    if (result.mid) patch.mid = result.mid;
    if (result.error) {
      patch.delivery_error = result.error;
      patch.delivery_retryable = result.retryable;
    } else {
      patch.delivered = true; // channel accepted — clears a stale error on resend
      patch.delivery_error = null;
      patch.delivery_retryable = null;
    }
    await stampDelivery(db, agent?.workspaceId, opts.messageId, patch);
  }
  return result.error
    ? { delivered: false, error: result.error, retryable: result.retryable }
    : { delivered: true };
}

/**
 * Send a raw Messenger message object (legacy Dialogflow payload.facebook
 * passthrough — quick replies, cards, templates) to the conversation's user.
 * Returns false when the conversation isn't bound to a Meta channel.
 */
export async function sendRawFbMessage(
  db: Db,
  conversationId: string,
  message: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await db
    .select({ binding: channelBindings, channel: channels })
    .from(channelBindings)
    .innerJoin(channels, eq(channelBindings.channelId, channels.id))
    .where(eq(channelBindings.conversationId, conversationId))
    .limit(1);
  if (!row) return false;
  if (row.channel.kind !== 'messenger' && row.channel.kind !== 'instagram') return false;
  const creds = row.channel.credentials as ChannelCredentials;
  if (!creds.access_token) return false;
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${creds.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: row.binding.platformUserId }, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find a channel by the webhook's object id (page_id or phone_number_id). */
// Channel list cache — Meta fires a webhook per event per subscribed page,
// including thousands of dead legacy pages that will never resolve. A short
// TTL keeps new channels visible quickly while absorbing that noise.
let channelListCache: { at: number; rows: ChannelRow[] } | null = null;
const CHANNEL_CACHE_TTL_MS = 10_000;

export function invalidateChannelCache() {
  channelListCache = null;
}

export async function findChannelByObjectId(db: Db, objectId: string) {
  if (!channelListCache || Date.now() - channelListCache.at > CHANNEL_CACHE_TTL_MS) {
    channelListCache = { at: Date.now(), rows: await db.select().from(channels) };
  }
  return channelListCache.rows.find((ch) => {
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
