import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import { env } from '../env.js';
import { htmlToText } from './email.js';
import type { ChannelCredentials } from './channels.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TENANT = () => env.msTenant || 'common';

type ChannelRow = typeof channels.$inferSelect;

/** A flattened Outlook message after /me/messages/{id}. */
export interface OutlookMessage {
  id: string; // Graph id — dedup key (stable per mailbox)
  conversationId: string; // Graph thread id
  internalMs: number; // receivedDateTime epoch ms — poll watermark
  from: string;
  to: string;
  subject: string;
  rfcMessageId?: string; // internetMessageId — In-Reply-To target
  text: string;
  headers: Record<string, string>;
}

function msFetch(token: string, path: string, init?: RequestInit) {
  return fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
}

/** Fresh access token for an outlook channel — refreshes via the stored
 * refresh_token when expired and persists the rotated pair. */
export async function ensureMsToken(db: Db, channel: ChannelRow): Promise<string> {
  const creds = channel.credentials as ChannelCredentials;
  if (creds.access_token && (creds.token_expiry ?? 0) > Date.now() + 60_000) {
    return creds.access_token;
  }
  if (!creds.refresh_token) {
    throw new Error('outlook channel has no refresh token — reconnect it under Integrations');
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.msClientId,
        client_secret: env.msClientSecret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
        scope: 'offline_access Mail.Read Mail.Send User.Read',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const data = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      }
    | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(
      `outlook token refresh failed: ${data?.error_description ?? data?.error ?? `HTTP ${res.status}`}`,
    );
  }
  const next: ChannelCredentials = {
    ...creds,
    access_token: data.access_token,
    // Microsoft rotates refresh tokens — keep the new one when returned.
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    token_expiry: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await db.update(channels).set({ credentials: next }).where(eq(channels.id, channel.id));
  return data.access_token;
}

interface MsMailItem {
  id?: string;
  conversationId?: string;
  receivedDateTime?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name?: string; value?: string }[];
}

/** Inbox messages newer than the cursor, oldest first. */
export async function listNewMessages(
  token: string,
  cursorMs: number,
): Promise<{ id: string }[]> {
  const after = new Date(cursorMs).toISOString();
  const res = await msFetch(
    token,
    `/me/mailFolders/inbox/messages?$filter=receivedDateTime gt ${after}&$orderby=receivedDateTime asc&$top=50&$select=id`,
  );
  const data = (await res.json().catch(() => null)) as
    | { value?: { id?: string }[]; error?: { message?: string } }
    | null;
  if (!res.ok) {
    throw new Error(`outlook list failed: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return (data?.value ?? []).filter((m): m is { id: string } => !!m.id).map((m) => ({ id: m.id }));
}

/** /me/messages/{id} flattened into OutlookMessage. */
export async function getMessage(token: string, id: string): Promise<OutlookMessage | null> {
  const res = await msFetch(
    token,
    `/me/messages/${id}?$select=id,conversationId,receivedDateTime,internetMessageId,subject,from,toRecipients,body,internetMessageHeaders`,
  );
  const m = (await res.json().catch(() => null)) as MsMailItem | null;
  if (!res.ok || !m?.id) return null;
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) {
    if (h.name && h.value !== undefined) headers[h.name.toLowerCase()] = h.value;
  }
  const bodyText =
    m.body?.contentType === 'text'
      ? (m.body.content ?? '')
      : htmlToText(m.body?.content ?? '');
  const from = m.from?.emailAddress;
  return {
    id: m.id,
    conversationId: m.conversationId ?? '',
    internalMs: new Date(m.receivedDateTime ?? 0).getTime(),
    from: from?.address ? `${from.name ?? ''} <${from.address}>` : '',
    to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? '').join(', '),
    subject: m.subject ?? '',
    rfcMessageId: m.internetMessageId,
    text: bodyText.trim(),
    headers,
  };
}

/** Send mail via Graph /me/sendMail. Fresh threads carry the caller's
 * subject; replies get Re: + In-Reply-To headers so foreign clients thread. */
export async function sendMail(
  token: string,
  opts: {
    /** Shared-mailbox/alias send-as — requires SendAs permission in M365. */
    from?: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    attachmentLinks?: { name: string; url: string }[];
  },
): Promise<{ id?: string } | null> {
  const body = opts.attachmentLinks?.length
    ? `${opts.text}\n\n${opts.attachmentLinks.map((a) => `📎 ${a.name}: ${a.url}`).join('\n')}`
    : opts.text;
  const headers: { name: string; value: string }[] = [];
  if (opts.inReplyTo) headers.push({ name: 'In-Reply-To', value: opts.inReplyTo });
  if (opts.references?.length) headers.push({ name: 'References', value: opts.references.join(' ') });
  const res = await msFetch(token, '/me/sendMail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: opts.subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: opts.to } }],
        ...(opts.from ? { from: { emailAddress: { address: opts.from } } } : {}),
        ...(headers.length ? { internetMessageHeaders: headers } : {}),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok && res.status !== 202) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`outlook send failed: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return { id: undefined }; // sendMail 202s with no id — dedup keys off the conv
}

/** Graph change-notification subscription on the inbox — Microsoft's
 * equivalent of users.watch. Subscriptions on messages live ≤4230 minutes
 * (~3 days); the sweeper renews. Returns null when push is unconfigured or
 * the call fails — the poll fallback keeps working. */
export async function watchMailbox(
  token: string,
  clientState: string,
): Promise<{ id: string; expirationMs: number } | null> {
  if (!env.msPushToken) return null;
  const res = await msFetch(token, '/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: `${env.apiOrigin}/outlook/push?token=${env.msPushToken}`,
      resource: "me/mailFolders('inbox')/messages",
      expirationDateTime: new Date(Date.now() + 4200 * 60_000).toISOString(),
      clientState,
    }),
  });
  const data = (await res.json().catch(() => null)) as
    | { id?: string; expirationDateTime?: string }
    | null;
  if (!res.ok || !data?.id || !data.expirationDateTime) return null;
  return { id: data.id, expirationMs: new Date(data.expirationDateTime).getTime() };
}

/** Renew an existing subscription's expiry. */
export async function renewMailboxWatch(token: string, subId: string): Promise<number | null> {
  const res = await msFetch(token, `/subscriptions/${subId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expirationDateTime: new Date(Date.now() + 4200 * 60_000).toISOString(),
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { expirationDateTime?: string } | null;
  return data?.expirationDateTime ? new Date(data.expirationDateTime).getTime() : null;
}
