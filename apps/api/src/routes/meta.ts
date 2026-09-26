import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channelBindings, channels, metaConnections } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toChannel } from '../lib/serializers.js';
import { setGetStartedButton, type ChannelCredentials } from '../lib/channels.js';

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

/**
 * Discover a user's pages (with IG accounts) and WhatsApp numbers.
 * Returns null when the user token itself is rejected (expired/revoked).
 */
async function discoverAssets(
  userToken: string,
): Promise<{ pages: MetaPage[]; wabas: MetaWaba[] } | null> {
  const pagesRes = await graph<{ data?: MetaPage[] }>(
    `/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100`,
    userToken,
  );
  if (!pagesRes) return null;

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
  return { pages: pagesRes.data ?? [], wabas };
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
  app.get('/connect', adminOnly, (c) => {
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
  app.get('/callback', adminOnly, async (c) => {
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

    // Persist the long-lived user token so the asset picker survives reloads.
    // /me gives the app-scoped user id that data-deletion callbacks use.
    const me = await graph<{ id?: string }>('/me?fields=id', userToken);
    const workspaceId = c.get('workspaceId');
    await db
      .insert(metaConnections)
      .values({ workspaceId, userToken, metaUserId: me?.id ?? null })
      .onConflictDoUpdate({
        target: metaConnections.workspaceId,
        set: { userToken, metaUserId: me?.id ?? null },
      });

    const assets = await discoverAssets(userToken);
    if (!assets) return back('Meta token rejected — try connecting again');

    const id = randomBytes(12).toString('hex');
    pending.set(id, {
      workspaceId,
      userToken,
      ...assets,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return c.redirect(`${env.webOrigin}/integrations?meta_connect=${id}`);
  });

  // Persistent session: if this workspace has a stored Meta token, re-discover
  // assets with it and mint a fresh pending id — no re-OAuth needed on reload.
  app.get('/session', async (c) => {
    const [conn] = await db
      .select()
      .from(metaConnections)
      .where(eq(metaConnections.workspaceId, c.get('workspaceId')))
      .limit(1);
    if (!conn) return c.json({ connected: false });
    const assets = await discoverAssets(conn.userToken);
    if (!assets) return c.json({ connected: false, expired: true });
    const id = randomBytes(12).toString('hex');
    pending.set(id, {
      workspaceId: c.get('workspaceId'),
      userToken: conn.userToken,
      ...assets,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return c.json({ connected: true, connect_id: id });
  });

  // Forget the stored Meta connection (e.g. to switch accounts).
  app.delete('/session', adminOnly, async (c) => {
    await db
      .delete(metaConnections)
      .where(eq(metaConnections.workspaceId, c.get('workspaceId')));
    return c.json({ ok: true });
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
  app.post('/link', adminOnly, zValidator('json', linkBody), async (c) => {
    const body = c.req.valid('json');
    const p = pending.get(body.connect_id);
    if (!p || p.expiresAt < Date.now() || p.workspaceId !== c.get('workspaceId')) {
      return c.json({ error: 'connect session expired — start again' }, 404);
    }
    // OAuth linking stays workspace-admin — it touches the shared Meta
    // connection; an agent-admin who isn't a workspace admin can't pull in
    // pages they shouldn't see.
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
      if (num.display_phone_number) {
        credentials.phone_number = num.display_phone_number.replace(/\D/g, '');
      }
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
      credentials.username = page.instagram_business_account.username;
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

    // Enable the page's Get Started button — its tap arrives as a
    // messaging_postback, which opens the conversation and fires the greeting.
    void setGetStartedButton(body.kind, credentials).catch(() => {});

    return c.json({ channel: toChannel(row, agent.name) }, 201);
  });

  return app;
}

// ---- Meta platform callbacks (public, app-secret signed) ----

const B64 = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/');

/** Verify a Meta signed_request (`b64url(sig).b64url(payload)`) and decode it. */
function parseSignedRequest(raw: string, secret: string): { user_id?: string } | null {
  const [sig, payload] = raw.split('.');
  if (!sig || !payload) return null;
  const got = Buffer.from(B64(sig), 'base64');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    return JSON.parse(Buffer.from(B64(payload), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const META_KINDS = ['messenger', 'instagram', 'whatsapp'] as const;

/**
 * Drop everything a Meta user's authorization produced: the stored user token,
 * and the Meta channels (with their conversation bindings) it created. Agent
 * transcripts stay — they belong to the workspace, not the Meta user.
 */
async function deleteMetaUserData(db: Db, metaUserId: string) {
  const [conn] = await db
    .select()
    .from(metaConnections)
    .where(eq(metaConnections.metaUserId, metaUserId))
    .limit(1);
  if (!conn) return;

  const metaChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.workspaceId, conn.workspaceId), inArray(channels.kind, [...META_KINDS])));
  const ids = metaChannels.map((ch) => ch.id);
  if (ids.length) {
    await db.delete(channelBindings).where(inArray(channelBindings.channelId, ids));
    await db.delete(channels).where(inArray(channels.id, ids));
  }
  await db.delete(metaConnections).where(eq(metaConnections.workspaceId, conn.workspaceId));
}

// Issued confirmation codes — deletions run synchronously, so every issued
// code is already 'completed' by the time the status page is fetched.
const deletionCodes = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [k, t] of deletionCodes) if (t < cutoff) deletionCodes.delete(k);
}, 3600_000).unref();

/** Public Meta callbacks mounted at /meta (no session — signed_request authed). */
export function metaPublicRoutes(db: Db) {
  const app = new Hono();

  const handleSignedRequest = async (c: Context) => {
    if (!env.metaAppSecret) return c.json({ error: 'Meta app not configured' }, 400);
    const body = await c.req.parseBody();
    const parsed =
      typeof body.signed_request === 'string'
        ? parseSignedRequest(body.signed_request, env.metaAppSecret)
        : null;
    if (!parsed?.user_id) return c.json({ error: 'invalid signed_request' }, 400);
    return parsed.user_id;
  };

  // Data Deletion Callback — Meta POSTs when a user requests deletion.
  app.post('/data-deletion', async (c) => {
    const userId = await handleSignedRequest(c);
    if (typeof userId !== 'string') return userId; // error response
    await deleteMetaUserData(db, userId);
    const code = `jd_${randomBytes(8).toString('hex')}`;
    deletionCodes.set(code, Date.now());
    return c.json({
      url: `${env.apiOrigin}/meta/data-deletion/status?code=${code}`,
      confirmation_code: code,
    });
  });

  app.get('/data-deletion/status', (c) => {
    const code = c.req.query('code');
    return c.json({ status: code && deletionCodes.has(code) ? 'completed' : 'not_found' });
  });

  // Deauthorize Callback — Meta POSTs when a user removes the app.
  app.post('/deauthorize', async (c) => {
    const userId = await handleSignedRequest(c);
    if (typeof userId !== 'string') return userId;
    await deleteMetaUserData(db, userId);
    return c.json({ ok: true });
  });

  return app;
}
