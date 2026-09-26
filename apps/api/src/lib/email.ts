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

/** True when headers mark the message as machine-generated — auto-replies,
 * bulk mail, lists, bounces. Answering these would loop or spam. */
export function isAutoReply(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const auto = h['auto-submitted'];
  if (auto && auto.toLowerCase() !== 'no') return true;
  const precedence = (h['precedence'] ?? '').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(precedence)) return true;
  if (h['list-id'] || h['list-unsubscribe'] || h['x-autoreply'] || h['x-autorespond']) return true;
  return false;
}

const MAILER_DAEMON = /^(mailer-daemon|postmaster|daemon|bounce)@/;

/** True for system senders nobody should reply to. */
export function isDaemonAddress(address: string): boolean {
  return MAILER_DAEMON.test(address);
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
