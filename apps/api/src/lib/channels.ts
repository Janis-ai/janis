import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { QuickReply, UserProfile } from '@janis/shared';
import type { WidgetComponent } from './widgets.js';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import { env } from '../env.js';
import { emitChatResponse } from './legacySocket.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';
import {
  ensureAccessToken,
  sendMessage as sendGmailMessage,
} from './gmail.js';
import { voiceDeliver } from './voiceBridge.js';
import { sendSms, type TwilioError } from './twilio.js';

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
  logo_padding?: number; // webchat: px inset inside the header tile + launcher ring
  logo_radius?: number; // webchat: px corner radius of the header logo tile
  logo_border_width?: number; // webchat: px outline on the header logo tile
  logo_border_color?: string; // webchat: outline color (falls back to soft dark)
  quick_replies?: string[]; // tappable prompts — webchat chips; reply buttons on Meta greetings
  teaser_text?: string; // webchat: proactive teaser line by the launcher (falls back to greeting)
  proactive?: boolean; // webchat: show the teaser at all — default on
  proactive_delay?: number; // webchat: seconds before the teaser appears (default 20)
  sound?: boolean; // webchat: chime on a new reply while closed/hidden — default on
  theme?: 'light' | 'dark' | 'auto'; // webchat: widget color scheme — default light
  hide_powered_by?: boolean; // webchat: drop the footer — honored on paid plans only
  // webchat: show the "Browse help articles" link — default on; an agent-level
  // config.help_url still overrides where it points
  show_help_link?: boolean;
  // webchat: mic dictation in the widget — opt-in; transcription is a metered
  // Janis charge regardless of the agent's LLM (BYOK included)
  dictation?: boolean;
  // webchat: 'llm' = server-side Gemini→OpenAI transcription (metered);
  // 'browser' = free client-side Web Speech API (Chrome/Edge only — the mic
  // hides on Safari/Firefox). Absent resolves to 'llm' so channels that
  // enabled dictation before this existed keep their coverage.
  dictation_engine?: 'llm' | 'browser';
  // webchat: HMAC-SHA256 key for host-signed identity assertions — when set,
  // a `sig` on the widget's user payload proves the host vouched for it
  identity_secret?: string;
  // webchat: legacy flag — operator identity is now governed by each
  // operator's show_identity profile setting; this field is ignored
  show_operator?: boolean;
  // webchat: console test-chat channel — works through the real /chat
  // pipeline but is hidden from the Integrations channel list
  internal?: boolean;
  // email: readable per-channel reply address on the inbound domain
  // (e.g. acme-support@inbound.janis.ai) — used as From AND Reply-To so the
  // address customers see is the address that routes their reply back.
  // Generated lazily for channels created before this field existed.
  reply_address?: string;
  // messenger: cached Meta Persona ids per operator user id — recreated
  // when the operator's display name or avatar changes
  personas?: Record<string, { id: string; name: string; avatar: string }>;
  // email: the channel's unique inbound address (ch_*@{EMAIL_INBOUND_DOMAIN})
  // + the display name outbound replies are From:'d as
  inbound_address?: string;
  from_name?: string;
  // email channels (resend/gmail/outlook): send-as From override — gmail
  // needs the alias verified in Gmail settings, resend needs the domain
  // verified, outlook needs SendAs permission on the mailbox.
  from_address?: string;
  // email (resend): client-branded sending domain registered on our Resend
  // account — DNS records surfaced in channel settings until verified.
  email_domain?: string;
  email_domain_id?: string;
  email_domain_status?: string;
  email_domain_records?: {
    record?: string;
    name: string;
    type: string;
    value: string;
    ttl?: string;
    priority?: number;
    status?: string;
  }[];
  // Cloudflare OAuth for one-click DNS setup — refresh token grants
  // zone.read + dns.write on the client's zones; used to push records.
  cf_refresh_token?: string;
  // detected upstream mailbox (e.g. janis@janis.ai auto-forwarding to the
  // channel address) — replies are BCC'd there so the thread stays complete
  // in the origin inbox.
  mirror_address?: string;
  // inbound mail rules — see EmailFilterConfig in lib/email.ts
  email_filters?: {
    answer_addresses?: string[];
    list_mail?: boolean;
    sender_allow?: string[];
    sender_block?: string[];
    subject_exclude?: string[];
  };
  // gmail poll: extra query terms appended to `in:inbox after:X`
  // (e.g. "label:support" or "-in:spam") — scopes what mail is eligible
  gmail_query?: string;
  // gmail (oauth): tokens + connected mailbox + poll cursor. access_token is
  // refreshed in place when token_expiry is near; gmail_cursor is the ms
  // internalDate watermark of the newest message ingested.
  refresh_token?: string;
  token_expiry?: number;
  email_address?: string;
  gmail_cursor?: number;
  // gmail push: users.watch expiry (ms) + historyId — the sweeper re-watches
  // before expiry; absent fields mean push was never set up (poll-only).
  gmail_watch_expiry?: number;
  gmail_watch_history?: string;
  // outlook (Microsoft Graph): same token fields as gmail + a poll cursor
  // (ms) and subscription id/expiry for Graph change notifications.
  outlook_cursor?: number;
  outlook_sub_id?: string;
  outlook_sub_expiry?: number;
  outlook_client_state?: string; // echoes back on Graph notifications — anti-forgery
  // voice (Twilio): number config + signature token. forward_to bridges the
  // live call to a human's phone when a teammate owns the conversation.
  // Hosted (Janis-provisioned) numbers: account/token are the channel's own
  // Twilio subaccount; twilio_number_sid is needed to release it on delete.
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  hosted?: boolean;
  twilio_number_sid?: string;
  forward_to?: string;
}

export interface AttachmentRef {
  name: string;
  url: string;
  type: string;
  size: number;
}

/** Widget-tap marker — a card/options/button tap carries a machine-readable
 *  payload so ingress stores it as a tap (not typed intent) and the model
 *  sees "[tapped]"-annotated history. `l` = the full label (postback titles
 *  truncate at 20 chars), `of` = which card/widget it sat on. */
const SELECT_MARKER = 'janis:sel:';
export function selectMarker(label: string, of?: string): string {
  return (
    SELECT_MARKER +
    JSON.stringify({ l: label.slice(0, 200), ...(of ? { of: of.slice(0, 80) } : {}) })
  );
}
export function parseSelectMarker(
  raw: string | undefined | null,
): { l?: string; of?: string } | null {
  if (!raw?.startsWith(SELECT_MARKER)) return null;
  try {
    const p = JSON.parse(raw.slice(SELECT_MARKER.length)) as { l?: string; of?: string };
    return typeof p === 'object' && p ? p : null;
  } catch {
    return null;
  }
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
  /** Extra fields merged into the stored message's payload — email carries
   *  subject/message-id/references so replies can thread. */
  payload?: Record<string, unknown>;
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
    /** Host-provided context (Janis.identify traits) — lands on
     *  user_profile.metadata and reaches the agent as background context. */
    traits?: Record<string, unknown>;
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
        const sel = parseSelectMarker(postback.payload);
        out.push({
          objectId,
          senderId: sender,
          // Marker payloads carry the full label — postback.title is the
          // 20-char-truncated button caption Meta echoes back.
          text: sel?.l ?? postback.title ?? postback.payload ?? 'Get Started',
          messageId: postback.mid,
          postback: true,
          // A postback is by definition a button tap — the marker adds which
          // card it sat on so the model sees a pick, not a typed command.
          payload: { tap: true, ...(sel?.of ? { tap_of: sel.of } : {}) },
          ...(standby ? { standby } : {}),
        });
        continue;
      }

      const msg = m.message as
        | {
            text?: string;
            is_echo?: boolean;
            mid?: string;
            quick_reply?: { payload?: string };
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
      const qrSel = parseSelectMarker(msg.quick_reply?.payload);
      out.push({
        objectId,
        senderId: sender,
        text: qrSel?.l ?? msg.text ?? '',
        messageId: msg.mid,
        ...(msg.quick_reply || qrSel
          ? { payload: { tap: true, ...(qrSel?.of ? { tap_of: qrSel.of } : {}) } }
          : {}),
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
        // Interactive reply buttons/lists — a tap returns the button title
        // plus the id we set, which carries the janis:sel: marker for
        // widget-originated options.
        if (wm.type === 'interactive') {
          const r = wm.interactive as
            | {
                button_reply?: { id?: string; title?: string };
                list_reply?: { id?: string; title?: string };
              }
            | undefined;
          const reply = r?.button_reply ?? r?.list_reply;
          const sel = parseSelectMarker(reply?.id);
          const text = sel?.l ?? reply?.title;
          if (text)
            out.push({
              ...base,
              text,
              payload: { tap: true, ...(sel?.of ? { tap_of: sel.of } : {}) },
            });
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

/** Split `text` at its last newline into {head, tail} when it exceeds `cap`
 * characters — used to re-anchor quick-reply/button bodies on the final
 * line (usually the question they answer) while the head goes out as plain
 * text. head: null when there's no clean split (caller drops the buttons). */
function buttonBodySplit(text: string, cap: number): { head: string | null; tail: string } {
  if ([...text].length <= cap) return { head: null, tail: text };
  const cut = text.lastIndexOf('\n');
  const tail = cut > 0 ? text.slice(cut + 1).trim() : '';
  const head = cut > 0 ? text.slice(0, cut).trim() : '';
  if (head && tail && [...tail].length <= cap) return { head, tail };
  return { head: null, tail: text };
}

export interface SendOptions {
  /** Suggested replies — tappable buttons on Messenger/IG quick replies and
   * WhatsApp interactive buttons. 20-char titles; WhatsApp shows max 3.
   * {type:'email'|'phone'} asks for a contact field natively (Messenger
   * user_email/user_phone_number); unsupported channels drop it — the
   * agent's text should still ask plainly. */
  quickReplies?: QuickReply[];
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
  /** Email subject for a fresh outbound thread — replies still derive the
   * subject from the customer's last inbound. */
  subject?: string;
  /** WhatsApp template send — required for business-initiated messages
   * outside the 24h customer-service window. */
  whatsappTemplate?: { name: string; language?: string; bodyParams?: string[] };
  /** Interactive in-conversation components (cards, pickers, receipts) —
   * webchat renders them natively; Meta kinds get the nearest platform
   * equivalent (generic-template carousel for cards, quick replies /
   * interactive list for pickers). Other types stay text-only. */
  widgets?: WidgetComponent[];
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
  if (channel.kind === 'email') {
    return sendEmailReply(db, channel, platformUserId, text, attachments, opts);
  }
  if (channel.kind === 'gmail') {
    return sendGmailReply(db, channel, platformUserId, text, attachments, opts);
  }
  if (channel.kind === 'outlook') {
    return sendOutlookReply(db, channel, platformUserId, text, attachments, opts);
  }
  if (channel.kind === 'sms') {
    return sendSmsReply(channel, platformUserId, text, attachments, opts);
  }
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
  // Meta/whatsApp title cap is 20 CHARACTERS — slice by code point so an
  // emoji never gets cut mid-surrogate-pair into mojibake
  const qrs = (opts?.quickReplies ?? [])
    .map((t): QuickReply | null =>
      typeof t === 'string' ? [...t.trim()].slice(0, 20).join('') || null : t,
    )
    .filter((t): t is QuickReply => t !== null);
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
    // Business-initiated outbound: outside the 24h session window Meta only
    // accepts approved templates — send the template, not free text.
    if (opts?.whatsappTemplate) {
      const t = opts.whatsappTemplate;
      const r = await send({
        messaging_product: 'whatsapp',
        to: platformUserId,
        type: 'template',
        template: {
          name: t.name,
          language: { code: t.language ?? 'en_US' },
          ...(t.bodyParams?.length
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: t.bodyParams.map((p) => ({ type: 'text', text: p })),
                  },
                ],
              }
            : {}),
        },
      });
      return r;
    }
    if (named.trim()) {
      // WhatsApp has no contact-request primitive — only labelled buttons
      let buttons = qrs
        .filter((q): q is string => typeof q === 'string')
        .slice(0, 3)
        .map((title, i) => ({
          type: 'reply',
          reply: { id: `qr_${i}`, title },
        }));
      // Interactive-button bodies cap at 1024 chars (plain text gets 4096).
      // A longer reply splits at the last newline — head goes out as plain
      // text and the tail carries the buttons; no clean split → buttons
      // drop rather than fail the whole send.
      let body = named;
      if (buttons.length && [...named].length > 1024) {
        const split = buttonBodySplit(named, 1024);
        if (split.head) {
          const r0 = await send({
            messaging_product: 'whatsapp',
            to: platformUserId,
            type: 'text',
            text: { body: split.head },
          });
          mid = r0.mid ?? mid;
          if (r0.error && !error) {
            error = r0.error;
            retryable = r0.retryable;
          }
          body = split.tail;
        } else {
          buttons = [];
        }
      }
      const r = await send(
        buttons.length
          ? {
              messaging_product: 'whatsapp',
              to: platformUserId,
              type: 'interactive',
              interactive: { type: 'button', body: { text: body }, action: { buttons } },
            }
          : { messaging_product: 'whatsapp', to: platformUserId, type: 'text', text: { body } },
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
    // In-conversation widgets → the nearest WhatsApp primitive: an option
    // picker becomes an interactive list (taps arrive as inbound text),
    // cards flatten to a text block since WhatsApp has no carousel.
    for (const w of opts?.widgets ?? []) {
      if (w.type === 'options') {
        const r = await send({
          messaging_product: 'whatsapp',
          to: platformUserId,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: w.title ?? 'Choose an option' },
            action: {
              button: 'See options',
              sections: [
                {
                  rows: w.items.slice(0, 10).map((it) => ({
                    // Marker id — the tap round-trips with widget context.
                    // WhatsApp caps row ids at 256 chars.
                    id: selectMarker(it.label, w.title).slice(0, 256),
                    title: [...it.label].slice(0, 24).join(''),
                    ...(it.description
                      ? { description: [...it.description].slice(0, 72).join('') }
                      : {}),
                  })),
                },
              ],
            },
          },
        });
        mid = r.mid ?? mid;
        if (r.error && !error) {
          error = r.error;
          retryable = r.retryable;
        }
      } else if (w.type === 'cards') {
        const lines = w.items
          .map(
            (it, i) =>
              `${i + 1}. *${it.title}*${it.price ? ` — ${it.price}` : ''}` +
              (it.subtitle ? `\n${it.subtitle}` : '') +
              (it.link ? `\n${it.link}` : ''),
          )
          .join('\n\n');
        const r = await send({
          messaging_product: 'whatsapp',
          to: platformUserId,
          type: 'text',
          text: { body: lines.slice(0, 4000) },
        });
        mid = r.mid ?? mid;
        if (r.error && !error) {
          error = r.error;
          retryable = r.retryable;
        }
      }
      // form/status/receipt have no WhatsApp equivalent — the accompanying
      // text carries them
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
  const textMessage = (body: string) => {
    // Instagram quick replies are text-only — contact-request types are
    // Messenger (user_email/user_phone_number)
    const mapped =
      channel.kind === 'messenger'
        ? qrs.map((q) =>
            typeof q === 'string'
              ? { content_type: 'text', title: q, payload: q }
              : { content_type: q.type === 'email' ? 'user_email' : 'user_phone_number' },
          )
        : qrs
            .filter((q): q is string => typeof q === 'string')
            .map((title) => ({ content_type: 'text', title, payload: title }));
    return mapped.length
      ? { text: body, quick_replies: mapped.slice(0, 13) }
      : { text: body };
  };
  let mid: string | null = null;
  let error: string | null = null;
  let retryable = true;
  if (named.trim()) {
    // Meta caps message text at ~2000 chars — over that, split at the last
    // newline so the tail (with any quick replies) still lands. Always the
    // prefixed text — Meta accepts persona_id but silently drops persona
    // rendering for a growing list of recipients/surfaces (admins viewing
    // the thread see plain page identity), so the inline name is the only
    // dependable attribution. persona_id still rides along when it
    // resolves — where it renders, the annotation backs the prefix.
    const parts: Record<string, unknown>[] = [];
    if ([...named].length > 2000) {
      const split = buttonBodySplit(named, 2000);
      if (split.head) parts.push({ text: split.head });
      parts.push(textMessage(split.tail));
    } else {
      parts.push(textMessage(named));
    }
    for (const m of parts) {
      const r = await send(m);
      if (!r.mid && personaId) {
        // persona deleted or rejected server-side — retry without it
        personaId = null;
        const retry = await send(m);
        mid = retry.mid ?? mid;
        const e = retry.error ?? r.error;
        if (e) {
          error = e;
          retryable = retry.error !== null ? retry.retryable : r.retryable;
        }
      } else {
        mid = r.mid ?? mid;
        if (r.error) {
          error = r.error;
          retryable = r.retryable;
        }
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
  // In-conversation widgets → the nearest Meta primitive: cards become a
  // generic-template carousel, an option picker becomes quick replies. Card
  // taps land back as postback text — the same path as a typed reply.
  for (const w of opts?.widgets ?? []) {
    let msg: Record<string, unknown> | null = null;
    if (w.type === 'cards') {
      const elements = w.items.slice(0, 10).map((it) => {
        const buttons: Record<string, unknown>[] = [];
        if (it.link && /^https?:\/\//.test(it.link)) {
          buttons.push({ type: 'web_url', url: it.link, title: (it.link_label || 'View').slice(0, 20) });
        }
        if (it.select_label) {
          buttons.push({
            type: 'postback',
            title: it.select_label.slice(0, 20),
            // Marker payload — the tap round-trips with card context instead
            // of arriving as bare text the model could misread as a command.
            payload: selectMarker(it.select_label, it.title).slice(0, 1000),
          });
        }
        return {
          title: it.title.slice(0, 80),
          ...(it.subtitle || it.price
            ? { subtitle: [it.subtitle, it.price].filter(Boolean).join(' · ').slice(0, 80) }
            : {}),
          ...(it.image && /^https?:\/\//.test(it.image) ? { image_url: it.image } : {}),
          // tap-anywhere on the card body opens the link, not just the button
          ...(it.link && /^https?:\/\//.test(it.link)
            ? { default_action: { type: 'web_url', url: it.link } }
            : {}),
          ...(buttons.length ? { buttons } : {}),
        };
      });
      if (elements.length) {
        msg = {
          attachment: {
            type: 'template',
            payload: { template_type: 'generic', elements },
          },
        };
      }
    } else if (w.type === 'options') {
      msg = {
        text: w.title ?? 'Choose an option:',
        quick_replies: w.items.slice(0, 13).map((it) => ({
          content_type: 'text',
          title: [...it.label].slice(0, 20).join(''),
          // quick_reply payloads echo back on the tap — same marker as cards
          payload: selectMarker(it.label, w.title).slice(0, 1000),
        })),
      };
    }
    // form/status/receipt have no Meta equivalent — the accompanying text
    // carries them
    if (!msg) continue;
    const r = await send(msg);
    mid = r.mid ?? mid;
    if (r.error && !error) {
      error = r.error;
      retryable = r.retryable;
    }
  }
  return { mid, error, retryable };
}

/** SMS/MMS replies — Twilio Messages API on the channel's number. No 24h
 * window (unlike Meta): any prior inbound keeps the thread sendable until
 * the customer replies STOP. Texts >1600 chars split on newlines; each
 * attachment is its own MMS. Buttons flatten to a numbered list — SMS has
 * no button primitive. */
async function sendSmsReply(
  channel: ChannelRow,
  to: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  opts?: SendOptions,
): Promise<SendResult> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.twilio_account_sid || !creds.twilio_auth_token || !creds.phone_number) {
    return {
      mid: null,
      error: 'SMS channel is missing Twilio credentials — reconnect it under Integrations',
      retryable: false,
    };
  }
  const named = opts?.senderName && text.trim() ? `${opts.senderName}: ${text}` : text;
  const strs = (opts?.quickReplies ?? []).filter((q): q is string => typeof q === 'string');
  const body =
    strs.length && named.trim()
      ? `${named}\n\n${strs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : named;
  // Twilio accepts one Body ≤1600 chars per message — split at newlines.
  const chunks: string[] = [];
  let rest = body;
  while ([...rest].length > 1600) {
    const win = [...rest].slice(0, 1600).join('');
    const cut = win.lastIndexOf('\n');
    const head = cut > 0 ? win.slice(0, cut) : win;
    chunks.push(head);
    rest = rest.slice([...head].length).replace(/^\n/, '');
  }
  if (rest.trim()) chunks.push(rest);
  const sends: { body: string; mediaUrl?: string }[] = chunks.map((b) => ({ body: b }));
  for (const a of attachments ?? []) {
    sends.push({ body: '', mediaUrl: absoluteAttachmentUrl(a) });
  }
  let mid: string | null = null;
  let error: string | null = null;
  let retryable = true;
  for (const s of sends) {
    try {
      const r = await sendSms(
        creds,
        to,
        s.body,
        s.mediaUrl,
        `${env.apiOrigin}/sms/${channel.id}/status`,
      );
      mid = r.sid;
    } catch (e) {
      const te = e as TwilioError;
      // Permanent when the number itself can't receive (invalid, landline,
      // unsubscribed); provider/rate-limit failures are worth a retry.
      const permanent =
        te.code === 21211 || te.code === 21610 || te.code === 21611 ||
        (te.status !== undefined && te.status >= 400 && te.status < 500 &&
          te.code !== 20429 && te.code !== 20503);
      if (!error) {
        error = `Twilio rejected the send${te.code ? ` (error ${te.code})` : ''}: ${te.message}`;
        retryable = !permanent;
      }
    }
  }
  if (!mid && !error) return { mid: null, error: 'nothing to send', retryable: false };
  return { mid, error, retryable };
}

/** Payload shape email-family inbound stores on messages — subject +
 * RFC threading ids so replies fold into the customer's mail thread. */
export interface EmailMeta {
  subject?: string;
  message_id?: string;
  references?: string[];
  thread_id?: string; // gmail: API thread id — send targets it directly
}

/** Shared threading context for email-family sends: Re: subject off the
 * customer's last inbound + the references chain + gmail thread id. */
async function emailThreadContext(
  db: Db | undefined,
  channel: ChannelRow,
  platformUserId: string,
  opts?: SendOptions,
): Promise<{ subject: string; refs: string[]; threadId?: string }> {
  // Fresh outbound thread — the caller's subject instead of a fake "Re:".
  let subject = opts?.subject?.trim() || `Re: ${channel.name}`;
  const refs: string[] = [];
  let threadId: string | undefined;
  if (db) {
    const [binding] = await db
      .select({ conversationId: channelBindings.conversationId })
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.channelId, channel.id),
          eq(channelBindings.platformUserId, platformUserId),
        ),
      )
      .limit(1);
    const [lastIn] = binding
      ? await db
          .select({ payload: messages.payload })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, binding.conversationId),
              eq(messages.direction, 'in'),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(1)
      : [];
    const em = ((lastIn?.payload as { email?: EmailMeta } | null)?.email) ?? {};
    threadId = em.thread_id;
    if (em.subject) {
      subject = /^re:/i.test(em.subject.trim()) ? em.subject : `Re: ${em.subject}`;
    }
    if (em.message_id) refs.push(...(em.references ?? []), em.message_id);
  }
  return { subject, refs, threadId };
}

/** From display name — operator identity rides the name field; an inline
 * "Name:" prefix reads wrong in email. */
function emailDisplayName(
  channel: ChannelRow,
  creds: ChannelCredentials,
  opts?: SendOptions,
): string {
  return opts?.senderName
    ? `${opts.senderName} via ${creds.from_name || channel.name}`
    : creds.from_name || channel.name;
}

/** Buttons have no email affordance — flatten to a numbered list the
 * customer answers in text. Typed contact asks degrade to the text ask. */
function emailBody(text: string, opts?: SendOptions): string {
  const strs = (opts?.quickReplies ?? []).filter((q): q is string => typeof q === 'string');
  return strs.length && text.trim()
    ? `${text}\n\n${strs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : text;
}

/** Email channel (Resend): reply with RFC threading headers so the answer
 * lands in the customer's existing mail thread. */
async function sendEmailReply(
  db: Db | undefined,
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  opts: SendOptions | undefined,
): Promise<SendResult> {
  const creds = channel.credentials as ChannelCredentials;
  // The channel's unique reply address carries From + Reply-To: the address
  // customers see is the one that routes their reply back. A from_address on
  // the inbound domain is superseded by it; a from_address on a verified
  // custom domain stays the From (reply routing still goes to replyAddr).
  const replyAddr = db
    ? await replyAddressFor(db, channel)
    : (creds.reply_address ?? creds.inbound_address);
  if (!replyAddr) {
    return {
      mid: null,
      error: 'email channel has no inbound address — recreate it under Integrations',
      retryable: false,
    };
  }
  const onInboundDomain = (a?: string) =>
    (a ?? '').toLowerCase().endsWith(`@${env.emailInboundDomain}`);
  const customFrom =
    creds.from_address && !onInboundDomain(creds.from_address)
      ? creds.from_address
      : undefined;
  if (!env.resendApiKey) {
    return { mid: null, error: 'RESEND_API_KEY not configured', retryable: false };
  }
  const { subject, refs } = await emailThreadContext(db, channel, platformUserId, opts);
  const displayName = emailDisplayName(channel, creds, opts);
  const body = emailBody(text, opts);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${displayName} <${customFrom ?? replyAddr}>`,
        // Replies always target the channel's unique reply address — same as
        // the From on inbound-domain channels, the routing address when a
        // custom-domain From is in use.
        reply_to: [replyAddr],
        to: [platformUserId],
        subject,
        text: body,
        headers: {
          // marks our own sends — inbound skips them if a forward/mirror
          // ever loops one back to the channel address
          'X-Janis-Outbound': channel.id,
          ...(refs.length
            ? { 'In-Reply-To': refs[refs.length - 1], References: refs.join(' ') }
            : {}),
        },
        // keep the origin inbox's copy of the thread complete when the
        // channel is fed by forwarding (janis@… → ch_…@inbound.janis.ai)
        ...(creds.mirror_address ? { bcc: [creds.mirror_address] } : {}),
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.name,
                path: absoluteAttachmentUrl(a),
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { id?: string; message?: string }
      | null;
    if (!res.ok) {
      return {
        mid: null,
        error: `Resend rejected the send (error ${res.status}): ${data?.message ?? 'send failed'}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    }
    return { mid: data?.id ?? null, error: null, retryable: true };
  } catch (e) {
    return {
      mid: null,
      error: `Email send failed: ${e instanceof Error ? e.message : e}`,
      retryable: true,
    };
  }
}

/** Gmail channel: reply through the mailbox's own Gmail API — threadId does
 * the threading natively; attachments go as hosted links (Janis uploads are
 * already public URLs). */
async function sendGmailReply(
  db: Db | undefined,
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  opts: SendOptions | undefined,
): Promise<SendResult> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.email_address || !db) {
    return {
      mid: null,
      error: 'gmail channel is not connected — reconnect it under Integrations',
      retryable: false,
    };
  }
  try {
    const token = await ensureAccessToken(db, channel);
    const { subject, refs, threadId } = await emailThreadContext(db, channel, platformUserId, opts);
    const data = await sendGmailMessage(token, {
      from: `${emailDisplayName(channel, creds, opts)} <${creds.from_address ?? creds.email_address}>`,
      to: platformUserId,
      subject,
      text: emailBody(text, opts),
      threadId,
      inReplyTo: refs[refs.length - 1],
      references: refs,
      attachmentLinks: attachments?.map((a) => ({
        name: a.name,
        url: absoluteAttachmentUrl(a),
      })),
    });
    return { mid: data?.id ?? null, error: null, retryable: true };
  } catch (e) {
    return {
      mid: null,
      error: `Gmail send failed: ${e instanceof Error ? e.message : e}`,
      retryable: true,
    };
  }
}

/** Outlook channel (Microsoft Graph): /me/sendMail with Re: subject +
 * In-Reply-To/References for threading — attachments as hosted links. */
async function sendOutlookReply(
  db: Db | undefined,
  channel: ChannelRow,
  platformUserId: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  opts: SendOptions | undefined,
): Promise<SendResult> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.email_address || !db) {
    return {
      mid: null,
      error: 'outlook channel is not connected — reconnect it under Integrations',
      retryable: false,
    };
  }
  try {
    const { ensureMsToken, sendMail } = await import('./outlook.js');
    const token = await ensureMsToken(db, channel);
    const { subject, refs } = await emailThreadContext(db, channel, platformUserId, opts);
    await sendMail(token, {
      from: creds.from_address,
      to: platformUserId,
      subject,
      text: emailBody(text, opts),
      inReplyTo: refs[refs.length - 1],
      references: refs,
      attachmentLinks: attachments?.map((a) => ({
        name: a.name,
        url: absoluteAttachmentUrl(a),
      })),
    });
    return { mid: null, error: null, retryable: true };
  } catch (e) {
    return {
      mid: null,
      error: `Outlook send failed: ${e instanceof Error ? e.message : e}`,
      retryable: true,
    };
  }
}

/** Find the email channel owning a recipient address (To: match, case-folded)
 *  — inbound_address and the channel's reply_address both route here. */
export async function findChannelByEmailAddress(
  db: Db,
  toAddress: string,
): Promise<ChannelRow | undefined> {
  const rows = await db.select().from(channels).where(eq(channels.kind, 'email'));
  const want = toAddress.trim().toLowerCase();
  return rows.find((c) => {
    const creds = c.credentials as ChannelCredentials;
    return (
      (creds.inbound_address ?? '').toLowerCase() === want ||
      (creds.reply_address ?? '').toLowerCase() === want
    );
  });
}

/** "acme support desk" → "acme-support-desk" (≤32 chars, DNS-safe). */
function replyLocalPart(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || `ch-${id.replace(/-/g, '').slice(0, 8)}`;
}

/** Allocate a unique reply address on the inbound domain for a channel name —
 *  checks both inbound_address and reply_address of every email channel,
 *  suffixing -2/-3/… on collision. Exported for channel creation. */
export async function uniqueReplyAddress(
  db: Db,
  name: string,
  fallbackId: string,
): Promise<string> {
  const base = replyLocalPart(name, fallbackId);
  const rows = await db
    .select({ credentials: channels.credentials })
    .from(channels)
    .where(eq(channels.kind, 'email'));
  const taken = new Set(
    rows.flatMap((r) => {
      const rc = r.credentials as ChannelCredentials;
      return [rc.inbound_address, rc.reply_address]
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase());
    }),
  );
  let addr = `${base}@${env.emailInboundDomain}`;
  for (let i = 2; taken.has(addr.toLowerCase()); i++) {
    addr = `${base}-${i}@${env.emailInboundDomain}`;
  }
  return addr;
}

/** The channel's unique reply address — readable (acme-support@inbound…),
 *  persisted on first use so an early channel rename doesn't orphan the
 *  address customers already have. Falls back to the opaque inbound_address
 *  when no db is available to persist with. */
export async function replyAddressFor(
  db: Db | undefined,
  channel: ChannelRow,
): Promise<string | undefined> {
  const creds = channel.credentials as ChannelCredentials;
  if (creds.reply_address) return creds.reply_address;
  if (!db) return creds.inbound_address;
  const addr = await uniqueReplyAddress(db, channel.name, channel.id);
  creds.reply_address = addr;
  await db
    .update(channels)
    .set({ credentials: creds })
    .where(eq(channels.id, channel.id))
    .catch(() => {});
  return addr;
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

/** Canonical message text is markdown-ish: **bold**, *italic*, ~~strike~~,
 * `code`, [label](url). Egress translates it per channel — the webchat
 * widget renders the markdown itself, WhatsApp has its own dialect
 * (*bold*, _italic_, ~strike~, ```code```), and every text-only channel
 * gets the markers stripped so customers never see literal asterisks.
 * Stored transcripts keep the canonical form. Guards against mangling
 * ordinary asterisks: emphasis needs non-space content at both ends. */
const CHANNEL_FMT_RE =
  /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*|\*([^\s*](?:[^*]*[^\s*])?)\*|~~([^\s~](?:[^~]*[^\s~])?)~~|`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function formatForChannel(text: string, kind: string): string {
  const wa = kind === 'whatsapp';
  return text.replace(
    CHANNEL_FMT_RE,
    (m, bold, ital, strike, code, label, url) => {
      if (kind === 'webchat') return m; // the widget renders the markdown
      if (bold != null) return wa ? `*${bold}*` : bold;
      if (ital != null) return wa ? `_${ital}_` : ital;
      if (strike != null) return wa ? `~${strike}~` : strike;
      if (code != null) return wa ? `\`\`\`${code}\`\`\`` : code;
      return `${label} (${url})`; // no link syntax outside webchat
    },
  );
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
  if (!text.trim() && !attachments?.length) return { delivered: true };
  if (!row) {
    // No binding: external agents (webhook / SDK socket) deliver outside
    // channels, so binding-free conversations are normal for them. A hosted
    // agent's conversation without a binding is orphaned — its channel was
    // deleted out from under it and nothing can reach the customer. Report
    // that instead of stamping "Delivered" on a reply that went nowhere.
    const [conv] = await db
      .select({ agentId: conversations.agentId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const [agent] = conv
      ? await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1)
      : [];
    if (agent && !agent.hosted) return { delivered: true };
    const error =
      'conversation has no channel binding — its channel may have been deleted; the customer cannot be reached';
    if (opts?.messageId) {
      await stampDelivery(db, agent?.workspaceId, opts.messageId, {
        delivery_error: error,
        delivery_retryable: false,
      });
    }
    return { delivered: false, error, retryable: false };
  }
  // Translate canonical markdown-ish text into the channel's dialect once —
  // voice, the SDK socket and the push send below all ship the same body.
  const body = formatForChannel(text, row.channel.kind);
  // Voice is turn-based — Twilio holds the line and the reply is spoken in
  // the next webhook response, not pushed. Queue it for the /voice/turn loop.
  if (row.channel.kind === 'voice') {
    void voiceDeliver(db, conversationId, body).catch(() => {});
    if (opts?.messageId) {
      const [a] = await db
        .select({ workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, row.conv.agentId))
        .limit(1);
      await stampDelivery(db, a?.workspaceId, opts.messageId, { delivered: true });
    }
    return { delivered: true };
  }
  // Self-hosted SDK bots receive operator/agent messages over their
  // registered socket — the channel binding is transcript bookkeeping only.
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, row.conv.agentId))
    .limit(1);
  if (agent && (await emitChatResponse(agent, row.binding.platformUserId, body))) {
    if (opts?.messageId) {
      await stampDelivery(db, agent.workspaceId, opts.messageId, { delivered: true });
    }
    return { delivered: true };
  }
  const result = await sendChannelMessage(row.channel, row.binding.platformUserId, body, attachments, opts, db).catch(
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
  // WhatsApp has no profile endpoint (name arrives in the webhook); email/
  // gmail carry the address in the message itself and their access_token is
  // a Google credential, not Meta's.
  if (!creds.access_token || ['whatsapp', 'email', 'gmail'].includes(channel.kind)) {
    return {};
  }
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
