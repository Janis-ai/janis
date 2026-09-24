import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, slackInstallations, slackThreads, suggestions } from '../db/schema.js';
import { env } from '../env.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { runHostedEvent } from '../lib/hostedAgent.js';
import {
  createSlackChannel,
  findThread,
  getInstallation,
  inviteWorkspaceMembers,
  listSlackChannels,
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

/** Session-authed management endpoints mounted at /api/slack. */
export function slackApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', async (c) => {
    const inst = await getInstallation(db, c.get('workspaceId'));
    return c.json({
      connected: !!inst,
      team_id: inst?.teamId ?? null,
      alert_channel_id: inst?.alertChannelId ?? null,
      configured: !!(env.slackClientId && env.slackClientSecret),
    });
  });

  // Navigate here in the browser (top-level GET → session cookie is sent).
  app.get('/install', adminOnly, (c) => {
    if (!env.slackClientId) return c.json({ error: 'SLACK_CLIENT_ID not configured' }, 503);
    const state = `${c.get('workspaceId')}:${c.get('user').id}`;
    return c.redirect(oauthUrl(state));
  });

  app.get('/channels', async (c) => {
    const workspaceId = c.get('workspaceId');
    const inst = await getInstallation(db, workspaceId);
    if (!inst) return c.json({ channels: [] });
    const channels = await listSlackChannels(inst.botToken);
    // conversations.list can omit freshly created channels for a while —
    // resolve any selected channels that are missing so the picker shows
    // them instead of snapping back to "Pick alert channel…".
    const selected = new Set<string>();
    if (inst.alertChannelId) selected.add(inst.alertChannelId);
    const agentRows = await db
      .select({ channelId: agents.slackChannelId })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    for (const a of agentRows) if (a.channelId) selected.add(a.channelId);
    const listed = new Set(channels.map((ch) => ch.id));
    for (const id of [...selected].filter((id) => !listed.has(id)).slice(0, 10)) {
      const info = await slackChannelInfo(inst.botToken, id);
      if (info) channels.push({ id: info.id, name: info.name });
    }
    return c.json({ channels });
  });

  app.patch(
    '/channel', adminOnly, zValidator('json', z.object({ channel_id: z.string().min(1) })),
    async (c) => {
      const inst = await getInstallation(db, c.get('workspaceId'));
      if (!inst) return c.json({ error: 'slack not connected' }, 404);
      const channelId = c.req.valid('json').channel_id;
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
      z.object({ name: z.string().min(1).max(80), agent_id: z.string().optional() }),
    ),
    async (c) => {
      const inst = await getInstallation(db, c.get('workspaceId'));
      if (!inst) return c.json({ error: 'slack not connected' }, 404);
      const { name: rawName, agent_id: agentId } = c.req.valid('json');
      const name = sanitizeChannelName(rawName);
      if (!name) return c.json({ error: 'invalid channel name' }, 400);
      if (agentId) {
        const [agent] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.workspaceId, inst.workspaceId)))
          .limit(1);
        if (!agent) return c.json({ error: 'agent not found' }, 404);
      }
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
        await db
          .update(agents)
          .set({ slackChannelId: channel.id })
          .where(eq(agents.id, agentId));
      } else {
        await db
          .update(slackInstallations)
          .set({ alertChannelId: channel.id })
          .where(eq(slackInstallations.id, inst.id));
      }
      void inviteWorkspaceMembers(db, inst, channel.id);
      return c.json({ ok: true, channel });
    },
  );

  app.post('/test', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const posted = await postSlackMessage(
      db,
      workspaceId,
      ':white_check_mark: Janis is connected — agent alerts will arrive here.',
    );
    if (!posted) return c.json({ error: 'no alert channel configured' }, 400);
    return c.json({ ok: true });
  });

  app.delete('/', adminOnly, async (c) => {
    const inst = await getInstallation(db, c.get('workspaceId'));
    if (!inst) return c.json({ ok: true });
    await db.delete(slackThreads).where(eq(slackThreads.installationId, inst.id));
    await db.delete(slackInstallations).where(eq(slackInstallations.id, inst.id));
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

  // OAuth redirect target
  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    const [workspaceId, userId] = state.split(':');
    if (!code || !workspaceId) return c.text('missing code/state', 400);

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
      team?: { id: string };
      authed_user?: { id: string; access_token?: string };
    };
    if (!data.ok || !data.access_token || !data.team) {
      return c.text(`slack oauth failed: ${data.error ?? 'unknown'}`, 400);
    }

    const [existing] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.workspaceId, workspaceId))
      .limit(1);
    if (existing) {
      await db.delete(slackThreads).where(eq(slackThreads.installationId, existing.id));
      await db.delete(slackInstallations).where(eq(slackInstallations.id, existing.id));
    }
    const [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId,
        teamId: data.team.id,
        botToken: data.access_token,
        installerUserId: userId || null,
        installerSlackUserId: data.authed_user?.id ?? null,
        installerUserToken: data.authed_user?.access_token ?? null,
        // a re-install of a migrated workspace keeps the cutover flag — the
        // fresh granular token upgrades scopes without handing traffic back
        migrated: existing?.migrated ?? false,
      })
      .returning();

    // Default to an existing Janis channel — #janis-alerts first, then any
    // janis-* match. When none exists we leave it unset: Settings prompts
    // the admin to confirm creating one (or pick an existing channel)
    // rather than silently provisioning inside an OAuth redirect.
    const channels = await listSlackChannels(inst.botToken);
    const channelId =
      channels.find((ch) => ch.name === 'janis-alerts')?.id ??
      channels.find((ch) => /janis/i.test(ch.name))?.id;
    if (channelId) {
      await db
        .update(slackInstallations)
        .set({ alertChannelId: channelId })
        .where(eq(slackInstallations.id, inst.id));
      void inviteWorkspaceMembers(db, inst, channelId);
    }

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
      // only delete the bot's own messages — for anyone else's we need their
      // user token (granted via user_scope at install). Without one the raw
      // message stays and the mirror is skipped so nothing duplicates.
      const deleteToken =
        ev.user === found.installation.installerSlackUserId && found.installation.installerUserToken
          ? found.installation.installerUserToken
          : found.installation.botToken;
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

    // /pause: prefer the live takeover (re-pause updates duration), else the
    // most recent conversation. /resume only makes sense on a human conv.
    const target =
      command === '/pause'
        ? (candidates.find((r) => r.conv.state === 'human')?.conv ?? candidates[0]?.conv)
        : candidates.find((r) => r.conv.state === 'human')?.conv;
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
