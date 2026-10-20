import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  agents,
  conversations,
  memberships,
  messages,
  slackClassicChannels,
  slackClassicPrefs,
  slackInstallations,
  users,
  workspaces,
} from '../../db/schema.js';
import {
  applyCustomAlertIntentCheck,
  isPro,
  logSeverityFor,
  resolveAlertSettings,
  sentimentSeverityFor,
  suppressionReason,
} from './gates.js';
import { assistanceHeader, errorHeader, logHeader, slashCommandWarning } from './strings.js';
import { getUserProfile, getUsername, removeFormatting, suggestedChannelName } from './profiles.js';
import { makeFbMessage, normalizeTranscriptAttachments } from './attachments.js';
import { dispatchClassicEvent, makeClassicCtx } from './index.js';
import { fetchBacklog, markProcessed } from './store.js';
import { classicIncoming, classicApiAiResponse, handleClassicCallback, handleClassicSlash } from './relay.js';

// ── Gates (pure) ────────────────────────────────────────────────────────────

describe('isPro', () => {
  const basic = 'basic_plan_id';
  beforeAll(() => {
    process.env.STRIPE_PLAN_BASIC = basic;
  });
  it('trialing → pro', () => {
    expect(isPro({ subscription: { status: 'trialing', plan: { id: basic } } })).toBe(true);
  });
  it('non-basic active → pro', () => {
    expect(isPro({ subscription: { status: 'active', plan: { id: 'pro' } } })).toBe(true);
  });
  it('basic active → not pro', () => {
    expect(isPro({ subscription: { status: 'active', plan: { id: basic } } })).toBe(false);
  });
  it('delinquent → not pro even on paid plan', () => {
    expect(
      isPro({
        stripe_customer: { delinquent: true },
        subscription: { status: 'active', plan: { id: 'pro' } },
      }),
    ).toBe(false);
  });
  it('no subscription → not pro', () => {
    expect(isPro({})).toBe(false);
    expect(isPro(null)).toBe(false);
  });
});

describe('resolveAlertSettings fall-through', () => {
  it('custom_alerts entry wins', () => {
    const doc = {
      custom_alerts: [{ client_key: 'ck', customAlertSeverityLevel: 1 }],
      customAlertSeverityLevel: 0,
      bot_context: { client_key: 'ck' },
    };
    const out = resolveAlertSettings(doc, 'ck');
    expect(out.customAlertSeverityLevel).toBe(1);
  });
  it('doc-level field when no custom_alerts entry', () => {
    const out = resolveAlertSettings({ logSeverityLevel: 2 }, 'ck');
    expect(out.logSeverityLevel).toBe(2);
    expect(out.customAlertSeverityLevel).toBe(0);
  });
  it('bot_context match defaults to 1', () => {
    const out = resolveAlertSettings({ bot_context: { client_key: 'ck' } }, 'ck');
    expect(out.customAlertSeverityLevel).toBe(1);
    expect(out.helpNeededSeverityLevel).toBe(1);
  });
  it('no context → 0', () => {
    const out = resolveAlertSettings({ bot_context: { client_key: 'other' } }, 'ck');
    expect(out.logSeverityLevel).toBe(0);
  });
});

describe('applyCustomAlertIntentCheck', () => {
  const reply = (action: string, intentId: string) =>
    JSON.stringify({ result: { action, metadata: { intentId } } });
  it('non-alert action → 0', () => {
    expect(applyCustomAlertIntentCheck(1, {}, reply('block_redirect', 'i1'))).toBe(0);
  });
  it('alert.custom action passes', () => {
    expect(applyCustomAlertIntentCheck(1, {}, reply('alert.custom', 'i1'))).toBe(1);
  });
  it('custom_alert action passes', () => {
    expect(applyCustomAlertIntentCheck(1, {}, reply('custom_alert', 'i1'))).toBe(1);
  });
  it('intent match re-enables even when action check failed', () => {
    const obj = { intents: [{ id: 'i1' }] };
    expect(applyCustomAlertIntentCheck(1, obj, reply('block_redirect', 'i1'))).toBe(1);
  });
  it('no reply → unchanged', () => {
    expect(applyCustomAlertIntentCheck(1, {}, null)).toBe(1);
  });
});

describe('severity computation + suppression', () => {
  it('logSeverity bounds', () => {
    expect(logSeverityFor(1)).toBe(1);
    expect(logSeverityFor(5)).toBe(2);
    expect(logSeverityFor(16)).toBe(3);
    expect(logSeverityFor(undefined)).toBe(1);
  });
  it('sentiment bounds', () => {
    expect(sentimentSeverityFor(-0.95)).toBe(3);
    expect(sentimentSeverityFor(-0.85)).toBe(2);
    expect(sentimentSeverityFor(-0.75)).toBe(1);
    expect(sentimentSeverityFor(0)).toBe(1);
  });
  it('isFailure vs logSeverityLevel', () => {
    expect(
      suppressionReason('showLog', { logSeverityLevel: 0 }, { isFailure: true }),
    ).toBe('logSeverity');
    expect(
      suppressionReason('showLog', { logSeverityLevel: 3 }, { isFailure: true, count: 1 }),
    ).toBe('logSeverity'); // 3 > 1
    expect(
      suppressionReason('showLog', { logSeverityLevel: 1 }, { isFailure: true, count: 1 }),
    ).toBeNull();
  });
  it('non-failure showLog vs userUpset', () => {
    expect(
      suppressionReason('showLog', { userUpsetSeverityLevel: 0 }, { docSentiment: { score: -0.9 } }),
    ).toBe('userUpset');
    expect(
      suppressionReason('showLog', { userUpsetSeverityLevel: 2 }, { docSentiment: { score: -0.85 } }),
    ).toBeNull();
  });
  it('showLiveChat vs helpNeededSeverityLevel', () => {
    expect(suppressionReason('showLiveChat', { helpNeededSeverityLevel: 0 }, {})).toBe('helpNeeded');
    expect(suppressionReason('showLiveChat', { helpNeededSeverityLevel: 1 }, {})).toBeNull();
  });
  it('showCustomAlert vs customAlertSeverityLevel', () => {
    expect(suppressionReason('showCustomAlert', { customAlertSeverityLevel: 0 }, {})).toBe(
      'customAlert',
    );
    expect(suppressionReason('showCustomAlert', { customAlertSeverityLevel: 1 }, {})).toBeNull();
  });
});

// ── Strings ────────────────────────────────────────────────────────────────

describe('verbatim strings', () => {
  it('logHeader neutral + failure', () => {
    expect(logHeader('Bot', 1, 0, true)).toBe(':speak_no_evil: *Bot*: No response');
    expect(logHeader('Bot', 3, 0, true)).toContain(':speak_no_evil::speak_no_evil::speak_no_evil:');
  });
  it('logHeader sentiment prefix', () => {
    expect(logHeader('Bot', 1, -0.95, false)).toBe(':scream::scream::scream: *Bot*: Negative sentiment');
  });
  it('assistanceHeader', () => {
    expect(assistanceHeader('ChatbotAirTahiti')).toBe(
      ':information_desk_person::skin-tone-2: *ChatbotAirTahiti*: Help requested',
    );
  });
  it('errorHeader', () => {
    expect(errorHeader('Bot')).toBe(':warning: *Bot*');
  });
  it('slashCommandWarning', () => {
    expect(slashCommandWarning).toBe(
      '_`/pause` and `/resume` only work in user transcript channels._',
    );
  });
});

// ── Profiles / names ───────────────────────────────────────────────────────

describe('profiles + channel names', () => {
  it('getUsername precedence', () => {
    expect(getUsername({ displayName: 'D' })).toBe('D');
    expect(getUsername({ first_name: 'shane', last_name: 's' })).toBe('Shane s');
    expect(getUsername({ real_name_normalized: 'Norm' })).toBe('Norm');
    expect(getUsername({ id: 'x' })).toBe('x');
    expect(getUsername({})).toBe('User');
  });
  it('getUserProfile gender icons + image precedence', () => {
    const p = getUserProfile({ id: 'u', gender: 'male', first_name: 'A' });
    expect(p.icon_emoji).toBe(':boy:');
    const q = getUserProfile({ id: 'u', profile_pic: 'https://x/p.png' });
    expect(q.image).toBe('https://x/p.png');
    const bot = getUserProfile({ name: 'Janis' }, true);
    expect(bot.image).toContain('favicon.jpg');
  });
  it('suggestedChannelName j- prefix + sanitize', () => {
    expect(suggestedChannelName('5322', { first_name: 'Mike', last_name: 'N' }).name).toBe(
      'j-mike-n',
    );
    expect(suggestedChannelName('5322', {}).name).toBe('j-5322');
    expect(suggestedChannelName('5322', { name: 'A.B C!' }).name).toBe('j-a-b-c-');
  });
  it('removeFormatting', () => {
    expect(removeFormatting('<#C123|chan>')).toBe('chan');
    expect(removeFormatting('<!here>')).toBe('@here');
    expect(removeFormatting('<mailto:a@b.c|a@b.c>')).toBe('a@b.c');
    expect(removeFormatting('<@U123>')).toBe('<@U123>');
    const m = removeFormatting({ text: 'go <http://x.com|x.com>' });
    // label contained in link → link wins (verbatim)
    expect((m as { text: string }).text).toBe('go http://x.com');
    const m2 = removeFormatting({ text: 'go <http://x.com|here>' });
    expect((m2 as { text: string }).text).toBe('go here (http://x.com)');
  });
});

// ── Attachments ────────────────────────────────────────────────────────────

describe('makeFbMessage', () => {
  it('quick_replies → fb_buttons attachment', () => {
    const m = makeFbMessage({ text: 'hi', quick_replies: [{ title: 'Yes' }, { title: 'No' }], bot_name: 'B' });
    const att = m.attachments.find((a) => a.callback_id === 'fb_buttons');
    expect(att.actions.map((a: any) => a.value)).toEqual(['Yes', 'No']);
    expect(m.username).toBe('B');
    expect(m.transcript).toBe(true);
  });
  it('button template → fb_buttons', () => {
    const m = makeFbMessage({
      attachments: [
        {
          type: 'template',
          payload: {
            template_type: 'button',
            text: 'Pick',
            buttons: [{ title: 'A' }, { title: 'B' }],
          },
        },
      ],
    });
    expect(m.attachments[0].callback_id).toBe('fb_buttons');
    expect(m.attachments[0].text).toBe('Pick');
  });
  it('generic template → image + title/text + buttons per element', () => {
    const m = makeFbMessage({
      attachments: [
        {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [{ title: 'T', subtitle: 'S', image_url: 'http://i', buttons: [{ title: 'Go' }] }],
          },
        },
      ],
    });
    expect(m.attachments).toHaveLength(3);
    expect(m.attachments[0].image_url).toBe('http://i');
    expect(m.attachments[1].title).toBe('T');
  });
  it('normalizeTranscriptAttachments: audio → url text + mp4 upload', () => {
    const { out, fileUploads } = normalizeTranscriptAttachments([
      { type: 'audio', payload: { url: 'http://a' } },
    ]);
    expect(out[0].text).toBe('http://a');
    expect(fileUploads[0].filename).toBe('audio.mp4');
  });
});

// ── Dispatch (dry mode — full decision set, no Slack calls) ────────────────

describe('dispatchClassicEvent (dry)', () => {
  let db: Db;
  let ws: typeof workspaces.$inferSelect;
  let install: typeof slackInstallations.$inferSelect;
  let agent: typeof agents.$inferSelect;

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: './drizzle' });
    [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
    [agent] = await db.insert(agents).values({ workspaceId: ws.id, name: 'Bot' }).returning();
    [install] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: ws.id,
        teamId: 'T1',
        teamName: 't',
        botToken: 'xoxb-test',
        mode: 'classic',
        classicConfig: { pro: true, teamDomain: 't' },
      })
      .returning();
    const [u] = await db
      .insert(users)
      .values({ email: 'm@x.c', name: 'M', slackUserId: 'U1' })
      .returning();
    await db.insert(memberships).values({ userId: u.id, workspaceId: ws.id, role: 'admin' });
    // Member subscribed to intent i1 at level 1 on client_key ck
    await db.insert(slackClassicPrefs).values({
      installationId: install.id,
      slackUserId: 'U1',
      dmChannelId: 'D1',
      clientKey: 'ck',
      settings: { client_key: 'ck', customAlertSeverityLevel: 1, intents: [{ id: 'i1' }] },
    });
  });

  it('paused custom alert → suppressed reason=paused', async () => {
    const r = await dispatchClassicEvent(db, install, 'custom alert message', {
      client_key: 'ck',
      channel: '5322',
      paused: true,
      team_ids: ['T1'],
      reply: JSON.stringify({ result: { action: 'alert.custom', metadata: { intentId: 'i1' } } }),
    }, { dry: true });
    expect(r.posted).toHaveLength(0);
    expect(r.suppressed[0].reason).toBe('paused');
  });

  it('custom alert w/ matching intent subscription → DM post', async () => {
    const r = await dispatchClassicEvent(db, install, 'custom alert message', {
      client_key: 'ck',
      channel: '5322',
      paused: false,
      bot_name: 'Bot',
      text: 'Je veux parler à un agent',
      team_ids: ['T1'],
      user_profile: { name: 'Cust' },
      reply: JSON.stringify({
        result: { action: 'alert.custom', metadata: { intentId: 'i1', intentName: 'talk.agent' } },
      }),
    }, { dry: true });
    const alert = r.posted.find((p) => p.kind === 'alert:showCustomAlert');
    expect(alert).toBeTruthy();
    expect(alert!.channel).toBe('D1');
    const payload = r.posted.find((p) => p.kind === 'dry' && (p.payload as any)?.channel === 'D1');
    expect((payload!.payload as any).text).toBe(':bell: *Bot*: talk.agent');
  });

  it('custom alert w/o subscription → suppressed customAlert', async () => {
    // Member has a prefs row but default (unsubscribed) settings → level 0.
    await db.update(slackClassicPrefs).set({
      settings: { client_key: 'ck' },
      dmChannelId: 'D1',
    });
    const r = await dispatchClassicEvent(db, install, 'custom alert message', {
      client_key: 'ck',
      channel: '5322',
      paused: false,
      bot_name: 'Bot',
      team_ids: ['T1'],
      reply: JSON.stringify({
        result: { action: 'alert.custom', metadata: { intentId: 'i1' } },
      }),
    }, { dry: true });
    expect(r.posted.filter((p) => p.kind.startsWith('alert:'))).toHaveLength(0);
    expect(r.suppressed.some((s) => s.reason === 'customAlert')).toBe(true);
  });

  it('non-classic install → suppressed', async () => {
    const [newInst] = await db
      .insert(slackInstallations)
      .values({ workspaceId: ws.id, teamId: 'T2', botToken: 'x', mode: 'new' })
      .returning();
    const r = await dispatchClassicEvent(db, newInst, 'chat message', { channel: '1' });
    expect(r.suppressed[0].reason).toBe('not classic mode');
  });

  it('non-pro classic install → chat message suppressed not pro', async () => {
    const [np] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: ws.id,
        teamId: 'T3',
        botToken: 'x',
        mode: 'classic',
        classicConfig: { pro: false },
      })
      .returning();
    const r = await dispatchClassicEvent(db, np, 'chat message', { channel: '1' });
    expect(r.suppressed[0].reason).toBe('not pro');
  });

  it('bulk messages → transcript lines into existing j-channel', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:5322' })
      .returning();
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'hello', payload: { message: { text: 'hello', user: 'u1' } } },
      { conversationId: conv.id, direction: 'out', text: 'hi back', payload: { message: { text: 'hi back' } } },
    ]);
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: '5322',
      slackChannelId: 'C5322',
      name: 'j-5322',
    });
    const r = await dispatchClassicEvent(db, install, 'bulk messages', {
      client_key: 'ck',
      channel: '5322',
      team_ids: ['T1'],
    }, { dry: true });
    const lines = r.posted.filter((p) => p.kind.startsWith('transcript:'));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.channel)).toEqual(['C5322', 'C5322']);
    // messages now marked processed → second flush posts nothing
    const r2 = await dispatchClassicEvent(db, install, 'bulk messages', {
      client_key: 'ck',
      channel: '5322',
      team_ids: ['T1'],
    }, { dry: true });
    expect(r2.posted.filter((p) => p.kind.startsWith('transcript:'))).toHaveLength(0);
  });

  it('engage users skips j-channels', async () => {
    const r = await dispatchClassicEvent(db, install, 'engage users', {
      client_key: 'ck',
      channels: ['C5322'],
      message: 'broadcast',
      team_ids: ['T1'],
    }, { dry: true });
    expect(r.suppressed.some((s) => s.reason === 'engage into j-channel')).toBe(true);
  });
});

// ── Relay: commands, inbound, callbacks ────────────────────────────────────

describe('classic relay (dry)', () => {
  let db: Db;
  let ws: typeof workspaces.$inferSelect;
  let install: typeof slackInstallations.$inferSelect;
  let agent: typeof agents.$inferSelect;
  let conv: typeof conversations.$inferSelect;

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: './drizzle' });
    [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
    [agent] = await db.insert(agents).values({ workspaceId: ws.id, name: 'Bot' }).returning();
    [install] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: ws.id,
        teamId: 'T9',
        botToken: 'xoxb-test',
        mode: 'classic',
        classicConfig: { pro: true },
      })
      .returning();
    [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:7777' })
      .returning();
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: '7777',
      slackChannelId: 'C7777',
      name: 'j-cust',
      clientKey: 'ck',
    });
  });

  const mkCtx = () => {
    const result = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    return { ctx: makeClassicCtx(db, install, result, { dry: true }), result };
  };

  it('/pause in j-channel → human takeover + registry paused+transcribe', async () => {
    const { ctx, result } = mkCtx();
    const out = await handleClassicSlash(ctx, '/pause', '', 'C7777', 'U9');
    expect(out.ok).toBe(true);
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c.state).toBe('human');
    expect(c.pauseMinutes).toBe(10);
    const [ch] = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'C7777'));
    expect(ch.paused).toBe(true);
    expect(ch.shouldProcessTranscript).toBe(true);
  });

  it('/pause forever → pauseMinutes -1', async () => {
    const { ctx } = mkCtx();
    await handleClassicSlash(ctx, '/pause_qa', 'forever', 'C7777', 'U9'); // alias
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c.pauseMinutes).toBe(-1);
  });

  it('/resume releases + clears registry pause', async () => {
    const { ctx } = mkCtx();
    await handleClassicSlash(ctx, '/resume_s', '', 'C7777', 'U9'); // alias
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c.state).toBe('active');
    const [ch] = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'C7777'));
    expect(ch.paused).toBe(false);
  });

  it('/pause in a plain channel → slashCommandWarning', async () => {
    const { ctx } = mkCtx();
    const out = await handleClassicSlash(ctx, '/pause', '', 'CNOPE', 'U9');
    expect(out.ephemeral).toBe('_`/pause` and `/resume` only work in user transcript channels._');
  });

  it('/say alias → /bot relays text to the customer (pause-on-send)', async () => {
    const { ctx, result } = mkCtx();
    const out = await handleClassicSlash(ctx, '/say', 'hello customer', 'C7777', 'U9');
    expect(out.ok).toBe(true);
    // humanReply stored the operator turn
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(msg.text).toBe('hello customer');
    expect(msg.direction).toBe('human');
    expect(result.posted.some((p) => p.kind === 'relay:customer')).toBe(true);
  });

  it('j-channel free text → relays to the customer (sendMessageAsBot verbatim)', async () => {
    // Legacy ambient: wordhop-channel ambient text → sendMessageAsBot →
    // channelResponse (pause-on-send relay). The meta-bot only sees
    // callback_id events on this surface.
    const { ctx, result } = mkCtx();
    await classicIncoming(ctx, { channel: 'C7777', user: 'U9', text: 'hi', ts: '1.0' });
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(msg.text).toBe('hi');
    expect(result.posted.some((p) => p.kind === 'relay:customer')).toBe(true);
  });

  it('j-channel callback event → meta-bot shell suppressed when unconfigured', async () => {
    const { ctx, result } = mkCtx();
    await classicIncoming(ctx, {
      channel: 'C7777',
      user: 'U9',
      text: '',
      ts: '1.0',
      callback_id: 'resume_buttons_with_source_channel',
    });
    expect(
      result.suppressed.some((s) => s.reason === 'transcript meta-bot not configured'),
    ).toBe(true);
  });

  it('fb_buttons click → verbatim drop (incomingContinued early-return)', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'fb_buttons', {
      channel: 'C7777',
      user: 'U9',
      actions: [{ value: 'Yes please' }],
    });
    // Legacy incomingContinued returns immediately for fb_buttons on wordhop
    // channels — nothing posts and no customer message is written.
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msgs.some((m) => m.text === 'Yes please')).toBe(false);
    expect(result.posted).toHaveLength(0);
  });

  it('archive_channel → api archive, registry row kept (verbatim)', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'archive_channel', { channel: 'C7777', user: 'U9' });
    // Legacy archives via the installer token and does NOT delete the channel doc.
    const rows = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'C7777'));
    expect(rows).toHaveLength(1);
    expect(result.posted.some((p) => p.kind === 'api:conversations.archive')).toBe(true);
    expect(result.posted.some((p) => p.kind === 'callback:archive')).toBe(true);
  });

  it('Transcribe button → resume transcribing reply + clicked-note update', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'resume_buttons_with_source_channel', {
      channel: 'C7777',
      user: 'U9',
      text: 'Transcribe',
      actions: [{ name: 'Transcribe', value: 'transcribe' }],
      original_message: { ts: '500.1', text: 'card', attachments: [{ text: 'a' }] },
    });
    const [ch] = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'C7777'));
    expect(ch.shouldProcessTranscript).toBe(true);
    expect(result.posted.some((p) => p.kind === 'replyInteractive')).toBe(true);
    expect(
      result.posted.some(
        (p) => p.kind === 'transcript:transcribe' || String(p.payload?.text ?? '').includes('resumed transcribing'),
      ),
    ).toBe(true);
  });

  it('Pause button → pause_modal dialog.open', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'resume_buttons_with_source_channel', {
      channel: 'C7777',
      user: 'U9',
      text: 'Pause',
      trigger_id: 'T1',
      actions: [{ name: 'Pause', value: 'pause' }],
      original_message: { ts: '500.1', text: 'card', attachments: [{ text: 'a' }] },
    });
    const dlg = result.posted.find(
      (p) => p.kind === 'api:dialog.open' || p.kind === 'dialog:pause_modal',
    );
    expect(dlg).toBeTruthy();
    expect(String(dlg.payload?.dialog ?? '')).toContain('pause_modal');
  });

  it('Leave button → conversations.kick', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'resume_buttons_with_source_channel', {
      channel: 'C7777',
      user: 'U9',
      text: 'Leave',
      actions: [{ name: 'Leave', value: 'leave' }],
      original_message: { ts: '500.1', text: 'card', attachments: [{ text: 'a' }] },
    });
    expect(result.posted.some((p) => p.kind === 'api:conversations.kick')).toBe(true);
  });

  it('threaded set_bot → bot context saved + settings re-render', async () => {
    const { ctx, result } = mkCtx();
    await db.insert(agents).values({
      workspaceId: install.workspaceId,
      name: 'MyBot',
      metadata: { legacy_client_key: 'ck-bot-1' },
    });
    // The settings thread lives on a NON-wordhop channel.
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: 'SRCPLAIN',
      slackChannelId: 'CPLAIN',
      name: 'plain',
      isWordhopChannel: false,
    });
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    await handleClassicCallback(ctx, 'set_bot', {
      channel: 'CPLAIN',
      user: 'U9',
      text: 'MyBot',
      actions: [{ name: 'set_bot', selected_options: [{ value: 'MyBot', text: 'MyBot' }] }],
      original_message: { ts: '500.2', thread_ts: '500.1', text: 'Settings', attachments: [] },
    });
    const prefs = await getClassicPrefs(db, install.id, 'U9', DM_SENTINEL);
    expect((prefs as any).bot_context?.client_key === 'ck-bot-1' || (prefs as any).bot_name === 'MyBot').toBe(true);
    expect(result.posted.some((p) => p.kind === 'callback:set_bot')).toBe(true);
  });

  it('non-wordhop unknown callback → catch-all buttonClicked (youSaid echo)', async () => {
    const { ctx, result } = mkCtx();
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: 'SRCX',
      slackChannelId: 'CX',
      name: 'plain-x',
      isWordhopChannel: false,
    });
    await handleClassicCallback(ctx, 'some_random_callback', {
      channel: 'CX',
      user: 'U9',
      actions: [{ name: 'doit', value: 'clicked-value' }],
      original_message: { ts: '500.3', text: 'orig', attachments: [] },
    });
    expect(result.posted.some((p) => p.kind === 'youSaid')).toBe(true);
  });

  it('member_joined_channel (bot invited) → verbatim transcript welcome card', async () => {
    const { ctx, result } = mkCtx();
    const [inst2] = await db
      .update(slackInstallations)
      .set({ classicConfig: { pro: true, botUserId: 'UBOT9' } })
      .where(eq(slackInstallations.id, install.id))
      .returning();
    const result2 = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    const ctx2 = makeClassicCtx(db, inst2, result2, { dry: true });
    const { handleClassicWorkspaceEvent } = await import('./relay.js');
    await handleClassicWorkspaceEvent(ctx2, {
      type: 'member_joined_channel',
      channel: 'C7777',
      user: 'UBOT9',
      inviter: 'U9',
    });
    const welcome = result2.posted.find((p) => p.kind === 'sync:invited_transcript');
    expect(welcome).toBeTruthy();
    expect(String(welcome.payload?.text ?? '')).toContain('Thanks for the adding me to this channel');
    expect(String(welcome.payload?.text ?? '')).toContain('janis.ai/messages/');
    // pauseResumeButtons appended verbatim
    expect((welcome.payload?.attachments ?? []).length).toBe(1);
    // updateChannel fires conversations.info afterwards
    expect(result2.posted.some((p) => p.kind === 'api:conversations.info')).toBe(true);
  });

  it('channel_deleted → registry row removed', async () => {
    const { ctx, result } = mkCtx();
    const { handleClassicWorkspaceEvent } = await import('./relay.js');
    await handleClassicWorkspaceEvent(ctx, { type: 'channel_deleted', channel: 'C7777' });
    const rows = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.slackChannelId, 'C7777'));
    expect(rows).toHaveLength(0);
    expect(result.posted.some((p) => p.kind === 'sync:channel_deleted')).toBe(true);
  });

  it('channel_unarchive on a wordhop channel → invite+leave ping', async () => {
    // channel_deleted (previous test) removed C7777 — re-seed.
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: 'SRC',
      slackChannelId: 'C7777',
      name: 'j-cust',
    }).onConflictDoNothing();
    const [inst2] = await db
      .update(slackInstallations)
      .set({ classicConfig: { pro: true, botUserId: 'UBOT9' } })
      .where(eq(slackInstallations.id, install.id))
      .returning();
    const result2 = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    const ctx2 = makeClassicCtx(db, inst2, result2, { dry: true });
    const { handleClassicWorkspaceEvent } = await import('./relay.js');
    await handleClassicWorkspaceEvent(ctx2, { type: 'channel_unarchive', channel: 'C7777' });
    expect(result2.posted.some((p) => p.kind === 'api:conversations.invite')).toBe(true);
    expect(result2.posted.some((p) => p.kind === 'api:conversations.leave')).toBe(true);
  });

  it('legacyDialogToView + normalizeViewSubmission round-trip', async () => {
    const { legacyDialogToView, normalizeViewSubmission } = await import('./dialogView.js');
    const view = legacyDialogToView(
      {
        callback_id: 'pause_modal',
        title: 'Pause the bot',
        submit_label: 'Pause',
        elements: [
          {
            label: 'Duration',
            type: 'select',
            name: 'duration',
            value: '10',
            options: [
              { label: '5 minutes', value: 5 },
              { label: '10 minutes', value: 10 },
            ],
          },
          { label: 'Or custom', name: 'custom_duration', type: 'text', value: '', optional: true },
        ],
      },
      JSON.stringify({ channel: 'C1', user: 'U1' }),
    ) as any;
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe('pause_modal');
    const sel = view.blocks[0].element;
    // Slack views require string option values — legacy numerics coerced.
    expect(sel.type).toBe('static_select');
    expect(sel.options[0].value).toBe('5');
    expect(sel.initial_option.value).toBe('10');
    expect(view.blocks[1].optional).toBe(true);

    const norm = normalizeViewSubmission({
      view: {
        callback_id: 'pause_modal',
        private_metadata: JSON.stringify({ channel: 'C1', user: 'U1' }),
        state: {
          values: {
            duration: { duration: { type: 'static_select', selected_option: { value: '30' } } },
            custom_duration: { custom_duration: { type: 'plain_text_input', value: '' } },
          },
        },
      },
      user: { id: 'U1' },
      team: { id: 'T9' },
      trigger_id: 'trig.1',
    });
    expect(norm?.callbackId).toBe('pause_modal');
    expect(norm?.channel).toBe('C1');
    expect(norm?.submission.duration).toBe('30');
    expect(norm?.submission.custom_duration).toBe('');
  });

  it('bot echo + slackbot guards', async () => {
    const [inst2] = await db
      .update(slackInstallations)
      .set({ classicConfig: { pro: true, botUserId: 'UBOT' } })
      .where(eq(slackInstallations.id, install.id))
      .returning();
    const result = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    const ctx = makeClassicCtx(db, inst2, result, { dry: true });
    await classicIncoming(ctx, { channel: 'C7777', user: 'UBOT', text: 'x', ts: '2' });
    await classicIncoming(ctx, { channel: 'C7777', user: 'USLACKBOT', text: 'x', ts: '3' });
    expect(result.suppressed.map((s) => s.reason)).toEqual(['bot identity echo', 'slackbot']);
  });
});

// ── dfRender (makeMessageFromApiAi verbatim) ───────────────────────────────

describe('makeMessageFromApiAi', () => {
  it('speech only → empty text (legacy drops it)', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out = makeMessageFromApiAi({ result: { fulfillment: { speech: 'hello' } } });
    expect(out.text).toBe('');
  });
  it('replies → button attachment w/ action callback_id', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out = makeMessageFromApiAi({
      result: {
        action: 'send_to_user',
        fulfillment: {
          messages: [{ replies: ['Yes', 'No'], title: 'Pick one' }],
        },
      },
    });
    const att = out.attachments[0];
    expect(att.callback_id).toBe('send_to_user');
    expect(att.actions.map((a: any) => a.value)).toEqual(['Yes', 'No']);
    expect(att.text).toBe('Pick one');
  });
  it('platform gate — verbatim: any non-UNSPECIFIED platform passes', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out = makeMessageFromApiAi({
      result: {
        fulfillment: {
          messages: [
            { platform: 'slack', speech: 'for slack' },
            { platform: 'facebook', speech: 'for fb' },
          ],
        },
      },
    });
    // Legacy is NOT slack-only: hasPlatform + any declared platform → render.
    expect(out.text).toContain('for slack');
    expect(out.text).toContain('for fb');
    // UNSPECIFIED platform messages do skip.
    const out2 = makeMessageFromApiAi({
      result: {
        fulfillment: {
          messages: [
            { platform: 'slack', speech: 'for slack' },
            { platform: 'PLATFORM_UNSPECIFIED', speech: 'skipped' },
          ],
        },
      },
    });
    expect(out2.text).toContain('for slack');
    expect(out2.text).not.toContain('skipped');
  });
  it('basicCard → title + text + buttons attachments', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out = makeMessageFromApiAi({
      result: {
        action: 'x',
        fulfillment: {
          messages: [
            {
              basicCard: {
                title: 'T',
                subtitle: 'S',
                formattedText: 'body',
                buttons: [{ title: 'Go', postback: 'go' }],
              },
            },
          ],
        },
      },
    });
    expect(out.attachments).toHaveLength(2);
    expect(out.attachments[1].actions[0].value).toBe('go');
  });
  it('payload.slack unwrap + attachments passthrough', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out = makeMessageFromApiAi({
      result: {
        fulfillment: {
          messages: [
            { payload: { slack: { text: 'p', attachments: [{ text: 'a' }] } } },
          ],
        },
      },
    });
    expect(out.text).toContain('p');
    expect(out.attachments[0].text).toBe('a');
  });
  it('literal \\n unescaped in message speech', async () => {
    const { makeMessageFromApiAi } = await import('./dfRender.js');
    const out2 = makeMessageFromApiAi({
      result: {
        fulfillment: { speech: '', messages: [{ speech: 'x\\ny' }] },
      },
    });
    expect(out2.text).toBe('\nx\ny');
  });
});

// ── meta-bot action dispatch (dry) ─────────────────────────────────────────

describe('meta-bot actions (dry)', () => {
  let db: Db;
  let ws: typeof workspaces.$inferSelect;
  let install: typeof slackInstallations.$inferSelect;
  let conv: typeof conversations.$inferSelect;

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: './drizzle' });
    [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'Bot',
        metadata: {
          legacy_client_key: 'ck',
          is_chatfuel: true,
          chatfuel_token: 'cftoken',
          chatfuel_botid: 'bot123',
        },
      })
      .returning();
    [install] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: ws.id,
        teamId: 'T8',
        botToken: 'xoxb-test',
        mode: 'classic',
        classicConfig: { pro: true },
      })
      .returning();
    [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'messenger:8888' })
      .returning();
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: '8888',
      slackChannelId: 'C8888',
      name: 'j-cust2',
      clientKey: 'ck',
    });
  });

  const ctxFor = () => {
    const result = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    return { ctx: makeClassicCtx(db, install, result, { dry: true }), result };
  };

  const respond = async (body: any) => {
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U1', type: 'message' }, body, channel!);
    return { ctx, result };
  };

  it('log_unknown_intent → fulfillment render verbatim', async () => {
    const { result } = await respond({
      result: {
        action: 'log_unknown_intent',
        fulfillment: { speech: '', messages: [{ speech: " OK got it! I've passed that message on to the Janis team." }] },
      },
    });
    expect(result.posted[0].payload.text).toContain("OK got it! I've passed that message on to the Janis team.");
  });

  it('resume_bot with no source_channel → verbatim instruction', async () => {
    const { result } = await respond({
      result: { action: 'resume_bot', parameters: {}, fulfillment: { speech: 'resumed!' } },
    });
    expect(result.posted[0].payload.text).toContain('Resume Bot');
  });

  it('resume_bot with source_channel → speech + take-over buttons', async () => {
    const { result } = await respond({
      result: {
        action: 'resume_bot',
        parameters: { source_channel: '8888' },
        fulfillment: { speech: '', messages: [{ speech: 'ok' }] },
      },
    });
    const att = result.posted[0].payload.attachments.find((a: any) => a.actions?.length);
    expect(att.callback_id).toBe('log_buttons');
    expect(att.actions[0].value).toContain('8888');
  });

  it('transcript_help → pause/transcribe buttons', async () => {
    const { result } = await respond({
      result: { action: 'transcript_help', fulfillment: { speech: '', messages: [{ speech: 'help' }] } },
    });
    const att = result.posted[0].payload.attachments.find((a: any) => a.actions?.length);
    expect(att).toBeDefined();
  });

  it('subscriptions.news.send → latches broadcasting + posts speech', async () => {
    const { result } = await respond({
      result: {
        action: 'subscriptions.news.send',
        fulfillment: { speech: '', messages: [{ speech: 'send the news' }] },
      },
    });
    expect(result.posted[0].payload.text).toContain('send the news');
    const { getMemberShellState } = await import('./store.js');
    const shell = await getMemberShellState(db, install.id, 'U1');
    expect(shell.broadcasting).toBe(true);
  });

  it('context.clear → resets member shell', async () => {
    const { setMemberShellState, getMemberShellState } = await import('./store.js');
    await setMemberShellState(db, install.id, 'U2', { broadcasting: true });
    const { ctx } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U2', type: 'message' }, {
      result: { action: 'context.clear', fulfillment: { speech: '', messages: [{ speech: 'cleared' }] } },
    }, channel!);
    const shell = await getMemberShellState(db, install.id, 'U2');
    expect(shell.broadcasting).toBeFalsy();
  });

  it('send_to_user without DF creds → suppressed, not faked', async () => {
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    const { handleClassicCallback } = await import('./relay.js');
    await handleClassicCallback(ctx, 'send_to_user', {
      channel: 'C8888',
      user: 'U1',
      type: 'interactive_message',
      callback_id: 'send_to_user',
      actions: [{ name: 'suggested', value: 'hi', type: 'button' }],
      original_message: { thread_ts: '111.222', attachments: [] },
    });
    expect(result.suppressed[0].reason).toBe('send_to_user: no DF credentials');
  });

  it('unported action → fulfillment renders + suppressed reason', async () => {
    const { result } = await respond({
      result: {
        action: 'some.unported.action',
        fulfillment: { speech: '', messages: [{ speech: 'menu' }] },
      },
    });
    expect(result.posted[0].payload.text).toContain('menu');
    expect(result.suppressed[0].reason).toBe('meta-bot action unported: some.unported.action');
  });

  it('bot.settings → botSettingsMessage threaded reply + settings persisted', async () => {
    const { result } = await respond({
      result: { action: 'bot.settings', fulfillment: { speech: '', messages: [] } },
    });
    const posted = result.posted.find((p) => p.payload?.attachments?.some?.((a: any) => a.callback_id === 'set_bot'));
    expect(posted).toBeDefined();
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    const doc = await getClassicPrefs(db, install.id, 'U1', DM_SENTINEL);
    expect(Array.isArray(doc.custom_alerts)).toBe(true);
  });

  it('bot.getAll → suggestBot select with workspace bots', async () => {
    const { result } = await respond({
      result: { action: 'bot.getAll', fulfillment: { speech: '', messages: [{ speech: 'pick one' }] } },
    });
    const att = result.posted[0].payload.attachments?.[0];
    expect(att?.callback_id).toBe('set_bot');
    expect(att?.actions?.[0]?.options?.some?.((o: any) => o.text === 'Bot')).toBe(true);
  });

  it('bot.name.save → creates agent + defaults all severities on doc', async () => {
    const { result } = await respond({
      result: {
        action: 'bot.name.save',
        parameters: { bot_name: 'NewBot' },
        fulfillment: { speech: '', messages: [{ speech: 'created' }] },
      },
    });
    expect(result.posted[0].payload.text).toContain('created');
    const { agents } = await import('../../db/schema.js');
    const rows = await db.select().from(agents);
    const created = rows.find((a) => a.name === 'NewBot');
    expect(created).toBeDefined();
    expect((created!.metadata as any).legacy_client_key).toBeTruthy();
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    const doc = await getClassicPrefs(db, install.id, 'U1', DM_SENTINEL);
    const entry = (doc.custom_alerts as any[]).find(
      (a) => a.client_key === (created!.metadata as any).legacy_client_key,
    );
    expect(entry?.logSeverityLevel).toBe(1);
    expect(entry?.customAlertSeverityLevel).toBe(1);
  });

  it('context params merge into state before dispatch (bot_name → doc)', async () => {
    await respond({
      result: {
        action: 'help.no_response.no_bot',
        parameters: { bot_name: 'Bot' },
        fulfillment: { speech: '', messages: [{ speech: 'ok' }] },
      },
    });
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    const doc = await getClassicPrefs(db, install.id, 'U1', DM_SENTINEL);
    expect(doc.bot_name).toBe('Bot');
    expect((doc.bot_context as any)?.name).toBe('Bot');
  });

  it('block_push → chatfuel broadcast URL per block, attrs on first only', async () => {
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U1', type: 'message' }, {
      result: {
        action: 'block_push',
        parameters: { blockname: 'Welcome, Help' },
        fulfillment: { speech: '', messages: [] },
      },
    }, channel!);
    const redirects = result.posted.filter((p) => p.kind === 'platform-redirect');
    expect(redirects).toHaveLength(2);
    expect(redirects[0].payload.url).toContain('chatfuel_block_name=Welcome');
    expect(redirects[1].payload.url).toContain('chatfuel_block_name=Help');
    expect(redirects[0].payload.url).toContain('chatfuel_token=cftoken');
  });

  it('set_attributes → attribute-only send hits block_name=Janis verbatim', async () => {
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U1', type: 'message' }, {
      result: {
        action: 'set_attributes',
        parameters: { attribute_name: 'vip', attribute_value: 'yes' },
        fulfillment: { speech: '', messages: [] },
      },
    }, channel!);
    const redirects = result.posted.filter((p) => p.kind === 'platform-redirect');
    expect(redirects).toHaveLength(1);
    expect(redirects[0].payload.url).toContain('chatfuel_block_name=Janis');
    // contact merge landed on the conversation's userProfile.attributes
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect((c.userProfile as any)?.attributes?.vip).toBe('yes');
  });

  it('flow_push → manychat sendFlow body verbatim', async () => {
    const { agents } = await import('../../db/schema.js');
    const [agent] = await db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = 'ck'`)
      .limit(1);
    await db
      .update(agents)
      .set({
        metadata: {
          legacy_client_key: 'ck',
          is_chatfuel: false,
          is_manychat: true,
          manychat_token: 'mctoken',
        },
      })
      .where(eq(agents.id, agent!.id));
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U1', type: 'message' }, {
      result: {
        action: 'flow_push',
        parameters: { flowid: 'flow123' },
        fulfillment: { speech: '', messages: [] },
      },
    }, channel!);
    const redirects = result.posted.filter((p) => p.kind === 'platform-redirect');
    expect(redirects).toHaveLength(1);
    expect(redirects[0].payload.url).toBe('https://api.manychat.com/fb/sending/sendFlow');
    // restore chatfuel meta for other tests
    await db
      .update(agents)
      .set({
        metadata: {
          legacy_client_key: 'ck',
          is_chatfuel: true,
          chatfuel_token: 'cftoken',
          chatfuel_botid: 'bot123',
        },
      })
      .where(eq(agents.id, agent!.id));
  });

  it('block_push without chatfuel creds → IntentPushFail meta-bot path', async () => {
    const { agents } = await import('../../db/schema.js');
    const [agent] = await db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = 'ck'`)
      .limit(1);
    await db
      .update(agents)
      .set({ metadata: { legacy_client_key: 'ck', is_chatfuel: true } })
      .where(eq(agents.id, agent!.id));
    const { ctx, result } = ctxFor();
    const { getClassicChannelBySlackId } = await import('./store.js');
    const channel = await getClassicChannelBySlackId(db, 'C8888');
    await classicApiAiResponse(ctx, { channel: 'C8888', user: 'U1', type: 'message' }, {
      result: {
        action: 'block_push',
        parameters: { blockname: 'X' },
        fulfillment: { speech: '', messages: [] },
      },
    }, channel!);
    // No meta-bot creds configured → IntentPushFail records suppressed
    expect(
      result.suppressed.some((s) => s.reason?.includes('IntentPushFail') || s.reason?.includes('meta-bot creds')),
    ).toBe(true);
  });
});

// ── training menu (writeTrainAttachments verbatim) ─────────────────────────

describe('training menu', () => {
  it('new intent + userSays → categorize menu verbatim', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments({ id: 'new' }, { client_key: 'ck', userSays: 'hello' });
    const first = menu.attachments[0];
    expect(first.title).toBe('Categorize this message :point_up:');
    expect(first.callback_id).toBe('create_new');
    expect(first.actions[0].name).toBe('createnew');
    const callbacks = menu.attachments.map((a: any) => a.callback_id);
    expect(callbacks).toContain('detect_intent');
    expect(callbacks).toContain('intent_selection');
  });

  it('matched intent (userSays hit) → Matched Intent + Cancel Match', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      {
        id: 'i1',
        name: 'greet',
        fallbackIntent: false,
        userSays: [{ data: [{ text: 'hello' }] }],
        responses: [{ messages: [{ type: 0, speech: 'hi there' }] }],
      },
      { client_key: 'ck', userSays: 'hello' },
    );
    const first = menu.attachments[0];
    expect(first.title).toBe('Matched Intent:');
    expect(first.text).toBe('greet');
    expect(first.actions[0].name).toBe('reject');
    expect(first.actions[0].confirm.title).toBe('Cancel');
  });

  it('suggested intent (userSays miss) → Suggested Intent + Confirm/Other', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      {
        id: 'i1',
        name: 'greet',
        fallbackIntent: false,
        userSays: [{ data: [{ text: 'goodbye' }] }],
        responses: [{ messages: [{ type: 0, speech: 'hi' }] }],
      },
      { client_key: 'ck', userSays: 'hello' },
    );
    const first = menu.attachments[0];
    expect(first.title).toBe('Suggested Intent:');
    expect(first.actions.map((a: any) => a.name)).toEqual(['approve', 'find_other_intent']);
  });

  it('fallback intent → Matched Intent + danger Change', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      { id: 'i1', name: 'Default Fallback', fallbackIntent: true, userSays: [], responses: [{ messages: [{ type: 0, speech: 'x' }] }] },
      { client_key: 'ck', userSays: '??' },
    );
    const first = menu.attachments[0];
    expect(first.title).toBe('Matched Intent:');
    expect(first.actions[0].name).toBe('find_other_intent');
    expect(first.actions[0].style).toBe('danger');
  });

  it('responses render: count select + text attachment + send_to_user + reply_type', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      {
        id: 'i1',
        name: 'greet',
        fallbackIntent: false,
        userSays: [{ data: [{ text: 'hello' }] }],
        responses: [{ messages: [{ type: 0, speech: 'answer' }] }],
      },
      { client_key: 'ck', userSays: 'hello' },
    );
    const callbacks = menu.attachments.map((a: any) => a.callback_id);
    expect(callbacks).toContain('user_says_type');
    expect(callbacks).toContain('intent_response');
    expect(callbacks).toContain('send_to_user');
    expect(callbacks).toContain('reply_type');
    const typeAtt = menu.attachments.find((a: any) => a.callback_id === 'user_says_type');
    expect(typeAtt.actions[0].options[0].text).toBe('Text (1)');
    const respAtt = menu.attachments.find((a: any) => a.callback_id === 'intent_response');
    expect(respAtt.fields[0].value).toBe('answer');
  });

  it('no userSays (manage intents) → Manage other intents + detect', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments({ id: 'new' }, { client_key: 'ck' });
    expect(menu.text).toBe('Manage other intents');
    const callbacks = menu.attachments.map((a: any) => a.callback_id);
    expect(callbacks).toContain('detect_intent');
    expect(callbacks).toContain('intent_selection');
  });

  it('editMode → Delete Intent action + Done Editing button', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      {
        id: 'i1',
        name: 'greet',
        fallbackIntent: false,
        userSays: [{ data: [{ text: 'x' }] }],
        responses: [{ messages: [{ type: 0, speech: 'y' }] }],
      },
      { client_key: 'ck', userSays: 'x', editMode: true },
    );
    const first = menu.attachments[0];
    expect(first.actions[0].name).toBe('delete');
    const replyAtt = menu.attachments.find((a: any) => a.callback_id === 'reply_type');
    expect(replyAtt.actions.map((a: any) => a.name)).toContain('done');
  });

  it('userSays paging >5 → userssay_page attachment', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      {
        id: 'i1',
        name: 'greet',
        fallbackIntent: false,
        userSays: Array.from({ length: 7 }, (_, i) => ({ data: [{ text: `say${i}` }] })),
        responses: [{ messages: [{ type: 0, speech: 'y' }] }],
      },
      { client_key: 'ck', userSays: 'unmatched' },
    );
    const pageAtt = menu.attachments.find((a: any) => a.callback_id === 'userssay_page');
    expect(pageAtt).toBeDefined();
    expect(pageAtt.actions[0].options).toHaveLength(2);
    const saysAtts = menu.attachments.filter((a: any) => a.callback_id === 'intent_user_says');
    expect(saysAtts).toHaveLength(5);
  });

  it('chatfuel option splice for fallback + chatfuel flag', async () => {
    const { writeTrainAttachments } = await import('./training.js');
    const menu = writeTrainAttachments(
      { id: 'i1', name: 'fb', fallbackIntent: true, userSays: [], responses: [{ messages: [{ type: 0, speech: 'x' }] }] },
      { client_key: 'ck', userSays: 'z', is_chatfuel: true },
    );
    const replyAtt = menu.attachments.find((a: any) => a.callback_id === 'reply_type');
    // chatfuel flag inserts 'Add a Chatfuel redirect' at index 3; fallback
    // splice(4,1) removes 'userssay' on the expanded list
    const values = replyAtt.actions[0].options.map((o: any) => o.value);
    expect(values).toContain('chatfuel');
    expect(values).not.toContain('userssay');
    expect(values).toContain('followup');
  });
});

// ── Store ──────────────────────────────────────────────────────────────────

describe('transcript store', () => {
  it('fetchBacklog + markProcessed dedup', async () => {
    const client = new PGlite();
    const db2 = drizzle(client, { schema }) as unknown as Db;
    await migrate(db2 as never, { migrationsFolder: './drizzle' });
    const [w] = await db2.insert(workspaces).values({ name: 'W' }).returning();
    const [a] = await db2.insert(agents).values({ workspaceId: w.id, name: 'B' }).returning();
    const [conv] = await db2
      .insert(conversations)
      .values({ agentId: a.id, externalId: 'messenger:9' })
      .returning();
    const [m1] = await db2
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'x', payload: {} })
      .returning();
    expect((await fetchBacklog(db2, conv.id)).length).toBe(1);
    await markProcessed(db2, [m1.id]);
    expect((await fetchBacklog(db2, conv.id)).length).toBe(0);
  });
});

// ── Training callback tree (getTrainingOptions + dispatch, dry) ────────────

import { getTrainingOptions, isInEditMode } from './trainingCallbacks.js';
import { v1DocToV2 } from './dfIntents.js';

describe('getTrainingOptions', () => {
  const baseMsg = (attachments: any[], extra: any = {}) => ({
    callback_id: 'responses_page',
    actions: [{ selected_options: [{ value: '1' }] }],
    original_message: { attachments, text: 'User: hi', ts: '100.1' },
    ...extra,
  });
  const channel = { clientKey: 'ck', isTrainingChannel: false, lang: 'en' };

  it('reply_type comes from the clicked select, else the trailing menu attachment', () => {
    const attachments = [
      { callback_id: 'user_says_type', actions: [{ selected_options: [{ value: 'text' }] }] },
      { callback_id: 'reply_type', actions: [{ name: 'abc', selected_options: [{ value: 'quickreply' }], options: [{ value: 'raw:7.5' }] }] },
      { text: 'tail' },
    ];
    // callback isn't reply_type → last-2 attachment's selected option wins
    const o1 = getTrainingOptions(baseMsg(attachments), channel, 'hello', {});
    expect(o1.reply_type).toBe('quickreply');
    expect(o1.ts).toBe(7.5);
    // callback IS reply_type with selected_options → that select wins
    const o2 = getTrainingOptions(
      baseMsg(attachments, { callback_id: 'reply_type' }),
      channel,
      'hello',
      {},
    );
    // actions[0].selected_options = '1' in baseMsg — verbatim: value wins
    expect(o2.reply_type).toBe('1');
  });

  it('editMode from the Done Editing action value', () => {
    const attachments = [
      { callback_id: 'reply_type', actions: [{ name: 'abc', value: 'done' }] },
      { callback_id: 'x', actions: [] },
      { text: 'tail' },
    ];
    expect(isInEditMode({ attachments })).toBe(true);
    const o = getTrainingOptions(baseMsg(attachments), channel, 'hi', {});
    expect(o.editMode).toBe(true);
    expect(o.suggestionMode).toBe(false);
  });

  it('page labels + user_says_type from original attachments', () => {
    const attachments = [
      { callback_id: 'user_says_type', actions: [{ selected_options: [{ value: 'payloads' }] }] },
      { actions: [{ name: 'responses_page_label', value: '2' }, { name: 'userssay_page_label', value: '3' }] },
      { callback_id: 'reply_type', actions: [{ name: 'abc' }] },
      { text: 'tail' },
    ];
    const o = getTrainingOptions(baseMsg(attachments), channel, 'hi', {});
    expect(o.responses_page).toBe(2);
    expect(o.userssay_page).toBe(3);
    expect(o.user_says_type).toBe('payloads');
  });

  it('userSays survives only for truthy non-menu titles (verbatim quirk)', () => {
    const mk = (title: string | undefined) =>
      getTrainingOptions(
        {
          callback_id: 'x',
          actions: [{}],
          original_message: { attachments: [{ title }, { text: 't' }], text: 'fallback-title' },
        },
        channel,
        'typed text',
        {},
      );
    // title 'Intents:' → deleted
    expect(mk('Intents:').userSays).toBeUndefined();
    expect(mk('Manage other intents').userSays).toBeUndefined();
    // any other truthy title → kept
    expect(mk('Something else').userSays).toBe('typed text');
    // falsy title → falls back to message.text ('fallback-title' is truthy!)
    const noText = getTrainingOptions(
      {
        callback_id: 'x',
        actions: [{}],
        original_message: { attachments: [{}], text: '' },
      },
      channel,
      'typed text',
      {},
    );
    expect(noText.userSays).toBeUndefined();
  });
});

describe('v1DocToV2', () => {
  it('maps trainingPhrases, message types, contexts, followup parents', () => {
    const v2 = v1DocToV2('proj-1', {
      name: 'greeting',
      contexts: ['sess_ctx'],
      userSays: [{ data: [{ text: 'hi' }, { text: 'there' }] }],
      events: [{ name: 'WELCOME' }],
      parentId: 'parentid',
      rootParentId: 'rootid',
      responses: [
        {
          messages: [
            { type: 0, speech: ['hello', 'hi'] },
            { type: 2, platform: 'facebook', title: 'pick', replies: ['a', 'b'] },
            { type: 4, payload: { redirect_to_blocks: ['b1'] } },
          ],
          affectedContexts: [{ name: 'out-ctx', lifespan: 2 }],
        },
      ],
    });
    expect(v2.displayName).toBe('greeting');
    expect(v2.isFallback).toBe(false);
    expect(v2.trainingPhrases).toEqual([
      { type: 'EXAMPLE', parts: [{ text: 'hi' }, { text: 'there' }] },
    ]);
    expect(v2.inputContextNames).toEqual(['projects/proj-1/agent/contexts/sess_ctx']);
    expect(v2.events).toEqual(['WELCOME']);
    expect(v2.messages[0]).toEqual({ text: { text: ['hello', 'hi'] } });
    expect(v2.messages[1]).toEqual({
      platform: 'FACEBOOK',
      quickReplies: { title: 'pick', quickReplies: ['a', 'b'] },
    });
    expect(v2.messages[2]).toEqual({ payload: { redirect_to_blocks: ['b1'] } });
    expect(v2.outputContexts).toEqual([
      { name: 'projects/proj-1/agent/sessions/-/contexts/out-ctx', lifespanCount: 2 },
    ]);
    expect(v2.parentFollowupIntentName).toBe('projects/proj-1/agent/intents/parentid');
    expect(v2.rootFollowupIntentName).toBe('projects/proj-1/agent/intents/rootid');
  });
});

describe('training callback dispatch (dry)', () => {
  let db: Db;
  let install: typeof slackInstallations.$inferSelect;

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: './drizzle' });
    const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
    const [agent] = await db.insert(agents).values({ workspaceId: ws.id, name: 'Bot' }).returning();
    [install] = await db
      .insert(slackInstallations)
      .values({
        workspaceId: ws.id,
        teamId: 'TCB',
        botToken: 'xoxb-test',
        mode: 'classic',
        classicConfig: { pro: true },
      })
      .returning();
    await db.insert(conversations).values({ agentId: agent.id, externalId: 'messenger:SRC9' });
    await db.insert(slackClassicChannels).values({
      installationId: install.id,
      sourceChannel: 'SRC9',
      slackChannelId: 'CTRN',
      name: 'j-cust',
      clientKey: 'ck-no-df',
    });
  });

  const mkCtx = () => {
    const result = { posted: [] as any[], suppressed: [] as any[], errors: [] as string[] };
    return { ctx: makeClassicCtx(db, install, result, { dry: true }), result };
  };

  // A matched-intent menu as the original_message: reply_type attachment's
  // actions[0].name carries the intentId — 'new' renders without DF.
  const menuMessage = (extra: any = {}) => ({
    channel: 'CTRN',
    user: 'U9',
    attachment_id: 3,
    actions: [{ selected_options: [{ value: '1' }] }],
    original_message: {
      ts: '900.1',
      thread_ts: '900.1',
      text: 'What the user said',
      attachments: [
        { callback_id: 'intent_selection', actions: [{ name: 'approve' }, { name: 'reject' }] },
        { callback_id: 'user_says_type', actions: [{ selected_options: [{ value: 'text' }] }] },
        { callback_id: 'reply_type', actions: [{ name: 'new', options: [{ value: 'raw:900.0' }] }] },
        { text: 'tail' },
      ],
    },
    ...extra,
  });

  it('responses_page → re-render + chat.update', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'responses_page', menuMessage());
    expect(result.posted.some((p) => p.kind === 'callback:responses_page')).toBe(true);
  });

  it('userssay_page → re-render + chat.update', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'userssay_page', menuMessage());
    expect(result.posted.some((p) => p.kind === 'callback:userssay_page')).toBe(true);
  });

  it('reply_type done → re-render (editMode off, suggestionMode on)', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'reply_type',
      menuMessage({ actions: [{ value: 'done' }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:reply_type')).toBe(true);
  });

  it('reply_type createnew → new-intent menu', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'reply_type',
      menuMessage({ actions: [{ value: 'createnew' }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:reply_type')).toBe(true);
  });

  it('reply_type manage_intents → new menu (manage-intents list)', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'reply_type',
      menuMessage({ actions: [{ value: 'manage_intents' }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:reply_type')).toBe(true);
  });

  it('add_followup "No follow-up" → attachment-mutation update', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'add_followup',
      menuMessage({ actions: [{ selected_options: [{ value: 'No follow-up' }] }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:add_followup')).toBe(true);
  });

  it('add_followup real type without DF creds → suppressed, not silent', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'add_followup',
      menuMessage({ actions: [{ selected_options: [{ value: 'yes' }] }] }),
    );
    expect(
      result.suppressed.some((s) => s.reason === 'callback add_followup: no df creds'),
    ).toBe(true);
  });

  it('detect_intent without DF creds → suppressed', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'detect_intent', menuMessage());
    expect(
      result.suppressed.some((s) => s.reason === 'callback detect_intent: no df creds'),
    ).toBe(true);
  });

  it('intent_selection approve without DF creds → suppressed', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'intent_selection',
      menuMessage({ actions: [{ name: 'approve' }] }),
    );
    expect(
      result.suppressed.some((s) => s.reason === 'callback intent_selection: no df creds'),
    ).toBe(true);
  });

  it('intent_selection find_other_intent → new-intent menu, no DF needed', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'intent_selection',
      menuMessage({ actions: [{ name: 'find_other_intent' }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:intent_selection')).toBe(true);
  });

  it('user_says_type select → re-render', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'user_says_type',
      menuMessage({ actions: [{ selected_options: [{ value: 'payloads' }] }] }),
    );
    expect(result.posted.some((p) => p.kind === 'callback:user_says_type')).toBe(true);
  });

  it('quick_reply_menu_callback (not edit mode) → attachment mutation', async () => {
    const { ctx, result } = mkCtx();
    const msg = menuMessage({
      attachment_id: 2,
      actions: [{ selected_options: [{ value: 'reply-a' }] }],
    });
    await handleClassicCallback(ctx, 'quick_reply_menu_callback', msg);
    expect(
      result.posted.some((p) => p.kind === 'callback:quick_reply_menu_callback'),
    ).toBe(true);
  });

  it('intent_user_says delete without DF creds → suppressed', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'intent_user_says',
      menuMessage({ actions: [{ name: 'delete' }] }),
    );
    expect(
      result.suppressed.some((s) => s.reason === 'callback intent_user_says: no df creds'),
    ).toBe(true);
  });

  it('createnew action name → suppressed without DF creds', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(
      ctx,
      'whatever_menu',
      menuMessage({ actions: [{ name: 'createnew' }] }),
    );
    expect(result.suppressed.some((s) => s.reason === 'callback createnew: no df creds')).toBe(
      true,
    );
  });

  it('unknown callback → unhandled suppressed record (nothing silent)', async () => {
    const { ctx, result } = mkCtx();
    await handleClassicCallback(ctx, 'bogus_callback', menuMessage());
    expect(
      result.suppressed.some((s) => s.reason === 'callback unhandled: bogus_callback'),
    ).toBe(true);
  });
});
