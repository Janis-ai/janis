import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channels } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toChannel } from '../lib/serializers.js';
import type { ChannelCredentials } from '../lib/channels.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const STATE_COOKIE = 'janis_meta_state';
const PENDING_TTL_MS = 15 * 60 * 1000;

// What the OAuth flow discovers about the user's Meta assets.
interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}
interface MetaWaba {
  id: string;
  name?: string;
  phone_numbers: { id: string; display_phone_number?: string }[];
}
interface PendingConnect {
  workspaceId: string;
  userToken: string;
  pages: MetaPage[];
  wabas: MetaWaba[];
  expiresAt: number;
}

// Short-lived in-memory store for OAuth results awaiting user selection.
// On restart the connect is simply retried.
const pending = new Map<string, PendingConnect>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}, 60_000).unref();

const SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_messages',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
].join(',');

async function graph<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

const linkBody = z.object({
  connect_id: z.string(),
  agent_id: z.string().uuid(),
  kind: z.enum(['messenger', 'instagram', 'whatsapp']),
  page_id: z.string().optional(),
  phone_number_id: z.string().optional(),
});

/** Console endpoints mounted at /api/meta (session auth, incl. OAuth callbacks). */
export function metaApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', (c) => c.json({ configured: Boolean(env.metaAppId && env.metaAppSecret) }));

  // Step 1: kick off Meta OAuth. Session cookie (SameSite=Lax) survives the
  // top-level redirect back from facebook.com.
  app.get('/connect', (c) => {
    if (!env.metaAppId || !env.metaAppSecret) {
      return c.json({ error: 'Meta app not configured (META_APP_ID/META_APP_SECRET)' }, 400);
    }
    const state = randomBytes(16).toString('hex');
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 });
    const url = new URL(`https://www.facebook.com/v21.0/dialog/oauth`);
    url.searchParams.set('client_id', env.metaAppId);
    url.searchParams.set('redirect_uri', `${env.apiOrigin}/api/meta/callback`);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  // Step 2: exchange code → long-lived user token → discover assets.
  app.get('/callback', async (c) => {
    const back = (msg: string) => c.redirect(`${env.webOrigin}/integrations?meta_error=${encodeURIComponent(msg)}`);
    const sent = c.req.query('state');
    const stored = getCookie(c, STATE_COOKIE);
    if (!sent || !stored || sent !== stored) return back('invalid OAuth state');
    const code = c.req.query('code');
    if (!code) return back(c.req.query('error_description') || 'authorization denied');

    const tok = await graph<{ access_token?: string }>(
      `/oauth/access_token?client_id=${env.metaAppId}&client_secret=${env.metaAppSecret}&redirect_uri=${encodeURIComponent(`${env.apiOrigin}/api/meta/callback`)}&code=${code}`,
      '',
    );
    if (!tok?.access_token) return back('token exchange failed');

    const long = await graph<{ access_token?: string }>(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.metaAppId}&client_secret=${env.metaAppSecret}&fb_exchange_token=${tok.access_token}`,
      '',
    );
    const userToken = long?.access_token ?? tok.access_token;

    // Pages (with their page access tokens + linked IG business accounts)
    const pages =
      (await graph<{ data?: MetaPage[] }>(
        `/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100`,
        userToken,
      ))?.data ?? [];

    // WhatsApp: businesses → owned WABAs → phone numbers. Best-effort — the
    // app may not have the WhatsApp product enabled.
    const wabas: MetaWaba[] = [];
    const businesses = (await graph<{ data?: { id: string }[] }>(`/me/businesses?limit=50`, userToken))?.data ?? [];
    for (const biz of businesses) {
      const list =
        (await graph<{ data?: { id: string; name?: string }[] }>(
          `/${biz.id}/owned_whatsapp_business_accounts?limit=50`,
          userToken,
        ))?.data ?? [];
      for (const w of list) {
        const phones =
          (await graph<{ data?: { id: string; display_phone_number?: string }[] }>(
            `/${w.id}/phone_numbers?limit=50`,
            userToken,
          ))?.data ?? [];
        wabas.push({ id: w.id, name: w.name, phone_numbers: phones });
      }
    }

    const id = randomBytes(12).toString('hex');
    pending.set(id, {
      workspaceId: c.get('workspaceId'),
      userToken,
      pages,
      wabas,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return c.redirect(`${env.webOrigin}/integrations?meta_connect=${id}`);
  });

  // Step 3: UI fetches discovered assets for the picker.
  app.get('/pending', (c) => {
    const p = pending.get(c.req.query('id') ?? '');
    if (!p || p.expiresAt < Date.now() || p.workspaceId !== c.get('workspaceId')) {
      return c.json({ error: 'connect session expired — start again' }, 404);
    }
    return c.json({
      pages: p.pages.map((pg) => ({
        id: pg.id,
        name: pg.name,
        instagram: pg.instagram_business_account
          ? { id: pg.instagram_business_account.id, username: pg.instagram_business_account.username }
          : null,
      })),
      whatsapp: p.wabas,
    });
  });

  // Step 4: link a discovered asset to an agent → channel + webhook subscribe.
  app.post('/link', zValidator('json', linkBody), async (c) => {
    const body = c.req.valid('json');
    const p = pending.get(body.connect_id);
    if (!p || p.expiresAt < Date.now() || p.workspaceId !== c.get('workspaceId')) {
      return c.json({ error: 'connect session expired — start again' }, 404);
    }
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, body.agent_id), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'agent not found' }, 404);

    let name = '';
    let pageToken = '';
    const credentials: ChannelCredentials = {
      via: 'oauth',
      verify_token: env.metaVerifyToken || randomBytes(16).toString('hex'),
    };

    if (body.kind === 'whatsapp') {
      const waba = p.wabas.find((w) => w.phone_numbers.some((n) => n.id === body.phone_number_id));
      const num = waba?.phone_numbers.find((n) => n.id === body.phone_number_id);
      if (!num) return c.json({ error: 'phone number not found in discovered assets' }, 400);
      name = num.display_phone_number ?? waba?.name ?? 'WhatsApp';
      credentials.phone_number_id = num.id;
      // A user token scoped whatsapp_business_messaging can send; a system-user
      // token is more durable for production — can be swapped later.
      credentials.access_token = p.userToken;

      const [row] = await db
        .insert(channels)
        .values({
          workspaceId: c.get('workspaceId'),
          agentId: agent.id,
          kind: body.kind,
          name,
          credentials,
        })
        .returning();
      return c.json({ channel: toChannel(row, agent.name) }, 201);
    }

    const page = p.pages.find((pg) => pg.id === body.page_id);
    if (!page) return c.json({ error: 'page not found in discovered assets' }, 400);
    pageToken = page.access_token;
    name = page.name;

    if (body.kind === 'instagram') {
      if (!page.instagram_business_account) {
        return c.json({ error: 'no Instagram business account linked to that page' }, 400);
      }
      credentials.page_id = page.instagram_business_account.id;
      name = page.instagram_business_account.username
        ? `@${page.instagram_business_account.username}`
        : `IG (${page.name})`;
    } else {
      credentials.page_id = page.id;
    }
    credentials.access_token = pageToken;

    const [row] = await db
      .insert(channels)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        kind: body.kind,
        name,
        credentials,
      })
      .returning();

    // Subscribe the page to our app's webhooks (messenger needs this; IG rides
    // on the page subscription too).
    await fetch(`${GRAPH}/${page.id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        subscribed_fields: 'messages,messaging_postbacks',
        access_token: pageToken,
      }),
    }).catch(() => {});

    return c.json({ channel: toChannel(row, agent.name) }, 201);
  });

  return app;
}
