import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { isDaemonAddress, parseFrom } from '../lib/email.js';
import { ensureAccessToken, getMessage, listNewMessages } from '../lib/gmail.js';
import { handleChannelMessage } from './channelIngress.js';

/** Poll every gmail channel for new inbox mail. Runs on the sweeper tick —
 * per-channel failures are isolated so a revoked grant can't stall others.
 * The cursor (last-ingested internalDate) is stored on the channel itself;
 * overlapping windows dedup on `gmail:{api-id}` mids downstream. */
export async function sweepGmail(db: Db): Promise<void> {
  const rows = await db.select().from(channels).where(eq(channels.kind, 'gmail'));
  for (const channel of rows) {
    try {
      await pollChannel(db, channel);
    } catch (err) {
      console.error(`gmail poll ${channel.id} (${channel.name}):`, err);
    }
  }
}

async function pollChannel(db: Db, channel: typeof channels.$inferSelect): Promise<void> {
  const creds = channel.credentials as ChannelCredentials;
  if (!creds.email_address) return;
  const token = await ensureAccessToken(db, channel);
  // No cursor yet (channels predating the field) → start at channel creation,
  // never the whole mailbox backlog.
  let cursor = creds.gmail_cursor ?? channel.createdAt.getTime();
  const listing = await listNewMessages(token, cursor);
  for (const stub of listing) {
    const mail = await getMessage(token, stub.id);
    if (!mail) continue;
    if (mail.internalMs > cursor) cursor = mail.internalMs;

    const { name: fromName, address: fromAddr } = parseFrom(mail.from);
    if (
      !fromAddr ||
      mail.autoSubmitted ||
      isDaemonAddress(fromAddr) ||
      fromAddr === creds.email_address.toLowerCase()
    ) {
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
