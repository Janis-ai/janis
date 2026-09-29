import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import { env } from '../env.js';
import { htmlToText, isAutoReply } from './email.js';
import type { ChannelCredentials } from './channels.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

type ChannelRow = typeof channels.$inferSelect;

/** A flattened Gmail message after `messages.get?format=full`. */
export interface GmailMessage {
  id: string; // stable API id — used as the mid dedup key
  threadId: string; // RFC thread bucket — send with threadId to stay in it
  internalMs: number; // internalDate epoch ms — poll watermark
  from: string;
  to: string;
  subject: string;
  rfcMessageId?: string; // Message-ID header — In-Reply-To target
  references: string[];
  text: string;
  autoSubmitted: boolean; // machine mail — poller skips it
}

function gmailFetch(token: string, path: string, init?: RequestInit) {
  return fetch(`${GMAIL}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
}

/** Fresh access token for a gmail channel — refreshes via the stored
 * refresh_token when expired (or missing) and persists the result. */
export async function ensureAccessToken(db: Db, channel: ChannelRow): Promise<string> {
  const creds = channel.credentials as ChannelCredentials;
  if (creds.access_token && (creds.token_expiry ?? 0) > Date.now() + 60_000) {
    return creds.access_token;
  }
  if (!creds.refresh_token) {
    throw new Error('gmail channel has no refresh token — reconnect it under Integrations');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string }
    | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(`gmail token refresh failed: ${data?.error ?? `HTTP ${res.status}`}`);
  }
  const next: ChannelCredentials = {
    ...creds,
    access_token: data.access_token,
    token_expiry: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await db.update(channels).set({ credentials: next }).where(eq(channels.id, channel.id));
  return data.access_token;
}

const b64url = (s: string) => Buffer.from(s, 'base64url').toString('utf-8');

interface GmailPayload {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
}

/** Best text part of a MIME tree: text/plain wins, html falls back through
 * the shared html→text stripper. */
function extractText(p: GmailPayload): string {
  if (p.mimeType === 'text/plain' && p.body?.data) return b64url(p.body.data);
  for (const part of p.parts ?? []) {
    const t = extractText(part);
    if (t) return t;
  }
  if (p.mimeType === 'text/html' && p.body?.data) return htmlToText(b64url(p.body.data));
  return '';
}

/** users.watch → Gmail publishes Pub/Sub notifications on mailbox changes.
 * Returns null when push isn't configured or the call fails — the caller
 * keeps relying on the periodic poll then. Watches last ≤7 days; the sweeper
 * renews them. */
export async function watchMailbox(
  token: string,
  topicName: string,
): Promise<{ historyId: string; expirationMs: number } | null> {
  const res = await gmailFetch(token, 'watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | { historyId?: string; expiration?: string }
    | null;
  if (!data?.expiration) return null;
  return { historyId: data.historyId ?? '', expirationMs: Number(data.expiration) };
}

/** messages.list for inbox mail newer than the cursor (ms). Returns API ids
 * oldest-first so the watermark always lands on the newest processed. */
export async function listNewMessages(
  token: string,
  cursorMs: number,
): Promise<{ id: string; threadId: string }[]> {
  const q = encodeURIComponent(`in:inbox after:${Math.floor(cursorMs / 1000)}`);
  const res = await gmailFetch(token, `messages?q=${q}&maxResults=50`);
  const data = (await res.json().catch(() => null)) as
    | { messages?: { id: string; threadId: string }[]; error?: { message?: string } }
    | null;
  if (!res.ok) throw new Error(`gmail list failed: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  return (data?.messages ?? []).reverse();
}

/** messages.get flattened into GmailMessage. */
export async function getMessage(token: string, id: string): Promise<GmailMessage | null> {
  const res = await gmailFetch(token, `messages/${id}?format=full`);
  const data = (await res.json().catch(() => null)) as {
    id?: string;
    threadId?: string;
    internalDate?: string;
    payload?: GmailPayload;
  } | null;
  if (!res.ok || !data?.id || !data.threadId) return null;
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers ?? []) {
    if (h.name && h.value !== undefined) headers[h.name.toLowerCase()] = h.value;
  }
  const refs = (headers['references'] ?? '')
    .match(/<[^>]+>/g)
    ?.map((m) => m) ?? [];
  return {
    id: data.id,
    threadId: data.threadId,
    internalMs: Number(data.internalDate ?? 0),
    from: headers['from'] ?? '',
    to: headers['to'] ?? '',
    subject: headers['subject'] ?? '',
    rfcMessageId: headers['message-id'],
    references: refs,
    text: extractText(data.payload ?? {}).trim(),
    autoSubmitted: isAutoReply(headers),
  };
}

/** Send a reply via Gmail. threadId keeps it in the customer's thread;
 * In-Reply-To/References keep foreign clients threading too. Attachments
 * ride as hosted links — multipart/mixed adds a MIME builder we don't need
 * yet since Janis attachments are already publicly URL'd. */
export async function sendMessage(
  token: string,
  opts: {
    from: string; // `Name <addr>` — addr must be the channel's own mailbox
    to: string;
    subject: string;
    text: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attachmentLinks?: { name: string; url: string }[];
  },
): Promise<{ id?: string; threadId?: string } | null> {
  const body = opts.attachmentLinks?.length
    ? `${opts.text}\n\n${opts.attachmentLinks.map((a) => `📎 ${a.name}: ${a.url}`).join('\n')}`
    : opts.text;
  const mime = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references?.length ? [`References: ${opts.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ].join('\r\n');
  const res = await gmailFetch(token, 'messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw: Buffer.from(mime, 'utf-8').toString('base64url'),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    }),
  });
  const data = (await res.json().catch(() => null)) as
    | { id?: string; threadId?: string; error?: { message?: string } }
    | null;
  if (!res.ok) {
    throw new Error(`gmail send failed: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return data;
}
