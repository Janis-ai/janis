import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import type { ChannelCredentials } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { MAX_UPLOAD_BYTES, storeUpload } from '../lib/uploads.js';
import { handleChannelMessage } from '../services/channelIngress.js';

/**
 * Public web-chat widget endpoints, mounted at /chat (no session auth).
 * The channel id is the public token; the visitor id (crypto-random, stored
 * in the visitor's browser) is the transcript credential.
 */
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

const attachment = z.object({
  name: z.string().max(255),
  url: z.string().regex(/^\/uploads\//),
  type: z.string().max(100),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
});

const postMessage = z
  .object({
    visitor_id: z.string().regex(VISITOR_RE),
    text: z.string().max(4000).default(''),
    name: z.string().max(80).optional(),
    attachments: z.array(attachment).max(5).optional(),
  })
  .refine((d) => d.text.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'text or attachments required',
  });

async function findChannel(db: Db, token: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, token), eq(channels.kind, 'webchat')))
    .limit(1);
  return channel;
}

/** Conversation bound to this channel + visitor, if one exists. */
async function findConversation(db: Db, channelId: string, visitorId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channelId),
        eq(channelBindings.platformUserId, visitorId),
      ),
    )
    .limit(1);
  return row?.conversation;
}

export function webchatRoutes(db: Db) {
  const app = new Hono();

  // Widget bootstrap — display config only; credentials never leave the API.
  app.get('/:token', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1);
    const creds = channel.credentials as ChannelCredentials;
    const agentCfg = (agent?.config ?? {}) as { quick_replies?: string[] };
    const agentReplies = agentCfg.quick_replies ?? [];
    // Same resolver as ingress so the widget's greeting matches the one
    // stored on the transcript (generated greetings are cached per channel).
    const greeting = await resolveGreeting(channel, agent);
    return c.json({
      name: channel.name,
      agent_name: agent?.name ?? 'Assistant',
      title: creds.title ?? channel.name,
      subtitle: creds.subtitle ?? null,
      greeting,
      accent: creds.accent ?? null,
      position: creds.position === 'left' ? 'left' : 'right',
      logo_url: creds.logo_url ?? null,
      // channel-level override wins; agent config is the default
      quick_replies: creds.quick_replies?.length ? creds.quick_replies : agentReplies,
    });
  });

  // Send a visitor message — runs through the same ingest/agent pipeline.
  app.post('/:token/messages', zValidator('json', postMessage), async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const { visitor_id, text, name, attachments } = c.req.valid('json');
    await handleChannelMessage(db, channel, {
      objectId: '',
      senderId: visitor_id,
      text,
      name,
      attachments,
    });
    return c.json({ ok: true });
  });

  // Widget file upload — same storage as console uploads, but scoped to a
  // live channel + well-formed visitor id instead of a session. URL comes
  // back relative; the widget prefixes its API origin, and attachments are
  // only accepted into messages if they point at /uploads/*.
  app.post('/:token/uploads', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const body = await c.req.parseBody();
    const visitorId = typeof body['visitor_id'] === 'string' ? body['visitor_id'] : '';
    if (!VISITOR_RE.test(visitorId)) return c.json({ error: 'bad visitor_id' }, 400);
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const ref = await storeUpload(db, {
      name: file.name,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(ref, 201);
  });

  // Poll for messages. ?visitor_id= (required) & after=<ISO timestamp>.
  // Only direction/text/created_at are exposed — never payloads or internals.
  app.get('/:token/messages', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const visitorId = c.req.query('visitor_id') ?? '';
    if (!VISITOR_RE.test(visitorId)) return c.json({ error: 'bad visitor_id' }, 400);
    const conv = await findConversation(db, channel.id, visitorId);
    if (!conv) return c.json({ messages: [], state: 'new' });

    const after = c.req.query('after');
    const afterDate = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
    const rows = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        text: messages.text,
        created_at: messages.createdAt,
        payload: messages.payload,
        flags: messages.flags,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          ...(afterDate ? [gte(messages.createdAt, afterDate)] : []),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(200);
    return c.json({
      // Internal notes (failures/handoffs/alerts) are stored as 'out' but must
      // never reach the visitor — filter them here, same as deliverToChannel does.
      messages: rows
        .filter((m) => {
          const f = (m.flags ?? {}) as { failure?: boolean; help_requested?: boolean; custom_alert?: boolean };
          // via:'greeting' rows are real transcript messages, but the widget
          // renders its own greeting from the bootstrap — don't double it.
          const via = (m.payload as { via?: string } | undefined)?.via;
          return !f.failure && !f.help_requested && !f.custom_alert && via !== 'greeting';
        })
        .map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        created_at: m.created_at.toISOString(),
        attachments: (m.payload as { attachments?: unknown[] } | undefined)?.attachments,
      })),
      state: conv.state,
    });
  });

  return app;
}
