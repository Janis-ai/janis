import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alerts, conversations, memberships, messages, sessions, slackInstallations, slackThreads, users, workspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { slackApiRoutes, slackPublicRoutes } from './slack.js';
import { findThread, mirrorToSlack, postSlackAlert, removeMemberFromAlertChannels, syncMemberToAlertChannels } from '../lib/slack.js';
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

beforeEach(() => vi.unstubAllGlobals());

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
    // mirrors keep landing in the thread
    calls.length = 0;
    await mirrorToSlack(db, convId, 'x', 'hello again', { direction: 'out' });
    const mirrored = calls.filter(
      (c) => c.url.includes('chat.postMessage') && c.body.text === 'hello again',
    );
    expect(mirrored.map((m) => m.body.thread_ts)).toEqual(['1.0']);
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
      // opted out → the agent masquerade returns
      await db.update(users).set({ showIdentity: false }).where(eq(users.id, memberId));
      calls.length = 0;
      await event('U_LINKED', 'anonymous reply');
      await new Promise((r) => setTimeout(r, 50));
      const masked = calls.find(
        (c) => c.url.includes('chat.postMessage') && c.body.username === 'EvBot (operator)',
      );
      expect(masked?.body.text).toBe('anonymous reply');
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
    await db.insert(slackInstallations).values({
      workspaceId: wsId,
      teamId: 'T_CH',
      botToken: 'xoxb-ch',
      installerUserId: admin.id,
      alertChannelId: 'CSEL',
    });
    const { hash, preview } = generateApiKey();
    await db.insert(agents).values({
      workspaceId: wsId,
      name: 'Ch Agent',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      slackChannelId: 'CAGENT',
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
    await db.insert(slackInstallations).values({
      workspaceId: ws.id,
      teamId: 'T_SYNC',
      botToken: 'xoxb-sync',
      alertChannelId: 'C_MAIN',
    });
    const { hash, preview } = generateApiKey();
    await db.insert(agents).values({
      workspaceId: ws.id,
      name: 'OverrideBot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      slackChannelId: 'C_AGENT',
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
