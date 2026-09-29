import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { validTwilioSignature } from '../lib/twilio.js';
import { applySmsOpt, smsOptKeyword } from '../lib/optout.js';
import { env } from '../env.js';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio messaging webhook. The number's SmsUrl points at
 * POST /sms/:channelId. Unlike voice there's no live socket — the customer
 * sends a text, it lands in the inbox, and replies go out via the REST
 * Messages API through the normal deliverToChannel path. Twilio retries
 * webhook posts that 5xx, so failures before ingest are not lost.
 *
 *     sms → Twilio → POST /sms/:channelId → handleChannelMessage → inbound
 */
export function smsRoutes(db: Db) {
  const app = new Hono();

  app.post('/:channelId', async (c) => {
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, c.req.param('channelId')), eq(channels.kind, 'sms')))
      .limit(1);
    if (!channel) return c.text('not found', 404);

    const creds = channel.credentials as ChannelCredentials;
    // Twilio signs the exact URL it called — env.apiOrigin + path + query.
    const req = new URL(c.req.url);
    const url = `${env.apiOrigin}${req.pathname}${req.search}`;
    const raw = await c.req.parseBody() as Record<string, unknown>;
    const body = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    if (!validTwilioSignature(url, body, c.req.header('X-Twilio-Signature'), creds.twilio_auth_token ?? '')) {
      return c.text('bad signature', 401);
    }

    const from = body.From ?? '';
    const text = body.Body ?? '';
    if (!from || (!text && !body.NumMedia)) return c.text(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });

    // CTIA opt keywords intercept before ingest — STOP marks the identity
    // opted-out (sendOutbound refuses thereafter) and never wakes the agent.
    if (await applySmsOpt(db, channel, from, text, body.MessageSid)) {
      const reply =
        smsOptKeyword(text) === 'out'
          ? 'You have been unsubscribed and will not receive further messages. Reply START to resubscribe.'
          : 'You have been resubscribed to messages.';
      return c.text(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`,
        200,
        { 'Content-Type': 'text/xml' },
      );
    }

    await handleChannelMessage(db, channel, {
      objectId: creds.phone_number ?? channel.id,
      senderId: from,
      text,
      messageId: body.MessageSid,
      attachments: Number(body.NumMedia ?? 0) > 0 && body.MediaUrl0
        ? [{
            name: 'attachment',
            url: body.MediaUrl0,
            type: body.MediaContentType0 ?? 'application/octet-stream',
            size: 0,
          }]
        : undefined,
      payload: {
        via: 'sms',
        message_sid: body.MessageSid,
        to: body.To,
      },
    });
    return c.text(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });
  });

  return app;
}
