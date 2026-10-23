import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alerts, channelBindings, channels, conversations, memberships, messages, pendingActions, sessions, slackClassicChannels, slackClassicPrefs, slackInstallations, slackMemberLinks, slackPendingInstalls, slackThreads, users, workspaces } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { slackApiRoutes, slackPublicRoutes } from './slack.js';
import { setLegacyOps, setLegacyTeamLookup } from '../lib/legacyMongo.js';
import { findThread, mirrorToSlack, postSlackAlert, removeMemberFromAlertChannels, resetChannelScanCache, slackMrkdwn, slackToCanonical, slackWidgetBlocks, syncMemberToAlertChannels } from '../lib/slack.js';
import { env } from '../env.js';

let app: Hono;
let db: Db;
const SECRET = 'test-signing-secret';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/slack', slackPublicRoutes(db));
  env.slackSigningSecret = SECRET;
  env.legacySlackInteractionsUrl = 'https://legacy-slack.test/slack/receive';
});

beforeEach(() => {
  vi.unstubAllGlobals();
  setLegacyTeamLookup(undefined);
  setLegacyOps(undefined);
  // channel scans cache per bot token — tests reuse token strings
  resetChannelScanCache();
});

function signedPost(body: string, path = '/slack/interactions') {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

describe('interactions fan-out', () => {
  it('forwards non-janis payloads verbatim to wordhop-slack and relays the response', async () => {
    const payload = JSON.stringify({
      type: 'dialog_submission',
      callback_id: 'training_dialog',
      user: { id: 'U1' },
      team: { id: 'T1' },
    });
    const raw = `payload=${encodeURIComponent(payload)}`;

    const fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ errors: [{ name: 'x', error: 'bad' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ errors: [{ name: 'x', error: 'bad' }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://legacy-slack.test/slack/receive');
    expect(init?.body).toBe(raw); // verbatim — signature still validates downstream
  });

  it('forwards legacy-format interactive_message payloads too', async () => {
    const payload = JSON.stringify({
      type: 'interactive_message',
      callback_id: 'followup_yes',
      actions: [{ name: 'yes', value: '1' }],
      user: { id: 'U1' },
    });
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles janis_* block_actions itself — no forward', async () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U_NOBODY' },
      actions: [{ action_id: 'janis_takeover', value: '00000000-0000-0000-0000-000000000000' }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    // Slack renders a non-empty block_actions body as message text — the ack
    // must be empty so no {"ok":true} leaks into the channel.
    expect(await res.text()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acks instead of forwarding when no legacy URL is configured', async () => {
    const saved = env.legacySlackInteractionsUrl;
    env.legacySlackInteractionsUrl = '';
    try {
      const payload = JSON.stringify({ type: 'dialog_submission', user: { id: 'U1' } });
      const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      env.legacySlackInteractionsUrl = saved;
    }
  });

  it('acks migrated teams without forwarding to legacy', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Migrated WS' }).returning();
    await db.insert(slackInstallations).values({
      workspaceId: ws.id,
      teamId: 'T_MIG',
      botToken: 'xoxb-mig',
      migrated: true,
    });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const payload = JSON.stringify({
      type: 'interactive_message',
      team: { id: 'T_MIG' },
      user: { id: 'U1' },
      actions: [{ name: 'training_yes' }],
    });
    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acks when the legacy endpoint is unreachable', async () => {
    const payload = JSON.stringify({ type: 'dialog_submission', user: { id: 'U1' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('slash commands', () => {
  let convId: string;

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'WS' }).returning();
    const [admin] = await db
      .insert(users)
      .values({ email: 'op@x.c', name: 'Op', slackUserId: 'U_OP' })
      .returning();
    await db.insert(memberships).values({
      userId: admin.id,
      workspaceId: ws.id,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'cmd-conv' })
      .returning();
    convId = conv.id;
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_NEW', botToken: 'xoxb-test', installerUserId: admin.id })
      .returning();
    await db
      .insert(slackThreads)
      .values({ conversationId: conv.id, installationId: inst.id, channelId: 'CALERT', ts: '1.0' });
  });

  const command = (body: Record<string, string>) =>
    signedPost(new URLSearchParams(body).toString(), '/slack/commands');

  it('/pause takes over the most recent conversation in the channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{"ok":false}'))));
    const res = await command({ command: '/pause', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toContain('paused');
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    expect(conv.pauseMinutes).toBeNull(); // no arg → agent default
  });

  it('/pause forever pins the takeover', async () => {
    const res = await command({ command: '/pause', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: 'forever' });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    expect(conv.pauseMinutes).toBe(-1);
  });

  it('/resume releases it', async () => {
    const res = await command({ command: '/resume', channel_id: 'CALERT', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('active');
    expect(conv.pauseMinutes).toBeNull();
  });

  it('a second alert posts top-level but links into the canonical thread', async () => {
    // one thread per conversation — the fresh alert is a top-level channel
    // post for visibility, with a "View thread" permalink button, but it
    // does NOT anchor a new thread; its ts is stored on the alert so its
    // buttons can be refreshed on takeover/resume
    await db
      .update(slackInstallations)
      .set({ alertChannelId: 'CALERT' })
      .where(eq(slackInstallations.teamId, 'T_NEW'));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        if (String(url).includes('chat.getPermalink')) {
          return new Response(
            '{"ok":true,"permalink":"https://t.slack.com/archives/CALERT/p1000"}',
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{"ok":true,"channel":"CALERT","ts":"9.9"}', { status: 200 });
      }),
    );
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId));
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'help_request', detail: 're-escalated' })
      .returning();
    await postSlackAlert(db, agent.workspaceId, conv, agent, alert);

    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    // fresh top-level alert in the channel…
    const topLevel = posts.filter((p) => p.body.channel === 'CALERT' && !p.body.thread_ts);
    expect(topLevel.length).toBe(1);
    // …with a "View thread" button pointing at the canonical thread permalink
    const blocks = topLevel[0].body.blocks as { elements?: { url?: string; action_id?: string }[] }[];
    const threadBtn = blocks
      .flatMap((b) => b.elements ?? [])
      .find((e) => e.action_id === 'janis_view_thread');
    expect(threadBtn?.url).toBe(
      'https://t.slack.com/archives/CALERT/p1000?thread_ts=1.0&cid=CALERT',
    );
    // nothing posted into the thread, and no new thread registered
    expect(posts.some((p) => p.body.thread_ts === '1.0')).toBe(false);
    const rows = await db.select().from(slackThreads).where(eq(slackThreads.conversationId, convId));
    expect(rows.map((r) => r.ts)).toEqual(['1.0']);
    // the card's ts is stored for button refreshes
    const [stored] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(stored.slackTs).toBe('9.9');
    expect(stored.slackChannelId).toBe('CALERT');
    // mirrors keep landing in the thread — and each one becomes the
    // permalink target (latest reply ts on the thread row)
    calls.length = 0;
    await mirrorToSlack(db, convId, 'x', 'hello again', { direction: 'out' });
    const mirrored = calls.filter(
      (c) => c.url.includes('chat.postMessage') && c.body.text === 'hello again',
    );
    expect(mirrored.map((m) => m.body.thread_ts)).toEqual(['1.0']);
    const [thread] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, convId));
    expect(thread.lastReplyTs).toBe('9.9'); // the mock returns ts 9.9

    // the next alert's "View thread" permalink targets the latest reply,
    // not the anchor — still opening the panel via thread_ts on the anchor
    calls.length = 0;
    const [alert2] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'failure', detail: 'again' })
      .returning();
    await postSlackAlert(db, agent.workspaceId, conv, agent, alert2);
    const perm = calls.find((c) => c.url.includes('chat.getPermalink'));
    expect(perm?.url).toContain('message_ts=9.9');
    const posts2 = calls.filter((c) => c.url.includes('chat.postMessage'));
    const topLevel2 = posts2.filter((p) => p.body.channel === 'CALERT' && !p.body.thread_ts);
    const blocks2 = topLevel2[0].body.blocks as { elements?: { url?: string; action_id?: string }[] }[];
    const btn2 = blocks2
      .flatMap((b) => b.elements ?? [])
      .find((e) => e.action_id === 'janis_view_thread');
    expect(btn2?.url).toContain('thread_ts=1.0');
    expect(btn2?.url).toContain('cid=CALERT');
  });

  it('an alert re-anchors in the configured channel when the thread channel is dead', async () => {
    // The canonical thread's channel is unreachable (deleted, or the bot was
    // removed from a private one): the alert must not die with it — the dead
    // rows prune and a fresh thread anchors in the configured alert channel.
    await db
      .update(slackThreads)
      .set({ channelId: 'CDEAD' })
      .where(eq(slackThreads.conversationId, convId));
    await db
      .update(slackInstallations)
      .set({ alertChannelId: 'CALERT' })
      .where(eq(slackInstallations.teamId, 'T_NEW'));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        if (String(url).includes('CDEAD') || (init?.body ?? '').includes('CDEAD')) {
          return new Response('{"ok":false,"error":"channel_not_found"}', { status: 200 });
        }
        if (String(url).includes('conversations.open')) {
          return new Response('{"ok":true,"channel":{"id":"D1"}}', { status: 200 });
        }
        if (String(url).includes('chat.getPermalink')) {
          return new Response(
            '{"ok":true,"permalink":"https://t.slack.com/archives/CALERT/p2000"}',
            { status: 200 },
          );
        }
        return new Response('{"ok":true,"channel":"CALERT","ts":"2.2"}', { status: 200 });
      }),
    );
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId));
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'custom', detail: 'again' })
      .returning();
    await postSlackAlert(db, agent.workspaceId, conv, agent, alert);

    // the dead-channel thread row pruned; a fresh thread anchored in the
    // configured alert channel
    const rows = await db.select().from(slackThreads).where(eq(slackThreads.conversationId, convId));
    expect(rows.map((r) => r.channelId)).toEqual(['CALERT']);
    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    const anchor = posts.filter(
      (p) => p.body.channel === 'CALERT' && !p.body.thread_ts && p.body.blocks,
    );
    expect(anchor.length).toBe(1);
  });

  it('an assigned-but-unresolvable assignee still DMs the resolvable members', async () => {
    // Assignee has no Slack user (no slack_user_id, lookupByEmail misses) —
    // the page must fan out to the workspace instead of DMing nobody.
    const [ghost] = await db
      .insert(users)
      .values({ email: 'ghost@x.c', name: 'Ghost' })
      .returning();
    const [conv] = await db
      .update(conversations)
      .set({ assigneeId: ghost.id })
      .where(eq(conversations.id, convId))
      .returning();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        if (String(url).includes('users.lookupByEmail')) {
          return new Response('{"ok":false,"error":"users_not_found"}', { status: 200 });
        }
        if (String(url).includes('conversations.open')) {
          return new Response('{"ok":true,"channel":{"id":"D_OP"}}', { status: 200 });
        }
        if (String(url).includes('chat.getPermalink')) {
          return new Response('{"ok":true,"permalink":"https://t.slack.com/x/p1"}', { status: 200 });
        }
        return new Response('{"ok":true,"channel":"CALERT","ts":"9.9"}', { status: 200 });
      }),
    );
    await db.update(alerts).set({ status: 'resolved' }).where(eq(alerts.conversationId, convId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId));
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'help_request', detail: 'needs a human' })
      .returning();
    await postSlackAlert(db, agent.workspaceId, conv, agent, alert);

    const dms = calls.filter((c) => c.url.includes('conversations.open'));
    expect(dms.map((d) => d.body.users)).toEqual(['U_OP']);
    const topLevel = calls.find((c) => c.url.includes('chat.postMessage') && c.body.channel === 'CALERT' && !c.body.thread_ts);
    expect(String(topLevel?.body.text)).toContain('<!here>');
    await db.update(conversations).set({ assigneeId: null }).where(eq(conversations.id, convId));
  });

  it('a rule notify list DMs the listed members alongside the assignee', async () => {
    // Assigned and resolvable — the notify list decides who gets paged past
    // the owner, so the assignee's Slack mention stays but the DM fans out.
    const [other] = await db
      .insert(users)
      .values({ email: 'other@x.c', name: 'Other', slackUserId: 'U_OTHER' })
      .returning();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const admin = (await db.select().from(users).where(eq(users.slackUserId, 'U_OP')))[0];
    await db.update(conversations).set({ assigneeId: admin.id }).where(eq(conversations.id, convId));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        if (String(url).includes('conversations.open')) {
          return new Response('{"ok":true,"channel":{"id":"D_OTHER"}}', { status: 200 });
        }
        if (String(url).includes('chat.getPermalink')) {
          return new Response('{"ok":true,"permalink":"https://t.slack.com/x/p1"}', { status: 200 });
        }
        return new Response('{"ok":true,"channel":"CALERT","ts":"9.9"}', { status: 200 });
      }),
    );
    await db.update(alerts).set({ status: 'resolved' }).where(eq(alerts.conversationId, convId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId));
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'help_request', detail: 'needs a human' })
      .returning();
    await postSlackAlert(db, agent.workspaceId, { ...conv, assigneeId: admin.id }, agent, alert, {
      notify: [other.id],
    });

    const dms = calls.filter((c) => c.url.includes('conversations.open'));
    expect(dms.map((d) => d.body.users)).toEqual(['U_OTHER']);
    const topLevel = calls.find((c) => c.url.includes('chat.postMessage') && c.body.channel === 'CALERT' && !c.body.thread_ts);
    expect(String(topLevel?.body.text)).toContain('<@U_OP>');
    await db.update(conversations).set({ assigneeId: null }).where(eq(conversations.id, convId));
  });

  it('forwards to legacy when the channel has no mapped conversations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await command({ command: '/pause', channel_id: 'C_LEGACY', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === 'https://legacy-slack.test/slack/receive')).toBe(true);
  });

  it('forwards unknown teams to legacy', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await command({ command: '/pause', channel_id: 'C1', team_id: 'T_UNKNOWN', user_id: 'U1', text: '' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('migrated teams get an ephemeral warning instead of a legacy forward', async () => {
    await db
      .update(slackInstallations)
      .set({ migrated: true })
      .where(eq(slackInstallations.teamId, 'T_NEW'));
    try {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
      vi.stubGlobal('fetch', fetchMock);
      const res = await command({ command: '/pause', channel_id: 'C_NOPE', team_id: 'T_NEW', user_id: 'U_OP', text: '' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.text).toContain('no active Janis conversation');
      // only users.info — never the legacy relay
      expect(
        fetchMock.mock.calls.every((c) => String(c[0]) !== 'https://legacy-slack.test/slack/receive'),
      ).toBe(true);
    } finally {
      await db
        .update(slackInstallations)
        .set({ migrated: false })
        .where(eq(slackInstallations.teamId, 'T_NEW'));
    }
  });
});

describe('classic-mode slash acks', () => {
  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'WS Classic' }).returning();
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Classic Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_CLASSIC', botToken: 'xoxb-cls', mode: 'classic' })
      .returning();
    await db.insert(slackClassicChannels).values({
      installationId: inst.id,
      sourceChannel: 'srcA',
      slackChannelId: 'CJ1',
      name: 'j-srcA',
    });
    await db.insert(conversations).values({ agentId: agent.id, externalId: 'messenger:srcA' });
  });

  const command = (body: Record<string, string>) =>
    signedPost(new URLSearchParams(body).toString(), '/slack/commands');

  it('a successful classic /pause acks with an EMPTY body — Slack renders any body text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('{"ok":true}'))),
    );
    const res = await command({
      command: '/pause',
      channel_id: 'CJ1',
      team_id: 'T_CLASSIC',
      user_id: 'U_OP',
      text: '',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    const [chan] = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'CJ1'));
    expect(chan.paused).toBe(true);
  });

  it('an unmapped classic channel still returns the ephemeral warning body', async () => {
    const res = await command({
      command: '/pause',
      channel_id: 'C_NOWHERE',
      team_id: 'T_CLASSIC',
      user_id: 'U_OP',
      text: '',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response_type).toBe('ephemeral');
  });
});

describe('slack member resolution', () => {
  let convId: string;
  let memberId: string;
  let emailMemberId: string;

  const event = (user: string, text = 'hello') =>
    signedPost(
      JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          channel: 'CEV',
          thread_ts: '9.0',
          ts: `9.${Math.random().toString(36).slice(2, 6)}`,
          user,
          text,
        },
      }),
      '/slack/events',
    );

  /** users.info resolves `email` for everyone; write methods all succeed. */
  const stubFor = (email: string | null) =>
    vi.fn().mockImplementation(async (url: string | URL) => {
      const u = String(url);
      const ok = (b: unknown) =>
        new Response(JSON.stringify({ ok: true, ...(b as object) }), {
          headers: { 'content-type': 'application/json' },
        });
      if (u.includes('users.info')) {
        return email
          ? ok({ user: { profile: { email } } })
          : new Response(JSON.stringify({ ok: false, error: 'user_not_found' }));
      }
      if (u.includes('chat.delete')) return new Response(JSON.stringify({ ok: false }));
      return ok({});
    });

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Ev WS' }).returning();
    const [linked] = await db
      .insert(users)
      .values({ email: 'linked@x.c', name: 'Linked', slackUserId: 'U_LINKED' })
      .returning();
    memberId = linked.id;
    const [emailOnly] = await db
      .insert(users)
      .values({ email: 'emailonly@x.c', name: 'EmailOnly' })
      .returning();
    emailMemberId = emailOnly.id;
    for (const uid of [memberId, emailMemberId]) {
      await db.insert(memberships).values({
        userId: uid,
        workspaceId: ws.id,
        role: 'member',
        acceptedAt: new Date(),
      });
    }
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'EvBot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'ev-conv' })
      .returning();
    convId = conv.id;
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_EV', botToken: 'xoxb-ev', installerUserId: memberId })
      .returning();
    await db
      .insert(slackThreads)
      .values({ conversationId: conv.id, installationId: inst.id, channelId: 'CEV', ts: '9.0' });
  });

  it('a stored slackUserId resolves without any users.info call', async () => {
    const fetchMock = stubFor(null); // would fail the lookup if it were attempted
    vi.stubGlobal('fetch', fetchMock);
    const res = await event('U_LINKED');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('users.info'))).toBe(false);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human'); // implicit takeover — the reply landed
  });

  it('an unmatched Slack user is denied — no takeover, denial posted in thread', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor('stranger@elsewhere.c');
    vi.stubGlobal('fetch', fetchMock);
    const res = await event('U_STRANGER');
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('active'); // nothing happened
    // and the denial was posted back into the thread
    const denial = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('chat.postMessage') && String(c[1]?.body).includes(':no_entry:'),
    );
    expect(denial).toBeTruthy();
    expect(String(denial![1]?.body)).toContain('9.0'); // threaded
  });

  it('double-delivered events (overlapping subscriptions) ingest once', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor(null);
    vi.stubGlobal('fetch', fetchMock);
    // Slack fires the same message twice ~100ms apart when subscriptions
    // overlap — fire two truly parallel copies plus a delayed third.
    const payload = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: 'CEV', thread_ts: '9.0', ts: '9.777', user: 'U_LINKED', text: 'once only' },
    });
    const [r1, r2] = await Promise.all([
      signedPost(payload, '/slack/events'),
      signedPost(payload, '/slack/events'),
    ]);
    const r3 = await signedPost(payload, '/slack/events');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId));
    const ingested = rows.filter((m) => (m.payload as { slack_ts?: string })?.slack_ts === '9.777');
    expect(ingested.length).toBe(1);
    expect(ingested[0].text).toBe('once only');
  });

  it('an operator reply stores canonical markdown, not raw mrkdwn', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    vi.stubGlobal('fetch', stubFor(null));
    const res = await event(
      'U_LINKED',
      'here is *the link* — <https://x.test/a|docs> & more',
    );
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId));
    const last = rows.find(
      (m) =>
        (m.payload as { slack_ts?: string })?.slack_ts &&
        m.text?.includes('the link'),
    );
    expect(last?.text).toBe('here is **the link** — [docs](https://x.test/a) & more');
  });

  it('typed /pause in a thread pauses that conversation instead of replying', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null, pauseMinutes: null })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor(null);
    vi.stubGlobal('fetch', fetchMock);
    // Slack can't invoke slash commands inside threads — the literal text
    // arrives as a message and must not reach the customer.
    const res = await event('U_LINKED', '/pause 30');
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    expect(conv.pauseMinutes).toBe(30);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, convId));
    expect(rows.some((m) => m.text === '/pause 30')).toBe(false);
    const confirm = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('chat.postMessage') && String(c[1]?.body).includes('paused this conversation'),
    );
    expect(confirm).toBeTruthy();
  });

  it('typed /resume in a thread hands the conversation back to the agent', async () => {
    await db
      .update(conversations)
      .set({ state: 'human', assigneeId: memberId })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor(null);
    vi.stubGlobal('fetch', fetchMock);
    const res = await event('U_LINKED', '/resume');
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).not.toBe('human');
    const rows = await db.select().from(messages).where(eq(messages.conversationId, convId));
    expect(rows.some((m) => m.text === '/resume')).toBe(false);
  });

  it('email match resolves and caches the slackUserId link', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor('emailonly@x.c');
    vi.stubGlobal('fetch', fetchMock);
    const res = await event('U_EMAIL1');
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('human');
    const [u] = await db.select().from(users).where(eq(users.id, emailMemberId));
    expect(u.slackUserId).toBe('U_EMAIL1');
  });

  it('unmatched button clicks get an ephemeral denial via response_url', async () => {
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    const fetchMock = stubFor('nobody@elsewhere.c');
    vi.stubGlobal('fetch', fetchMock);
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U_STRANGER2' },
      response_url: 'https://hooks.slack.test/resp1',
      actions: [{ action_id: 'janis_takeover', value: convId }],
    });
    const res = await signedPost(`payload=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const denial = fetchMock.mock.calls.find((c) => String(c[0]) === 'https://hooks.slack.test/resp1');
    expect(denial).toBeTruthy();
    expect(String(denial![1]?.body)).toContain('ephemeral');
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.state).toBe('active'); // takeover denied — state untouched
  });

  it('deletes the raw reply with the installer token and reposts as the agent', async () => {
    await db
      .update(slackInstallations)
      .set({ installerUserToken: 'xoxp-inst' })
      .where(eq(slackInstallations.teamId, 'T_EV'));
    await db
      .update(conversations)
      .set({ state: 'active', assigneeId: null })
      .where(eq(conversations.id, convId));
    const calls: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async (url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
          const u = String(url);
          calls.push({ url: u, auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : {} });
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      ),
    );
    try {
      const res = await event('U_LINKED', 'operator reply text');
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50)); // mirror is fire-and-forget
      // the delete ran under the installer's user token, not the bot token —
      // only a user token can delete someone else's message
      const del = calls.find((c) => c.url.includes('chat.delete'));
      expect(del?.auth).toBe('Bearer xoxp-inst');
      // show_identity defaults on → the repost carries the operator's name
      const repost = calls.find(
        (c) => c.url.includes('chat.postMessage') && c.body.username === 'Linked (operator)',
      );
      expect(repost?.body.thread_ts).toBe('9.0');
      expect(repost?.body.text).toBe('operator reply text');
      // no avatar → bust silhouette, not the Janis app icon
      expect(repost?.body.icon_emoji).toBe(':bust_in_silhouette:');
      expect(repost?.body.icon_url).toBeUndefined();
      // opted out → the agent masquerade returns
      await db.update(users).set({ showIdentity: false }).where(eq(users.id, memberId));
      calls.length = 0;
      await event('U_LINKED', 'anonymous reply');
      await new Promise((r) => setTimeout(r, 50));
      const masked = calls.find(
        (c) => c.url.includes('chat.postMessage') && c.body.username === 'EvBot (operator)',
      );
      expect(masked?.body.text).toBe('anonymous reply');
      expect(masked?.body.icon_emoji).toBe(':robot_face:');
    } finally {
      await db
        .update(slackInstallations)
        .set({ installerUserToken: null })
        .where(eq(slackInstallations.teamId, 'T_EV'));
      await db.update(users).set({ showIdentity: true }).where(eq(users.id, memberId));
    }
  });
});

describe('channel management', () => {
  let api: Hono;
  let cookie: string;
  let wsId: string;

  const slackOk = (body: unknown) =>
    new Response(JSON.stringify({ ok: true, ...(body as object) }), {
      headers: { 'content-type': 'application/json' },
    });

  /** Stub fetch: conversations.list returns `listed`, conversations.info
   * resolves from `known`, conversations.create honors `create`. */
  const stubSlack = (
    listed: { id: string; name: string }[],
    known: Record<string, string>,
    create: { ok: boolean; channel?: { id: string; name: string }; error?: string },
  ) => {
    const mock = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('conversations.list')) {
        return slackOk({ channels: listed.map((ch) => ({ ...ch, is_archived: false })) });
      }
      if (u.includes('conversations.info')) {
        const id = new URLSearchParams(u.split('?')[1]).get('channel')!;
        const name = known[id];
        return name
          ? slackOk({ channel: { id, name, is_archived: false } })
          : new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      }
      if (u.includes('conversations.create')) {
        return new Response(JSON.stringify(create));
      }
      return slackOk({});
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  const req = (path: string, init: RequestInit = {}) =>
    api.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    api = new Hono().route('/api/slack', slackApiRoutes(db));
    const [ws] = await db.insert(workspaces).values({ name: 'Slack WS' }).returning();
    wsId = ws.id;
    const [admin] = await db
      .insert(users)
      .values({ email: 'slack-admin@x.c', name: 'Admin' })
      .returning();
    await db.insert(memberships).values({
      userId: admin.id,
      workspaceId: wsId,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId: admin.id,
      workspaceId: wsId,
      expiresAt: new Date(Date.now() + 86400_000),
    });
    cookie = `${SESSION_COOKIE}=${token}`;
    const [chInst] = await db.insert(slackInstallations).values({
      workspaceId: wsId,
      teamId: 'T_CH',
      botToken: 'xoxb-ch',
      installerUserId: admin.id,
      alertChannelId: 'CSEL',
    }).returning();
    const { hash, preview } = generateApiKey();
    await db.insert(agents).values({
      workspaceId: wsId,
      name: 'Ch Agent',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      slackRoutes: [{ installation_id: chInst.id, channel_id: 'CAGENT' }],
    });
  });

  it('merges selected channels missing from conversations.list', async () => {
    // Slack's list lags on new channels — the workspace alert channel and the
    // agent's channel are resolved via conversations.info and appended.
    stubSlack([{ id: 'CGEN', name: 'general' }], {
      CSEL: 'janis-alerts-7ipo',
      CAGENT: 'janis-ch-agent',
    });
    const res = await req('/api/slack/channels');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toContainEqual({ id: 'CSEL', name: 'janis-alerts-7ipo' });
    expect(body.channels).toContainEqual({ id: 'CAGENT', name: 'janis-ch-agent' });
    expect(body.channels).toContainEqual({ id: 'CGEN', name: 'general' });
  });

  it('filters archived channels even when Slack returns them', async () => {
    // Slack occasionally returns archived rows despite exclude_archived —
    // the client-side belt keeps them out of the picker regardless
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('conversations.list')) {
          return slackOk({
            channels: [
              { id: 'C_LIVE', name: 'live-chan' },
              { id: 'C_DEAD', name: 'dead-chan', is_archived: true },
            ],
          });
        }
        return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      }),
    );
    const res = await req('/api/slack/channels');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels.map((ch: { id: string }) => ch.id)).toContain('C_LIVE');
    expect(body.channels.map((ch: { id: string }) => ch.id)).not.toContain('C_DEAD');
  });

  it('sends conversations.list params on the query string', async () => {
    const mock = stubSlack([], { CSEL: 'sel', CAGENT: 'ag' });
    await req('/api/slack/channels');
    const listCall = mock.mock.calls.find((c) => String(c[0]).includes('conversations.list'));
    expect(String(listCall?.[0])).toContain('exclude_archived=true');
    expect(String(listCall?.[0])).toContain('types=public_channel');
  });

  it('POST /channel creates and selects the channel', async () => {
    stubSlack([], {}, { ok: true, channel: { id: 'CNEW', name: 'janis-alerts' } });
    const res = await req('/api/slack/channel', {
      method: 'POST',
      body: JSON.stringify({ name: 'janis-alerts' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel).toEqual({ id: 'CNEW', name: 'janis-alerts' });
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.workspaceId, wsId));
    expect(inst.alertChannelId).toBe('CNEW');
    await db
      .update(slackInstallations)
      .set({ alertChannelId: 'CSEL' })
      .where(eq(slackInstallations.workspaceId, wsId));
  });

  it('POST /channel surfaces name_taken instead of a silent suffix', async () => {
    const mock = stubSlack([], {}, { ok: false, error: 'name_taken' });
    const res = await req('/api/slack/channel', {
      method: 'POST',
      body: JSON.stringify({ name: 'janis-alerts' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already taken');
    // exactly one create call — no retry renaming the user's choice
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('conversations.create'))).toHaveLength(1);
  });

  it('PATCH /channel updates the alert channel', async () => {
    stubSlack([], { CSEL: 'sel' });
    const res = await req('/api/slack/channel', {
      method: 'PATCH',
      body: JSON.stringify({ channel_id: 'CGEN' }),
    });
    expect(res.status).toBe(200);
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.workspaceId, wsId));
    expect(inst.alertChannelId).toBe('CGEN');
    await db
      .update(slackInstallations)
      .set({ alertChannelId: 'CSEL' })
      .where(eq(slackInstallations.workspaceId, wsId));
  });
});

describe('member channel sync', () => {
  let wsId: string;
  let memberId: string;

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Sync WS' }).returning();
    wsId = ws.id;
    const [member] = await db
      .insert(users)
      .values({ email: 'synced@x.c', name: 'Synced', slackUserId: 'U_SYNC' })
      .returning();
    memberId = member.id;
    await db.insert(memberships).values({
      userId: member.id,
      workspaceId: ws.id,
      role: 'member',
      acceptedAt: new Date(),
    });
    const [inst] = await db.insert(slackInstallations).values({
      workspaceId: ws.id,
      teamId: 'T_SYNC',
      botToken: 'xoxb-sync',
      alertChannelId: 'C_MAIN',
    }).returning();
    const { hash, preview } = generateApiKey();
    await db.insert(agents).values({
      workspaceId: ws.id,
      name: 'OverrideBot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      slackRoutes: [{ installation_id: inst.id, channel_id: 'C_AGENT' }],
    });
  });

  const callsFor = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
    fetchMock.mock.calls
      .filter((c) => String(c[0]).includes(method))
      .map((c) => JSON.parse(String(c[1]?.body ?? '{}')));

  it('syncMemberToAlertChannels invites the member to every janis channel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await syncMemberToAlertChannels(db, wsId, memberId);
    const invites = callsFor(fetchMock, 'conversations.invite');
    expect(invites.map((b) => b.channel).sort()).toEqual(['C_AGENT', 'C_MAIN']);
    expect(invites.every((b) => b.users === 'U_SYNC')).toBe(true);
  });

  it('removeMemberFromAlertChannels kicks the member from every janis channel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await removeMemberFromAlertChannels(db, wsId, memberId);
    const kicks = callsFor(fetchMock, 'conversations.kick');
    expect(kicks.map((b) => b.channel).sort()).toEqual(['C_AGENT', 'C_MAIN']);
    expect(kicks.every((b) => b.user === 'U_SYNC')).toBe(true);
  });

  it('no-ops when the member has no slack identity', async () => {
    const [unlinked] = await db
      .insert(users)
      .values({ email: 'noslack@x.c', name: 'NoSlack' })
      .returning();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":false,"error":"users_not_found"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await syncMemberToAlertChannels(db, wsId, unlinked.id);
    // only the users.lookupByEmail attempt — no invites
    expect(callsFor(fetchMock, 'conversations.invite')).toHaveLength(0);
  });
});

describe('per-agent Slack workspace override', () => {
  it('routes an agent\'s alert through its own installation + channel; default agents stay on the default install', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'MultiWS' }).returning();
    const [defInst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_DEF', botToken: 'xoxb-default', alertChannelId: 'C_DEF' })
      .returning();
    const [altInst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_ALT', botToken: 'xoxb-alt', alertChannelId: 'C_ALT' })
      .returning();
    // orderBy createdAt picks the default — keep them distinct if the clock ties
    const [routed] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'RoutedBot',
        slackRoutes: [{ installation_id: altInst.id, channel_id: 'C_AGENT_ALT' }],
      })
      .returning();
    const [plain] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'PlainBot' })
      .returning();
    const [convR] = await db
      .insert(conversations)
      .values({ agentId: routed.id, externalId: 'mr:1' })
      .returning();
    const [convP] = await db
      .insert(conversations)
      .values({ agentId: plain.id, externalId: 'mp:1' })
      .returning();

    const calls: { url: string; token: string; body: Record<string, unknown> }[] = [];
    let tsSeq = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({
          url: String(url),
          token: init?.headers?.Authorization ?? '',
          body: init?.body ? JSON.parse(init.body) : {},
        });
        // unique ts per call — slack_threads is unique on (channel, ts)
        return new Response(`{"ok":true,"channel":"C_X","ts":"5.${++tsSeq}"}`, { status: 200 });
      }),
    );

    const [alertR] = await db
      .insert(alerts)
      .values({ conversationId: convR.id, type: 'help_request', detail: 'routed' })
      .returning();
    await postSlackAlert(db, ws.id, convR, routed, alertR);
    const routedPosts = calls.filter(
      (c) => c.url.includes('chat.postMessage') && c.token === 'Bearer xoxb-alt',
    );
    // agent's own channel in the ALT workspace
    expect(routedPosts.some((p) => p.body.channel === 'C_AGENT_ALT')).toBe(true);
    // nothing went out over the default installation's token
    expect(
      calls.some((c) => c.token === 'Bearer xoxb-default' && c.url.includes('chat.postMessage')),
    ).toBe(false);
    const [threadR] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, convR.id));
    expect(threadR.installationId).toBe(altInst.id);

    calls.length = 0;
    const [alertP] = await db
      .insert(alerts)
      .values({ conversationId: convP.id, type: 'help_request', detail: 'plain' })
      .returning();
    await postSlackAlert(db, ws.id, convP, plain, alertP);
    const plainPosts = calls.filter(
      (c) => c.url.includes('chat.postMessage') && c.token === 'Bearer xoxb-default',
    );
    expect(plainPosts.some((p) => p.body.channel === 'C_DEF')).toBe(true);
    const [threadP] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, convP.id));
    expect(threadP.installationId).toBe(defInst.id);
  });

  it('ignores a route pointing at another workspace\'s installation', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'OrphanWS' }).returning();
    const [otherWs] = await db.insert(workspaces).values({ name: 'OtherWS' }).returning();
    await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_ONLY', botToken: 'xoxb-only', alertChannelId: 'C_ONLY' })
      .returning();
    const [foreign] = await db
      .insert(slackInstallations)
      .values({ workspaceId: otherWs.id, teamId: 'T_FOREIGN', botToken: 'xoxb-foreign' })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'OrphanBot',
        // an installation that belongs to a different Janis workspace —
        // unresolvable, so this agent has no valid destinations
        slackRoutes: [{ installation_id: foreign.id, channel_id: null }],
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'mo:1' })
      .returning();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response('{"ok":true,"channel":"C_ONLY","ts":"6.6"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'failure', detail: 'x' })
      .returning();
    await postSlackAlert(db, ws.id, conv, agent, alert);
    const rows = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, conv.id));
    expect(rows).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('chat.postMessage')),
    ).toHaveLength(0);
  });

  it('fans out to multiple destinations and mutes on an empty route list', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'FanWS' }).returning();
    const [instA] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_A', botToken: 'xoxb-a', alertChannelId: 'C_A' })
      .returning();
    const [instB] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_B', botToken: 'xoxb-b', alertChannelId: 'C_B' })
      .returning();
    // routes = A's alert channel (channel_id null) + a specific channel on B
    const [multi] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'MultiBot',
        slackRoutes: [
          { installation_id: instA.id, channel_id: null },
          { installation_id: instB.id, channel_id: 'C_B2' },
        ],
      })
      .returning();
    const [muted] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'MutedBot', slackRoutes: [] })
      .returning();
    const [convM] = await db
      .insert(conversations)
      .values({ agentId: multi.id, externalId: 'fan:1' })
      .returning();
    const [convMuted] = await db
      .insert(conversations)
      .values({ agentId: muted.id, externalId: 'fan:2' })
      .returning();

    const calls: { url: string; token: string; body: Record<string, unknown> }[] = [];
    let tsSeq = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
          calls.push({
            url: String(url),
            token: init?.headers?.Authorization ?? '',
            body: init?.body ? JSON.parse(init.body) : {},
          });
          return new Response(`{"ok":true,"channel":"C_X","ts":"7.${++tsSeq}"}`, { status: 200 });
        },
      ),
    );

    const [alertM] = await db
      .insert(alerts)
      .values({ conversationId: convM.id, type: 'failure', detail: 'fan out' })
      .returning();
    await postSlackAlert(db, ws.id, convM, multi, alertM);
    // one anchored alert per destination: A's alert channel via xoxb-a,
    // C_B2 via xoxb-b — each anchored its own thread
    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posts.some((p) => p.token === 'Bearer xoxb-a' && p.body.channel === 'C_A')).toBe(true);
    expect(posts.some((p) => p.token === 'Bearer xoxb-b' && p.body.channel === 'C_B2')).toBe(true);
    const threads = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, convM.id));
    expect(new Set(threads.map((t) => t.installationId)).size).toBe(2);

    calls.length = 0;
    const [alertMuted] = await db
      .insert(alerts)
      .values({ conversationId: convMuted.id, type: 'failure', detail: 'muted' })
      .returning();
    await postSlackAlert(db, ws.id, convMuted, muted, alertMuted);
    expect(calls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);
  });
});

describe('public OAuth install', () => {
  let api: Hono;
  let adminCookie = '';
  let adminWsId = '';
  let adminUserId = '';

  const slackOk = (body: unknown) =>
    new Response(JSON.stringify({ ok: true, ...(body as object) }), {
      headers: { 'content-type': 'application/json' },
    });

  /** oauth.v2.access grants `xoxb-<teamId>`; every other Slack call acks
   *  (conversations.list → empty → no alert channel picked). */
  const stubOAuth = (teamId: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        if (String(url).includes('oauth.v2.access')) {
          return slackOk({
            access_token: `xoxb-${teamId}`,
            team: { id: teamId, name: `Team ${teamId}` },
            authed_user: { id: 'U_INST', access_token: `xoxp-${teamId}` },
          });
        }
        return slackOk({ channels: [] });
      }),
    );

  const pubState = async (ret?: string) => {
    const res = await api.request(`/slack/add${ret ? `?return=${encodeURIComponent(ret)}` : ''}`);
    return new URL(res.headers.get('location')!).searchParams.get('state')!;
  };

  const pendingCookieOf = (res: Response) =>
    /janis_slack_pending=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';

  const claim = (pendingId: string) =>
    api.request('/api/slack/claim', {
      method: 'POST',
      headers: { cookie: `${adminCookie}; janis_slack_pending=${pendingId}` },
    });

  const claimWith = (pendingId: string, decision: string) =>
    api.request('/api/slack/claim', {
      method: 'POST',
      headers: {
        cookie: `${adminCookie}; janis_slack_pending=${pendingId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision }),
    });

  beforeAll(async () => {
    env.slackClientId = 'CID';
    env.slackClientSecret = 'SEC';
    api = new Hono()
      .route('/slack', slackPublicRoutes(db))
      .route('/api/slack', slackApiRoutes(db));
    const [ws] = await db.insert(workspaces).values({ name: 'Claim WS' }).returning();
    adminWsId = ws.id;
    const [admin] = await db
      .insert(users)
      .values({ email: 'claim-admin@x.c', name: 'CAdmin' })
      .returning();
    adminUserId = admin.id;
    await db.insert(memberships).values({
      userId: admin.id,
      workspaceId: ws.id,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId: admin.id,
      workspaceId: ws.id,
      expiresAt: new Date(Date.now() + 86400_000),
    });
    adminCookie = `${SESSION_COOKIE}=${token}`;
  });

  it('GET /slack/add redirects to Slack with a signed pub state', async () => {
    const res = await api.request('/slack/add');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    expect(loc.searchParams.get('client_id')).toBe('CID');
    expect(loc.searchParams.get('state')!.startsWith('pub.')).toBe(true);
  });

  it('sessionless callback parks a pending install and redirects to login', async () => {
    stubOAuth('T_PARK');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/login?slack=pending`);
    const pid = pendingCookieOf(res);
    expect(pid).toBeTruthy();
    const [p] = await db
      .select()
      .from(slackPendingInstalls)
      .where(eq(slackPendingInstalls.id, pid));
    expect(p.teamId).toBe('T_PARK');
    expect(p.botToken).toBe('xoxb-T_PARK');
    expect(p.installerUserToken).toBe('xoxp-T_PARK');
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a tampered pub state before touching the token exchange', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent('pub.bogus.sig')}`,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the legacy unsigned workspace:user state shape', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent('a-workspace-id:a-user-id')}`,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Marketplace-style empty state parks pending when logged out', async () => {
    stubOAuth('T_MKT');
    const res = await api.request('/slack/oauth/callback?code=C');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/login?slack=pending`);
    expect(pendingCookieOf(res)).toBeTruthy();
  });

  it('pub-state callback with a live session binds straight to the active workspace', async () => {
    stubOAuth('T_SOFT');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
      { headers: { cookie: adminCookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/settings?slack=connected`);
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_SOFT'));
    expect(inst.workspaceId).toBe(adminWsId);
    expect(inst.installerUserId).toBe(adminUserId);
  });

  it('a same-workspace reinstall refreshes in place — migrated flag + classic state survive', async () => {
    setLegacyTeamLookup(async () => 'none'); // already migrated — no re-park
    stubOAuth('T_REINST');
    const [inst] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: adminWsId,
        teamId: 'T_REINST',
        teamName: 'Old Name',
        botToken: 'xoxb-old',
        migrated: true,
      })
      .returning();
    await db.insert(slackClassicChannels).values({
      installationId: inst.id,
      sourceChannel: 'C_T',
      slackChannelId: 'C_T',
      name: 'transcripts',
      team: 'T_REINST',
      isWordhopChannel: true,
      paused: true,
    });
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
      { headers: { cookie: adminCookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/settings?slack=connected`);
    const [after] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_REINST'));
    expect(after.id).toBe(inst.id);
    expect(after.migrated).toBe(true);
    expect(after.botToken).toBe('xoxb-T_REINST');
    expect(after.teamName).toBe('Team T_REINST');
    expect(
      await db
        .select()
        .from(slackClassicChannels)
        .where(eq(slackClassicChannels.installationId, inst.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.teamId, 'T_REINST')),
    ).toHaveLength(0);
  });

  it('a signed-in reinstall on a dual-owned team refreshes in place and still parks', async () => {
    setLegacyTeamLookup(async () => 'live');
    stubOAuth('T_DUAL');
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: adminWsId, teamId: 'T_DUAL', botToken: 'xoxb-old' })
      .returning();
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
      { headers: { cookie: adminCookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/slack/legacy`);
    // the install was refreshed, not deleted — the chooser decides its fate
    const [after] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, inst.id));
    expect(after.botToken).toBe('xoxb-T_DUAL');
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.teamId, 'T_DUAL')),
    ).toHaveLength(1);
  });

  it("'keep' on a dual-owned team removes the new install — classic stays authoritative", async () => {
    setLegacyTeamLookup(async () => 'live');
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: adminWsId, teamId: 'T_KEEPDUAL', botToken: 'xoxb-dual' })
      .returning();
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_KEEPDUAL', botToken: 'xoxb-keep', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    const res = await claimWith(p.id, 'keep');
    expect(await res.json()).toEqual({ claimed: false, kept: true });
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.id, inst.id)),
    ).toHaveLength(0);
  });

  it('claims a pending install into the signed-in workspace exactly once', async () => {
    stubOAuth('T_CLAIM');
    const oauth = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    const pid = pendingCookieOf(oauth);
    const res = await claim(pid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: true, team_name: 'Team T_CLAIM' });
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_CLAIM'));
    expect(inst.workspaceId).toBe(adminWsId);
    expect(inst.installerUserId).toBe(adminUserId);
    expect(inst.installerSlackUserId).toBe('U_INST');
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.id, pid)),
    ).toHaveLength(0);
    // replaying the consumed cookie claims nothing
    expect(((await (await claim(pid)).json()) as { claimed: boolean }).claimed).toBe(false);
  });

  it('welcomes the installer with a DM after claim', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).includes('oauth.v2.access')) {
        return slackOk({
          access_token: 'xoxb-T_WELCOME',
          team: { id: 'T_WELCOME', name: 'Team Welcome' },
          authed_user: { id: 'U_WELCOME', access_token: 'xoxp-T_WELCOME' },
        });
      }
      if (String(url).includes('conversations.open')) {
        return slackOk({ channel: { id: 'D_WELCOME' } });
      }
      return slackOk({ channels: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    await claim(pendingCookieOf(oauth));
    // welcomeInstallerDm is fire-and-forget — give it a tick to post.
    for (let i = 0; i < 50 && !fetchMock.mock.calls.some(([u]) => String(u).includes('chat.postMessage')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('conversations.open'))).toBe(true);
    const post = fetchMock.mock.calls.find(([u]) => String(u).includes('chat.postMessage'));
    expect(post).toBeDefined();
    expect(String(post![1]?.body)).toContain('Welcome to Janis');
    expect(String(post![1]?.body)).toContain('Team Welcome');
  });

  it('refuses an expired pending install', async () => {
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_EXP', botToken: 'xoxb-exp', expiresAt: new Date(Date.now() - 1000) })
      .returning();
    const res = await claim(p.id);
    expect(((await res.json()) as { claimed: boolean }).claimed).toBe(false);
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T_EXP')),
    ).toHaveLength(0);
  });

  it('never re-binds a team already owned by another workspace', async () => {
    const [otherWs] = await db.insert(workspaces).values({ name: 'Other WS' }).returning();
    await db.insert(slackInstallations).values({
      workspaceId: otherWs.id,
      teamId: 'T_OWNED',
      botToken: 'xoxb-owned',
    });
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_OWNED', botToken: 'xoxb-new', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    const body = (await (await claim(p.id)).json()) as {
      claimed: boolean;
      already_connected?: boolean;
    };
    expect(body.claimed).toBe(false);
    expect(body.already_connected).toBe(true);
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_OWNED'));
    expect(inst.workspaceId).toBe(otherWs.id);
    expect(inst.botToken).toBe('xoxb-owned');
  });

  it('in-session install binds directly via signed dir. state', async () => {
    stubOAuth('T_DIR');
    const start = await api.request('/api/slack/install', { headers: { cookie: adminCookie } });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    expect(state.startsWith('dir.')).toBe(true);
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/settings?slack=connected`);
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_DIR'));
    expect(inst.workspaceId).toBe(adminWsId);
  });

  it('in-session install returns to the ?return path with slack=connected', async () => {
    stubOAuth('T_RET');
    const ret = '/agents/agent-1/settings?sub=escalation';
    const start = await api.request(`/api/slack/install?return=${encodeURIComponent(ret)}`, {
      headers: { cookie: adminCookie },
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get('location')).toBe(
      `${env.webOrigin}/agents/agent-1/settings?sub=escalation&slack=connected`,
    );
  });

  it('a signed-in /slack/add installer is returned to the ?return path', async () => {
    stubOAuth('T_RET2');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState('/agents/agent-9/settings'))}`,
      { headers: { cookie: adminCookie } },
    );
    expect(res.headers.get('location')).toBe(
      `${env.webOrigin}/agents/agent-9/settings?slack=connected`,
    );
  });

  it('hostile return paths fall back to /settings', async () => {
    for (const [i, ret] of ['//evil.com/x', 'https://evil.com', 'javascript:alert(1)', '\\\\evil'].entries()) {
      stubOAuth(`T_EVIL_${i}`);
      const start = await api.request(`/api/slack/install?return=${encodeURIComponent(ret)}`, {
        headers: { cookie: adminCookie },
      });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const res = await api.request(
        `/slack/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      );
      expect(res.headers.get('location')).toBe(`${env.webOrigin}/settings?slack=connected`);
    }
  });

  it('sessionless reinstall of a connected team refreshes the token in place', async () => {
    // The Marketplace listing's reauthorize path: keeps the binding, upgrades
    // scopes, doesn't park a pending row.
    await db.insert(slackInstallations).values({
      workspaceId: adminWsId,
      teamId: 'T_SESS',
      botToken: 'xoxb-stale',
    });
    stubOAuth('T_SESS');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('already connected');
    const insts = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_SESS'));
    expect(insts).toHaveLength(1);
    expect(insts[0].botToken).toBe('xoxb-T_SESS');
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.teamId, 'T_SESS')),
    ).toHaveLength(0);
  });

  it('reinstall refreshes the row in place — threads and the migrated flag survive', async () => {
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: adminWsId, name: 'MigBot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'mig-conv' })
      .returning();
    const [inst0] = await db
      .insert(slackInstallations)
      .values({ workspaceId: adminWsId, teamId: 'T_MIG2', botToken: 'xoxb-old', migrated: true })
      .returning();
    await db.insert(slackThreads).values({
      conversationId: conv.id,
      installationId: inst0.id,
      channelId: 'C_OLD',
      ts: '1.0',
    });
    stubOAuth('T_MIG2');
    const start = await api.request('/api/slack/install', { headers: { cookie: adminCookie } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await api.request(`/slack/oauth/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    const insts = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_MIG2'));
    expect(insts).toHaveLength(1);
    expect(insts[0].id).toBe(inst0.id);
    expect(insts[0].botToken).toBe('xoxb-T_MIG2');
    expect(insts[0].migrated).toBe(true);
    expect(
      await db.select().from(slackThreads).where(eq(slackThreads.installationId, inst0.id)),
    ).toHaveLength(1);
  });

  it('parks a legacy-team install and refuses a decisionless claim', async () => {
    setLegacyTeamLookup(async (t) => (t === 'T_LEGACY' ? 'live' : 'none'));
    stubOAuth('T_LEGACY');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    expect(res.status).toBe(302);
    const pid = pendingCookieOf(res);
    expect(pid).toBeTruthy();
    // nothing bound — the row waits for the interstitial's explicit choice
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T_LEGACY')),
    ).toHaveLength(0);
    const body = (await (await claim(pid)).json()) as { claimed: boolean; legacy?: string };
    expect(body.claimed).toBe(false);
    expect(body.legacy).toBe('live');
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.id, pid)),
    ).toHaveLength(1);
  });

  it('an in-session install on a legacy team lands on the interstitial', async () => {
    setLegacyTeamLookup(async () => 'live');
    stubOAuth('T_DIRLEG');
    const start = await api.request('/api/slack/install', { headers: { cookie: adminCookie } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      { headers: { cookie: adminCookie } },
    );
    expect(res.headers.get('location')).toBe(`${env.webOrigin}/slack/legacy`);
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T_DIRLEG')),
    ).toHaveLength(0);
  });

  it('fails closed when the legacy lookup itself errors', async () => {
    setLegacyTeamLookup(async () => 'unknown');
    stubOAuth('T_UNK');
    const res = await api.request(
      `/slack/oauth/callback?code=C&state=${encodeURIComponent(await pubState())}`,
    );
    const pid = pendingCookieOf(res);
    expect(pid).toBeTruthy();
    const body = (await (await claim(pid)).json()) as { claimed: boolean; legacy?: string };
    expect(body.claimed).toBe(false);
    expect(body.legacy).toBe('unknown');
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T_UNK')),
    ).toHaveLength(0);
  });

  it("'keep' consumes the grant without binding", async () => {
    setLegacyTeamLookup(async () => 'live');
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_KEEP', botToken: 'xoxb-keep', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    const res = await claimWith(p.id, 'keep');
    expect(await res.json()).toEqual({ claimed: false, kept: true });
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.id, p.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T_KEEP')),
    ).toHaveLength(0);
  });

  it("'migrate' runs the self-serve cutover: binds, marks, reseeds, deletes the grant", async () => {
    setLegacyTeamLookup(async () => 'live');
    const marked: string[] = [];
    setLegacyOps({
      channels: async (t) =>
        t === 'T_MIGR'
          ? [
              {
                id: 'C_TRANSCRIPT',
                team: 'T_MIGR',
                name: 'transcripts',
                sourceChannel: 'C_TRANSCRIPT',
                is_wordhop_channel: true,
                paused: true,
                should_process_transcript: true,
              },
              {
                id: 'D_MEMBER',
                team: 'T_MIGR',
                source_user: 'U_M1',
                client_key: 'wordhop',
                custom_alerts: { help: true },
              },
            ]
          : [],
      mark: async (t) => {
        marked.push(t);
        return true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => slackOk({ channels: [] })));
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({
        teamId: 'T_MIGR',
        teamName: 'Migrating',
        botToken: 'xoxb-migr',
        installerSlackUserId: 'U_INST',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    const res = await claimWith(p.id, 'migrate');
    expect(await res.json()).toEqual({ claimed: false, migration: 'done', team_name: 'Migrating' });

    // bound as a classic-mode install, grant consumed
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_MIGR'));
    expect(inst.workspaceId).toBe(adminWsId);
    expect(inst.migrated).toBe(true);
    expect(inst.botToken).toBe('xoxb-migr');
    expect(
      await db.select().from(slackPendingInstalls).where(eq(slackPendingInstalls.id, p.id)),
    ).toHaveLength(0);

    // mongo doc flagged + channel state reseeded
    expect(marked).toEqual(['T_MIGR']);
    const classic = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.installationId, inst.id));
    expect(classic).toHaveLength(1);
    expect(classic[0].paused).toBe(true);
    expect(classic[0].shouldProcessTranscript).toBe(true);
    const prefs = await db
      .select()
      .from(slackClassicPrefs)
      .where(eq(slackClassicPrefs.installationId, inst.id));
    expect(prefs.find((r) => r.clientKey === '__dm__')?.settings).toMatchObject({
      custom_alerts: { help: true },
    });
    expect(prefs.find((r) => r.clientKey === '*')?.dmChannelId).toBe('D_MEMBER');
    setLegacyOps(undefined);
  });

  it("'migrate' falls back to the assisted flag when the pipeline throws", async () => {
    setLegacyTeamLookup(async () => 'live');
    setLegacyOps({
      channels: async () => {
        throw new Error('mongo down');
      },
    });
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_MIGERR', botToken: 'xoxb-err', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    const res = await claimWith(p.id, 'migrate');
    expect(await res.json()).toEqual({ claimed: false, migration: 'requested' });
    const [row] = await db
      .select()
      .from(slackPendingInstalls)
      .where(eq(slackPendingInstalls.id, p.id));
    expect(row.decision).toBe('migrate');
    // bound before the throw — cleanup is the assisted path's job
    setLegacyOps(undefined);
  });

  it("'new' binds a legacy team explicitly — the interstitial's informed choice", async () => {
    setLegacyTeamLookup(async () => 'live');
    vi.stubGlobal('fetch', vi.fn(async () => slackOk({ channels: [] })));
    const [p] = await db
      .insert(slackPendingInstalls)
      .values({ teamId: 'T_FRESH', botToken: 'xoxb-fresh', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    const res = await claimWith(p.id, 'new');
    expect(((await res.json()) as { claimed: boolean }).claimed).toBe(true);
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, 'T_FRESH'));
    expect(inst.mode).toBe('new');
    expect(inst.workspaceId).toBe(adminWsId);
  });
});

describe('canonical ↔ mrkdwn translation', () => {
  it('slackMrkdwn translates canonical formatting to mrkdwn', () => {
    expect(slackMrkdwn('**bold** and *ital* and ~~struck~~')).toBe(
      '*bold* and _ital_ and ~struck~',
    );
    expect(slackMrkdwn('see [the docs](https://x.test/a)')).toBe(
      'see <https://x.test/a|the docs>',
    );
    expect(slackMrkdwn('`inline` stays')).toBe('`inline` stays');
  });

  it('slackMrkdwn demotes markdown headers to bold', () => {
    expect(slackMrkdwn('### Summary\nbody text')).toBe('*Summary*\nbody text');
    expect(slackMrkdwn('intro\n## Details **kept**\noutro')).toBe(
      'intro\nDetails *kept*\noutro',
    );
    expect(slackMrkdwn('a\n---\nb')).toBe('a\n───────────\nb');
  });

  it('slackMrkdwn escapes &<> so they cannot form Slack markup', () => {
    expect(slackMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    // a literal <url> in canonical text must not become a Slack autolink
    expect(slackMrkdwn('try <https://x.test> later')).toBe(
      'try &lt;https://x.test&gt; later',
    );
  });

  it('slackToCanonical reverses mrkdwn to canonical', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Fmt WS' }).returning();
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_FMT', botToken: 'xoxb-fmt' })
      .returning();
    expect(await slackToCanonical(db, inst, '*b* _i_ ~s~')).toBe('**b** *i* ~~s~~');
    expect(await slackToCanonical(db, inst, 'see <https://x.test/a|the docs>')).toBe(
      'see [the docs](https://x.test/a)',
    );
    expect(await slackToCanonical(db, inst, 'bare <https://x.test>')).toBe(
      'bare https://x.test',
    );
    expect(await slackToCanonical(db, inst, 'a &amp; b &lt;c&gt;')).toBe('a & b <c>');
    expect(await slackToCanonical(db, inst, 'heads up <!channel>')).toBe(
      'heads up @channel',
    );
  });

  it('slackToCanonical resolves <@U> mentions to member names', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Mention WS' }).returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'm@x.c', name: 'Maya', slackUserId: 'U01MAYA' })
      .returning();
    await db.insert(memberships).values({
      userId: member.id,
      workspaceId: ws.id,
      role: 'member',
      acceptedAt: new Date(),
    });
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_MENT', botToken: 'xoxb-ment' })
      .returning();
    expect(await slackToCanonical(db, inst, 'cc <@U01MAYA> on this')).toBe(
      'cc @Maya on this',
    );
  });

  it('slackToCanonical degrades unknown mentions to @teammate', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Unk WS' }).returning();
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_UNK', botToken: 'xoxb-unk' })
      .returning();
    // users.info fails — no link, no member match
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"ok":false,"error":"user_not_found"}', { status: 200 }),
      ),
    );
    expect(await slackToCanonical(db, inst, 'ask <@U09NOPE>')).toBe('ask @teammate');
  });
});

describe('slackWidgetBlocks', () => {
  it('renders cards with a link button + image blocks', () => {
    const blocks = slackWidgetBlocks([
      {
        type: 'cards',
        items: [
          {
            title: 'Powder Board',
            price: '$499',
            compare_at: '$599',
            stock: 'In stock',
            image: 'https://cdn.test/p.png',
            link: 'https://shop.test/p/1',
            link_label: 'View',
          },
        ],
      },
    ]);
    // section (button accessory) + standalone image block — a link claims
    // the accessory slot, so the image drops to its own block
    expect(blocks).toHaveLength(2);
    const b = blocks[0] as {
      type: string;
      text: { text: string };
      accessory?: { type: string; url?: string; action_id?: string };
    };
    expect(b.type).toBe('section');
    expect(b.text.text).toContain('*Powder Board*');
    expect(b.text.text).toContain('~$599~ $499 (In stock)');
    expect(b.accessory?.type).toBe('button');
    expect(b.accessory?.url).toBe('https://shop.test/p/1');
    expect(b.accessory?.action_id).toBe('janis_card_link_0');
    const img = blocks[1] as { type: string; image_url: string };
    expect(img.type).toBe('image');
    expect(img.image_url).toBe('https://cdn.test/p.png');
  });

  it('renders a linkless card with an image accessory', () => {
    const blocks = slackWidgetBlocks([
      { type: 'cards', items: [{ title: 'Board', image: 'https://cdn.test/p.png' }] },
    ]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as { accessory?: { type: string; image_url: string } };
    expect(b.accessory?.type).toBe('image');
    expect(b.accessory?.image_url).toBe('https://cdn.test/p.png');
  });

  it('renders options as a bullet list and forms as context', () => {
    const blocks = slackWidgetBlocks([
      {
        type: 'options',
        title: 'Pick a slot',
        items: [
          { label: 'Monday 9am' },
          { label: 'Tuesday 2pm', description: 'with Sam' },
        ],
      },
      {
        type: 'form',
        title: 'Contact us',
        fields: [
          { name: 'email', label: 'Email', type: 'email' as const },
          { name: 'msg', label: 'Message', type: 'textarea' as const },
        ],
      },
    ]);
    const sec = blocks[0] as { text: { text: string } };
    expect(sec.text.text).toContain('*Pick a slot*');
    expect(sec.text.text).toContain('• Monday 9am');
    expect(sec.text.text).toContain('• Tuesday 2pm — with Sam');
    const ctx = blocks[1] as { elements: { text: string }[] };
    expect(ctx.elements[0].text).toContain('Contact us');
    expect(ctx.elements[0].text).toContain('Email, Message');
  });

  it('renders status steps with state icons and receipt rows', () => {
    const blocks = slackWidgetBlocks([
      {
        type: 'status',
        title: 'Order 1001',
        steps: [
          { label: 'Placed', state: 'done' as const },
          { label: 'Shipped', state: 'current' as const },
          { label: 'Delivered', state: 'todo' as const },
        ],
      },
      {
        type: 'receipt',
        title: 'Receipt',
        rows: [{ label: 'Board', value: '$499' }],
        total: { label: 'Total', value: '$549' },
      },
    ]);
    const sec = blocks[0] as { text: { text: string } };
    expect(sec.text.text).toContain(':heavy_check_mark: Placed');
    expect(sec.text.text).toContain(':arrow_forward: Shipped');
    expect(sec.text.text).toContain(':white_circle: Delivered');
    const rec = blocks[1] as { text: { text: string } };
    expect(rec.text.text).toContain('Board: $499');
    expect(rec.text.text).toContain('*Total: $549*');
  });

  it('renders quick replies as a suggested-replies context line', () => {
    const blocks = slackWidgetBlocks([], ['Yes, get a human', 'No thanks', { type: 'email' }]);
    expect(blocks).toHaveLength(1);
    const ctx = blocks[0] as { elements: { text: string }[] };
    expect(ctx.elements[0].text).toBe(
      '_suggested replies: Yes, get a human · No thanks · share email_',
    );
  });
});

describe('transcript mirroring fidelity', () => {
  it('seeds threads with converted text and read-only widget blocks', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Mir WS' }).returning();
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'MirBot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'mir-conv', userProfile: { name: 'Pat' } })
      .returning();
    await db.insert(messages).values([
      {
        conversationId: conv.id,
        direction: 'in',
        text: 'is the **Powder Board** in stock? see [size chart](https://x.test/sizes) & shipping',
      },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'Yes — *two* options:',
        payload: {
          widgets: [
            {
              type: 'cards',
              items: [
                {
                  title: 'Powder Board',
                  price: '$499',
                  link: 'https://shop.test/p/1',
                  link_label: 'View',
                },
              ],
            },
          ],
          quick_replies: ['Add to cart', { type: 'email' }],
        },
      },
    ]);
    await db.insert(slackInstallations).values({
      workspaceId: ws.id,
      teamId: 'T_MIRSEED',
      botToken: 'xoxb-mirseed',
      alertChannelId: 'CMIR',
    });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        return new Response('{"ok":true,"channel":"CMIR","ts":"5.5"}', { status: 200 });
      }),
    );
    const [alert] = await db
      .insert(alerts)
      .values({ conversationId: conv.id, type: 'help_request', detail: 'test' })
      .returning();
    await postSlackAlert(db, ws.id, conv, agent, alert);

    const replies = calls.filter(
      (c) => c.url.includes('chat.postMessage') && c.body.thread_ts === '5.5',
    );
    // customer message: canonical → mrkdwn (**→*, link→<url|label>, & escaped)
    const cust = replies.find((r) => String(r.body.text).includes('Powder Board'));
    expect(cust).toBeTruthy();
    expect(cust!.body.text).toContain('*Powder Board*');
    expect(cust!.body.text).toContain('<https://x.test/sizes|size chart>');
    expect(cust!.body.text).toContain('&amp; shipping');
    expect(cust!.body.text).not.toContain('**');
    // sender attribution: avatar-less customer wears the silhouette, the
    // agent wears the robot face rather than the Janis app icon
    expect(cust!.body.username).toBe('Pat (customer)');
    expect(cust!.body.icon_emoji).toBe(':bust_in_silhouette:');
    expect(cust!.body.icon_url).toBeUndefined();
    // agent message: *two* → _two_, card renders as a section, chips as context
    const out = replies.find((r) => String(r.body.text).includes('_two_'));
    expect(out).toBeTruthy();
    expect(out!.body.username).toBe('MirBot (agent)');
    expect(out!.body.icon_emoji).toBe(':robot_face:');
    const blocks = out!.body.blocks as {
      type: string;
      text?: { text: string };
      elements?: { text: string }[];
      accessory?: { type: string; url?: string };
    }[];
    const section = blocks.find((b) => b.type === 'section');
    expect(section?.text?.text).toContain('*Powder Board*');
    // link lands as a url button accessory — navigation only, doesn't speak
    expect(section?.accessory?.type).toBe('button');
    expect(section?.accessory?.url).toBe('https://shop.test/p/1');
    const ctx = blocks.find((b) => b.type === 'context');
    expect(ctx?.elements?.[0]?.text).toBe('_suggested replies: Add to cart · share email_');
    // read-only — no tappable actions
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('mirrorToSlack converts text and appends widget blocks', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Mir2 WS' }).returning();
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Mir2Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'mir2-conv' })
      .returning();
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T_MIR2', botToken: 'xoxb-mir2' })
      .returning();
    await db.insert(slackThreads).values({
      conversationId: conv.id,
      installationId: inst.id,
      channelId: 'CMIR2',
      ts: '7.0',
    });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        return new Response('{"ok":true,"ts":"7.1"}', { status: 200 });
      }),
    );
    await mirrorToSlack(db, conv.id, 'x', 'pick *one*:', {
      direction: 'out',
      widgets: [
        {
          type: 'options',
          title: 'Delivery',
          items: [{ label: 'Ship it' }, { label: 'Pick up' }],
        },
      ],
      quickReplies: ['Ship it', 'Pick up'],
    });
    const post = calls.find((c) => c.url.includes('chat.postMessage'));
    expect(post?.body.text).toBe('pick _one_:');
    expect(post?.body.username).toBe('Mir2Bot (agent)');
    expect(post?.body.icon_emoji).toBe(':robot_face:');
    const blocks = post?.body.blocks as { type: string; text?: { text: string }; elements?: { text: string }[] }[];
    const section = blocks.find((b) => b.type === 'section');
    expect(section?.text?.text).toContain('*Delivery*');
    expect(section?.text?.text).toContain('• Ship it');
    const ctx = blocks.find((b) => b.type === 'context');
    expect(ctx?.elements?.[0]?.text).toBe('_suggested replies: Ship it · Pick up_');
  });
});

describe('slack concierge (DM to the app)', () => {
  let wsId: string;
  let memberId: string;
  let convChannelId: string;
  const DCHAN = 'D_CONCIERGE';

  const dm = (user: string, text: string, ts = `8.${Math.random().toString(36).slice(2, 6)}`) =>
    signedPost(
      JSON.stringify({
        type: 'event_callback',
        team_id: 'T_DM',
        event: {
          type: 'message',
          channel: DCHAN,
          channel_type: 'im',
          ts,
          user,
          text,
        },
      }),
      '/slack/events',
    );

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'DM WS' }).returning();
    wsId = ws.id;
    const [member] = await db
      .insert(users)
      .values({ email: 'dm@x.c', name: 'Dm Member', slackUserId: 'U_DM' })
      .returning();
    memberId = member.id;
    await db.insert(memberships).values({
      userId: member.id,
      workspaceId: ws.id,
      role: 'member',
      acceptedAt: new Date(),
    });
    const { hash, preview } = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Concierge', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [ch] = await db
      .insert(channels)
      .values({ agentId: agent.id, workspaceId: ws.id, kind: 'webchat', name: 'Support' })
      .returning();
    convChannelId = ch.id;
    await db.insert(slackInstallations).values({
      workspaceId: ws.id,
      teamId: 'T_DM',
      botToken: 'xoxb-dm',
    });
    env.supportChannelId = ch.id;
  });

  it('a member DM lands on their concierge conversation bound to the support channel', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        return new Response('{"ok":true,"ts":"8.9"}', { status: 200 });
      }),
    );
    const res = await dm('U_DM', 'how do *alerts* work?');
    expect(res.status).toBe(200);

    const [binding] = await db
      .select()
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.channelId, convChannelId),
          eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
        ),
      );
    expect(binding).toBeTruthy();
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, binding.conversationId));
    const inbound = rows.find((m) => m.direction === 'in');
    // mrkdwn → canonical on the way in
    expect(inbound?.text).toBe('how do **alerts** work?');
    expect((inbound?.payload as { slack_ts?: string })?.slack_ts).toBeTruthy();
    expect((inbound?.payload as { via_slack_dm?: boolean })?.via_slack_dm).toBe(true);

    // The console context pack lands on the conversation — agent/channel
    // uuids in context are what the concierge builds (and the link guard
    // verifies) /agents/<id> deep links from.
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, binding.conversationId));
    const md = (conv.userProfile as { metadata?: Record<string, unknown> }).metadata!;
    expect(md.surface).toBe('slack');
    expect(String(md.workspaces)).toContain('DM WS');
    expect(String(md.agents)).toContain('Concierge <');
    expect(String(md.agents)).toMatch(/webchat:[0-9a-f-]{36}/);
  });

  it('a non-member DM gets a polite refusal, not silence', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
        if (String(url).includes('users.info')) {
          return new Response('{"ok":true,"user":{"profile":{"email":"nobody@elsewhere.c"}}}', {
            status: 200,
          });
        }
        return new Response('{"ok":true,"ts":"8.9"}', { status: 200 });
      }),
    );
    const res = await dm('U_STRANGER9', 'hello?');
    expect(res.status).toBe(200);
    const refusal = calls.find(
      (c) => c.url.includes('chat.postMessage') && c.body.channel === DCHAN,
    );
    expect(refusal).toBeTruthy();
    expect(String(refusal!.body.text)).toContain("isn't linked");
  });

  it('the installer resolves even when their Slack email differs from Janis', async () => {
    // Slack user ids are team-scoped and the installer's Slack profile email
    // may differ from their Janis email — the OAuth installer pair is the
    // link. Regression: this exact case produced "isn't linked" refusals.
    const [installer] = await db
      .insert(users)
      .values({ email: 'installer@x.c', name: 'Installer', slackUserId: 'U_OTHER_TEAM' })
      .returning();
    await db.insert(memberships).values({
      userId: installer.id,
      workspaceId: wsId,
      role: 'admin',
      acceptedAt: new Date(),
    });
    await db
      .update(slackInstallations)
      .set({ installerUserId: installer.id, installerSlackUserId: 'U_INST9' })
      .where(eq(slackInstallations.teamId, 'T_DM'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('users.info')) {
          return new Response('{"ok":true,"user":{"profile":{"email":"different@gmail.c"}}}', {
            status: 200,
          });
        }
        return new Response('{"ok":true,"ts":"8.9"}', { status: 200 });
      }),
    );
    const res = await dm('U_INST9', 'hi janis');
    expect(res.status).toBe(200);

    const [link] = await db
      .select()
      .from(slackMemberLinks)
      .where(
        and(
          eq(slackMemberLinks.slackUserId, 'U_INST9'),
          eq(slackMemberLinks.userId, installer.id),
        ),
      );
    expect(link).toBeTruthy();

    const [binding] = await db
      .select()
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.channelId, convChannelId),
          eq(channelBindings.platformUserId, `u:${installer.id}:tslackdm`),
        ),
      );
    expect(binding).toBeTruthy();
  });

  it('duplicate DM deliveries ingest once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"ok":true,"ts":"8.9"}', { status: 200 })),
    );
    const payload = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_DM',
      event: {
        type: 'message',
        channel: DCHAN,
        channel_type: 'im',
        ts: '8.555',
        user: 'U_DM',
        text: 'dup check',
      },
    });
    await Promise.all([
      signedPost(payload, '/slack/events'),
      signedPost(payload, '/slack/events'),
    ]);
    await signedPost(payload, '/slack/events');
    const [binding] = await db
      .select()
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.channelId, convChannelId),
          eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
        ),
      );
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, binding.conversationId));
    const dups = rows.filter(
      (m) => (m.payload as { slack_ts?: string })?.slack_ts === '8.555',
    );
    expect(dups.length).toBe(1);
  });

  it(
    'a parked approval card posts Slack buttons; approving in Slack runs it and relays the outcome',
    { timeout: 20000 },
    async () => {
    const [concierge] = await db.select().from(agents).where(eq(agents.name, 'Concierge'));
    const prevOpWs = env.operatorWorkspaceId;
    env.operatorWorkspaceId = wsId;
    // A second install on the same workspace — prod hit this: the
    // workspace-install fallback picked an arbitrary row and tried to
    // edit this team's DM with the OTHER team's token. The posting
    // install's id is now recorded in slackPosts so resolution is exact.
    const [otherInst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: wsId, teamId: 'T_OTHER', botToken: 'xoxb-other' })
      .returning();
    try {
      // hosted flips the relay from early-return to poll — a card is the
      // only thing this turn produces, and card posts count toward settle.
      await db.update(agents).set({ hosted: true }).where(eq(agents.id, concierge.id));
      const [jerry] = await db
        .insert(agents)
        .values({ workspaceId: wsId, name: 'Jerry Garcia', hosted: true })
        .returning();
      // concierge cards gate admin-only writes
      await db
        .update(memberships)
        .set({ role: 'admin' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));

      const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
            calls.push({
              url: String(url),
              body: init?.body ? JSON.parse(init.body) : {},
              auth: init?.headers?.Authorization,
            });
            return new Response('{"ok":true,"ts":"9.9","channel":"D_CONCIERGE"}', { status: 200 });
          },
        ),
      );

      // Seed the binding, then park the card mid-flight so it lands inside
      // the relay's `before` window.
      await dm('U_DM', 'seed');
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelId, convChannelId),
            eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
          ),
        );
      const dmRun = dm('U_DM', 'add to knowledge "my hair was blue for 3 days once"');
      await new Promise((r) => setTimeout(r, 500));
      const [pa] = await db
        .insert(pendingActions)
        .values({
          workspaceId: wsId,
          agentId: concierge.id,
          conversationId: binding.conversationId,
          toolName: 'apply_knowledge',
          tool: { builtin: 'apply_knowledge' } as never,
          args: {
            workspace_id: wsId,
            agent_id: jerry.id,
            entry: 'my hair was blue for 3 days once',
          } as never,
        })
        .returning();
      await db.insert(messages).values({
        conversationId: binding.conversationId,
        direction: 'human',
        text: 'Teach Jerry Garcia',
        flags: { action_request: true },
        payload: {
          internal: true,
          event: 'action proposed',
          action: {
            id: pa.id,
            tool: 'apply_knowledge',
            label: 'Teach Jerry Garcia',
            args: {},
            display: { agent: 'Jerry Garcia', entry: 'my hair was blue for 3 days once' },
            status: 'pending',
          },
        },
      });
      await dmRun;

      // The card reached Slack as real buttons, and its posted ts was
      // recorded for outcome resolution.
      const card = calls.find(
        (c) =>
          c.url.includes('chat.postMessage') &&
          c.body.channel === 'D_CONCIERGE' &&
          JSON.stringify(c.body.blocks ?? []).includes('janis_approve_action'),
      );
      expect(card).toBeTruthy();
      expect(JSON.stringify(card!.body.blocks)).toContain(pa.id);
      const [postedPa] = await db
        .select({ slackPosts: pendingActions.slackPosts })
        .from(pendingActions)
        .where(eq(pendingActions.id, pa.id));
      const [dmInst] = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, 'T_DM'));
      expect(postedPa.slackPosts).toEqual([
        { channelId: 'D_CONCIERGE', ts: '9.9', installationId: dmInst.id },
      ]);

      // The member approves in Slack — no console round trip. DM payloads
      // can arrive without payload.channel; the destination resolves via
      // container.channel_id (and would fall back to the card's own
      // slackPosts row).
      calls.length = 0;
      const click = await signedPost(
        `payload=${encodeURIComponent(
          JSON.stringify({
            type: 'block_actions',
            user: { id: 'U_DM' },
            team: { id: 'T_DM' },
            container: { channel_id: 'D_CONCIERGE', message_ts: '9.9' },
            message: { ts: '9.9' },
            actions: [{ action_id: 'janis_approve_action', value: pa.id }],
          }),
        )}`,
        '/slack/interactions',
      );
      expect(click.status).toBe(200);

      // Approved + executed — knowledge landed on Jerry.
      const [decided] = await db
        .select({ status: pendingActions.status })
        .from(pendingActions)
        .where(eq(pendingActions.id, pa.id));
      expect(decided.status).toBe('approved');
      const [jerryAfter] = await db.select().from(agents).where(eq(agents.id, jerry.id));
      expect((jerryAfter.config as { knowledge?: string[] }).knowledge).toContain(
        'my hair was blue for 3 days once',
      );

      // The card rewrote itself to the outcome on the POSTING install's
      // token — the second same-workspace install must not be picked —
      // and the deterministic "Done —" line relayed to the DM.
      const update = calls.find(
        (c) => c.url.includes('chat.update') && c.body.channel === 'D_CONCIERGE',
      );
      expect(update).toBeTruthy();
      expect(update!.auth).toBe('Bearer xoxb-dm');
      expect(JSON.stringify(update!.body.blocks)).toContain('approved');
      expect(JSON.stringify(update!.body.blocks)).not.toContain('janis_approve_action');
      const done = calls.find(
        (c) =>
          c.url.includes('chat.postMessage') &&
          c.body.channel === 'D_CONCIERGE' &&
          String(c.body.text).includes('Done'),
      );
      expect(done).toBeTruthy();
    } finally {
      env.operatorWorkspaceId = prevOpWs;
      await db.update(agents).set({ hosted: false }).where(eq(agents.name, 'Concierge'));
      await db
        .update(memberships)
        .set({ role: 'member' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));
      await db.delete(slackInstallations).where(eq(slackInstallations.id, otherInst.id));
    }
    },
  );

  it(
    'approving a concierge card clicked on a sibling team resolves the click install, not the thread install',
    { timeout: 20000 },
    async () => {
    const [concierge] = await db.select().from(agents).where(eq(agents.name, 'Concierge'));
    const prevOpWs = env.operatorWorkspaceId;
    env.operatorWorkspaceId = wsId;
    // The conv's slack_threads row anchors to a DIFFERENT Slack team's
    // install — same workspace, several installs. Prod hit this: the click
    // in the T_DM DM was identity-checked against T_ANCHOR's user ids and
    // a real admin got "not a member".
    const [anchorInst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: wsId, teamId: 'T_ANCHOR', botToken: 'xoxb-anchor' })
      .returning();
    try {
      await db.update(agents).set({ hosted: true }).where(eq(agents.id, concierge.id));
      const [jerry] = await db
        .insert(agents)
        .values({ workspaceId: wsId, name: 'Click Target', hosted: true })
        .returning();
      await db
        .update(memberships)
        .set({ role: 'admin' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));

      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
          return new Response('{"ok":true,"ts":"9.9","channel":"D_CONCIERGE"}', { status: 200 });
        }),
      );

      await dm('U_DM', 'seed');
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelId, convChannelId),
            eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
          ),
        );
      // Anchor the conversation's thread to the OTHER team's install.
      await db.insert(slackThreads).values({
        conversationId: binding.conversationId,
        installationId: anchorInst.id,
        channelId: 'C_ANCHOR',
        ts: '1.1',
      });
      const [pa] = await db
        .insert(pendingActions)
        .values({
          workspaceId: wsId,
          agentId: concierge.id,
          conversationId: binding.conversationId,
          toolName: 'apply_knowledge',
          tool: { builtin: 'apply_knowledge' } as never,
          args: {
            workspace_id: wsId,
            agent_id: jerry.id,
            entry: 'cross-team click knowledge',
          } as never,
        })
        .returning();

      // The member approves from the T_DM install — the thread points at
      // T_ANCHOR, so without team re-resolution this click denies.
      const click = await signedPost(
        `payload=${encodeURIComponent(
          JSON.stringify({
            type: 'block_actions',
            user: { id: 'U_DM' },
            team: { id: 'T_DM' },
            container: { channel_id: 'D_CONCIERGE', message_ts: '9.9' },
            message: { ts: '9.9' },
            actions: [{ action_id: 'janis_approve_action', value: pa.id }],
          }),
        )}`,
        '/slack/interactions',
      );
      expect(click.status).toBe(200);

      const [decided] = await db
        .select({ status: pendingActions.status })
        .from(pendingActions)
        .where(eq(pendingActions.id, pa.id));
      expect(decided.status).toBe('approved');
      expect(calls.some((c) => String(c.body.text).includes('not a member'))).toBe(false);
    } finally {
      env.operatorWorkspaceId = prevOpWs;
      await db.update(agents).set({ hosted: false }).where(eq(agents.name, 'Concierge'));
      await db
        .update(memberships)
        .set({ role: 'member' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));
      await db
        .delete(slackThreads)
        .where(eq(slackThreads.installationId, anchorInst.id));
      await db.delete(slackInstallations).where(eq(slackInstallations.id, anchorInst.id));
    }
    },
  );

  it(
    'dismissing a parked card rewrites it to the denied outcome and relays Dismissed',
    { timeout: 20000 },
    async () => {
    const [concierge] = await db.select().from(agents).where(eq(agents.name, 'Concierge'));
    const prevOpWs = env.operatorWorkspaceId;
    env.operatorWorkspaceId = wsId;
    try {
      await db.update(agents).set({ hosted: true }).where(eq(agents.id, concierge.id));
      const [jerry] = await db
        .insert(agents)
        .values({ workspaceId: wsId, name: 'Deny Target', hosted: true })
        .returning();
      await db
        .update(memberships)
        .set({ role: 'admin' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));

      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
          return new Response('{"ok":true,"ts":"9.8","channel":"D_CONCIERGE"}', { status: 200 });
        }),
      );

      await dm('U_DM', 'seed deny');
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelId, convChannelId),
            eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
          ),
        );
      const dmRun = dm('U_DM', 'teach deny target something');
      await new Promise((r) => setTimeout(r, 500));
      const [pa] = await db
        .insert(pendingActions)
        .values({
          workspaceId: wsId,
          agentId: concierge.id,
          conversationId: binding.conversationId,
          toolName: 'apply_knowledge',
          tool: { builtin: 'apply_knowledge' } as never,
          args: {
            workspace_id: wsId,
            agent_id: jerry.id,
            entry: 'should never land',
          } as never,
        })
        .returning();
      await db.insert(messages).values({
        conversationId: binding.conversationId,
        direction: 'human',
        text: 'Teach Deny Target',
        flags: { action_request: true },
        payload: {
          internal: true,
          event: 'action proposed',
          action: { id: pa.id, label: 'Teach Deny Target', display: { agent: 'Deny Target' } },
        },
      });
      await dmRun;

      calls.length = 0;
      const click = await signedPost(
        `payload=${encodeURIComponent(
          JSON.stringify({
            type: 'block_actions',
            user: { id: 'U_DM' },
            team: { id: 'T_DM' },
            container: { channel_id: 'D_CONCIERGE', message_ts: '9.8' },
            actions: [{ action_id: 'janis_deny_action', value: pa.id }],
          }),
        )}`,
        '/slack/interactions',
      );
      expect(click.status).toBe(200);

      const [decided] = await db
        .select({ status: pendingActions.status })
        .from(pendingActions)
        .where(eq(pendingActions.id, pa.id));
      expect(decided.status).toBe('denied');
      const [jerryAfter] = await db.select().from(agents).where(eq(agents.id, jerry.id));
      expect((jerryAfter.config as { knowledge?: string[] }).knowledge ?? []).not.toContain(
        'should never land',
      );

      const update = calls.find(
        (c) => c.url.includes('chat.update') && c.body.channel === 'D_CONCIERGE',
      );
      expect(update).toBeTruthy();
      expect(JSON.stringify(update!.body.blocks)).toContain('denied');
      expect(JSON.stringify(update!.body.blocks)).not.toContain('janis_approve_action');
      expect(JSON.stringify(update!.body.blocks)).not.toContain('janis_deny_action');
      const dismissed = calls.find(
        (c) =>
          c.url.includes('chat.postMessage') &&
          c.body.channel === 'D_CONCIERGE' &&
          String(c.body.text).includes('Dismissed'),
      );
      expect(dismissed).toBeTruthy();
    } finally {
      env.operatorWorkspaceId = prevOpWs;
      await db.update(agents).set({ hosted: false }).where(eq(agents.name, 'Concierge'));
      await db
        .update(memberships)
        .set({ role: 'member' })
        .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));
    }
    },
  );

  it(
    'concierge quick replies post as buttons; a click injects the pick as the clicker\'s own turn',
    { timeout: 20000 },
    async () => {
    const [concierge] = await db.select().from(agents).where(eq(agents.name, 'Concierge'));
    await db.update(agents).set({ hosted: true }).where(eq(agents.id, concierge.id));
    try {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
          return new Response('{"ok":true,"ts":"9.9","channel":"D_CONCIERGE"}', { status: 200 });
        }),
      );

      await dm('U_DM', 'seed');
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelId, convChannelId),
            eq(channelBindings.platformUserId, `u:${memberId}:tslackdm`),
          ),
        );

      // An outbound concierge reply carrying quick replies lands mid-poll.
      const dmRun = dm('U_DM', 'what can I do?');
      await new Promise((r) => setTimeout(r, 500));
      await db.insert(messages).values({
        conversationId: binding.conversationId,
        direction: 'out',
        text: 'Here are a few things:',
        payload: { quick_replies: ['Show my agents', 'Check billing'] },
      });
      await dmRun;

      const reply = calls.find(
        (c) =>
          c.url.includes('chat.postMessage') &&
          c.body.channel === DCHAN &&
          JSON.stringify(c.body.blocks ?? []).includes('janis_quick_reply'),
      );
      expect(reply).toBeTruthy();
      const actions = (reply!.body.blocks as { type: string; elements?: { value?: string }[] }[]).find(
        (b) => b.type === 'actions',
      );
      expect(actions!.elements!.map((e) => e.value)).toEqual(['Show my agents', 'Check billing']);
      // `blocks` renders INSTEAD of the text field — the reply body must
      // live in a section block or the message shows as bare buttons.
      expect(JSON.stringify(reply!.body.blocks)).toContain('Here are a few things:');

      // The member taps "Show my agents" — buttons swap to a picked line,
      // and the pick ingests as their own concierge inbound.
      calls.length = 0;
      const click = await signedPost(
        `payload=${encodeURIComponent(
          JSON.stringify({
            type: 'block_actions',
            user: { id: 'U_DM' },
            team: { id: 'T_DM' },
            channel: { id: DCHAN },
            message: {
              ts: '9.9',
              text: 'Here are a few things:',
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: 'Here are a few things:' } },
                { type: 'actions', elements: [{ type: 'button', action_id: 'janis_quick_reply' }] },
              ],
            },
            actions: [{ action_id: 'janis_quick_reply', action_ts: '12.34', value: 'Show my agents' }],
          }),
        )}`,
        '/slack/interactions',
      );
      expect(click.status).toBe(200);
      await new Promise((r) => setTimeout(r, 1500));

      const update = calls.find((c) => c.url.includes('chat.update') && c.body.ts === '9.9');
      expect(update).toBeTruthy();
      expect(JSON.stringify(update!.body.blocks)).toContain('picked');
      expect(JSON.stringify(update!.body.blocks)).not.toContain('"actions"');

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, binding.conversationId));
      expect(
        rows.some(
          (m) => m.direction === 'in' && m.text === 'Show my agents',
        ),
      ).toBe(true);
    } finally {
      await db.update(agents).set({ hosted: false }).where(eq(agents.name, 'Concierge'));
    }
    },
  );

  it(
    'channel mentions share one conversation per member per channel; replies mirror placement',
    { timeout: 20000 },
    async () => {
    const [concierge] = await db.select().from(agents).where(eq(agents.name, 'Concierge'));
    await db.update(agents).set({ hosted: true }).where(eq(agents.id, concierge.id));
    try {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
          return new Response('{"ok":true,"ts":"9.9","channel":"C_MENTION"}', { status: 200 });
        }),
      );
      const mention = (text: string, extra?: { thread_ts?: string; ts?: string }) =>
        signedPost(
          JSON.stringify({
            type: 'event_callback',
            team_id: 'T_DM',
            event: {
              type: 'app_mention',
              channel: 'C_MENTION',
              ts: extra?.ts ?? `7.${Math.random().toString(36).slice(2, 6)}`,
              user: 'U_DM',
              text,
              ...(extra?.thread_ts ? { thread_ts: extra.thread_ts } : {}),
            },
          }),
          '/slack/events',
        );

      // Top-level mention → channel-scoped binding (u:<member>:t<channel>),
      // replies post top-level — no thread is created.
      const run = mention('<@U9BOTUSER> hello');
      await new Promise((r) => setTimeout(r, 500));
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelId, convChannelId),
            eq(channelBindings.platformUserId, `u:${memberId}:tc_mention`),
          ),
        );
      expect(binding).toBeTruthy();
      await db.insert(messages).values({
        conversationId: binding.conversationId,
        direction: 'out',
        text: 'top-level answer',
      });
      await run;
      const topReply = calls.find(
        (c) => c.url.includes('chat.postMessage') && c.body.text === 'top-level answer',
      );
      expect(topReply).toBeTruthy();
      expect(topReply!.body.thread_ts).toBeUndefined();

      // A mention inside an existing thread continues the SAME conversation
      // and answers inside that thread.
      calls.length = 0;
      const run2 = mention('<@U9BOTUSER> follow up', { thread_ts: '5.5', ts: '7.777' });
      await new Promise((r) => setTimeout(r, 500));
      await db.insert(messages).values({
        conversationId: binding.conversationId,
        direction: 'out',
        text: 'in-thread answer',
      });
      await run2;
      const threadReply = calls.find(
        (c) => c.url.includes('chat.postMessage') && c.body.text === 'in-thread answer',
      );
      expect(threadReply).toBeTruthy();
      expect(threadReply!.body.thread_ts).toBe('5.5');

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, binding.conversationId));
      const ins = rows.filter((m) => m.direction === 'in');
      expect(ins.map((m) => m.text)).toEqual(['hello', 'follow up']);
    } finally {
      await db.update(agents).set({ hosted: false }).where(eq(agents.name, 'Concierge'));
    }
    },
  );
});

describe('disconnect installation', () => {
  let api: Hono;
  let cookie: string;
  let wsId: string;
  let instId: string;
  let agentId: string;
  let adminId: string;

  const req = (path: string, init: RequestInit = {}) =>
    api.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    api = new Hono().route('/api/slack', slackApiRoutes(db));
    const [ws] = await db.insert(workspaces).values({ name: 'Disconnect WS' }).returning();
    wsId = ws.id;
    const [admin] = await db.insert(users).values({ email: 'dc-admin@x.c', name: 'Admin' }).returning();
    adminId = admin.id;
    await db.insert(memberships).values({
      userId: admin.id,
      workspaceId: wsId,
      role: 'admin',
      acceptedAt: new Date(),
    });
    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId: admin.id,
      workspaceId: wsId,
      expiresAt: new Date(Date.now() + 86400_000),
    });
    cookie = `${SESSION_COOKIE}=${token}`;
    const { hash, preview } = generateApiKey();
    const [inst] = await db.insert(slackInstallations).values({
      workspaceId: wsId,
      teamId: 'T_DC',
      botToken: 'xoxb-dc',
      installerUserId: admin.id,
    }).returning();
    instId = inst.id;
    const [agent] = await db.insert(agents).values({
      workspaceId: wsId,
      name: 'Dc Bot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      slackRoutes: [{ installation_id: instId, channel_id: 'CAGENT' }],
    }).returning();
    agentId = agent.id;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'dc-conv' })
      .returning();
    await db.insert(slackThreads).values({
      conversationId: conv.id,
      installationId: instId,
      channelId: 'CALERT',
      ts: '9.9',
    });
    await db.insert(slackClassicChannels).values({
      installationId: instId,
      sourceChannel: 'messenger:1234',
      slackChannelId: 'CJCHAN',
      name: 'j-1234',
      clientKey: 'ck-dc',
    });
    await db.insert(slackClassicPrefs).values({
      installationId: instId,
      slackUserId: 'U_OP',
      clientKey: 'ck-dc',
    });
  });

  it('DELETE /:id removes the install plus classic channels, prefs, and threads', async () => {
    const res = await req(`/api/slack/${instId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await db.select().from(slackInstallations).where(eq(slackInstallations.id, instId))).toEqual([]);
    expect(await db.select().from(slackClassicChannels).where(eq(slackClassicChannels.installationId, instId))).toEqual([]);
    expect(await db.select().from(slackClassicPrefs).where(eq(slackClassicPrefs.installationId, instId))).toEqual([]);
    expect(await db.select().from(slackThreads).where(eq(slackThreads.installationId, instId))).toEqual([]);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.slackRoutes).toBeNull(); // last route → inherit workspace default
  });

  it('an install owned by another workspace is untouched', async () => {
    const [otherWs] = await db.insert(workspaces).values({ name: 'Foreign WS' }).returning();
    const [foreign] = await db.insert(slackInstallations).values({
      workspaceId: otherWs.id,
      teamId: 'T_FOREIGN',
      botToken: 'xoxb-f',
      installerUserId: adminId,
    }).returning();
    const res = await req(`/api/slack/${foreign.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200); // idempotent not-found for this workspace
    expect(
      await db.select().from(slackInstallations).where(eq(slackInstallations.id, foreign.id)),
    ).toHaveLength(1);
    await db.delete(slackInstallations).where(eq(slackInstallations.id, foreign.id));
    await db.delete(workspaces).where(eq(workspaces.id, otherWs.id));
  });
});
