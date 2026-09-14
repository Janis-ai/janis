import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OutboundWebhook } from '@janis/shared';

/**
 * Verify a Janis webhook signature (Express/Hono/etc).
 *
 *   app.post('/janis/webhook', express.raw({type:'application/json'}), (req,res) => {
 *     if (!verifySignature(secret, req.headers['x-janis-signature'], req.body)) return res.sendStatus(401);
 *     const event = JSON.parse(req.body.toString()) as OutboundWebhook;
 *     ...
 *   })
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: string | Buffer,
): boolean {
  if (!header) return false;
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
  if (!match) return false;
  const [, timestamp, signature] = match;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export type { OutboundWebhook };
