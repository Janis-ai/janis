import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channelBindings,
  channels,
  conversations,
  messages,
  slackInstallations,
  workspaces,
} from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { generateApiKey } from '../lib/crypto.js';
import { slackPublicRoutes } from './slack.js';
import { sendChannelMessage } from '../lib/channels.js';
import { env } from '../env.js';

let app: Hono;
let db: Db;
let wsId: string;
let agent: typeof agents.$inferSelect;
const APP_SECRET = 'shared-app-secret';
const MANUAL_SECRET = 'manual-app-secret';
const MANUAL_TOKEN = 'xoxb-manual-token';
const INST_TOKEN = 'xoxb-install-token';

function sig(secret: string, ts: string, body: string) {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function postJson(path: string, secret: string, body: unknown, badSig = false) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': badSig ? 'v0=bogus' : sig(secret, ts, raw),
    },
    body: raw,
  });
}

const ev = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: 'T_MANUAL',
  event: {
    type: 'message',
    channel: 'D_DM',
    channel_type: 'im',
    user: 'U_VIS',
    text: 'hello there',
    ts: `1700.${Math.random().toString().slice(2, 8)}`,
    ...over,
  },
});

async function convFor(channelId: string, participant: string) {
  const [b] = await db
    .select({ conv: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channelId),
        eq(channelBindings.platformUserId, participant),
      ),
    )
    .limit(1);
  return b?.conv;
}

/** Slack API stub — routes by method suffix; records calls for asserts. */
function stubSlackApi(calls: { method: string; body: unknown }[]) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'users.info') {
      return new Response(
        JSON.stringify({
          ok: true,
          user: { name: 'vis', real_name: 'Visitor One', profile: { display_name: 'Visitor', email: 'vis@example.com', image_72: 'https://img.test/v.png' } },
        }),
        { status: 200 },
      );
    }
    if (method === 'chat.postMessage') {
      return new Response(JSON.stringify({ ok: true, ts: '1701.000001', channel: 'D_DM' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/slack', slackPublicRoutes(db));
  env.slackSigningSecret = APP_SECRET;
  env.legacySlackInteractionsUrl = 'https://legacy-slack.test/slack/receive';

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const { hash, preview } = generateApiKey();
  [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Helper Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('manual (BYO) slack channel events', () => {
  it('verifies url_verification challenge and rejects bad signatures', async () => {
    const [channel] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'slack',
        name: 'Slack',
        credentials: {
          via: 'manual',
          slack_bot_token: MANUAL_TOKEN,
          slack_signing_secret: MANUAL_SECRET,
          slack_dm: true,
        },
      })
      .returning();
    const res = await postJson(`/slack/ext/${channel.id}/events`, MANUAL_SECRET, {
      type: 'url_verification',
      challenge: 'ch42',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'ch42' });

    const bad = await postJson(`/slack/ext/${channel.id}/events`, MANUAL_SECRET, { type: 'url_verification', challenge: 'x' }, true);
    expect(bad.status).toBe(401);
  });

  it('ingests a bot DM as a visitor conversation and stamps the reply target', async () => {
    const [channel] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'slack',
        name: 'Slack',
        credentials: {
          via: 'manual',
          slack_bot_token: MANUAL_TOKEN,
          slack_signing_secret: MANUAL_SECRET,
          slack_team_id: 'T_MANUAL',
          slack_dm: true,
        },
      })
      .returning();
    vi.stubGlobal('fetch', stubSlackApi([]));

    const res = await postJson(`/slack/ext/${channel.id}/events`, MANUAL_SECRET, ev());
    expect(res.status).toBe(200);

    const conv = await convFor(channel.id, `slack:T_MANUAL:U_VIS`);
    expect(conv).toBeTruthy();
    expect(conv?.agentId).toBe(agent.id);
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id))
      .limit(1);
    expect(msg.text).toBe('hello there');
    const slackMeta = (msg.payload as { slack?: Record<string, unknown> }).slack;
    expect(slackMeta?.channel).toBe('D_DM');
    expect(slackMeta?.channel_type).toBe('im');
    expect((conv?.userProfile as { email?: string }).email).toBe('vis@example.com');
    expect((conv?.userProfile as { identity_verified?: boolean }).identity_verified).toBe(false);
  });

  it('ignores events on unclaimed surfaces', async () => {
    const [channel] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'slack',
        name: 'Slack',
        credentials: {
          via: 'manual',
          slack_bot_token: MANUAL_TOKEN,
          slack_signing_secret: MANUAL_SECRET,
          slack_channel_ids: ['C_BOUND'],
          slack_dm: false,
        },
      })
      .returning();
    vi.stubGlobal('fetch', stubSlackApi([]));

    // DM not claimed (slack_dm off) — no conversation.
    await postJson(`/slack/ext/${channel.id}/events`, MANUAL_SECRET, ev({ ts: '1702.000001' }));
    expect(await convFor(channel.id, 'slack:T_MANUAL:U_VIS')).toBeFalsy();

    // bound channel message — ingests.
    await postJson(
      `/slack/ext/${channel.id}/events`,
      MANUAL_SECRET,
      ev({ channel: 'C_BOUND', channel_type: 'channel', ts: '1702.000002' }),
    );
    const conv = await convFor(channel.id, 'slack:T_MANUAL:U_VIS');
    expect(conv).toBeTruthy();
  });
});

describe('shared-app visitor events', () => {
  it('claims bound surfaces before the concierge', async () => {
    const [inst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: wsId, teamId: 'T_SHARED', botToken: INST_TOKEN })
      .returning();
    const [vChannel] = await db.insert(channels).values({
      workspaceId: wsId,
      agentId: agent.id,
      kind: 'slack',
      name: 'Slack',
      credentials: {
        via: 'oauth',
        slack_installation_id: inst.id,
        slack_team_id: 'T_SHARED',
        slack_dm: true,
      },
    }).returning();
    vi.stubGlobal('fetch', stubSlackApi([]));

    const res = await postJson('/slack/events', APP_SECRET, {
      type: 'event_callback',
      team_id: 'T_SHARED',
      event: {
        type: 'message',
        channel: 'D_DM',
        channel_type: 'im',
        user: 'U_VIS2',
        text: 'hi concierge-claimable dm',
        ts: '1703.000001',
      },
    });
    expect(res.status).toBe(200);
    // Visitor path claimed it — a conversation exists keyed to the slack user.
    const conv = await convFor(vChannel.id ?? '', 'slack:T_SHARED:U_VIS2');
    expect(conv).toBeTruthy();
    expect(conv?.agentId).toBe(agent.id);
  });
});

describe('sendSlackReply', () => {
  it('posts to the DM unthreaded with the agent persona', async () => {
    const [channel] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'slack',
        name: 'Slack',
        credentials: {
          via: 'manual',
          slack_bot_token: MANUAL_TOKEN,
          slack_signing_secret: MANUAL_SECRET,
          slack_dm: true,
        },
      })
      .returning();
    const calls: { method: string; body: { channel?: string; thread_ts?: string; text?: string; username?: string } }[] = [];
    vi.stubGlobal('fetch', stubSlackApi(calls));

    await postJson(`/slack/ext/${channel.id}/events`, MANUAL_SECRET, ev({ ts: '1704.000001' }));
    const result = await sendChannelMessage(channel, 'slack:T_MANUAL:U_VIS', '**hi** there', undefined, undefined, db);
    expect(result?.mid).toBe('1701.000001');
    const post = calls.find((cl) => cl.method === 'chat.postMessage');
    expect(post?.body.channel).toBe('D_DM');
    expect(post?.body.thread_ts).toBeUndefined(); // DM convention — unthreaded
    expect(post?.body.text).toBe('*hi* there'); // canonical → mrkdwn
    expect(post?.body.username).toBe('Helper Bot');
  });

  it('threads channel replies under the inbound anchor', async () => {
    const [channel] = await db
      .insert(channels)
      .values({
        workspaceId: wsId,
        agentId: agent.id,
        kind: 'slack',
        name: 'Slack',
        credentials: {
          via: 'manual',
          slack_bot_token: MANUAL_TOKEN,
          slack_signing_secret: MANUAL_SECRET,
          slack_channel_ids: ['C_SUPPORT'],
        },
      })
      .returning();
    const calls: { method: string; body: { channel?: string; thread_ts?: string } }[] = [];
    vi.stubGlobal('fetch', stubSlackApi(calls));

    await postJson(
      `/slack/ext/${channel.id}/events`,
      MANUAL_SECRET,
      ev({ channel: 'C_SUPPORT', channel_type: 'channel', ts: '1705.000009', user: 'U_C1' }),
    );
    const result = await sendChannelMessage(channel, 'slack:T_MANUAL:U_C1', 'answer', undefined, undefined, db);
    expect(result?.mid).toBeTruthy();
    const post = calls.find((cl) => cl.method === 'chat.postMessage');
    expect(post?.body.channel).toBe('C_SUPPORT');
    expect(post?.body.thread_ts).toBe('1705.000009'); // new thread under their post
  });
});
