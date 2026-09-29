import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { mailSkipReason, parseFrom } from '../lib/email.js';
import {
  ensureMsToken,
  getMessage,
  listNewMessages,
  renewMailboxWatch,
  watchMailbox,
} from '../lib/outlook.js';
import { env } from '../env.js';
import { handleChannelMessage } from './channelIngress.js';
import { randomBytes } from 'node:crypto';

/** Poll every outlook channel for new inbox mail — mirrors sweepGmail.
 *  Per-channel failures isolated; cursor lives on channel credentials. */
export async function sweepOutlook(db: Db): Promise<void> {
  const rows = await db.select().from(channels).where(eq(channels.kind, 'outlook'));
  for (const channel of rows) {
    try {
      await pollOutlookChannel(db, channel);
    } catch (err) {
      console.error(`outlook poll ${channel.id} (${channel.name}):`, err);
    }
  }
}

export async function pollOutlookChannel(
  db: Db,
  channel: typeof channels.$inferSelect,
): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.email_address) return;
  const token = await ensureMsToken(db, channel);
  let cursor = creds.outlook_cursor ?? channel.createdAt.getTime();
  const listing = await listNewMessages(token, cursor);
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
      messageId: `outlook:${mail.id}`,
      user: { email: fromAddr },
      payload: {
        email: {
          subject: mail.subject,
          message_id: mail.rfcMessageId,
          thread_id: mail.conversationId,
        },
      },
    });
  }
  if (cursor !== creds.outlook_cursor) {
    await db
      .update(channels)
      .set({ credentials: { ...creds, outlook_cursor: cursor } })
      .where(eq(channels.id, channel.id));
  }
}

/** Renew Graph subscriptions before they lapse (~3-day cap). Creates one
 *  for channels that never got one. Skips when MS_PUSH_TOKEN is unset. */
export async function renewOutlookWatches(db: Db): Promise<void> {
  if (!env.msPushToken || !env.msClientId) return;
  const renewBefore = Date.now() + 24 * 3600 * 1000;
  const rows = await db.select().from(channels).where(eq(channels.kind, 'outlook'));
  for (const channel of rows) {
    const creds = channel.credentials as ChannelCredentials;
    if (!creds.email_address || !creds.refresh_token) continue;
    if ((creds.outlook_sub_expiry ?? 0) > renewBefore) continue;
    try {
      const token = await ensureMsToken(db, channel);
      let next = creds.outlook_sub_id
        ? await renewMailboxWatch(token, creds.outlook_sub_id)
        : null;
      let subId = creds.outlook_sub_id;
      if (!next) {
        // Renewal failed (sub expired/deleted) or never existed — create fresh.
        const watch = await watchMailbox(
          token,
          creds.outlook_client_state ?? randomBytes(16).toString('hex'),
        );
        if (!watch) continue;
        next = watch.expirationMs;
        subId = watch.id;
      }
      const nextCreds: ChannelCredentials = {
        ...(channel.credentials as ChannelCredentials),
        outlook_sub_id: subId,
        outlook_sub_expiry: next,
      };
      if (!nextCreds.outlook_client_state) {
        nextCreds.outlook_client_state = randomBytes(16).toString('hex');
      }
      await db
        .update(channels)
        .set({ credentials: nextCreds })
        .where(eq(channels.id, channel.id));
    } catch (err) {
      console.error(`outlook watch ${channel.id} (${channel.name}):`, err);
    }
  }
}
