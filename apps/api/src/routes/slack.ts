import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, memberships, messages, pendingActions, sessions, slackInstallations, slackPendingInstalls, slackThreads, suggestions } from '../db/schema.js';
import { env } from '../env.js';
import { adminOnly, sessionAuth, SESSION_COOKIE, type SessionEnv } from '../middleware/sessionAuth.js';
import { sha256 } from '../lib/crypto.js';
import { runHostedEvent } from '../lib/hostedAgent.js';
import { decidePendingAction } from '../lib/approvals.js';
import {
  createSlackChannel,
  findThread,
  getInstallation,
  installationsFor,
  inviteWorkspaceMembers,
  listSlackChannels,
  markThreadReply,
  postSlackMessage,
  sanitizeChannelName,
  slackApi,
  slackChannelInfo,
  slackUserToMember,
  verifyAvatarSig,
  verifySlackSignature,
} from '../lib/slack.js';
import { fetchAvatar } from '../lib/avatar.js';
import { membershipFor } from '../lib/members.js';
import { agentSend, humanReply, internalNote, resume, takeover, TakeoverError, teachAgent } from '../services/takeover.js';

type Installation = typeof slackInstallations.$inferSelect;

/** Optional installation_id query/body → that row if it belongs to this
 * workspace; absent → the default (earliest) installation. A foreign or stale
 * id resolves to undefined rather than silently falling back. */
async function installationById(
  db: Db,
  workspaceId: string,
  installationId?: string | null,
): Promise<Installation | undefined> {
  if (!installationId) return getInstallation(db, workspaceId);
  const [row] = await db
    .select()
    .from(slackInstallations)
    .where(
      and(eq(slackInstallations.id, installationId), eq(slackInstallations.workspaceId, workspaceId)),
    )
    .limit(1);
  return row;
}

// channel:ts → processed-at. Slack's overlapping event subscriptions deliver
// the same user message twice in parallel; this collapses them in-process.
// (payload.slack_ts covers retries that outlive a restart.)
const recentSlackEvents = new Map<string, number>();

// Keep in sync with REQUIRED_BOT_SCOPES in scripts/slack-manifest-sync.ts —
// the history scopes are what actually deliver the message.* event
// subscriptions to an install; the manifest declares them, this requests them.
const SCOPES = [
  'chat:write',
  'chat:write.public',
  'chat:write.customize', // per-message username/avatar in transcript mirrors
  'channels:read',
  'channels:history', // required for message.channels delivery
  'groups:read',
  'groups:history', // required for message.groups delivery
  'channels:manage', // invite assignees into the public alert channel
  'channels:join', // bot joins the public alert channel before inviting
  'groups:write', // same for private alert channels
  'im:write', // DM pointer when an assignee can't be invited
  'im:history', // required for message.im delivery
  'mpim:history', // required for message.mpim delivery
  'commands', // slash commands (/pause, /resume)
  'users:read',
  'users:read.email',
].join(',');

function oauthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env.slackClientId,
    scope: SCOPES,
    // installer's user token — chat:write lets us delete their own thread
    // replies (bots can't touch other users' messages) so styled mirrors
    // can replace them
    user_scope: 'chat:write',
    redirect_uri: `${env.apiOrigin}/slack/oauth/callback`,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

const STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_COOKIE = 'janis_slack_pending';
const PENDING_TTL_MS = 24 * 3600 * 1000;

/** OAuth state is HMAC-signed so nobody can forge a workspace binding:
 *  'dir.' states carry {w: workspaceId, u: installerUserId} for in-session
 *  installs; 'pub.' carries just an expiry for the public Add-to-Slack flow
 *  (the Marketplace listing's Install button arrives with no state at all). */
function signState(body: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify({ ...body, x: Date.now() + STATE_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', env.sessionSecret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyState<T>(token: string): T | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const i = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { x?: number };
    return i.x && i.x > Date.now() ? i : null;
  } catch {
    return null;
  }
}

/** Soft session check for public routes — resolves the active workspace when
 *  the installing browser happens to be signed in, without requiring it. */
async function sessionWorkspace(
  db: Db,
  cookieToken: string | undefined,
): Promise<{ workspaceId: string; userId: string } | null> {
  if (!cookieToken) return null;
  const [row] = await db
    .select({ userId: sessions.userId, workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(cookieToken)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  let wsId = row.workspaceId;
  if (!wsId) {
    const [mem] = await db
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(and(eq(memberships.userId, row.userId), isNotNull(memberships.acceptedAt)))
      .limit(1);
    wsId = mem?.workspaceId ?? null;
  }
  return wsId ? { workspaceId: wsId, userId: row.userId } : null;
}

/** Default the install's alert channel to an existing #janis-alerts, then
 *  any janis-* match (on a complete scan only — a partial list's first match
 *  is arbitrary, that's how a random j-* channel once became the default).
 *  Nothing found → left unset; Settings prompts rather than silently
 *  provisioning inside an OAuth redirect. */
async function chooseAlertChannel(db: Db, inst: Installation) {
  const { channels, complete } = await listSlackChannels(inst.botToken);
  const channelId =
    channels.find((ch) => ch.name === 'janis-alerts')?.id ??
    (complete ? channels.find((ch) => /janis/i.test(ch.name))?.id : undefined);
  if (channelId) {
    await db
      .update(slackInstallations)
      .set({ alertChannelId: channelId })
      .where(eq(slackInstallations.id, inst.id));
    void inviteWorkspaceMembers(db, inst, channelId);
  }
}

/** Session-authed management endpoints mounted at /api/slack. */
export function slackApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', async (c) => {
    const insts = await installationsFor(db, c.get('workspaceId'));
    const inst = insts[0]; // default = earliest connected
    return c.json({
      connected: !!inst,
      team_id: inst?.teamId ?? null,
      alert_channel_id: inst?.alertChannelId ?? null,
      installations: insts.map((i) => ({
        id: i.id,
        team_id: i.teamId,
        team_name: i.teamName,
        alert_channel_id: i.alertChannelId,
      })),
      configured: !!(env.slackClientId && env.slackClientSecret),
    });
  });

  // Navigate here in the browser (top-level GET → session cookie is sent).
  app.get('/install', adminOnly, (c) => {
    if (!env.slackClientId) return c.json({ error: 'SLACK_CLIENT_ID not configured' }, 503);
    const state = `dir.${signState({ w: c.get('workspaceId'), u: c.get('user').id })}`;
    return c.redirect(oauthUrl(state));
  });

  // Bind a Slack grant that completed while signed out (public install —
  // Marketplace listing or landing-page button) to this workspace. The
  // pending row id rides an httpOnly cookie set at OAuth callback; the app
  // shell calls this opportunistically after login — no-op when absent.
  app.post('/claim', adminOnly, async (c) => {
    const pendingId = getCookie(c, PENDING_COOKIE);
    deleteCookie(c, PENDING_COOKIE, { path: '/' });
    if (!pendingId) return c.json({ claimed: false });
    const [row] = await db
      .select()
      .from(slackPendingInstalls)
      .where(
        and(
          eq(slackPendingInstalls.id, pendingId),
          gt(slackPendingInstalls.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return c.json({ claimed: false });
    await db.delete(slackPendingInstalls).where(eq(slackPendingInstalls.id, row.id));
    // The team may have been bound meanwhile (someone else claimed it, or a
    // session-bound reinstall) — never double-bind.
    const [existing] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, row.teamId))
      .limit(1);
    if (existing) return c.json({ claimed: false, already_connected: true });
    const [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: c.get('workspaceId'),
        teamId: row.teamId,
        teamName: row.teamName,
        botToken: row.botToken,
        installerUserId: c.get('user').id,
        installerSlackUserId: row.installerSlackUserId,
        installerUserToken: row.installerUserToken,
      })
      .returning();
    await chooseAlertChannel(db, inst);
    return c.json({ claimed: true, team_name: row.teamName });
  });

  app.get('/channels', async (c) => {
    const workspaceId = c.get('workspaceId');
    const inst = await installationById(db, workspaceId, c.req.query('installation_id'));
    if (!inst) return c.json({ channels: [] });
    const { channels, complete } = await listSlackChannels(inst.botToken);
    // conversations.list can omit freshly created channels for a while —
    // resolve any selected channels that are missing so the picker shows
    // them instead of snapping back to "Pick alert channel…".
    const selected = new Set<string>();
    if (inst.alertChannelId) selected.add(inst.alertChannelId);
    const agentRows = await db
      .select({ routes: agents.slackRoutes })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    for (const a of agentRows) {
      for (const r of a.routes ?? []) {
        if (r.installation_id === inst.id && r.channel_id) selected.add(r.channel_id);
      }
    }
    const listed = new Set(channels.map((ch) => ch.id));
    for (const id of [...selected].filter((id) => !listed.has(id)).slice(0, 10)) {
      const info = await slackChannelInfo(inst.botToken, id, { rateLimitRetries: 2 });
      if (info) channels.push({ id: info.id, name: info.name });
    }
    return c.json({ channels, truncated: !complete });
  });

  app.patch(
    '/channel',
    adminOnly,
    zValidator(
      'json',
      z.object({ channel_id: z.string().min(1), installation_id: z.string().optional() }),
    ),
    async (c) => {
      const { channel_id: channelId, installation_id } = c.req.valid('json');
      const inst = await installationById(db, c.get('workspaceId'), installation_id);
      if (!inst) return c.json({ error: 'slack not connected' }, 404);
      await db
        .update(slackInstallations)
        .set({ alertChannelId: channelId })
        .where(eq(slackInstallations.id, inst.id));
      void inviteWorkspaceMembers(db, inst, channelId);
      return c.json({ ok: true });
    },
  );

  // Create a dedicated channel (e.g. #janis-alerts) and point alerts at it —
  // better than asking customers to repurpose #general. With agent_id the new
  // channel becomes that agent's own alert channel instead of the workspace
  // default.
  app.post(
    '/channel', adminOnly, zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(80),
        agent_id: z.string().optional(),
        installation_id: z.string().optional(),
      }),
    ),
    async (c) => {
      const { name: rawName, agent_id: agentId, installation_id: instParam } = c.req.valid('json');
      // installation_id picks the Slack workspace directly. With agent_id the
      // channel is created in that agent's first routed workspace (else the
      // default) and appended to its routes.
      let inst: Installation | undefined;
      if (instParam) {
        inst = await installationById(db, c.get('workspaceId'), instParam);
      } else if (agentId) {
        const [agent] = await db
          .select({ slackRoutes: agents.slackRoutes })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.workspaceId, c.get('workspaceId'))))
          .limit(1);
        if (!agent) return c.json({ error: 'agent not found' }, 404);
        inst = agent.slackRoutes?.[0]?.installation_id
          ? await installationById(db, c.get('workspaceId'), agent.slackRoutes[0].installation_id)
          : await getInstallation(db, c.get('workspaceId'));
      } else {
        inst = await getInstallation(db, c.get('workspaceId'));
      }
      if (!inst) return c.json({ error: 'slack not connected' }, 404);
      const name = sanitizeChannelName(rawName);
      if (!name) return c.json({ error: 'invalid channel name' }, 400);
      // The user typed this name — surface collisions instead of silently
      // creating #name-x3yz so they can rename in the dialog.
      const { channel, error: createErr } = await createSlackChannel(inst, name, {
        retryOnTaken: false,
      });
      if (!channel) {
        const msg =
          createErr === 'name_taken'
            ? `#${name} is already taken — pick another name`
            : createErr === 'missing_scope'
              ? `slack: ${createErr} — reconnect Slack to grant channel-creation permission`
              : `slack: ${createErr}`;
        return c.json({ error: msg }, 400);
      }
      if (agentId) {
        // Append the new channel to the agent's routes — creating a channel
        // in the picker means "send this agent's alerts here too".
        const [agent] = await db
          .select({ routes: agents.slackRoutes })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        const routes = [
          ...(agent?.routes ?? []),
          { installation_id: inst.id, channel_id: channel.id },
        ];
        await db
          .update(agents)
          .set({ slackRoutes: routes })
          .where(eq(agents.id, agentId));
      } else {
        await db
          .update(slackInstallations)
          .set({ alertChannelId: channel.id })
          .where(eq(slackInstallations.id, inst.id));
      }
      void inviteWorkspaceMembers(db, inst, channel.id, agentId);
      return c.json({ ok: true, channel });
    },
  );

  app.post('/test', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const posted = await postSlackMessage(
      db,
      workspaceId,
      ':white_check_mark: Janis is connected — agent alerts will arrive here.',
      { installationId: c.req.query('installation_id') },
    );
    if (!posted) return c.json({ error: 'no alert channel configured' }, 400);
    return c.json({ ok: true });
  });

  app.delete('/:id', adminOnly, async (c) => {
    const inst = await installationById(db, c.get('workspaceId'), c.req.param('id'));
    if (!inst) return c.json({ ok: true });
    // Strip this install from agent routes. An agent left with no
    // destinations reverts to inheriting the workspace default rather than
    // silently going dark.
    const routedAgents = await db
      .select({ id: agents.id, routes: agents.slackRoutes })
      .from(agents)
      .where(eq(agents.workspaceId, c.get('workspaceId')));
    for (const a of routedAgents) {
      if (!a.routes?.some((r) => r.installation_id === inst.id)) continue;
      const next = a.routes.filter((r) => r.installation_id !== inst.id);
      await db
        .update(agents)
        .set({ slackRoutes: next.length ? next : null })
        .where(eq(agents.id, a.id));
    }
    await db.delete(slackThreads).where(eq(slackThreads.installationId, inst.id));
    await db.delete(slackInstallations).where(eq(slackInstallations.id, inst.id));
    return c.json({ ok: true });
  });

  app.delete('/', adminOnly, async (c) => {
    for (const inst of await installationsFor(db, c.get('workspaceId'))) {
      await db.delete(slackThreads).where(eq(slackThreads.installationId, inst.id));
      await db.delete(slackInstallations).where(eq(slackInstallations.id, inst.id));
    }
    return c.json({ ok: true });
  });

  return app;
}

/** Relay a signed payload verbatim to wordhop-slack and pass its response
 * through — legacy surfaces (dialogs, menus, slash commands) keep working
 * while the app's request URLs point at us. */
async function forwardToLegacySlack(raw: string): Promise<Response> {
  if (!env.legacySlackInteractionsUrl) return Response.json({ ok: true });
  try {
    const res = await fetch(env.legacySlackInteractionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: raw,
      signal: AbortSignal.timeout(2500), // Slack's 3s ack budget
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    });
  } catch {
    return Response.json({ ok: true }); // legacy down — ack, don't retry-storm
  }
}

/** Public endpoints Slack calls directly (verified by signing secret). */
export function slackPublicRoutes(db: Db) {
  const app = new Hono();

  const verify = (c: { req: { header: (n: string) => string | undefined } }, rawBody: string) => {
    const ts = c.req.header('x-slack-request-timestamp');
    const sig = c.req.header('x-slack-signature');
    return (
      verifySlackSignature(env.slackSigningSecret, ts, sig, rawBody) ||
      (env.slackSigningSecretAlt
        ? verifySlackSignature(env.slackSigningSecretAlt, ts, sig, rawBody)
        : false)
    );
  };

  // Public install entry — the Marketplace listing's Install button and the
  // landing-page "Add to Slack" link. Signed workspace-free state; the
  // callback parks the grant until the installer signs in.
  app.get('/add', (c) => {
    if (!env.slackClientId) return c.text('Slack app not configured', 503);
    return c.redirect(oauthUrl(`pub.${signState({ p: 1 })}`));
  });

  // OAuth redirect target. State shapes: 'dir.<signed{w,u}>' (in-session
  // install), 'pub.<signed{p}>' (our /slack/add), or empty (Slack's listing
  // initiates installs with no state at all).
  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    if (!code) return c.text('missing code', 400);

    let workspaceId: string | undefined;
    let userId: string | undefined;
    if (state.startsWith('dir.')) {
      const s = verifyState<{ w?: string; u?: string }>(state.slice(4));
      if (!s?.w || !s.u) return c.text('invalid OAuth state', 400);
      workspaceId = s.w;
      userId = s.u;
    } else if (state === '') {
      // Marketplace listing install — no state; resolves via session/pending.
    } else if (state.startsWith('pub.')) {
      if (!verifyState<{ p?: number }>(state.slice(4))) return c.text('invalid OAuth state', 400);
    } else {
      return c.text('invalid OAuth state', 400);
    }

    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.slackClientId,
        client_secret: env.slackClientSecret,
        code,
        redirect_uri: `${env.apiOrigin}/slack/oauth/callback`,
      }),
    });
    const data = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id: string; name?: string };
      authed_user?: { id: string; access_token?: string };
    };
    if (!data.ok || !data.access_token || !data.team) {
      return c.text(`slack oauth failed: ${data.error ?? 'unknown'}`, 400);
    }

    // Public flows fall back to a soft session — a signed-in installer binds
    // to their active workspace without a dir. state.
    const sess = workspaceId
      ? null
      : await sessionWorkspace(db, getCookie(c, SESSION_COOKIE));
    workspaceId ??= sess?.workspaceId;
    userId ??= sess?.userId;

    // A Slack team binds to exactly one Janis workspace. Reinstalls refresh
    // the row (threads anchored on it die with the old token's channel
    // state); a team already owned by a DIFFERENT workspace is refused —
    // silently rebinding would leak that customer's alerts.
    const [existing] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, data.team.id))
      .limit(1);
    if (existing) {
      if (!workspaceId) {
        await db
          .update(slackInstallations)
          .set({
            botToken: data.access_token,
            installerSlackUserId: data.authed_user?.id ?? existing.installerSlackUserId,
            installerUserToken: data.authed_user?.access_token ?? existing.installerUserToken,
          })
          .where(eq(slackInstallations.id, existing.id));
        return c.text(
          `Slack is already connected to Janis${existing.teamName ? ` for ${existing.teamName}` : ''} — sign in to manage it.`,
        );
      }
      if (existing.workspaceId !== workspaceId) {
        return c.text(
          'That Slack workspace is already connected to a different Janis workspace — disconnect it there first.',
          409,
        );
      }
      await db.delete(slackThreads).where(eq(slackThreads.installationId, existing.id));
      await db.delete(slackInstallations).where(eq(slackInstallations.id, existing.id));
    }

    // New team, nobody signed in — park the grant; the installer claims it
    // into their workspace after sign-in via POST /api/slack/claim.
    if (!workspaceId) {
      const [pending] = await db
        .insert(slackPendingInstalls)
        .values({
          teamId: data.team.id,
          teamName: data.team.name ?? null,
          botToken: data.access_token,
          installerSlackUserId: data.authed_user?.id ?? null,
          installerUserToken: data.authed_user?.access_token ?? null,
          expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        })
        .returning();
      setCookie(c, PENDING_COOKIE, pending.id, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: PENDING_TTL_MS / 1000,
        secure: env.apiOrigin.startsWith('https'),
      });
      return c.redirect(`${env.webOrigin}/login?slack=pending`);
    }

    const [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId,
        teamId: data.team.id,
        teamName: data.team.name ?? null,
        botToken: data.access_token,
        installerUserId: userId || null,
        installerSlackUserId: data.authed_user?.id ?? null,
        installerUserToken: data.authed_user?.access_token ?? null,
        // a re-install of a migrated workspace keeps the cutover flag — the
        // fresh granular token upgrades scopes without handing traffic back
        migrated: existing?.migrated ?? false,
      })
      .returning();
    await chooseAlertChannel(db, inst);
    return c.redirect(`${env.webOrigin}/settings?slack=connected`);
  });

  // Events API: thread replies become human messages
  // HMAC-signed avatar proxy — Slack's image fetcher has no session, so
  // alert blocks embed /slack/avatar/:id?sig=… instead of the authed route.
  app.get('/avatar/:id', async (c) => {
    const id = c.req.param('id');
    if (!verifyAvatarSig(id, c.req.query('sig'))) return c.json({ error: 'unauthorized' }, 401);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conv) return c.json({ error: 'not found' }, 404);
    const avatar = await fetchAvatar(db, conv);
    if (!avatar) return c.json({ error: 'avatar unavailable' }, 404);
    return new Response(avatar.bytes, {
      headers: {
        'content-type': avatar.type,
        'cache-control': 'public, max-age=86400',
      },
    });
  });

  app.post('/events', async (c) => {
    const raw = await c.req.text();
    if (!verify(c, raw)) return c.text('invalid signature', 401);
    const body = JSON.parse(raw) as {
      type: string;
      challenge?: string;
      event?: {
        type: string;
        subtype?: string;
        bot_id?: string;
        user?: string;
        channel?: string;
        thread_ts?: string;
        ts?: string;
        text?: string;
      };
    };
    if (body.type === 'url_verification') return c.json({ challenge: body.challenge });
    if (body.type !== 'event_callback') return c.json({ ok: true });

    const ev = body.event;
    // Only user-authored thread replies (ignore bot echoes, edits, joins)
    if (!ev || ev.type !== 'message' || !ev.thread_ts || !ev.channel || !ev.user || !ev.text || !ev.ts) {
      return c.json({ ok: true });
    }
    if (ev.bot_id || ev.subtype) return c.json({ ok: true });

    // Slack redelivers the same message when subscriptions overlap (e.g.
    // message.channels + message.groups) — the copies arrive ~100ms apart
    // and raced straight through to duplicate transcript rows. The mark is
    // taken synchronously before any await so parallel deliveries collide.
    const evKey = `${ev.channel}:${ev.ts}`;
    if (recentSlackEvents.has(evKey)) return c.json({ ok: true });
    recentSlackEvents.set(evKey, Date.now());
    for (const [k, t] of recentSlackEvents) {
      if (Date.now() - t > 10 * 60 * 1000) recentSlackEvents.delete(k);
    }

    const found = await findThread(db, ev.channel, ev.thread_ts);
    if (!found) return c.json({ ok: true });
    // Any user-authored reply is the thread's newest message — "View thread"
    // permalinks point at lastReplyTs, so keep it current even for replies
    // that end up dropped below (non-member, archived, commands).
    await markThreadReply(db, ev.channel, ev.thread_ts, ev.ts).catch(() => {});
    const user = await slackUserToMember(db, found.installation, ev.user);
    if (!user) {
      // Channel member but not a Janis operator — tell them why nothing
      // happened rather than silently dropping the reply.
      await slackApi(found.installation.botToken, 'chat.postMessage', {
        channel: ev.channel,
        thread_ts: ev.thread_ts,
        text: `:no_entry: <@${ev.user}> isn't a member of this Janis workspace — ask an admin to invite them`,
      }).catch(() => {});
      return c.json({ ok: true });
    }

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, found.thread.conversationId))
      .limit(1);
    if (!conv || conv.state === 'archived') return c.json({ ok: true });

    // Durable dedupe — a stored row carrying this slack_ts means the event
    // was already ingested (covers retries after a deploy/restart, which the
    // in-memory map can't see).
    const [dup] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          sql`payload->>'slack_ts' = ${ev.ts}`,
        ),
      )
      .limit(1);
    if (dup) return c.json({ ok: true });

    try {
      // Thread vocabulary:
      //   /pause [N|forever]            → take over / extend the human window
      //   /resume                       → hand back to the agent
      //   /note <text> | note: <text>   → internal operator note (never sent to customer)
      //   /teach <text> | teach: <text> → append to agent knowledge (admin only)
      //   /agent <text>                 → deliver as the agent
      //   anything else                 → human reply to the customer
      // Slack can't invoke app slash commands inside threads — typed /pause
      // arrives as literal text, so parse it here with exact thread context.
      const isPause = /^\/pause\b/i.test(ev.text);
      const isResume = /^\/resume\b/i.test(ev.text);
      const noteText = /^(?:\/note\s+|note:\s*)(.+)$/is.exec(ev.text)?.[1]?.trim();
      const teachText = /^(?:\/teach\s+|teach:\s*)(.+)$/is.exec(ev.text)?.[1]?.trim();
      const asAgent = ev.text.startsWith('/agent ');
      const text = asAgent ? ev.text.slice('/agent '.length).trim() : noteText ?? teachText ?? ev.text;
      if (!text) return c.json({ ok: true });

      // Teach is permission-gated: members can reply and leave notes but only
      // admins may change what the agent knows.
      const teachMembership =
        teachText !== undefined
          ? await membershipFor(db, user.id, found.installation.workspaceId)
          : undefined;
      if (teachText !== undefined && teachMembership?.role !== 'admin') {
        await slackApi(found.installation.botToken, 'chat.postMessage', {
          channel: ev.channel,
          thread_ts: ev.thread_ts,
          text: `:no_entry: <@${ev.user}> only workspace admins can teach the agent`,
        }).catch(() => {});
        return c.json({ ok: true });
      }

      // Replace the raw reply with a styled transcript entry. Bot tokens can
      // only delete the bot's own messages — for anyone else's we need the
      // installer's user token (user_scope=chat:write at install): it deletes
      // whatever that user could delete in Slack, which for a workspace
      // admin is everyone's messages. When no token can delete it the raw
      // message stays and the mirror is skipped so nothing duplicates.
      const deleteToken = found.installation.installerUserToken ?? found.installation.botToken;
      const deleted = await slackApi(deleteToken, 'chat.delete', {
        channel: ev.channel,
        ts: ev.ts,
      })
        .then((r) => r.ok)
        .catch(() => false);

      if (isPause || isResume) {
        if (isPause) {
          const arg = ev.text.replace(/^\/pause\b/i, '').trim();
          let minutes: number | undefined;
          if (/^(unlimited|forever|infinity)$/i.test(arg)) minutes = -1;
          else if (arg) {
            const n = parseInt(arg, 10);
            if (Number.isFinite(n) && n > 0) minutes = n;
          }
          if (conv.state !== 'human') {
            await takeover(db, found.installation.workspaceId, conv.id, user);
          }
          await db
            .update(conversations)
            .set({
              humanSince: new Date(), // operator intent refreshes the window
              resumeWarnedAt: null,
              ...(minutes !== undefined ? { pauseMinutes: minutes } : {}),
            })
            .where(eq(conversations.id, conv.id));
          const span =
            minutes === -1
              ? 'until resumed manually'
              : minutes !== undefined
                ? `for ${minutes}m`
                : 'for the agent default';
          await slackApi(found.installation.botToken, 'chat.postMessage', {
            channel: ev.channel,
            thread_ts: ev.thread_ts,
            text: `:pause_button: <@${ev.user}> paused this conversation ${span}`,
          }).catch(() => {});
        } else if (conv.state === 'human') {
          await resume(db, found.installation.workspaceId, conv.id, user);
          await slackApi(found.installation.botToken, 'chat.postMessage', {
            channel: ev.channel,
            thread_ts: ev.thread_ts,
            text: `:arrow_forward: <@${ev.user}> resumed the agent`,
          }).catch(() => {});
        } else {
          await slackApi(found.installation.botToken, 'chat.postMessage', {
            channel: ev.channel,
            thread_ts: ev.thread_ts,
            text: `:information_source: the agent already owns this conversation`,
          }).catch(() => {});
        }
      } else if (noteText !== undefined) {
        await internalNote(db, found.installation.workspaceId, conv.id, user, text, !deleted, ev.ts);
      } else if (teachText !== undefined) {
        await teachAgent(db, found.installation.workspaceId, conv.id, user, text, !deleted, ev.ts);
      } else if (asAgent) {
        await agentSend(db, found.installation.workspaceId, conv.id, user, text, undefined, !deleted, ev.ts);
      } else {
        // Replying in the thread takes over implicitly if the agent still owns it
        if (conv.state !== 'human') {
          await takeover(db, found.installation.workspaceId, conv.id, user);
        }
        await humanReply(db, found.installation.workspaceId, conv.id, user, text, undefined, !deleted, ev.ts);
      }
    } catch (err) {
      if (!(err instanceof TakeoverError)) throw err;
    }
    return c.json({ ok: true });
  });

  // Interactive components: Take over / Resume buttons on alert messages
  app.post('/interactions', async (c) => {
    const raw = await c.req.text();
    if (!verify(c, raw)) return c.text('invalid signature', 401);
    const payloadParam = new URLSearchParams(raw).get('payload');
    if (!payloadParam) return c.json({ ok: true });
    const payload = JSON.parse(payloadParam) as {
      type: string;
      user?: { id: string };
      team?: { id?: string };
      team_id?: string;
      response_url?: string;
      actions?: { action_id: string; value?: string }[];
    };

    // Fan-out: the real Janis Slack app has ONE Interactivity URL serving both
    // systems during migration. Everything that isn't one of ours (janis_*
    // block_actions) belongs to wordhop-slack — legacy dialogs, training
    // buttons, followup menus — so relay the signed body verbatim and pass
    // through its response (dialog_submission returns validation errors this
    // way; block_actions ignore the body anyway).
    const isOurs =
      payload.type === 'block_actions' &&
      (payload.actions?.length ?? 0) > 0 &&
      payload.actions!.every((a) => a.action_id?.startsWith('janis_'));
    if (!isOurs) {
      // Cutover flag: migrated teams are owned by us — legacy is stood down,
      // so forwarding would double-handle (or dead-click) legacy payloads.
      const teamId = payload.team?.id ?? payload.team_id;
      if (teamId) {
        const [inst] = await db
          .select({ migrated: slackInstallations.migrated })
          .from(slackInstallations)
          .where(eq(slackInstallations.teamId, teamId))
          .limit(1);
        if (inst?.migrated) return c.json({ ok: true });
      }
      return forwardToLegacySlack(raw);
    }

    if (!payload.user) return c.json({ ok: true });
    const action = payload.actions![0];
    let convId = action.value;
    if (!convId) return c.json({ ok: true });
    // Approval buttons carry the pending_action id — resolve the conversation
    // through it
    if (
      action.action_id === 'janis_approve_action' ||
      action.action_id === 'janis_deny_action'
    ) {
      const [act] = await db
        .select({ conversationId: pendingActions.conversationId })
        .from(pendingActions)
        .where(eq(pendingActions.id, convId))
        .limit(1);
      convId = act?.conversationId;
      if (!convId) return c.json({ ok: true });
    }
    // Send carries the suggestion id — resolve the conversation through it
    if (
      action.action_id === 'janis_send_suggestion' ||
      action.action_id === 'janis_send_suggestion_human'
    ) {
      const [sug] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, convId))
        .limit(1);
      convId = sug?.conversationId;
      if (!convId) return c.json({ ok: true });
    }

    // Resolve workspace via the thread record (or conversation → agent chain)
    const [thread] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, convId))
      .limit(1);
    if (!thread) return c.json({ ok: true });
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, thread.installationId))
      .limit(1);
    if (!inst) return c.json({ ok: true });
    const user = await slackUserToMember(db, inst, payload.user.id);
    if (!user) {
      // Ephemeral denial via response_url — visible only to the clicker.
      if (payload.response_url) {
        await fetch(payload.response_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: ":no_entry: you're not a member of this Janis workspace — ask an admin to invite you",
          }),
        }).catch(() => {});
      }
      return c.json({ ok: true });
    }

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);
    const [agent] = conv
      ? await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1)
      : [];

    try {
      if (action.action_id === 'janis_takeover') {
        await takeover(db, inst.workspaceId, convId, user);
      } else if (
        action.action_id === 'janis_approve_action' ||
        action.action_id === 'janis_deny_action'
      ) {
        const approve = action.action_id === 'janis_approve_action';
        const decided = await decidePendingAction(
          db,
          action.value!,
          { id: user.id, name: user.name ?? 'teammate' },
          approve,
        );
        if ((decided === 'not-pending' || !decided) && payload.response_url) {
          await fetch(payload.response_url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              response_type: 'ephemeral',
              text: ':warning: that action was already decided',
            }),
          }).catch(() => {});
        } else if (decided && decided !== 'not-pending') {
          // Resume the agent so it can tell the customer the outcome.
          void runHostedEvent(db, decided.agent, {
            type: 'message.user',
            conversation_id: decided.conv.externalId,
            janis_conversation_id: decided.conv.id,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }
      } else if (action.action_id === 'janis_resume') {
        await resume(db, inst.workspaceId, convId, user);
      } else if (
        action.action_id === 'janis_send_suggestion' ||
        action.action_id === 'janis_send_suggestion_human'
      ) {
        // Deliver the drafted suggestion — as the agent, or as the operator
        // (auto-takes over first since humanReply requires human mode).
        const [sug] = await db
          .select()
          .from(suggestions)
          .where(eq(suggestions.id, action.value!))
          .limit(1);
        if (sug && conv) {
          if (action.action_id === 'janis_send_suggestion_human') {
            if (conv.state !== 'human') await takeover(db, inst.workspaceId, conv.id, user);
            await humanReply(db, inst.workspaceId, conv.id, user, sug.text);
          } else {
            await agentSend(db, inst.workspaceId, conv.id, user, sug.text);
          }
          // Delete the ephemeral draft — the mirrored send in the thread is
          // the record.
          if (payload.response_url) {
            await fetch(payload.response_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ delete_original: true }),
            });
          }
        }
        return c.json({ ok: true });
      } else if (action.action_id === 'janis_suggest' && conv && agent) {
        // Draft in the background (LLM takes seconds), then post the
        // suggestion ephemerally — visible only to the person who clicked.
        void (async () => {
          await runHostedEvent(db, agent, {
            type: 'suggestion.request',
            timestamp: new Date().toISOString(),
            conversation_id: conv.externalId,
            janis_conversation_id: conv.id,
          }).catch(() => {});
          const [sug] = await db
            .select()
            .from(suggestions)
            .where(eq(suggestions.conversationId, conv.id))
            .orderBy(desc(suggestions.createdAt))
            .limit(1);
          const res = await slackApi(inst.botToken, 'chat.postEphemeral', {
            channel: thread.channelId,
            thread_ts: thread.ts,
            user: payload.user!.id,
            text: sug
              ? `*Suggested reply:*\n${sug.text}`
              : "couldn't draft a suggestion right now",
            ...(sug
              ? {
                  blocks: [
                    {
                      type: 'section',
                      text: { type: 'mrkdwn', text: `*Suggested reply:*\n${sug.text}` },
                    },
                    {
                      type: 'actions',
                      elements: [
                        {
                          type: 'button',
                          action_id: 'janis_send_suggestion',
                          text: { type: 'plain_text', text: 'Send as agent' },
                          style: 'primary',
                          value: sug.id,
                        },
                        {
                          type: 'button',
                          action_id: 'janis_send_suggestion_human',
                          text: { type: 'plain_text', text: 'Send as me' },
                          value: sug.id,
                        },
                      ],
                    },
                  ],
                }
              : {}),
          });
          if (!res.ok) console.error('slack ephemeral failed:', res.error);
        })();
        return c.json({ ok: true });
      }
    } catch (err) {
      if (err instanceof TakeoverError) {
        await postSlackMessage(db, inst.workspaceId, `:warning: ${err.message}`, {
          channelId: thread.channelId,
          threadTs: thread.ts,
        });
      } else {
        throw err;
      }
    }

    // takeover()/resume() already refresh the alert message via updateSlackAlert
    return c.json({ ok: true });
  });

  // Slash commands: /pause [N|forever], /resume. Commands are channel-scoped —
  // no thread context — so in a mapped channel we act on the most recently
  // active conversation; anything we can't resolve forwards verbatim to
  // wordhop-slack, which serves legacy per-conversation channels.
  app.post('/commands', async (c) => {
    const raw = await c.req.text();
    if (!verify(c, raw)) return c.text('invalid signature', 401);
    const f = new URLSearchParams(raw);
    const command = f.get('command') ?? '';
    const channelId = f.get('channel_id') ?? '';
    const teamId = f.get('team_id') ?? '';
    const slackUserId = f.get('user_id') ?? '';
    const arg = f.get('text')?.trim() ?? '';

    if (command !== '/pause' && command !== '/resume') return forwardToLegacySlack(raw);

    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);
    if (!inst) return forwardToLegacySlack(raw);

    const user = await slackUserToMember(db, inst, slackUserId);
    if (!user) {
      if (inst.migrated) {
        return c.json({ response_type: 'ephemeral', text: ':warning: your Slack user is not a Janis operator' });
      }
      return forwardToLegacySlack(raw);
    }

    const candidates = await db
      .select({ conv: conversations })
      .from(slackThreads)
      .innerJoin(conversations, eq(slackThreads.conversationId, conversations.id))
      .where(
        and(
          eq(slackThreads.installationId, inst.id),
          eq(slackThreads.channelId, channelId),
          ne(conversations.state, 'archived'),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(20);

    // A conv with several alert threads in this channel joins once per
    // thread row — dedupe so it can't crowd out other conversations.
    const seen = new Set<string>();
    const convs = candidates
      .map((r) => r.conv)
      .filter((conv) => (seen.has(conv.id) ? false : (seen.add(conv.id), true)));

    // /pause: prefer the live takeover (re-pause updates duration), else the
    // most recent conversation. /resume only makes sense on a human conv.
    const target =
      command === '/pause'
        ? (convs.find((c) => c.state === 'human') ?? convs[0])
        : convs.find((c) => c.state === 'human');
    if (!target) {
      // Migrated teams are fully ours — legacy is stood down, so an
      // unresolvable channel gets a private warning instead of a forward.
      if (inst.migrated) {
        return c.json({
          response_type: 'ephemeral',
          text: ':warning: no active Janis conversation is linked to this channel',
        });
      }
      return forwardToLegacySlack(raw); // nothing of ours → maybe legacy
    }

    const displayName =
      (target.userProfile as { name?: string } | null)?.name ?? target.externalId;

    try {
      if (command === '/pause') {
        // /pause N | /pause forever | /pause (agent default)
        let minutes: number | undefined;
        if (/^(unlimited|forever|infinity)$/i.test(arg)) minutes = -1;
        else if (arg) {
          const n = parseInt(arg, 10);
          if (Number.isFinite(n) && n > 0) minutes = n;
        }
        if (target.state !== 'human') {
          await takeover(db, inst.workspaceId, target.id, user);
        }
        await db
          .update(conversations)
          .set({
            humanSince: new Date(), // operator intent refreshes the window
            resumeWarnedAt: null,
            ...(minutes !== undefined ? { pauseMinutes: minutes } : {}),
          })
          .where(eq(conversations.id, target.id));
        const span =
          minutes === -1
            ? 'until resumed manually'
            : minutes !== undefined
              ? `for ${minutes}m`
              : `for the agent default`;
        return c.json({ response_type: 'ephemeral', text: `⏸️ paused *${displayName}* ${span}` });
      }
      await resume(db, inst.workspaceId, target.id, user);
      return c.json({ response_type: 'ephemeral', text: `▶️ resumed the agent on *${displayName}*` });
    } catch (err) {
      if (err instanceof TakeoverError) {
        return c.json({ response_type: 'ephemeral', text: `:warning: ${err.message}` });
      }
      throw err;
    }
  });

  return app;
}
