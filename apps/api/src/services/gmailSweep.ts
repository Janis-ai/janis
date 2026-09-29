import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { mailSkipReason, parseFrom } from '../lib/email.js';
import { ensureAccessToken, getMessage, listNewMessages, watchMailbox } from '../lib/gmail.js';
import { env } from '../env.js';
import { handleChannelMessage } from './channelIngress.js';

/** Poll every gmail channel for new inbox mail. Runs on the sweeper tick —
 * per-channel failures are isolated so a revoked grant can't stall others.
 * The cursor (last-ingested internalDate) is stored on the channel itself;
 * overlapping windows dedup on `gmail:{api-id}` mids downstream. */
export async function sweepGmail(db: Db): Promise<void> {
  const rows = await db.select().from(channels).where(eq(channels.kind, 'gmail'));
  for (const channel of rows) {
    try {
      await pollGmailChannel(db, channel);
    } catch (err) {
      console.error(`gmail poll ${channel.id} (${channel.name}):`, err);
    }
  }
}

/** Poll one gmail channel — called by the sweeper tick and by the Pub/Sub
 * push handler for near-real-time ingest. */
export async function pollGmailChannel(db: Db, channel: typeof channels.$inferSelect): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.email_address) return;
  const token = await ensureAccessToken(db, channel);
  // No cursor yet (channels predating the field) → start at channel creation,
  // never the whole mailbox backlog.
  let cursor = creds.gmail_cursor ?? channel.createdAt.getTime();
  const listing = await listNewMessages(token, cursor, creds.gmail_query);
  for (const stub of listing) {
    const mail = await getMessage(token, stub.id);
    if (!mail) continue;
    if (mail.internalMs > cursor) cursor = mail.internalMs;

    const { name: fromName, address: fromAddr } = parseFrom(mail.from);
    if (!fromAddr) continue;
    if (mailSkipReason(
      { headers: mail.headers, from: mail.from, to: mail.to, subject: mail.subject },
      { selfAddress: creds.email_address, filters: creds.email_filters },
    )) {
      continue;
    }
    await handleChannelMessage(db, channel, {
      objectId: creds.email_address,
      senderId: fromAddr,
      name: fromName,
      text: mail.text,
      messageId: `gmail:${mail.id}`,
      user: { email: fromAddr },
      payload: {
        email: {
          subject: mail.subject,
          message_id: mail.rfcMessageId,
          references: mail.references.length ? mail.references : undefined,
          thread_id: mail.threadId,
        },
      },
    });
  }
  if (cursor !== creds.gmail_cursor) {
    await db
      .update(channels)
      .set({ credentials: { ...creds, gmail_cursor: cursor } })
      .where(eq(channels.id, channel.id));
  }
}

/** Renew Gmail Pub/Sub watches before they lapse (Google caps them at 7
 * days). Runs inside the sweeper's leader lock so only one instance renews.
 * Skips entirely when GMAIL_PUBSUB_TOPIC is unset. */
export async function renewGmailWatches(db: Db): Promise<void> {
  if (!env.gmailPubsubTopic) return;
  const renewBefore = Date.now() + 24 * 3600 * 1000; // re-watch a day early
  const rows = await db.select().from(channels).where(eq(channels.kind, 'gmail'));
  for (const channel of rows) {
    const creds = channel.credentials as ChannelCredentials;
    if (!creds.email_address || !creds.refresh_token) continue;
    if ((creds.gmail_watch_expiry ?? 0) > renewBefore) continue;
    try {
      const token = await ensureAccessToken(db, channel);
      const watch = await watchMailbox(token, env.gmailPubsubTopic);
      if (!watch) continue;
      await db
        .update(channels)
        .set({
          credentials: {
            ...(channel.credentials as ChannelCredentials),
            gmail_watch_expiry: watch.expirationMs,
            gmail_watch_history: watch.historyId,
          },
        })
        .where(eq(channels.id, channel.id));
    } catch (err) {
      console.error(`gmail watch ${channel.id} (${channel.name}):`, err);
    }
  }
}
