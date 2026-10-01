import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  cfAuthorizeUrl,
  cfExchangeCode,
  cfRefresh,
  cloudflareSetupRecords,
  createOrAdoptResendDomain,
  deleteResendDomain,
  getResendDomain,
  verifyResendDomain,
} from '../lib/resendDomains.js';
import { detectDnsSetup } from '../lib/dnsSetup.js';
import { and, eq, sql } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channelBindings, channels, contacts, usageEvents } from '../db/schema.js';
import { effectivePlanKey } from '../lib/plans.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentRoleFor, agentScopeCond, isAdminRole } from '../lib/access.js';
import {
  findChannelByEmailAddress,
  uniqueReplyAddress,
  findChannelByObjectId,
  invalidateChannelCache,
  parseMetaWebhook,
  resolveChatIdentity,
  setGetStartedButton,
  takeThreadControl,
  verifyMetaSignature,
  type ChannelCredentials,
} from '../lib/channels.js';
import { sendOutbound } from '../lib/outbound.js';
import { enqueueJob } from '../lib/jobs.js';
import { dbRateLimit, takeDbAllowance } from '../lib/rateLimit.js';
import { audit } from '../lib/audit.js';
import { recordSuppression } from '../lib/deliverability.js';

type ChannelRow = typeof channels.$inferSelect;
import {
  htmlToText,
  mailSkipReason,
  parseAddressList,
  parseFrom,
  verifySvixSignature,
  type EmailReceived,
} from '../lib/email.js';
import { toChannel } from '../lib/serializers.js';
import { handleChannelMessage } from '../services/channelIngress.js';

const createChannel = z.object({
  kind: z.enum(['messenger', 'instagram', 'whatsapp', 'webchat', 'email', 'voice', 'sms']),
  name: z.string().min(1).max(120),
  agent_id: z.string().uuid(),
  page_id: z.string().optional(), // messenger / instagram
  phone_number_id: z.string().optional(), // whatsapp
  access_token: z.string().min(1).optional(), // not required for webchat/email
  verify_token: z.string().optional(), // auto-generated if absent
  greeting: z.string().max(500).optional(), // webchat + voice (spoken opener)
  quick_replies: z.array(z.string().min(1).max(120)).max(8).optional(), // webchat
  from_name: z.string().max(120).optional(), // email: From display name
  // voice (Twilio)
  twilio_account_sid: z.string().optional(),
  twilio_auth_token: z.string().optional(),
  phone_number: z.string().optional(), // the channel's E.164 number
  forward_to: z.string().optional(), // human handoff bridges the call here
  // hosted voice: Janis provisions the number under our Twilio account —
  // phone_number is one the customer picked from /channels/voice-numbers
  hosted: z.boolean().optional(),
  country: z.string().length(2).optional(),
  // sms: clone the Twilio creds + number off an existing voice channel — the
  // one-click "text-enable this number" path (hosted and BYO both work).
  from_voice_channel_id: z.string().uuid().optional(),
});

const patchChannel = z.object({
  name: z.string().min(1).max(120).optional(),
  // webchat widget appearance; empty strings clear a field
  branding: z
    .object({
      title: z.string().max(120).optional(),
      subtitle: z.string().max(200).optional(),
      greeting: z.string().max(500).optional(),
      quick_replies: z.array(z.string().min(1).max(120)).max(8).optional(),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).or(z.literal('')).optional(),
      position: z.enum(['left', 'right']).optional(),
      // absolute http(s) url or an uploaded image path; '' clears
      logo_url: z
        .union([z.literal(''), z.string().url().max(500), z.string().regex(/^\/uploads\//).max(500)])
        .optional(),
      // logo tile: inset padding, corner radius, outline — px ints
      logo_padding: z.number().int().min(0).max(16).optional(),
      logo_radius: z.number().int().min(0).max(16).optional(),
      logo_border_width: z.number().int().min(0).max(4).optional(),
      logo_border_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).or(z.literal('')).optional(),
      teaser_text: z.string().max(200).optional(), // '' clears → greeting used
      proactive: z.boolean().optional(),
      proactive_delay: z.number().int().min(0).max(300).optional(),
      sound: z.boolean().optional(),
      theme: z.enum(['light', 'dark', 'auto']).optional(),
      hide_powered_by: z.boolean().optional(),
      show_help_link: z.boolean().optional(),
      dictation: z.boolean().optional(),
    })
    .optional(),
  // webchat: HMAC key for signed visitor identity (Janis.identify sig); '' clears
  identity_secret: z.string().max(200).optional(),
  // webchat: show operator name/avatar on human replies — off by default
  show_operator: z.boolean().optional(),
  // email: From display name on outbound replies; '' clears to channel name
  from_name: z.string().max(120).optional(),
  // email/gmail/outlook: send-as address (verified alias / shared mailbox);
  // '' clears to the mailbox/inbound address
  from_address: z.string().email().max(200).or(z.literal('')).optional(),
  // email: upstream mailbox replies get BCC'd to (auto-detected from
  // forwarded mail; '' clears)
  mirror_address: z.string().email().max(200).or(z.literal('')).optional(),
  // email/gmail/outlook: inbound answer rules — group/alias addressing,
  // list-mail opt-in, sender allow/block, subject excludes
  email_filters: z
    .object({
      answer_addresses: z.array(z.string().email().max(200)).max(20).optional(),
      list_mail: z.boolean().optional(),
      sender_allow: z.array(z.string().max(200)).max(50).optional(),
      sender_block: z.array(z.string().max(200)).max(50).optional(),
      subject_exclude: z.array(z.string().max(200)).max(50).optional(),
    })
    .optional(),
  // gmail only: extra poll query terms ("label:support -in:spam"); '' clears
  gmail_query: z.string().max(300).optional(),
  // reassign which agent answers this channel
  agent_id: z.string().uuid().optional(),
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
      .where(
        and(
          eq(channels.workspaceId, c.get('workspaceId')),
          ...(agentScopeCond(c.get('agentScope')) ? [agentScopeCond(c.get('agentScope'))!] : []),
        ),
      );
    await Promise.all(rows.map((r) => resolveChatIdentity(db, r.channel)));
    // Internal test-chat channels ride the real /chat pipeline but aren't
    // integrations — keep them out of the console list.
    return c.json({
      channels: rows
        .filter((r) => !(r.channel.credentials as ChannelCredentials).internal)
        .map((r) => toChannel(r.channel, r.agentName)),
    });
  });

  // Hosted voice: list buyable numbers so the customer can pick one. Must
  // register before /:id or "voice-numbers" would be read as a channel id.
  app.get('/voice-numbers', async (c) => {
    const { hostedVoiceCreds, searchVoiceNumbers } = await import('../lib/twilio.js');
    if (!hostedVoiceCreds()) return c.json({ configured: false, paid: true, numbers: [] });
    const planKey = await effectivePlanKey(db, c.get('workspaceId'));
    if (planKey === 'free') return c.json({ configured: true, paid: false, numbers: [] });
    try {
      const numbers = await searchVoiceNumbers(
        (c.req.query('country') ?? env.twilioVoiceCountry).toUpperCase(),
        { areaCode: c.req.query('area_code'), contains: c.req.query('contains') },
      );
      return c.json({ configured: true, paid: true, numbers });
    } catch (err) {
      const e = err as { message?: string };
      return c.json({ error: e.message ?? 'number search failed' }, 400);
    }
  });

  app.get('/:id', async (c) => {
    const [row] = await db
      .select({ channel: channels, agentName: agents.name })
      .from(channels)
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .where(
        and(
          eq(channels.id, c.req.param('id')),
          eq(channels.workspaceId, c.get('workspaceId')),
          ...(agentScopeCond(c.get('agentScope')) ? [agentScopeCond(c.get('agentScope'))!] : []),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    await resolveChatIdentity(db, row.channel);
    return c.json({ channel: toChannel(row.channel, row.agentName) });
  });

  app.post('/', zValidator('json', createChannel), async (c) => {
    const body = c.req.valid('json');
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), body.agent_id, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, body.agent_id), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (body.kind === 'whatsapp' && !body.phone_number_id) {
      return c.json({ error: 'phone_number_id required for whatsapp' }, 400);
    }
    if (body.kind === 'voice' && !body.hosted) {
      if (!body.twilio_account_sid || !body.twilio_auth_token || !body.phone_number) {
        return c.json(
          { error: 'twilio_account_sid, twilio_auth_token and phone_number required for voice' },
          400,
        );
      }
    }
    if (body.kind === 'voice' && body.hosted && !body.phone_number) {
      return c.json({ error: 'phone_number required — pick one from /channels/voice-numbers' }, 400);
    }
    if (body.kind === 'sms' && !body.from_voice_channel_id) {
      if (!body.twilio_account_sid || !body.twilio_auth_token || !body.phone_number) {
        return c.json(
          { error: 'twilio_account_sid, twilio_auth_token and phone_number required for sms' },
          400,
        );
      }
    }
    if (body.kind === 'messenger' || body.kind === 'instagram') {
      if (!body.page_id) {
        return c.json({ error: 'page_id required for messenger/instagram' }, 400);
      }
      if (!body.access_token) {
        return c.json({ error: 'access_token required for messenger/instagram' }, 400);
      }
    }

    const credentials: ChannelCredentials = {
      page_id: body.page_id,
      phone_number_id: body.phone_number_id,
      access_token: body.access_token,
      verify_token: body.verify_token || randomBytes(16).toString('hex'),
      greeting: body.greeting,
      twilio_account_sid: body.twilio_account_sid,
      twilio_auth_token: body.twilio_auth_token,
      phone_number: body.phone_number,
      forward_to: body.forward_to,
      quick_replies: body.quick_replies,
    };
    if (body.kind === 'email') {
      // Each email channel gets a unique inbound address — customer mail is
      // routed to this channel by matching the To: header against it — plus a
      // readable reply_address used as From/Reply-To on outbound replies.
      credentials.inbound_address = `ch_${randomBytes(4).toString('hex')}@${env.emailInboundDomain}`;
      credentials.reply_address = await uniqueReplyAddress(db, body.name, 'new');
      credentials.from_name = body.from_name;
    }
    if (body.kind === 'sms' && body.from_voice_channel_id) {
      const [voice] = await db
        .select({ credentials: channels.credentials })
        .from(channels)
        .where(
          and(
            eq(channels.id, body.from_voice_channel_id),
            eq(channels.workspaceId, c.get('workspaceId')),
            eq(channels.kind, 'voice'),
          ),
        )
        .limit(1);
      if (!voice) return c.json({ error: 'voice channel not found' }, 404);
      const vc = voice.credentials as ChannelCredentials;
      credentials.twilio_account_sid = vc.twilio_account_sid;
      credentials.twilio_auth_token = vc.twilio_auth_token;
      credentials.phone_number = vc.phone_number;
      credentials.hosted = vc.hosted;
      credentials.twilio_number_sid = vc.twilio_number_sid;
    }
    if (body.kind === 'voice' && body.hosted) {
      // Paid plans only — hosted numbers burn real Twilio balance, and free
      // workspaces have no billing relationship to charge overage against.
      const planKey = await effectivePlanKey(db, c.get('workspaceId'));
      if (planKey === 'free') {
        return c.json({ error: 'hosted numbers require a paid plan' }, 402);
      }
      // Abuse controls: cap live hosted numbers per workspace and daily
      // provisioning attempts (each attempt creates a Twilio subaccount).
      const existing = await db
        .select({ credentials: channels.credentials })
        .from(channels)
        .where(and(eq(channels.workspaceId, c.get('workspaceId')), eq(channels.kind, 'voice')));
      const hostedCount = existing.filter(
        (r) => (r.credentials as ChannelCredentials).hosted,
      ).length;
      if (hostedCount >= env.voiceHostedMax) {
        return c.json({ error: `hosted number limit reached (${env.voiceHostedMax} per workspace)` }, 400);
      }
      const [{ attempts }] = await db
        .select({ attempts: sql<number>`count(*)::int` })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.workspaceId, c.get('workspaceId')),
            eq(usageEvents.kind, 'voice_provision'),
            sql`${usageEvents.createdAt} > now() - interval '24 hours'`,
          ),
        );
      if (attempts >= env.voiceProvisionDaily) {
        return c.json({ error: 'too many provisioning attempts — try again tomorrow' }, 429);
      }
      // Count the attempt up front so failed provisions can't be retried
      // into an effective quota bypass.
      await db.insert(usageEvents).values({
        workspaceId: c.get('workspaceId'),
        kind: 'voice_provision',
        quantity: 1,
        period: new Date().toISOString().slice(0, 7),
      });
      // Janis-hosted: provision the number under a dedicated Twilio
      // subaccount with the webhooks prewired. The subaccount's auth token is
      // what signs inbound webhooks — stored as the channel's creds.
      const { provisionVoiceNumber } = await import('../lib/twilio.js');
      const channelId = randomUUID();
      const p = await provisionVoiceNumber(channelId, body.phone_number!, body.name).catch((err) => {
        throw new HTTPException(400, {
          message: `number provisioning failed: ${(err as Error).message}`,
        });
      });
      credentials.twilio_account_sid = p.subSid;
      credentials.twilio_auth_token = p.subToken;
      credentials.phone_number = p.number;
      credentials.hosted = true;
      credentials.twilio_number_sid = p.numberSid;
      const [row] = await db
        .insert(channels)
        .values({
          id: channelId,
          workspaceId: c.get('workspaceId'),
          agentId: body.agent_id,
          kind: body.kind,
          name: body.name,
          credentials,
        })
        .returning();
      invalidateChannelCache();
      return c.json({ channel: toChannel(row, agent.name) }, 201);
    }
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
    if (row && body.kind === 'sms') {
      // Best-effort: point the number's SmsUrl at this channel. If Twilio
      // rejects (bad creds, number elsewhere) the channel card still shows
      // the webhook URL for manual setup.
      const { setSmsWebhook } = await import('../lib/twilio.js');
      await setSmsWebhook(credentials, `${env.apiOrigin}/sms/${row.id}`).catch(() => {});
    }
    invalidateChannelCache();
    // Get Started button on the page profile — best-effort, never block creation
    void setGetStartedButton(body.kind, credentials).catch(() => {});
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'channel.create',
      targetType: 'channel',
      targetId: row.id,
      meta: { kind: body.kind, name: body.name, agent_id: body.agent_id },
    });
    return c.json({ channel: toChannel(row, agent.name) }, 201);
  });

  app.patch('/:id', zValidator('json', patchChannel), async (c) => {
    const body = c.req.valid('json');
    const [row] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, c.req.param('id')), eq(channels.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    // both the current and the target agent must be adminable
    for (const aid of [row.agentId, ...(body.agent_id ? [body.agent_id] : [])]) {
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), aid, c.get('workspaceId'),
      );
      if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    }
    if (body.branding && row.kind !== 'webchat') {
      return c.json({ error: 'branding applies to webchat channels' }, 400);
    }
    if (body.identity_secret !== undefined && row.kind !== 'webchat') {
      return c.json({ error: 'identity_secret applies to webchat channels' }, 400);
    }
    if (body.show_operator !== undefined && row.kind !== 'webchat') {
      return c.json({ error: 'show_operator applies to webchat channels' }, 400);
    }
    const emailKinds = ['email', 'gmail', 'outlook'];
    if (body.from_name !== undefined && !emailKinds.includes(row.kind)) {
      return c.json({ error: 'from_name applies to email channels' }, 400);
    }
    if (body.from_address !== undefined && !emailKinds.includes(row.kind)) {
      return c.json({ error: 'from_address applies to email channels' }, 400);
    }
    if (body.email_filters !== undefined && !emailKinds.includes(row.kind)) {
      return c.json({ error: 'email_filters applies to email channels' }, 400);
    }
    if (body.mirror_address !== undefined && row.kind !== 'email') {
      return c.json({ error: 'mirror_address applies to resend email channels' }, 400);
    }
    if (body.gmail_query !== undefined && row.kind !== 'gmail') {
      return c.json({ error: 'gmail_query applies to gmail channels' }, 400);
    }
    if (body.agent_id) {
      const [target] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agent_id), eq(agents.workspaceId, c.get('workspaceId'))))
        .limit(1);
      if (!target) return c.json({ error: 'agent not found' }, 404);
    }

    const creds = { ...(row.credentials as ChannelCredentials) };
    if (body.identity_secret !== undefined) {
      if (body.identity_secret === '') delete creds.identity_secret;
      else creds.identity_secret = body.identity_secret;
    }
    if (body.show_operator !== undefined) creds.show_operator = body.show_operator;
    if (body.from_name !== undefined) {
      if (body.from_name === '') delete creds.from_name;
      else creds.from_name = body.from_name;
    }
    if (body.from_address !== undefined) {
      if (body.from_address === '') delete creds.from_address;
      else if (
        row.kind === 'email' &&
        body.from_address.split('@')[1]?.toLowerCase() !== env.emailInboundDomain &&
        !(
          creds.email_domain &&
          creds.email_domain_status === 'verified' &&
          body.from_address.toLowerCase().endsWith(`@${creds.email_domain}`)
        )
      )
        return c.json(
          {
            error: `from_address must be on ${env.emailInboundDomain} or a domain verified under Custom sending domain`,
          },
          400,
        );
      else creds.from_address = body.from_address.toLowerCase();
    }
    if (body.mirror_address !== undefined) {
      if (body.mirror_address === '') delete creds.mirror_address;
      else creds.mirror_address = body.mirror_address.toLowerCase();
    }
    if (body.gmail_query !== undefined) {
      if (body.gmail_query === '') delete creds.gmail_query;
      else creds.gmail_query = body.gmail_query;
    }
    if (body.email_filters !== undefined) {
      const f = body.email_filters;
      const next = { ...(creds.email_filters ?? {}) };
      for (const key of [
        'answer_addresses',
        'sender_allow',
        'sender_block',
        'subject_exclude',
      ] as const) {
        const v = f[key];
        if (v === undefined) continue;
        const clean = v.map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (clean.length) next[key] = clean;
        else delete next[key];
      }
      if (f.list_mail !== undefined) {
        if (f.list_mail) next.list_mail = true;
        else delete next.list_mail;
      }
      if (Object.keys(next).length) creds.email_filters = next;
      else delete creds.email_filters;
    }
    if (body.branding) {
      const b = body.branding;
      for (const key of ['title', 'subtitle', 'greeting', 'accent', 'logo_url'] as const) {
        const v = b[key];
        if (v === undefined) continue;
        if (v === '') delete creds[key];
        else creds[key] = v;
      }
      if (b.position !== undefined) creds.position = b.position;
      if (b.logo_padding !== undefined) creds.logo_padding = b.logo_padding;
      if (b.logo_radius !== undefined) creds.logo_radius = b.logo_radius;
      if (b.logo_border_width !== undefined) creds.logo_border_width = b.logo_border_width;
      if (b.logo_border_color !== undefined) {
        if (b.logo_border_color === '') delete creds.logo_border_color;
        else creds.logo_border_color = b.logo_border_color;
      }
      if (b.teaser_text !== undefined) {
        if (b.teaser_text === '') delete creds.teaser_text;
        else creds.teaser_text = b.teaser_text;
      }
      if (b.proactive !== undefined) creds.proactive = b.proactive;
      if (b.proactive_delay !== undefined) creds.proactive_delay = b.proactive_delay;
      if (b.sound !== undefined) creds.sound = b.sound;
      if (b.theme !== undefined) creds.theme = b.theme;
      if (b.hide_powered_by !== undefined) creds.hide_powered_by = b.hide_powered_by;
      if (b.show_help_link !== undefined) creds.show_help_link = b.show_help_link;
      if (b.dictation !== undefined) creds.dictation = b.dictation;
      if (b.quick_replies !== undefined) {
        if (b.quick_replies.length) creds.quick_replies = b.quick_replies;
        else delete creds.quick_replies;
      }
    }
    const [updated] = await db
      .update(channels)
      .set({
        name: body.name ?? row.name,
        credentials: creds,
        ...(body.agent_id ? { agentId: body.agent_id } : {}),
      })
      .where(eq(channels.id, row.id))
      .returning();
    invalidateChannelCache();
    // Re-apply Get Started on edits — covers channels created before this existed
    void setGetStartedButton(row.kind, creds).catch(() => {});
    const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId)).limit(1);
    return c.json({ channel: toChannel(updated, agent?.name ?? '') });
  });

  // ── Custom sending domain (email channels, Resend-verified) ─────────
  // Client registers e.g. mail.acme.com on our Resend account; we return
  // the DNS records, they configure them, verify flips status. Replies
  // still route to the channel's inbound_address via Reply-To — sending-
  // side records only.
  const loadEmailChannel = async (workspaceId: string, channelId: string) => {
    const [row] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1);
    return row;
  };

  app.post(
    '/:id/email-domain',
    zValidator('json', z.object({ domain: z.string().min(4).max(200) })),
    async (c) => {
      const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
      if (!row) return c.json({ error: 'not found' }, 404);
      if (row.kind !== 'email') return c.json({ error: 'email channel required' }, 400);
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
      );
      if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
      const domain = c.req
        .valid('json')
        .domain.trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/?#].*$/, '');
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) || domain.endsWith(env.emailInboundDomain))
        return c.json({ error: 'enter a domain you own — e.g. mail.acme.com' }, 400);
      const creds = row.credentials as ChannelCredentials;
      let d;
      try {
        // idempotent — re-registering an existing domain adopts it
        d = await createOrAdoptResendDomain(domain);
      } catch (e) {
        return c.json({ error: `resend: ${e instanceof Error ? e.message : e}` }, 502);
      }
      const next = {
        ...creds,
        email_domain: domain,
        email_domain_id: d.id,
        email_domain_status: d.status ?? 'pending',
        email_domain_records: d.records ?? [],
      };
      await db.update(channels).set({ credentials: next }).where(eq(channels.id, row.id));
      invalidateChannelCache();
      return c.json({ email_domain: domain, status: next.email_domain_status, records: next.email_domain_records });
    },
  );

  app.post('/:id/email-domain/verify', async (c) => {
    const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.kind !== 'email') return c.json({ error: 'email channel required' }, 400);
    const creds = row.credentials as ChannelCredentials;
    if (!creds.email_domain_id) return c.json({ error: 'no domain registered' }, 400);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    try {
      // ask Resend to re-check; a not-yet-propagated domain can error — the
      // fresh GET below is the source of truth either way
      await verifyResendDomain(creds.email_domain_id).catch(() => {});
      const d = await getResendDomain(creds.email_domain_id);
      const next = {
        ...creds,
        email_domain_status: d.status ?? creds.email_domain_status,
        ...(d.records?.length ? { email_domain_records: d.records } : {}),
      };
      await db.update(channels).set({ credentials: next }).where(eq(channels.id, row.id));
      invalidateChannelCache();
      return c.json({ status: next.email_domain_status, records: next.email_domain_records ?? creds.email_domain_records ?? [] });
    } catch (e) {
      return c.json({ error: `resend: ${e instanceof Error ? e.message : e}` }, 502);
    }
  });

  // Cloudflare OAuth — one-click DNS setup. State is HMAC-signed and binds
  // the consent redirect back to this channel (same scheme as Slack).
  const cfRedirectUri = `${env.apiOrigin}/channels/email-domain/cf-callback`;
  app.post('/:id/email-domain/cf-connect', async (c) => {
    if (!env.cfOauthClientId) return c.json({ error: 'cloudflare oauth not configured' }, 503);
    const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    const b64 = Buffer.from(
      JSON.stringify({ ch: row.id, w: c.get('workspaceId'), x: Date.now() + 600_000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', env.sessionSecret).update(b64).digest('base64url');
    return c.json({ url: cfAuthorizeUrl(cfRedirectUri, `cf.${b64}.${sig}`) });
  });

  // Best-path DNS setup: Domain Connect → Cloudflare OAuth → manual. The UI
  // calls this and navigates to whatever URL comes back (or shows records).
  app.post('/:id/email-domain/dns-setup', async (c) => {
    const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.kind !== 'email') return c.json({ error: 'email channel required' }, 400);
    const creds = row.credentials as ChannelCredentials;
    if (!creds.email_domain || !creds.email_domain_records?.length)
      return c.json({ error: 'register a domain first' }, 400);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    const mode = await detectDnsSetup(creds.email_domain, creds.email_domain_records);
    if (mode.mode === 'cloudflare') {
      if (!env.cfOauthClientId) return c.json({ mode: 'manual' });
      const b64 = Buffer.from(
        JSON.stringify({ ch: row.id, w: c.get('workspaceId'), x: Date.now() + 600_000 }),
      ).toString('base64url');
      const sig = createHmac('sha256', env.sessionSecret).update(b64).digest('base64url');
      return c.json({ mode: 'cloudflare', url: cfAuthorizeUrl(cfRedirectUri, `cf.${b64}.${sig}`) });
    }
    return c.json(mode);
  });

  // Push the DNS records into Cloudflare on the client's behalf — an OAuth
  // connection if one exists, else a one-shot API token (never stored).
  // Skips records that already exist.
  app.post(
    '/:id/email-domain/cf-setup',
    zValidator('json', z.object({ api_token: z.string().min(20).max(200).optional() })),
    async (c) => {
      const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
      if (!row) return c.json({ error: 'not found' }, 404);
      if (row.kind !== 'email') return c.json({ error: 'email channel required' }, 400);
      const creds = row.credentials as ChannelCredentials;
      if (!creds.email_domain || !creds.email_domain_records?.length)
        return c.json({ error: 'register a domain first' }, 400);
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
      );
      if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
      try {
        let token = c.req.valid('json').api_token;
        if (!token) {
          if (!creds.cf_refresh_token)
            return c.json({ error: 'connect Cloudflare or paste an API token' }, 400);
          token = (await cfRefresh(creds.cf_refresh_token)).access_token;
        }
        const out = await cloudflareSetupRecords(
          creds.email_domain,
          creds.email_domain_records,
          token,
        );
        await verifyResendDomain(creds.email_domain_id!).catch(() => {});
        const d = await getResendDomain(creds.email_domain_id!);
        const next = {
          ...creds,
          email_domain_status: d.status ?? creds.email_domain_status,
          ...(d.records?.length ? { email_domain_records: d.records } : {}),
        };
        await db.update(channels).set({ credentials: next }).where(eq(channels.id, row.id));
        invalidateChannelCache();
        return c.json({ ...out, status: next.email_domain_status, records: next.email_domain_records });
      } catch (e) {
        return c.json({ error: `cloudflare: ${e instanceof Error ? e.message : e}` }, 502);
      }
    },
  );

  app.delete('/:id/email-domain', async (c) => {
    const row = await loadEmailChannel(c.get('workspaceId'), c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.kind !== 'email') return c.json({ error: 'email channel required' }, 400);
    const creds = row.credentials as ChannelCredentials;
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    if (creds.email_domain_id) void deleteResendDomain(creds.email_domain_id).catch(() => {});
    const next = { ...creds };
    delete next.email_domain;
    delete next.email_domain_id;
    delete next.email_domain_status;
    delete next.email_domain_records;
    // a branded From on the removed domain can no longer send
    if (next.from_address && creds.email_domain && next.from_address.endsWith(`@${creds.email_domain}`))
      delete next.from_address;
    await db.update(channels).set({ credentials: next }).where(eq(channels.id, row.id));
    invalidateChannelCache();
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const [row] = await db
      .select({
        id: channels.id,
        agentId: channels.agentId,
        kind: channels.kind,
        credentials: channels.credentials,
      })
      .from(channels)
      .where(and(eq(channels.id, c.req.param('id')), eq(channels.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    // Hosted voice: release the number + close the subaccount so nothing
    // keeps billing after the channel is gone.
    const creds = row.credentials as ChannelCredentials;
    if (row.kind === 'voice' && creds?.hosted && creds.twilio_account_sid) {
      const { deprovisionVoiceNumber } = await import('../lib/twilio.js');
      void deprovisionVoiceNumber(creds.twilio_account_sid, creds.twilio_number_sid);
    }
    // An SMS channel cloned off a hosted number dies with it — the shared
    // subaccount creds stop working when the number releases. BYO voice
    // creds still exist on the customer's account, so no cascade there.
    if (row.kind === 'voice' && creds?.hosted) {
      const smsSiblings = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, c.get('workspaceId')),
            eq(channels.kind, 'sms'),
            sql`${channels.credentials}->>'phone_number' = ${creds.phone_number ?? ''}`,
          ),
        );
      for (const sib of smsSiblings) {
        await db.delete(channelBindings).where(eq(channelBindings.channelId, sib.id));
        await db.delete(channels).where(eq(channels.id, sib.id));
      }
    }
    // Bindings reference channels without cascade — remove them first.
    await db.delete(channelBindings).where(eq(channelBindings.channelId, row.id));
    await db.delete(channels).where(eq(channels.id, row.id));
    invalidateChannelCache();
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: row.id,
      meta: { kind: row.kind },
    });
    return c.json({ ok: true });
  });

  // ---- Outbound / proactive messaging -----------------------------------

  const waTemplate = z.object({
    name: z.string().min(1).max(200),
    language: z.string().max(20).optional(),
    body_params: z.array(z.string().max(1024)).max(20).optional(),
  });
  const outboundBody = z.object({
    to: z.string().min(1).max(320),
    text: z.string().max(4000).default(''),
    subject: z.string().max(200).optional(),
    whatsapp_template: waTemplate.optional(),
  });
  const broadcastBody = outboundBody
    .omit({ to: true })
    .extend({ recipients: z.array(z.string().min(1).max(320)).min(1).max(200) });

  /** Load the channel scoped to workspace + agent visibility; null → 404. */
  const loadChannel = async (c: Context<SessionEnv>): Promise<ChannelRow | null> => {
    const [row] = await db
      .select({ channel: channels })
      .from(channels)
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .where(
        and(
          eq(channels.id, c.req.param('id') ?? ''),
          eq(channels.workspaceId, c.get('workspaceId')),
          ...(agentScopeCond(c.get('agentScope')) ? [agentScopeCond(c.get('agentScope'))!] : []),
        ),
      )
      .limit(1);
    return row?.channel ?? null;
  };

  // Proactive outbound — creates the conversation if the recipient hasn't
  // messaged before. SMS/email can initiate freely; WhatsApp requires an
  // approved template outside the 24h session window (enforced in
  // sendOutbound). Messenger/IG/webchat can't initiate — Meta only allows
  // replies inside the messaging window, and the widget is pull-based.
  app.post(
    '/:id/send',
    dbRateLimit(db, {
      scope: 'outbound-send',
      windowMs: 60 * 60_000,
      max: 120,
      key: (c) => c.req.param('id') ?? 'unknown',
    }),
    zValidator('json', outboundBody),
    async (c) => {
    const channel = await loadChannel(c);
    if (!channel) return c.json({ error: 'not found' }, 404);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), channel.agentId, c.get('workspaceId'),
    );
    if (!role) return c.json({ error: 'forbidden' }, 403);
    const body = c.req.valid('json');
    const r = await sendOutbound(db, channel, c.get('user'), {
      to: body.to,
      text: body.text,
      subject: body.subject,
      template: body.whatsapp_template
        ? {
            name: body.whatsapp_template.name,
            language: body.whatsapp_template.language,
            bodyParams: body.whatsapp_template.body_params,
          }
        : undefined,
    });
    if ('error' in r && !r.conversationId) return c.json({ error: r.error }, 400);
    const out = { conversation_id: r.conversationId, mid: r.mid, error: r.error };
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'channel.send',
      targetType: 'channel',
      targetId: channel.id,
      meta: { to: body.to, kind: channel.kind, ok: !r.error },
    });
    return c.json(out, r.error ? 502 : 200);
  });

  // Broadcast — one message to a list of recipients on this channel. Admin
  // only: bulk outbound is the spam/abuse surface. Sends are enqueued as
  // jobs (drained by the sweeper, ~1/tick-chain) instead of run inline —
  // a 200-recipient blast shouldn't hold an HTTP connection. The hourly
  // recipient budget is workspace-wide, counted in rate_limits.
  app.post(
    '/:id/broadcast',
    dbRateLimit(db, {
      scope: 'broadcast-req',
      windowMs: 60 * 60_000,
      max: 20,
      key: (c) => c.get('workspaceId') as string,
    }),
    zValidator('json', broadcastBody),
    async (c) => {
      const channel = await loadChannel(c);
      if (!channel) return c.json({ error: 'not found' }, 404);
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), channel.agentId, c.get('workspaceId'),
      );
      if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
      const workspaceId = c.get('workspaceId');
      const body = c.req.valid('json');

      const allowance = await takeDbAllowance(db, {
        key: `bcast-recipients:${workspaceId}`,
        n: body.recipients.length,
        max: 500,
        windowMs: 60 * 60_000,
      });
      if (!allowance.ok) {
        c.header('Retry-After', String(allowance.retryAfter ?? 60));
        return c.json({ error: 'broadcast recipient budget exceeded (500/hr per workspace)' }, 429);
      }

      const template = body.whatsapp_template
        ? {
            name: body.whatsapp_template.name,
            language: body.whatsapp_template.language,
            bodyParams: body.whatsapp_template.body_params,
          }
        : undefined;
      const user = c.get('user');
      for (const to of body.recipients) {
        await enqueueJob(db, {
          workspaceId,
          type: 'outbound.send',
          payload: {
            channelId: channel.id,
            to,
            text: body.text,
            subject: body.subject,
            template,
            senderId: user.id,
            senderName: user.name,
          },
        });
      }
      await audit(db, {
        workspaceId,
        userId: user.id,
        userName: user.name,
        action: 'channel.broadcast',
        targetType: 'channel',
        targetId: channel.id,
        meta: { kind: channel.kind, recipients: body.recipients.length },
      });
      return c.json({ queued: body.recipients.length });
    },
  );

  return app;
}

/** Public Meta webhook endpoints mounted at /channels (app-secret signed). */
export function channelWebhookRoutes(db: Db) {
  const app = new Hono();

  // Cloudflare OAuth redirect — 'cf.<b64>.<hmac>' state binds consent back to
  // the channel; on success we keep the refresh token and immediately push
  // the pending DNS records + trigger Resend verification.
  app.get('/email-domain/cf-callback', async (c) => {
    const fail = (msg: string, agentId?: string, channelId?: string) =>
      c.redirect(
        channelId && agentId
          ? `${env.webOrigin}/agents/${agentId}/channels/${channelId}?cf_error=${encodeURIComponent(msg)}`
          : agentId
            ? `${env.webOrigin}/agents/${agentId}?tab=channels&cf_error=${encodeURIComponent(msg)}`
            : `${env.webOrigin}/agents?cf_error=${encodeURIComponent(msg)}`,
      );
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    if (!code || !state.startsWith('cf.')) return fail('missing code or state');
    const [b64, sig] = state.slice(3).split('.');
    const expected = createHmac('sha256', env.sessionSecret).update(b64 ?? '').digest('base64url');
    if (
      !b64 ||
      !sig ||
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return fail('invalid state');
    let st: { ch?: string; w?: string; x?: number };
    try {
      st = JSON.parse(Buffer.from(b64, 'base64url').toString());
    } catch {
      return fail('invalid state');
    }
    if (!st.ch || !st.w || !st.x || st.x < Date.now()) return fail('expired state');
    const [row] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, st.ch), eq(channels.workspaceId, st.w)))
      .limit(1);
    if (!row) return fail('channel not found');
    const failAtAgent = (msg: string) => fail(msg, row.agentId, row.id);
    const creds = row.credentials as ChannelCredentials;
    try {
      const tokens = await cfExchangeCode(
        code,
        `${env.apiOrigin}/channels/email-domain/cf-callback`,
      );
      const next = { ...creds, cf_refresh_token: tokens.refresh_token ?? creds.cf_refresh_token };
      let pushed = '';
      if (creds.email_domain && creds.email_domain_records?.length) {
        const out = await cloudflareSetupRecords(
          creds.email_domain,
          creds.email_domain_records,
          tokens.access_token,
        );
        if (creds.email_domain_id) {
          await verifyResendDomain(creds.email_domain_id).catch(() => {});
          const d = await getResendDomain(creds.email_domain_id);
          next.email_domain_status = d.status ?? creds.email_domain_status;
          if (d.records?.length) next.email_domain_records = d.records;
        }
        pushed = ` — ${out.created} record${out.created === 1 ? '' : 's'} created`;
      }
      await db.update(channels).set({ credentials: next }).where(eq(channels.id, row.id));
      invalidateChannelCache();
      return c.redirect(
        `${env.webOrigin}/agents/${row.agentId}/channels/${row.id}?cf_connect=${encodeURIComponent(`Cloudflare${pushed}`)}`,
      );
    } catch (e) {
      return failAtAgent(e instanceof Error ? e.message : 'cloudflare setup failed');
    }
  });

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
    const body = JSON.parse(raw);
    // Diagnostic: handover metadata (take/pass/request_thread_control,
    // app_roles) and standby items parse to nothing — log their shape so a
    // misconfigured page shows up as events rather than silence.
    for (const entry of (body.entry ?? []) as Record<string, unknown>[]) {
      const standby = (entry.standby ?? []) as Record<string, unknown>[];
      const feed = [
        ...((entry.messaging ?? []) as Record<string, unknown>[]),
        ...standby,
      ];
      const handover = feed.filter(
        (m) =>
          m.take_thread_control ||
          m.request_thread_control ||
          m.pass_thread_control ||
          m.app_roles,
      );
      if (standby.length > 0 || handover.length > 0) {
        const kinds = feed
          .map((m) =>
            Object.keys(m)
              .filter((k) => !['sender', 'recipient', 'timestamp'].includes(k))
              .join('/'),
          )
          .join(', ');
        console.log(
          `meta handover/standby: page=${String(entry.id)} standby=${standby.length} kinds=${kinds || '-'}`,
        );
      }
    }
    const msgs = parseMetaWebhook(body);
    let handled = 0;
    let legacyOwned = false;
    for (const msg of msgs) {
      const channel = await findChannelByObjectId(db, msg.objectId);
      if (channel) {
        // Handover protocol: the event arrived on standby, so another app
        // (Page Inbox, a legacy bot) owns the thread and only it can send.
        // For oauth channels WE are the bot — pull control so replies go
        // through; Meta then routes this thread's future events on
        // messaging. Legacy channels read standby for transcript only —
        // their replies still live in the legacy stack.
        if (msg.standby) {
          console.log(
            `meta standby event: page=${msg.objectId} sender=${msg.senderId} via=${(channel.credentials as ChannelCredentials).via ?? '-'}`,
          );
          if ((channel.credentials as ChannelCredentials).via === 'oauth') {
            await takeThreadControl(channel, msg.senderId);
          }
        }
        await handleChannelMessage(db, channel, msg);
        handled++;
        // Channel belongs to a legacy-imported agent — the event also goes
        // to the legacy stack so Mongo transcripts + Slack takeovers work.
        const [a] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, channel.agentId))
          .limit(1);
        if ((a?.metadata as Record<string, unknown> | null)?.legacy_client_key)
          legacyOwned = true;
      }
    }
    // Legacy coexistence: while old and new Janis share the Meta app, relay
    // events for pages we don't own — or pages whose bots still live in the
    // legacy dashboard/Slack — to the old system (raw body + signature).
    if (env.metaLegacyWebhookUrl && (handled < msgs.length || legacyOwned)) {
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

  // Resend inbound email — one channel per recipient address. The webhook
  // carries the envelope; the body is fetched from the receiving API.
  app.post('/email/inbound', async (c) => {
    const raw = await c.req.text();
    if (
      !env.resendInboundSecret ||
      !verifySvixSignature(env.resendInboundSecret, raw, c.req.raw.headers)
    ) {
      return c.text('invalid signature', 401);
    }
    let event: { type?: string; data?: EmailReceived };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return c.text('bad json', 400);
    }
    if (event.type !== 'email.received' || !event.data) return c.json({ ok: true });
    const data = event.data;

    // The webhook is an envelope — pull the full message (text/html) from
    // the receiving API when the key is configured; tolerate either shape.
    let mail = data;
    const emailId = data.email_id ?? data.id;
    if (env.resendApiKey && emailId && !(data.text || data.html)) {
      const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
        headers: { Authorization: `Bearer ${env.resendApiKey}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (res?.ok) {
        mail = { ...data, ...((await res.json().catch(() => ({}))) as EmailReceived) };
      }
    }

    const headers = mail.headers;
    const { name: fromName, address: fromAddr } = parseFrom(mail.from);
    if (!fromAddr) return c.json({ ok: true });
    const recipients = parseAddressList(mail.to);
    let channel;
    for (const r of recipients) {
      channel = await findChannelByEmailAddress(db, r);
      if (channel) break;
    }
    if (!channel) return c.json({ ok: true });

    // Loop guards + per-channel answer rules — auto-replies, bulk mail,
    // bounces, our own outbound domain, and anything the channel's filters
    // exclude must never ingest, or we'd email ourselves into a loop.
    const creds = channel.credentials as ChannelCredentials;
    if (
      mailSkipReason(
        { headers, from: mail.from, to: mail.to, subject: mail.subject },
        {
          selfAddress: creds.inbound_address,
          selfDomain: env.emailInboundDomain,
          filters: creds.email_filters,
        },
      )
    ) {
      return c.json({ ok: true });
    }

    let text = (mail.text ?? '').trim();
    if (!text && mail.html) text = htmlToText(mail.html);
    const atts = (mail.attachments ?? [])
      .map((a) => a.filename)
      .filter((f): f is string => !!f);
    if (atts.length) {
      text = `${text}${text ? '\n\n' : ''}${atts.map((f) => `📎 ${f}`).join('\n')}`;
    }
    // Forwarded-mail detection: when a real mailbox (janis@janis.ai) auto-
    // forwards here, its address shows up in x-forwarded-* / delivered-to /
    // To — remember it so outbound replies can BCC the origin inbox and
    // keep its copy of the thread complete.
    if (!creds.mirror_address && headers) {
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const ours = `@${env.emailInboundDomain}`;
      const mirror = ['x-forwarded-for', 'x-forwarded-to', 'delivered-to', 'to', 'cc']
        .flatMap((k) => parseAddressList(lower[k]))
        .find((a) => !a.endsWith(ours));
      if (mirror) {
        creds.mirror_address = mirror;
        await db
          .update(channels)
          .set({ credentials: creds })
          .where(eq(channels.id, channel.id));
      }
    }

    // RFC threading fields get stored on the message so replies can
    // reconstruct In-Reply-To/References.
    const refsHeader = headers?.['References'] ?? headers?.['references'];
    const references = refsHeader
      ? [...refsHeader.matchAll(/<[^>]+>/g)].map((m) => m[0])
      : [];

    await handleChannelMessage(db, channel, {
      objectId: (channel.credentials as ChannelCredentials).inbound_address ?? '',
      senderId: fromAddr,
      text,
      messageId: mail.message_id ?? emailId,
      name: fromName,
      user: { email: fromAddr },
      payload: {
        email: {
          subject: mail.subject,
          message_id: mail.message_id,
          references: references.length ? references : undefined,
        },
      },
    });
    return c.json({ ok: true });
  });

  // Resend OUTBOUND events — email.bounced / .complained / .failed land here
  // (ops point a second Resend webhook subscription at this path; same Svix
  // signing secret as inbound). A hard bounce or complaint = the mailbox is
  // dead or hostile, so we suppress it in every workspace that holds that
  // contact — provider-side attribution beats guessing a send's workspace.
  app.post('/email/events', async (c) => {
    const raw = await c.req.text();
    const secret = env.resendEventsSecret || env.resendInboundSecret;
    if (!secret || !verifySvixSignature(secret, raw, c.req.raw.headers)) {
      return c.text('invalid signature', 401);
    }
    let event: { type?: string; data?: { to?: string[] | string; bounce_type?: string } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return c.text('bad json', 400);
    }
    const type = event.type ?? '';
    if (!['email.bounced', 'email.complained', 'email.failed'].includes(type)) {
      return c.json({ ok: true });
    }
    const recipients = event.data?.to;
    const tos = Array.isArray(recipients) ? recipients : recipients ? [recipients] : [];
    const reason = type === 'email.complained' ? 'complaint' : 'bounce';
    for (const to of tos) {
      const normalized = to.trim().toLowerCase();
      if (!normalized.includes('@')) continue;
      const owners = await db
        .select({ workspaceId: contacts.workspaceId })
        .from(contacts)
        .where(
          sql`lower(${contacts.email}) = ${normalized}
              or ${normalized} = any(${contacts.altEmails})`,
        )
        .limit(50);
      for (const { workspaceId } of owners) {
        await recordSuppression(db, {
          workspaceId,
          address: normalized,
          kind: 'email',
          reason,
          source: `resend:${type}`,
        });
      }
    }
    return c.json({ ok: true });
  });

  return app;
}
