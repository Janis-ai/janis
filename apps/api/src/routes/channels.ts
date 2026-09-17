import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channelBindings, channels } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import {
  findChannelByObjectId,
  parseMetaWebhook,
  resolveChatIdentity,
  verifyMetaSignature,
  type ChannelCredentials,
} from '../lib/channels.js';
import { toChannel } from '../lib/serializers.js';
import { handleChannelMessage } from '../services/channelIngress.js';

const createChannel = z.object({
  kind: z.enum(['messenger', 'instagram', 'whatsapp']),
  name: z.string().min(1).max(120),
  agent_id: z.string().uuid(),
  page_id: z.string().optional(), // messenger / instagram
  phone_number_id: z.string().optional(), // whatsapp
  access_token: z.string().min(1),
  verify_token: z.string().optional(), // auto-generated if absent
});

/** Console endpoints mounted at /api/channels (session auth). */
export function channelApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select({ channel: channels, agentName: agents.name })
      .from(channels)
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .where(eq(channels.workspaceId, c.get('workspaceId')));
    await Promise.all(rows.map((r) => resolveChatIdentity(db, r.channel)));
    return c.json({ channels: rows.map((r) => toChannel(r.channel, r.agentName)) });
  });

  app.post('/', zValidator('json', createChannel), async (c) => {
    const body = c.req.valid('json');
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, body.agent_id), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (body.kind === 'whatsapp' && !body.phone_number_id) {
      return c.json({ error: 'phone_number_id required for whatsapp' }, 400);
    }
    if (body.kind !== 'whatsapp' && !body.page_id) {
      return c.json({ error: 'page_id required for messenger/instagram' }, 400);
    }

    const credentials: ChannelCredentials = {
      page_id: body.page_id,
      phone_number_id: body.phone_number_id,
      access_token: body.access_token,
      verify_token: body.verify_token || randomBytes(16).toString('hex'),
    };
    const [row] = await db
      .insert(channels)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: body.agent_id,
        kind: body.kind,
        name: body.name,
        credentials,
      })
      .returning();
    return c.json({ channel: toChannel(row, agent.name) }, 201);
  });

  app.delete('/:id', async (c) => {
    const [row] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, c.req.param('id')), eq(channels.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    // Bindings reference channels without cascade — remove them first.
    await db.delete(channelBindings).where(eq(channelBindings.channelId, row.id));
    await db.delete(channels).where(eq(channels.id, row.id));
    return c.json({ ok: true });
  });

  return app;
}

/** Public Meta webhook endpoints mounted at /channels (app-secret signed). */
export function channelWebhookRoutes(db: Db) {
  const app = new Hono();

  // Webhook verification — Meta sends this when you register the callback URL
  app.get('/meta/webhook', async (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode !== 'subscribe' || !token || !challenge) return c.text('bad request', 400);
    // OAuth channels share the app-level token; manual channels carry their own.
    if (env.metaVerifyToken && token === env.metaVerifyToken) return c.text(challenge);
    const all = await db.select().from(channels);
    const match = all.find(
      (ch) => (ch.credentials as ChannelCredentials).verify_token === token,
    );
    if (!match) return c.text('verify token mismatch', 403);
    return c.text(challenge);
  });

  // Message ingress — normalize, route to the owning channel, ingest
  app.post('/meta/webhook', async (c) => {
    const raw = await c.req.text();
    if (!verifyMetaSignature(env.metaAppSecret, raw, c.req.header('x-hub-signature-256'))) {
      return c.text('invalid signature', 401);
    }
    const msgs = parseMetaWebhook(JSON.parse(raw));
    let handled = 0;
    for (const msg of msgs) {
      const channel = await findChannelByObjectId(db, msg.objectId);
      if (channel) {
        await handleChannelMessage(db, channel, msg);
        handled++;
      }
    }
    // Legacy coexistence: while old and new Janis share the Meta app, relay
    // events for pages we don't own to the old system (raw body + signature).
    if (env.metaLegacyWebhookUrl && handled < msgs.length) {
      fetch(env.metaLegacyWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': c.req.header('x-hub-signature-256') ?? '',
        },
        body: raw,
      }).catch(() => {});
    }
    return c.json({ ok: true });
  });

  // Events relayed by the legacy broadcast API after it determined no
  // existing client owns this page. Signed with JANIS_RELAY_SECRET (our own
  // trusted hop), not Meta's app secret — the relay serves many Meta apps.
  app.post('/meta/relay', async (c) => {
    if (!env.janisRelaySecret) return c.text('relay not configured', 503);
    const raw = await c.req.text();
    if (
      !verifyMetaSignature(
        env.janisRelaySecret,
        raw,
        c.req.header('x-janis-relay-signature'),
      )
    ) {
      return c.text('invalid signature', 401);
    }
    const msgs = parseMetaWebhook(JSON.parse(raw));
    for (const msg of msgs) {
      const channel = await findChannelByObjectId(db, msg.objectId);
      if (channel) await handleChannelMessage(db, channel, msg);
    }
    return c.json({ ok: true });
  });

  return app;
}
