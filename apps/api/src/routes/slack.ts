import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, slackInstallations, slackThreads } from '../db/schema.js';
import { env } from '../env.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import {
  findThread,
  getInstallation,
  postSlackMessage,
  slackApi,
  slackUserToMember,
  verifySlackSignature,
} from '../lib/slack.js';
import { humanReply, resume, takeover, TakeoverError } from '../services/takeover.js';

const SCOPES = [
  'chat:write',
  'chat:write.public',
  'channels:read',
  'groups:read',
  'users:read',
  'users:read.email',
].join(',');

function oauthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env.slackClientId,
    scope: SCOPES,
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
  app.get('/install', (c) => {
    if (!env.slackClientId) return c.json({ error: 'SLACK_CLIENT_ID not configured' }, 503);
    const state = `${c.get('workspaceId')}:${c.get('user').id}`;
    return c.redirect(oauthUrl(state));
  });

  app.get('/channels', async (c) => {
    const inst = await getInstallation(db, c.get('workspaceId'));
    if (!inst) return c.json({ channels: [] });
    const res = await slackApi<{ channels: { id: string; name: string }[] }>(
      inst.botToken,
      'conversations.list',
      { types: 'public_channel,private_channel', limit: 200 },
    );
    return c.json({ channels: res.ok ? res.channels : [] });
  });

  app.patch(
    '/channel',
    zValidator('json', z.object({ channel_id: z.string().min(1) })),
    async (c) => {
      const inst = await getInstallation(db, c.get('workspaceId'));
      if (!inst) return c.json({ error: 'slack not connected' }, 404);
      await db
        .update(slackInstallations)
        .set({ alertChannelId: c.req.valid('json').channel_id })
        .where(eq(slackInstallations.id, inst.id));
      return c.json({ ok: true });
    },
  );

  app.post('/test', async (c) => {
    const workspaceId = c.get('workspaceId');
    const posted = await postSlackMessage(
      db,
      workspaceId,
      ':white_check_mark: Janis is connected — agent alerts will arrive here.',
    );
    if (!posted) return c.json({ error: 'no alert channel configured' }, 400);
    return c.json({ ok: true });
  });

  app.delete('/', async (c) => {
    const inst = await getInstallation(db, c.get('workspaceId'));
    if (!inst) return c.json({ ok: true });
    await db.delete(slackThreads).where(eq(slackThreads.installationId, inst.id));
    await db.delete(slackInstallations).where(eq(slackInstallations.id, inst.id));
    return c.json({ ok: true });
  });

  return app;
}

/** Public endpoints Slack calls directly (verified by signing secret). */
export function slackPublicRoutes(db: Db) {
  const app = new Hono();

  const verify = (c: { req: { header: (n: string) => string | undefined } }, rawBody: string) =>
    verifySlackSignature(
      env.slackSigningSecret,
      c.req.header('x-slack-request-timestamp'),
      c.req.header('x-slack-signature'),
      rawBody,
    );

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
      })
      .returning();

    // Pick a sensible default alert channel
    const channels = await slackApi<{ channels: { id: string; name: string }[] }>(
      inst.botToken,
      'conversations.list',
      { types: 'public_channel,private_channel', limit: 200 },
    );
    const pick =
      channels.ok &&
      (channels.channels.find((ch) => /janis/i.test(ch.name)) ??
        channels.channels.find((ch) => ch.name === 'general'));
    if (pick) {
      await db
        .update(slackInstallations)
        .set({ alertChannelId: pick.id })
        .where(eq(slackInstallations.id, inst.id));
    }

    return c.redirect(`${env.webOrigin}/settings?slack=connected`);
  });

  // Events API: thread replies become human messages
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
    if (!ev || ev.type !== 'message' || !ev.thread_ts || !ev.channel || !ev.user || !ev.text) {
      return c.json({ ok: true });
    }
    if (ev.bot_id || ev.subtype) return c.json({ ok: true });

    const found = await findThread(db, ev.channel, ev.thread_ts);
    if (!found) return c.json({ ok: true });
    const user = await slackUserToMember(db, found.installation, ev.user);
    if (!user) return c.json({ ok: true });

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, found.thread.conversationId))
      .limit(1);
    if (!conv || conv.state === 'archived') return c.json({ ok: true });

    try {
      // Replying in the thread takes over implicitly if the agent still owns it
      if (conv.state !== 'human') {
        await takeover(db, found.installation.workspaceId, conv.id, user);
      }
      await humanReply(
        db,
        found.installation.workspaceId,
        conv.id,
        user,
        ev.text,
        undefined,
        true, // viaSlack — don't mirror back
      );
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
      actions?: { action_id: string; value?: string }[];
    };
    if (payload.type !== 'block_actions' || !payload.actions?.length || !payload.user) {
      return c.json({ ok: true });
    }
    const action = payload.actions[0];
    const convId = action.value;
    if (!convId) return c.json({ ok: true });

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
    if (!user) return c.json({ ok: true });

    try {
      if (action.action_id === 'janis_takeover') {
        await takeover(db, inst.workspaceId, convId, user);
      } else if (action.action_id === 'janis_resume') {
        await resume(db, inst.workspaceId, convId, user);
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
    return c.json({ ok: true });
  });

  return app;
}
