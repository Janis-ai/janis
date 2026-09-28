import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { channelBindings, channels, conversations } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { handleChannelMessage } from '../services/channelIngress.js';
import { voiceAwaitReply, voiceEndCall } from '../lib/voiceBridge.js';
import { env } from '../env.js';

/**
 * Twilio Voice channel — turn-based IVR-style voice on the existing text
 * pipeline: <Gather input="speech"> transcribes the caller, the hosted agent
 * (or an operator's queued replies) answers, and the reply is spoken back
 * with <Say>. A call = the caller's existing conversation (keyed on their
 * E.164 number), so voice and text share one transcript and the inbox.
 *
 * Twilio console setup (shown in the channel card):
 *   Voice → "A call comes in":        POST {origin}/voice/:channelId/incoming
 *   Status changes (optional):        POST {origin}/voice/:channelId/status
 */

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAY = (t: string) => `<Say voice="Polly.Joanna">${escapeXml(t)}</Say>`;

const gather = (channelId: string) =>
  `<Gather input="speech" action="/voice/${channelId}/turn" method="POST" speechTimeout="auto" timeout="6" />`;

const twiml = (c: Context, inner: string) =>
  c.text(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, 200, {
    'Content-Type': 'text/xml',
  });

/** Twilio signs URL + alphabetically-sorted POST params with the auth token. */
function validSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (!signature || !authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function voiceRoutes(db: Db, opts?: { replyWaitMs?: number }) {
  const replyWaitMs = opts?.replyWaitMs ?? 12_000;
  const app = new Hono();

  // Every webhook resolves its channel, validates Twilio's signature against
  // the channel's own auth token, then branches.
  async function resolve(c: Context) {
    const channelId = c.req.param('channelId');
    if (!channelId) return null;
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.kind, 'voice')))
      .limit(1);
    if (!channel) return null;
    const creds = channel.credentials as ChannelCredentials;
    const body = ((await c.req.parseBody().catch(() => ({}))) ?? {}) as Record<string, string>;
    // Twilio signs the exact URL it called — env.apiOrigin + path + query.
    const req = new URL(c.req.url);
    const url = `${env.apiOrigin}${req.pathname}${req.search}`;
    if (!validSignature(url, body, c.req.header('X-Twilio-Signature'), creds.twilio_auth_token ?? ''))
      return null;
    return { channel, creds, body };
  }

  async function convForCaller(channelId: string, caller: string) {
    const [bound] = await db
      .select({ conv: conversations })
      .from(channelBindings)
      .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
      .where(
        and(eq(channelBindings.channelId, channelId), eq(channelBindings.platformUserId, caller)),
      )
      .limit(1);
    return bound?.conv;
  }

  app.post('/:channelId/incoming', async (c) => {
    const r = await resolve(c);
    if (!r) return c.text('forbidden', 403);
    const greeting = r.creds.greeting ?? 'Hi, thanks for calling. How can I help you today?';
    return twiml(c, SAY(greeting) + gather(r.channel.id));
  });

  app.post('/:channelId/turn', async (c) => {
    const r = await resolve(c);
    if (!r) return c.text('forbidden', 403);
    const { channel, creds, body } = r;
    const caller = body.From ?? '';
    const speech = (body.SpeechResult ?? '').trim();
    const redirects = Number(new URL(c.req.url).searchParams.get('r') ?? '0');

    if (speech && caller) {
      // Caller spoke — run it through the normal pipeline: stores the inbound
      // message, kicks the hosted agent, and the reply lands in voiceBridge.
      // Awaited so a first-time caller's conversation+binding exists before
      // the lookup below.
      await handleChannelMessage(db, channel, {
        objectId: creds.phone_number ?? channel.id,
        senderId: caller,
        text: speech,
        payload: { via: 'voice', call_sid: body.CallSid },
      }).catch(() => {});
    }

    // Conversation = the caller's phone-number binding on this channel.
    const conv = caller ? await convForCaller(channel.id, caller) : undefined;

    // A human owns the thread — hand the call off for real if a forward
    // number is configured, else promise a callback. <Dial> bridges the live
    // call to the operator's phone; nothing else needs to happen here.
    if (conv?.state === 'human') {
      if (creds.forward_to) {
        return twiml(
          c,
          SAY('Let me connect you to a teammate now.') +
            `<Dial>${escapeXml(creds.forward_to)}</Dial>`,
        );
      }
      return twiml(
        c,
        SAY('A teammate will call you back shortly. Goodbye.') + '<Hangup/>',
      );
    }

    if (!conv) {
      return twiml(c, SAY('Sorry, something went wrong. Goodbye.') + '<Hangup/>');
    }

    // Wait for the agent's reply (or queued operator replies) — Twilio holds
    // the line while we answer. ~12s keeps inside Twilio's webhook timeout.
    const replies = await voiceAwaitReply(conv.id, replyWaitMs);
    const text = replies.join(' ').trim();
    if (text) {
      return twiml(c, SAY(text) + gather(channel.id));
    }
    // Nothing yet — the agent is still thinking. Loop back; queued replies
    // drain at the top of the next pass. Bail after 5 empty polls.
    if (redirects >= 5) {
      return twiml(
        c,
        SAY("I'm having trouble right now — a teammate will follow up with you. Goodbye.") +
          '<Hangup/>',
      );
    }
    return twiml(
      c,
      SAY('One moment…') +
        `<Redirect method="POST">/voice/${channel.id}/turn?r=${redirects + 1}</Redirect>`,
    );
  });

  // Optional — wire "Call status changes" in the Twilio console to this.
  // Hangup mid-thought leaves waiters hanging; flush them here.
  app.post('/:channelId/status', async (c) => {
    const r = await resolve(c);
    if (!r) return c.text('forbidden', 403);
    if (['completed', 'failed', 'busy', 'no-answer'].includes(r.body.CallStatus ?? '')) {
      const conv = r.body.From ? await convForCaller(r.channel.id, r.body.From) : undefined;
      if (conv) voiceEndCall(conv.id);
    }
    return c.json({ ok: true });
  });

  return app;
}
