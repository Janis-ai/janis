import { createHmac, timingSafeEqual } from 'node:crypto';

/** Resend `email.received` webhook payload (tolerant — fields vary a little
 * by API version; the receiving endpoint is fetched for the body anyway). */
export interface EmailReceived {
  email_id?: string;
  id?: string;
  from?: string;
  to?: string | string[];
  subject?: string;
  message_id?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename?: string; content_type?: string }[];
}

/** Verify a Svix-style webhook signature (Resend's provider): headers
 * svix-id / svix-timestamp / svix-signature over `${id}.${ts}.${body}` with
 * an HMAC-SHA256 keyed by the base64 part of `whsec_…`. */
export function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: { get(name: string): string | null },
): boolean {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigs = headers.get('svix-signature');
  if (!id || !ts || !sigs) return false;
  // Replay window — signed content includes the timestamp, so an old
  // signature can't be reused.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${ts}.${rawBody}`)
    .digest('base64');
  // Space-separated "v1,<sig>" tokens — any match passes (rotation overlap).
  return sigs.split(' ').some((s) => {
    const [ver, sig] = s.split(',', 2);
    if (ver !== 'v1' || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Extract bare addresses from a To/Cc header or array —
 * `"Jane" <jane@x.com>, bob@y.com` → `['jane@x.com', 'bob@y.com']`. */
export function parseAddressList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(',');
  return parts
    .map((p) => {
      const m = p.match(/<([^>]+)>/);
      return (m ? m[1] : p).trim().toLowerCase();
    })
    .filter((a) => a.includes('@'));
}

/** Split `"Jane Doe" <jane@x.com>` → name + address (either may be absent). */
export function parseFrom(raw: string | undefined): { name?: string; address?: string } {
  if (!raw) return {};
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || undefined, address: m[2].trim().toLowerCase() };
  const addr = raw.trim().toLowerCase();
  return addr.includes('@') ? { address: addr } : {};
}

/** Lowercase a header map's keys once so checks can assume lowercase. */
function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** True when headers mark the message as machine-generated — auto-replies,
 * bulk mail, lists, bounces. Answering these would loop or spam.
 * `allowList` demotes list-delivery signals (List-Id, List-Unsubscribe,
 * Precedence: list|bulk|junk) to informational — real humans post to
 * mailing lists, and channels that opt in (or match answer_addresses)
 * should see those messages. Auto-reply/auto-submitted headers still skip. */
export function isAutoReply(
  headers: Record<string, string> | undefined,
  opts?: { allowList?: boolean },
): boolean {
  if (!headers) return false;
  const h = lowerHeaders(headers);
  const auto = h['auto-submitted'];
  if (auto && auto.toLowerCase() !== 'no') return true;
  if (h['x-autoreply'] || h['x-autorespond']) return true;
  const precedence = (h['precedence'] ?? '').toLowerCase();
  if (opts?.allowList ? precedence === 'junk' : ['bulk', 'list', 'junk'].includes(precedence)) {
    return true;
  }
  if (!opts?.allowList && (h['list-id'] || h['list-unsubscribe'])) return true;
  return false;
}

const MAILER_DAEMON = /^(mailer-daemon|postmaster|daemon|bounce)@/;

/** True for system senders nobody should reply to. */
export function isDaemonAddress(address: string): boolean {
  return MAILER_DAEMON.test(address);
}

/** Per-channel inbound mail rules — set via PATCH /api/channels/:id. */
export interface EmailFilterConfig {
  /** Only ingest mail addressed to these addresses (To/Cc/Delivered-To match).
   *  Enables the Google-Group/alias case and quiets shared mailboxes.
   *  Mail addressed to a listed address is exempt from the list-mail skip. */
  answer_addresses?: string[];
  /** Ingest mailing-list/bulk mail (List-Id et al.) — default off. */
  list_mail?: boolean;
  /** Sender addresses or @domains allowed to reach the agent; empty = all. */
  sender_allow?: string[];
  /** Sender addresses or @domains never ingested — wins over allow. */
  sender_block?: string[];
  /** Substrings (case-insensitive) that disqualify a subject. */
  subject_exclude?: string[];
}

export type MailSkipReason =
  | 'no-sender'
  | 'daemon'
  | 'self'
  | 'machine'
  | 'list'
  | 'not-addressed'
  | 'sender-blocked'
  | 'not-allowed'
  | 'subject-excluded';

function domainMatch(addr: string, patterns: string[]): boolean {
  const lower = addr.toLowerCase();
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    return pat.startsWith('@') || !pat.includes('@')
      ? lower.endsWith(`@${pat.replace(/^@/, '')}`)
      : lower === pat;
  });
}

/** Single decision point for inbound mail: returns the skip reason, or
 *  null to ingest. Shared by the gmail/outlook pollers and the Resend
 *  inbound webhook so every email channel honors the same rules. */
export function mailSkipReason(
  msg: {
    headers?: Record<string, string>;
    from?: string;
    to?: string | string[];
    subject?: string;
  },
  opts: {
    /** Channel's own mailbox/address — self-mail is skipped. */
    selfAddress?: string;
    /** Our sending domain — mail from it is a loop (resend inbound). */
    selfDomain?: string;
    filters?: EmailFilterConfig;
  },
): MailSkipReason | null {
  const filters = opts.filters ?? {};
  const { address: fromAddr } = parseFrom(msg.from);
  if (!fromAddr) return 'no-sender';
  if (isDaemonAddress(fromAddr)) return 'daemon';
  const selfAddr = opts.selfAddress?.toLowerCase();
  if ((selfAddr && fromAddr === selfAddr) || (opts.selfDomain && fromAddr.endsWith(`@${opts.selfDomain}`))) {
    return 'self';
  }

  // Addressed-to check: To + Cc + Delivered-To headers, or the `to` field.
  const h = lowerHeaders(msg.headers);
  // Our own outbound mail boomeranging back via a mirror/forward is a loop.
  if (h['x-janis-outbound']) return 'self';
  const want = (filters.answer_addresses ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  let addressed = true;
  if (want.length) {
    const got = new Set([
      ...parseAddressList(msg.to),
      ...parseAddressList(h['to']),
      ...parseAddressList(h['cc']),
      ...parseAddressList(h['delivered-to']),
      ...parseAddressList(h['x-forwarded-to']),
    ]);
    addressed = want.some((a) => got.has(a));
  }
  // True machine mail (auto-submitted, auto-reply headers, junk precedence)
  // always skips — even on list-enabled channels.
  if (isAutoReply(msg.headers, { allowList: true })) return 'machine';
  // List-delivery signals: allowed when the channel opts in, or when the
  // mail was explicitly addressed to a configured answer address (the
  // group/alias case — the operator asked for this mail).
  if (isAutoReply(msg.headers) && !(filters.list_mail || (want.length > 0 && addressed))) {
    return 'list';
  }
  if (want.length && !addressed) return 'not-addressed';
  if (filters.sender_block?.length && domainMatch(fromAddr, filters.sender_block)) {
    return 'sender-blocked';
  }
  if (filters.sender_allow?.length && !domainMatch(fromAddr, filters.sender_allow)) {
    return 'not-allowed';
  }
  const subject = (msg.subject ?? h['subject'] ?? '').toLowerCase();
  if (filters.subject_exclude?.some((p) => p.trim() && subject.includes(p.trim().toLowerCase()))) {
    return 'subject-excluded';
  }
  return null;
}

/** Minimal html→text for emails that arrive without a text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
