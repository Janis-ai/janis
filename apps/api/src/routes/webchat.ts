import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, agentWidgets, channelBindings, channels, conversations, helpArticles, memberships, messages, sessions, users, workspaces } from '../db/schema.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { sha256 } from '../lib/crypto.js';
import type { QuickReply } from '@janis/shared';
import { mathToUnicode } from '@janis/shared';
import type { ChannelCredentials, InboundMessage } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { emitHookEvent } from '../lib/hooks.js';
import { interpolateSpec, stripEmptyStrings, WidgetComponent } from '../lib/widgets.js';
import { effectivePlanKey } from '../lib/plans.js';
import { recordSttUsage } from '../lib/usage.js';
import { MAX_UPLOAD_BYTES, storeUpload } from '../lib/uploads.js';
import { adoptVisitorConversation, handleChannelMessage } from '../services/channelIngress.js';
import { processEvents } from '../services/ingest.js';
import { bus } from '../lib/bus.js';
import { rateLimit, takeDbAllowance } from '../lib/rateLimit.js';
import { agentWorking, operatorTyping } from '../lib/typingState.js';
import { collectFormNamed, recordFormSubmission } from '../lib/collectForms.js';
import { operatorIdentities } from '../lib/access.js';

/**
 * Public web-chat widget endpoints, mounted at /chat (no session auth).
 * The channel id is the public token; the visitor id (crypto-random, stored
 * in the visitor's browser) is the transcript credential.
 */
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Copilot thread key — the Ask Janis rail's "New chat" mints `t<rand>`
 *  tokens that scope a signed-in user's participant to u:<id>:<key>, giving
 *  each concierge chat its own conversation. Anonymous visitors ignore it —
 *  their visitor_id is already the thread key. */
const THREAD_RE = /^t[a-z0-9]{5,39}$/;
const threadFor = (raw: string | undefined | null) =>
  raw && THREAD_RE.test(raw) ? raw : undefined;

/**
 * Server-side dictation backend. Prefers the metered default account —
 * Gemini natively ingests audio via generateContent when JANIS_LLM_BASE_URL
 * is Google's OpenAI-compat endpoint, OpenAI /audio/transcriptions when it's
 * api.openai.com — then falls back to a vendor-scoped OPENAI_LLM_API_KEY.
 * Keys are read lazily so tests can inject them after module load.
 * Returns null when no backend is configured; throws when a configured
 * backend errors. `engine` is a temporary A/B knob: 'auto' prefers Gemini,
 * 'gemini'/'openai' force that backend (unsupported mime on gemini throws —
 * no silent cross-engine fallback, or the comparison is meaningless).
 */
async function transcribeAudio(
  file: File,
  engine: 'auto' | 'gemini' | 'openai' = 'auto',
): Promise<{ text: string; seconds: number } | null> {
  // Blob types arrive as e.g. 'audio/webm;codecs=opus' — strip params.
  const mime = (file.type || 'audio/webm').split(';')[0].trim();
  // Gemini's inline audio drops unsupported containers silently (mp4/m4a/aac
  // return "[BLANK_AUDIO]" with zero audio tokens) — only send what it reads.
  const GEMINI_AUDIO = /^audio\/(webm|ogg|wav|mp3|mpeg|aiff|x-aiff|flac)$/;
  const googleKey =
    process.env.GOOGLE_LLM_API_KEY ||
    env.llmVendorKeys.google?.api_key ||
    (env.llmBaseUrl.includes('generativelanguage.googleapis.com') ? env.llmApiKey : '');
  const googleOk = googleKey && GEMINI_AUDIO.test(mime) && engine !== 'openai';
  if (googleOk) {
    const base = env.llmBaseUrl.includes('generativelanguage.googleapis.com')
      ? env.llmBaseUrl.replace(/\/openai\/?$/, '')
      : 'https://generativelanguage.googleapis.com/v1beta';
    const model = env.llmModel.startsWith('gemini') ? env.llmModel : 'gemini-2.0-flash';
    const r = await fetch(`${base}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': googleKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mime,
                data: Buffer.from(await file.arrayBuffer()).toString('base64'),
              },
            },
            { text: 'Transcribe this audio verbatim. Output only the transcript text — no quotes, labels or commentary.' },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
    });
    if (r.ok) {
      const out = (await r.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = out.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      // Gemini returns no duration — estimate from size (~16KB/s opus).
      return { text: text.trim(), seconds: Math.min(Math.max(file.size / 16_000, 0), 600) };
    }
    console.warn('[stt] gemini', r.status, (await r.text()).slice(0, 300));
  }
  if (engine === 'gemini') {
    // Forced engine: a readable mime with a configured key that failed above
    // is an error; anything else means the engine can't serve this file.
    if (googleKey && GEMINI_AUDIO.test(mime)) throw new Error('gemini transcription failed');
    return null;
  }
  const openaiKey =
    process.env.OPENAI_LLM_API_KEY ||
    env.llmVendorKeys.openai?.api_key ||
    (env.llmBaseUrl.includes('api.openai.com') ? env.llmApiKey : '');
  if (!openaiKey) {
    if (!googleKey || !googleOk) return null; // nothing configured, or format only OpenAI reads
    throw new Error('gemini transcription failed');
  }
  const fd = new FormData();
  fd.append('file', file, file.name || 'dictation.webm');
  fd.append('model', 'gpt-4o-mini-transcribe');
  fd.append('response_format', 'verbose_json');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: fd,
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    console.warn('[stt] openai', r.status, detail);
    throw new Error(`openai transcription failed: ${r.status}`);
  }
  const out = (await r.json()) as { text?: string; duration?: number };
  return { text: (out.text ?? '').trim(), seconds: Math.min(Math.max(out.duration ?? 0, 0), 600) };
}

const attachment = z.object({
  name: z.string().max(255),
  url: z.string().regex(/^\/uploads\//),
  type: z.string().max(100),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
});

/** Host-asserted identity — `sig` is HMAC-SHA256(identity_secret, `${id}|${email}|${name}`). */
const identityClaim = z.object({
  id: z.string().max(120).optional(),
  name: z.string().max(80).optional(),
  email: z.string().max(200).optional(),
  sig: z.string().max(200).optional(),
  /** Host-provided context for the agent (plan, company, page, …). Unsigned
   *  — treated as self-reported context, never proof of anything. */
  traits: z.record(z.unknown()).optional(),
});

const postMessage = z
  .object({
    visitor_id: z.string().regex(VISITOR_RE),
    text: z.string().max(4000).default(''),
    name: z.string().max(80).optional(),
    user: identityClaim.optional(),
    // Console page the sender was on (Ask Janis rail sends location.pathname) —
    // context for the concierge, surfaced as the `page` trait for session users.
    page: z.string().max(500).optional(),
    // Agent selected in the console when the concierge message was sent —
    // surfaced as the `current_agent` trait so "this agent" resolves.
    agent_id: z.string().max(80).optional(),
    attachments: z.array(attachment).max(5).optional(),
    // Client-generated send id — a retried POST (timeout, "failed to send"
    // that actually landed) carries the same id and is deduped server-side
    // so the retry can't double-store the message.
    client_id: z.string().max(80).optional(),
    // Widget/chip taps — the message is a pick from a component, not typed
    // intent. tap_of names the card/widget it came from.
    tap: z.boolean().optional(),
    tap_of: z.string().max(300).optional(),
    // Storefront cart snapshot — the widget reads the shop's /cart.js and
    // sends a one-line summary so the agent can answer "what's in my cart"
    // from the shopper's real cart. Lands on user_profile.metadata.cart.
    cart: z.string().max(300).optional(),
    // Shopper's resolved Shopify market (Shopify.country, two-letter code) —
    // multi-market stores price/stock per market; the server-side
    // availability check must probe in THIS market, not the API's geography.
    market: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    // Copilot thread key (t<rand>) — scopes a signed-in concierge chat to
    // its own conversation; ignored for anonymous visitors.
    thread: z.string().max(48).optional(),
    // Structured collect-form submit — the widget stamps `collect` on a
    // configured form's spec and posts {name, values} alongside the readable
    // text so the server can enrich the contact + fire destinations. Ad-hoc
    // model-authored forms never carry this.
    form: z
      .object({
        name: z.string().max(60),
        values: z.record(z.string().max(2000)),
      })
      .optional(),
  })
  .refine((d) => d.text.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'text or attachments required',
  });

async function findChannel(db: Db, token: string) {
  // A non-UUID token (link expanders, typos, scanner probes hitting
  // /chat/anything) would throw in Postgres's uuid parser — 404 instead.
  if (!UUID_RE.test(token)) return undefined;
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, token), eq(channels.kind, 'webchat')))
    .limit(1);
  return channel;
}

type Claim = z.infer<typeof identityClaim>;
type ChannelRow = typeof channels.$inferSelect;

/** HMAC check — sig proves the host server (which knows the secret) vouched
 *  for this exact id/email/name triple. */
function verifyIdentitySig(secret: string, claim: Claim): boolean {
  if (!claim.sig) return false;
  const expected = createHmac('sha256', secret)
    .update(`${claim.id ?? ''}|${claim.email ?? ''}|${claim.name ?? ''}`)
    .digest('hex');
  return (
    expected.length === claim.sig.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(claim.sig))
  );
}

/**
 * Resolve who the visitor is, most-trusted first:
 *   1. a valid Janis session cookie — same-origin embeds (app.janis.ai) and
 *      credentialed embeds identify the logged-in account automatically;
 *   2. a host-signed claim — the embedding site signs with the channel's
 *      identity_secret (server-side) so identity can't be forged client-side;
 *   3. an unsigned claim — stored but flagged unverified.
 */
async function resolveIdentity(
  c: Context,
  db: Db,
  channel: ChannelRow,
  claim: Claim | undefined,
  page?: string,
  contextAgentId?: string,
): Promise<InboundMessage['user']> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const [row] = await db
      .select({ user: users, wsId: sessions.workspaceId })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (row) {
      // A signed-in Janis user gets their workspace names as traits so the
      // agent can reason about account questions ("you're on the Default
      // workspace") instead of guessing.
      const ws = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, row.user.id));
      const traits: Record<string, unknown> = {
        janis_account: 'yes',
        ...(ws.length ? { workspaces: ws.map((w) => w.name).join(', ') } : {}),
      };
      // The concierge surfaces (internal test channels + the Ask Janis rail,
      // which posts through the support channel) get the full context pack:
      // which workspace the session is acting in, the console page the user
      // was on, and the workspace's agent/channel inventory. Resolved fresh
      // per message — never stale — and gated so a logged-in operator
      // chatting on a customer's embedded widget doesn't leak their
      // workspace's agent list into that conversation.
      const isConcierge =
        (channel.credentials as ChannelCredentials).internal === true ||
        (env.supportChannelId !== '' && channel.id === env.supportChannelId);
      if (isConcierge) {
        const curWs = ws.find((w) => w.id === row.wsId) ?? ws[0];
        if (curWs) traits.current_workspace = curWs.name;
        if (page) traits.page = page;
        if (curWs) {
          const agentRows = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(eq(agents.workspaceId, curWs.id));
          // The agent the console was scoped to when the message was sent —
          // so "this agent" / "my greeting" resolve without the operator
          // having to name it. Only trusted inside the workspace. Stamped on
          // every concierge post (empty clears it): the trait dict merges
          // per-message, so an unstamped key would outlive the selection.
          const sel = agentRows.find((a) => a.id === contextAgentId);
          traits.current_agent = sel?.name ?? '';
          // The id too — console links (/agents/<id>/…) can then be built
          // verbatim instead of the model inventing a slug. Same merge rule:
          // empty clears a stale selection.
          traits.current_agent_id = sel?.id ?? '';
          if (agentRows.length) {
            const chans = await db
              .select({
                agentId: channels.agentId,
                kind: channels.kind,
                id: channels.id,
                credentials: channels.credentials,
              })
              .from(channels)
              .where(
                inArray(
                  channels.agentId,
                  agentRows.map((a) => a.id),
                ),
              );
            // Internal test-chat channels aren't customer-facing — counting
            // them makes the copilot claim agents "already have a Bubble".
            // Ids ride along so console links (/agents/<agent-id>/channels/
            // <channel-id>) can be built verbatim, not invented.
            const pub = chans.filter(
              (ch) => !(ch.credentials as ChannelCredentials).internal,
            );
            traits.agents = agentRows
              .map((a) => {
                const kinds = pub
                  .filter((ch) => ch.agentId === a.id)
                  .map((ch) => `${ch.kind}:${ch.id}`);
                return `${a.name} <${a.id}>${kinds.length ? ` (${kinds.join(', ')})` : ''}`;
              })
              .join('; ');
          }
        }
      }
      return {
        id: row.user.id,
        name: row.user.name,
        email: row.user.email,
        verified: true,
        via: 'session',
        avatarUrl: row.user.avatarUrl ?? undefined,
        traits,
      };
    }
  }
  if (!claim) return undefined;
  const secret = (channel.credentials as ChannelCredentials).identity_secret;
  const verified = secret ? verifyIdentitySig(secret, claim) : false;
  // A verified claim whose id is a real Janis user is the cross-origin form
  // of a session identity (the /identity endpoint vends exactly this) — it
  // binds the conversation to the user the same way.
  let janisUser = false;
  let avatarUrl: string | undefined;
  if (verified && claim.id && UUID_RE.test(claim.id)) {
    const [u] = await db
      .select({ id: users.id, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, claim.id))
      .limit(1);
    janisUser = Boolean(u);
    avatarUrl = u?.avatarUrl ?? undefined;
  }
  return {
    id: claim.id,
    name: claim.name,
    email: claim.email,
    verified,
    via: 'claim',
    janisUser,
    avatarUrl,
    traits: claim.traits,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Binding key for transcript lookups — mirrors channelIngress: a verified
 * Janis identity (session cookie, or a signed claim whose id is a real Janis
 * user) keys the conversation on the user so the same person keeps one
 * thread across devices and surfaces. Host-signed claims for their own
 * (non-Janis) users annotate the visitor's conversation instead. */
function participantFor(
  resolved: InboundMessage['user'] | undefined,
  visitorId: string,
  thread?: string,
) {
  return resolved?.verified && resolved.id && (resolved.via === 'session' || resolved.janisUser)
    ? `u:${resolved.id}${thread ? `:${thread}` : ''}`
    : visitorId;
}

/** Simulated-customer visitor — internal test channels only. An operator
 *  role-playing a customer uses a `cust_`-prefixed visitor id: the session
 *  identity is skipped entirely, so the conversation never gets
 *  identity_verified/external_id — the agent sees a real customer, and the
 *  escalation ladder ([HANDOFF]/[OFFER_HUMAN]) works instead of the
 *  copilot's "no human tier above you" clause. The prefix also binds a
 *  separate conversation from the operator's own test thread (u:<user>). */
function simVisitor(channel: ChannelRow, visitorId: string | undefined): boolean {
  return (
    !!visitorId?.startsWith('cust_') &&
    (channel.credentials as ChannelCredentials).internal === true
  );
}

/** Conversation for this channel + participant. Bound-conversation lookup
 * first; for verified Janis users (u:) fall back to the kind:participant
 * externalId — their thread is shared across surfaces by design and may be
 * bound to a sibling channel (see ingress participantFor). */
async function findConversation(db: Db, channel: ChannelRow, visitorId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, visitorId),
      ),
    )
    .limit(1);
  if (row) return row.conversation;
  if (visitorId.startsWith('u:')) {
    const internal = (channel.credentials as ChannelCredentials).internal === true;
    const externalId = internal
      ? `${channel.kind}:test:${channel.id}:${visitorId}`
      : `${channel.kind}:${visitorId}`;
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.agentId, channel.agentId), eq(conversations.externalId, externalId)),
      )
      .limit(1);
    return conv;
  }
  return undefined;
}

export function webchatRoutes(db: Db) {
  const app = new Hono();

  // Custom-domain resolution — chat.acme.com CNAME'd at this app calls here to
  // learn which channel claimed the host. The channel id doubles as the public
  // widget token (it ships in every embed snippet), so nothing new is exposed.
  // Registered before /:token — 'by-domain' isn't a UUID and would 404 there.
  app.get('/by-domain', async (c) => {
    const host = (c.req.query('host') ?? c.req.header('host') ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (!host) return c.json({ error: 'not found' }, 404);
    const [channel] = await db
      .select({ id: channels.id, name: channels.name, agentId: channels.agentId })
      .from(channels)
      .where(
        and(
          eq(channels.kind, 'webchat'),
          sql`${channels.credentials}->>'widget_domain' = ${host}`,
        ),
      )
      .limit(1);
    if (!channel) return c.json({ error: 'not found' }, 404);
    const [agent] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, channel.agentId))
      .limit(1);
    return c.json({ token: channel.id, channel_name: channel.name, agent_name: agent?.name ?? '' });
  });

  // Widget bootstrap — display config only; credentials never leave the API.
  app.get('/:token', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    // Branding edits must reach the widget on next load — heuristic caching
    // of this response makes "save appearance" look like it did nothing.
    c.header('cache-control', 'no-store');
    const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1);
    const creds = channel.credentials as ChannelCredentials;
    const agentCfg = (agent?.config ?? {}) as { quick_replies?: string[] };
    const agentReplies = agentCfg.quick_replies ?? [];
    // Same resolver as ingress so the widget's greeting matches the one
    // stored on the transcript (generated greetings are cached per channel).
    // Internal test channels resolve synchronously — a background resolve
    // could return the default here while the stored row gets the generated
    // text once the cache warms, and the rail would show a placeholder that
    // doesn't match the transcript.
    const internal = (channel.credentials as ChannelCredentials).internal === true;
    const greeting = await resolveGreeting(channel, agent, undefined, { background: !internal }, db);
    // Surface the public help center when the agent has published articles —
    // the widget renders it as a "Browse help articles" link.
    const [{ n: helpCount }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(helpArticles)
      .where(and(eq(helpArticles.agentId, channel.agentId), eq(helpArticles.status, 'published')));
    // White-labeling is a paid feature — the stored flag only reaches the
    // widget when the workspace's effective plan isn't free.
    const planKey = await effectivePlanKey(db, channel.workspaceId);
    // Custom help domain: the agent's own override wins, else the workspace
    // claim — the widget then links to help.acme.com rather than app.janis.ai.
    const [wsRow] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, channel.workspaceId))
      .limit(1);
    const helpHost =
      ((agent?.config ?? {}) as { help_domain?: string }).help_domain ??
      ((wsRow?.config ?? {}) as { help_domain?: string }).help_domain;
    // An agent-level external help_url wins over the built-in centre and
    // shows even with zero published articles; the channel-level
    // show_help_link toggle gates the button entirely.
    const externalHelp =
      ((agent?.config ?? {}) as { help_url?: string }).help_url ?? null;
    // Components pinned with "show when the chat opens" in the composer.
    const greetingWidgets = agent
      ? await db
          .select({ spec: agentWidgets.spec })
          .from(agentWidgets)
          .where(and(eq(agentWidgets.agentId, agent.id), eq(agentWidgets.autoGreet, true)))
      : [];
    const helpUrl =
      creds.show_help_link === false
        ? null
        : externalHelp ??
          (helpCount > 0
            ? `${helpHost ? `https://${helpHost}` : env.webOrigin}/help/${channel.agentId}`
            : null);
    return c.json({
      name: channel.name,
      agent_name: agent?.name ?? 'Assistant',
      title: creds.title ?? channel.name,
      subtitle: creds.subtitle ?? null,
      greeting,
      accent: creds.accent ?? null,
      position: creds.position === 'left' ? 'left' : 'right',
      display: creds.display === 'modal' ? 'modal' : 'bubble',
      logo_url: creds.logo_url ?? null,
      launcher: creds.launcher ?? null,
      logo_padding: creds.logo_padding ?? null,
      logo_radius: creds.logo_radius ?? null,
      logo_border_width: creds.logo_border_width ?? null,
      logo_border_color: creds.logo_border_color ?? null,
      radius: creds.radius ?? null,
      border_width: creds.border_width ?? null,
      border_color: creds.border_color ?? null,
      // channel-level override wins; agent config is the default
      quick_replies: creds.quick_replies?.length ? creds.quick_replies : agentReplies,
      help_url: helpUrl,
      // 'Text us' footer line — only when an SMS channel exists on this
      // agent and the channel hasn't switched the line off.
      sms_number:
        creds.sms_footer === false
          ? null
          : ((await db
              .select({ p: sql<string>`${channels.credentials}->>'phone_number'` })
              .from(channels)
              .where(and(eq(channels.agentId, channel.agentId), eq(channels.kind, 'sms')))
              .limit(1))[0]?.p ?? null),
      teaser_text: creds.teaser_text ?? null,
      proactive: creds.proactive !== false,
      proactive_delay: creds.proactive_delay ?? 20,
      sound: creds.sound !== false,
      theme: creds.theme ?? 'light',
      hide_powered_by: creds.hide_powered_by === true && planKey !== 'free',
      dictation: creds.dictation === true || creds.internal === true,
      // 'llm' = metered server transcription; 'browser' = free client-side
      // Web Speech. Absent resolves to 'llm' — channels that opted into
      // dictation before the engine switch keep their coverage.
      dictation_engine: creds.dictation_engine === 'browser' ? 'browser' : 'llm',
      font_family: creds.font_family ?? null,
      font_scale: creds.font_scale ?? null,
      // Saved components pinned to the greeting — rendered under the greeting
      // text on an empty thread (widget.js) and in the Ask Janis rail.
      // Greeting pins are static — interpolate with empty props and re-validate
      // so a data-bound template never renders literal "{prop}" placeholders.
      greeting_widgets: greetingWidgets
        .map((w) => WidgetComponent.safeParse(stripEmptyStrings(interpolateSpec(w.spec, {}))))
        .filter((r) => r.success)
        .map((r) => r.data),
    });
  });

  // Console preview host page — a bare document embedding this channel's
  // widget. The Bubble editor iframes it so the live preview runs the real
  // widget against the real pipeline, not a mock. ?mode=full swaps the
  // floating bubble for a page-filling messenger — the shareable "open chat"
  // link and what a claimed widget domain serves.
  app.get('/:token/page', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel || channel.kind !== 'webchat') return c.json({ error: 'not found' }, 404);
    c.header('cache-control', 'no-store');
    const mode = c.req.query('mode') === 'full'
      ? 'data-janis-page="1"'
      : 'data-janis-preview="1"';
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<style>html,body{margin:0;background:transparent}</style></head><body>` +
        `<script src="/widget.js" data-janis-token="${channel.id}" ${mode} async><\/script>` +
        `</body></html>`,
    );
  });

  // Send a visitor message — runs through the same ingest/agent pipeline.
  app.post('/:token/messages', zValidator('json', postMessage), async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const { visitor_id, text, name, user, page, agent_id, attachments, client_id, tap, tap_of, cart, market, thread, form } =
      c.req.valid('json');
    const threadKey = threadFor(thread);
    // Inbound throttle — anonymous widgets are the spam/cost surface. Two
    // Postgres-backed buckets (exact across instances): per-visitor stops a
    // single scripted visitor; the channel ceiling bounds a many-visitor
    // flood. Fails open on DB error like the other limiters.
    const perVisitor = await takeDbAllowance(db, {
      key: `chat-msg:${channel.id}:${visitor_id}`,
      n: 1,
      max: 20,
      windowMs: 60_000,
    });
    const perChannel = perVisitor.ok
      ? await takeDbAllowance(db, {
          key: `chat-msg-ch:${channel.id}`,
          n: 1,
          max: 300,
          windowMs: 60_000,
        })
      : { ok: false as const, retryAfter: perVisitor.retryAfter };
    if (!perVisitor.ok || !perChannel.ok) {
      c.header('Retry-After', String(perVisitor.retryAfter ?? perChannel.retryAfter ?? 60));
      return c.json({ error: 'Too many messages — slow down and retry.' }, 429);
    }
    const resolved = simVisitor(channel, visitor_id)
      ? undefined
      : await resolveIdentity(c, db, channel, user, page, agent_id);
    // Retry idempotency — the client resends with the same client_id after a
    // failed-looking POST (timeout, lost response). The write may have
    // landed already; if a stored inbound carries this id, acknowledge and
    // skip rather than double-store.
    if (client_id) {
      const conv = await findConversation(db, channel, participantFor(resolved, visitor_id, threadKey));
      if (conv) {
        const [dup] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conv.id),
              eq(messages.direction, 'in'),
              sql`${messages.payload}->>'client_id' = ${client_id}`,
            ),
          )
          .limit(1);
        // Echo deduped:true — an honest 200 either way, but a buggy sender
        // reusing one client_id (scripted runners minting it once outside
        // the loop) sees "accepted" for messages that never stored.
        if (dup) return c.json({ ok: true, deduped: true });
      }
    }
    // Collect-form submission — the widget sent the readable summary as
    // `text` (the agent reads it like any turn) plus the structured values
    // here. Record + enrich + destinations; the visitor's message still
    // flows through normal ingress regardless of the outcome.
    if (form) {
      void (async () => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1);
        const def = agent ? collectFormNamed(agent, form.name) : undefined;
        if (!agent || !def) return;
        const conv = await findConversation(
          db,
          channel,
          participantFor(resolved, visitor_id, threadKey),
        );
        await recordFormSubmission(db, { agent, conv, form: def, values: form.values });
      })().catch((err) => console.error('[webchat] form submission failed:', err));
    }
    // Ingress includes awaited side-paths (sync greeting generation on a
    // fresh test conversation, rule notifications) that can stretch past a
    // client timeout. Bound the wait — the pipeline keeps running after the
    // ack either way, and the transcript poll reconciles whatever landed.
    const ingress = handleChannelMessage(db, channel, {
      objectId: '',
      senderId: visitor_id,
      text,
      name: resolved?.name ?? name,
      user: resolved,
      cart,
      market: market?.toUpperCase(),
      thread: threadKey,
      attachments,
      payload: {
        ...(client_id ? { client_id } : {}),
        ...(tap ? { tap: true, ...(tap_of ? { tap_of } : {}) } : {}),
        ...(market ? { market: market.toUpperCase() } : {}),
      },
    }).catch((err) => {
      console.error('[webchat] message ingress failed:', err);
    });
    await Promise.race([ingress, new Promise((r) => setTimeout(r, 20_000))]);
    return c.json({ ok: true });
  });

  // Host-asserted identity update — lets the embed call Janis.identify()
  // before the first message or after a login/logout on the host page.
  app.post(
    '/:token/identify',
    zValidator(
      'json',
      z.object({
        visitor_id: z.string().regex(VISITOR_RE),
        user: identityClaim,
        thread: z.string().max(48).optional(),
      }),
    ),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id, user, thread } = c.req.valid('json');
      const resolved = simVisitor(channel, visitor_id)
        ? undefined
        : await resolveIdentity(c, db, channel, user);
      const conv = await findConversation(
        db,
        channel,
        participantFor(resolved, visitor_id, threadFor(thread)),
      );
      if (!resolved || !conv) return c.json({ ok: true }); // attaches on first message anyway
      const patch = {
        ...(resolved.name ? { name: resolved.name } : {}),
        ...(resolved.email ? { email: resolved.email } : {}),
        ...(resolved.avatarUrl ? { picture_url: resolved.avatarUrl } : {}),
        ...(resolved.verified && resolved.id ? { external_id: resolved.id } : {}),
        identity_verified: resolved.verified === true,
      };
      // Per-key merge — a stale read-modify-write would clobber concurrent
      // verification/profile keys (pending_verification, verified_emails).
      let profileMerge = sql`coalesce(${conversations.userProfile}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
      if (resolved.traits)
        profileMerge = sql`${profileMerge} || jsonb_build_object('metadata', coalesce(${conversations.userProfile}->'metadata', '{}'::jsonb) || ${JSON.stringify(resolved.traits)}::jsonb)`;
      await db
        .update(conversations)
        .set({ userProfile: profileMerge })
        .where(eq(conversations.id, conv.id));
      return c.json({ ok: true });
    },
  );

  // Signed identity bootstrap — a logged-in Janis session holder gets their
  // own identity back, HMAC-signed with the channel's identity_secret, ready
  // to pass to Janis.identify(). Lets host pages on any origin assert a
  // verified identity; unsigned/absent sessions get {enabled:false}.
  app.get('/:token/identity', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const secret = (channel.credentials as ChannelCredentials).identity_secret;
    const token = getCookie(c, SESSION_COOKIE);
    if (!secret || !token) return c.json({ enabled: false });
    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ enabled: false });
    const u = { id: row.user.id, name: row.user.name, email: row.user.email };
    const sig = createHmac('sha256', secret)
      .update(`${u.id}|${u.email}|${u.name}`)
      .digest('hex');
    return c.json({ id: u.id, name: u.name, email: u.email, sig });
  });

  // Copilot history — the signed-in user's concierge threads on this
  // channel's agent. Named threads carry externalId `webchat:u:<id>:t<key>`;
  // the default shared thread is plain `webchat:u:<id>` (thread: null).
  // Session-cookie only — anonymous visitors keep single visitor-keyed
  // threads and have nothing to list.
  app.get('/:token/threads', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const token = getCookie(c, SESSION_COOKIE);
    const [row] = token
      ? await db
          .select({ user: users })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
          .limit(1)
      : [];
    if (!row) return c.json({ threads: [] });
    const prefix = `${channel.kind}:u:${row.user.id}`;
    const convs = await db
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        state: conversations.state,
        preview: conversations.lastMessagePreview,
        at: conversations.lastMessageAt,
        created: conversations.createdAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, channel.agentId),
          or(
            eq(conversations.externalId, prefix),
            sql`${conversations.externalId} like ${prefix + ':%'}`,
          ),
        ),
      )
      .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`))
      .limit(30);
    return c.json({
      threads: convs
        .filter((cv) => cv.externalId)
        .map((cv) => ({
          thread: cv.externalId === prefix ? null : cv.externalId!.slice(prefix.length + 1),
          conversation_id: cv.id,
          state: cv.state,
          preview: cv.preview == null ? cv.preview : mathToUnicode(cv.preview),
          at: (cv.at ?? cv.created).toISOString(),
        })),
    });
  });

  // Widget file upload — same storage as console uploads, but scoped to a
  // live channel + well-formed visitor id instead of a session. URL comes
  // back relative; the widget prefixes its API origin, and attachments are
  // only accepted into messages if they point at /uploads/*.
  app.post('/:token/uploads', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const body = await c.req.parseBody();
    const visitorId = typeof body['visitor_id'] === 'string' ? body['visitor_id'] : '';
    if (!VISITOR_RE.test(visitorId)) return c.json({ error: 'bad visitor_id' }, 400);
    const allow = await takeDbAllowance(db, {
      key: `chat-upload:${channel.id}:${visitorId}`,
      n: 1,
      max: 10,
      windowMs: 60_000,
    });
    if (!allow.ok) {
      c.header('Retry-After', String(allow.retryAfter ?? 60));
      return c.json({ error: 'Too many uploads — slow down and retry.' }, 429);
    }
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const ref = await storeUpload(db, {
      name: file.name,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(ref, 201);
  });

  // Widget/rail dictation — MediaRecorder audio transcribed server-side.
  // Deliberately not Web Speech API on the client: Chrome's path silently
  // no-ops where its speech service is unreachable (VPNs, DNS filters,
  // on-device packs), and Firefox lacks the API entirely. The channel token
  // is the credential; the chat-token-upload limiter caps spend. Opt-in per
  // channel (credentials.dictation) because it's a metered Janis charge even
  // when the agent is BYOK — dictation always runs on platform keys. Internal
  // channels (Ask Janis rail, console test chat) always allow it.
  app.post('/:token/transcribe', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const creds = channel.credentials as ChannelCredentials;
    if (creds.dictation !== true && creds.internal !== true)
      return c.json({ error: 'dictation not enabled' }, 403);
    // 'browser'-engine channels opted out of metered transcription — a
    // crafted POST must not be able to run up the Janis STT meter anyway.
    if (creds.dictation_engine === 'browser' && creds.internal !== true)
      return c.json({ error: 'channel uses browser dictation' }, 403);
    const engineQ = c.req.query('engine');
    const engine =
      engineQ === 'gemini' || engineQ === 'openai' ? engineQ : 'auto';
    const body = await c.req.parseBody();
    const file = body['audio'];
    if (!(file instanceof File)) return c.json({ error: 'audio field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'audio too large (max 10MB)' }, 413);
    if (!file.size) return c.json({ text: '' });

    let out: { text: string; seconds: number } | null;
    try {
      out = await transcribeAudio(file, engine);
    } catch (e) {
      console.warn('[stt]', e);
      return c.json({ error: 'transcription failed' }, 502);
    }
    if (!out) return c.json({ error: 'transcription not configured' }, 503);
    if (!out.text.trim())
      console.warn('[stt] empty transcript', file.type, `${file.size}B`);
    const seconds = out.seconds;
    if (seconds > 0) {
      await recordSttUsage(db, {
        workspaceId: channel.workspaceId,
        agentId: channel.agentId,
        seconds,
      });
    }
    return c.json({ text: (out.text ?? '').trim() });
  });

  // Poll for messages. ?visitor_id= identifies anonymous browsers; a session
  // cookie or a signed claim (?u_id&u_name&u_email&u_sig) for a real Janis
  // user resolves to the user's own conversation instead (see ingress).
  // & after=<ISO timestamp> increments. Only direction/text/created_at are
  // exposed — never payloads or internals.
  app.get('/:token/messages', async (c) => {
    const channel = await findChannel(db, c.req.param('token'));
    if (!channel) return c.json({ error: 'not found' }, 404);
    const visitorId = c.req.query('visitor_id') ?? '';
    const claim: Claim = {
      id: c.req.query('u_id'),
      name: c.req.query('u_name'),
      email: c.req.query('u_email'),
      sig: c.req.query('u_sig'),
    };
    const resolved = simVisitor(channel, visitorId)
      ? undefined
      : await resolveIdentity(c, db, channel, claim);
    const bound =
      resolved?.verified && resolved.id && (resolved.via === 'session' || resolved.janisUser);
    if (!bound && !VISITOR_RE.test(visitorId)) {
      return c.json({ error: 'bad visitor_id' }, 400);
    }
    const thread = threadFor(c.req.query('thread'));
    const participant = participantFor(resolved, visitorId, thread);
    // Same adoption as ingress — a signed-in user's poll pulls their
    // browser's anonymous thread into the conversation being viewed even
    // before they send anything new. The verified-email sweep stays on the
    // default thread: polling a named copilot thread folds this browser's
    // own anon chat in, but never drags the user's whole past with it.
    if (bound && VISITOR_RE.test(visitorId)) {
      await adoptVisitorConversation(
        db,
        channel,
        participant,
        visitorId,
        thread ? undefined : resolved!.email,
      );
    }
    // Live transcript data must never be heuristically cached — a stale
    // response hides new messages and makes delivery look broken.
    c.header('cache-control', 'no-store');
    const conv = await findConversation(db, channel, participant);
    if (!conv) return c.json({ messages: [], state: 'new' });

    const after = c.req.query('after');
    const afterDate = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
    const before = c.req.query('before');
    const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
    // Latest page first: with no cursor the visitor cares about the newest
    // history, and older pages back-fill via ?before= as they scroll up.
    // Fetching PAGE+1 rows tells us whether an earlier page exists.
    const PAGE = 100;
    const select = () =>
      db
        .select({
          id: messages.id,
          direction: messages.direction,
          text: messages.text,
          created_at: messages.createdAt,
          payload: messages.payload,
          flags: messages.flags,
          author_id: messages.authorId,
        })
        .from(messages);
    let rows;
    let hasMore = false;
    if (afterDate) {
      // incremental poll — chronological, everything since the cursor
      rows = await select()
        .where(and(eq(messages.conversationId, conv.id), gt(messages.createdAt, afterDate)))
        .orderBy(asc(messages.createdAt))
        .limit(500);
    } else {
      const fetched = await select()
        .where(
          and(
            eq(messages.conversationId, conv.id),
            ...(beforeDate ? [lt(messages.createdAt, beforeDate)] : []),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(PAGE + 1);
      hasMore = fetched.length > PAGE;
      rows = fetched.slice(0, PAGE).reverse();
    }

    // Operator identity on human replies — the per-agent override
    // (agent_members display_name/avatar/show_identity) wins over the
    // operator's global profile; an effective opt-out keeps the reply
    // anonymous.
    const authors = new Map<string, { name: string; avatar: string | null }>();
    const ids = [...new Set(rows.filter((r) => r.direction === 'human' && r.author_id).map((r) => r.author_id!))];
    if (ids.length) {
      const us = await db
        .select()
        .from(users)
        .where(inArray(users.id, ids));
      for (const [id, ident] of await operatorIdentities(db, us, conv.agentId)) {
        if (ident.name == null) continue;
        authors.set(id, { name: ident.name, avatar: ident.avatar });
      }
    }

    // Internal test channels: the greeting row is a real transcript message
    // the rail should show — the widget's own bootstrap-greeting render is
    // skipped for those, so there's nothing to double.
    const internal = (channel.credentials as ChannelCredentials).internal === true;
    // The Ask Janis rail rides the support channel — deliberately NOT flagged
    // internal, since it's also the public widget on janis.ai and internal
    // rows must never reach anonymous visitors. A verified signed-in operator
    // polling their own concierge thread should still see approval cards.
    // Lazy env read so tests can point it at a fixture channel.
    const supportId = process.env.JANIS_SUPPORT_CHANNEL_ID || env.supportChannelId;
    const conciergeViewer = supportId !== '' && channel.id === supportId && !!bound;
    const showActions = internal || conciergeViewer;
    const raw = c.req.query('raw') === '1';

    return c.json({
      // Internal notes (failures/handoffs/alerts) are stored as 'out' but must
      // never reach the visitor — filter them here, same as deliverToChannel does.
      messages: rows
        .filter((m) => {
          const f = (m.flags ?? {}) as {
            failure?: boolean;
            help_requested?: boolean;
            custom_alert?: boolean;
            handoff_offer?: boolean;
            handoff_cancelled?: boolean;
            resolved?: boolean;
          };
          // payload.internal covers operator-only rows (takeover/resume/notes)
          // — they carry the author's real name and must never reach visitors.
          const p = m.payload as
            | { via?: string; internal?: boolean; action?: unknown; event?: string }
            | undefined;
          return (
            !f.failure &&
            !f.help_requested &&
            !f.custom_alert &&
            !f.handoff_offer &&
            !f.handoff_cancelled &&
            !f.resolved &&
            // Approval cards reach the internal test rail (Ask Janis) so an
            // operator can exercise a gated tool end-to-end. Every other
            // internal row — alerts, notes, the sign-in adoption fold — is
            // operator-only console annotation and stays hidden even from a
            // signed-in concierge viewer: the rail is a visitor surface.
            (!p?.internal || (showActions && !!p?.action))
          );
        })
        .map((m) => ({
        id: m.id,
        direction: m.direction,
        // Math renders as Unicode in the bubble ($60^\circ$ → 60°) — the
        // widget has no typesetter. ?raw=1 keeps canonical $…$ for the
        // console rail, whose richText styles math spans itself.
        text: raw ? m.text : m.text == null ? m.text : mathToUnicode(m.text),
        created_at: m.created_at.toISOString(),
        // sender's own idempotency key — lets the client reconcile its
        // optimistic outbox entry exactly, even after a lost response
        client_id: (m.payload as { client_id?: string } | undefined)?.client_id,
        // via:'greeting' rows are real transcript messages — the stored
        // record, so history loads show exactly what the visitor saw. The
        // widget's bootstrap renders a synthetic greeting on first open; it
        // dedupes on this flag instead of drawing the message twice.
        ...((m.payload as { via?: string } | undefined)?.via === 'greeting'
          ? { greeting: true }
          : {}),
        attachments: (m.payload as { attachments?: unknown[] } | undefined)?.attachments,
        quick_replies: (m.payload as { quick_replies?: QuickReply[] } | undefined)?.quick_replies,
        // interactive components (cards, pickers, forms) — validated on
        // ingest; the widget renders what it understands
        widgets: (m.payload as { widgets?: unknown[] } | undefined)?.widgets,
        // approval card payload — serialized only for internal test channels
        // and signed-in concierge viewers; external embeds must never see
        // tool args (refund amounts, order ids)
        ...(showActions
          ? { action: (m.payload as { action?: unknown } | undefined)?.action }
          : {}),
        // console destination a concierge tool asked to open — same gate as
        // the action card; external embeds must never see it
        ...(showActions && typeof (m.payload as { open_url?: unknown } | undefined)?.open_url === 'string'
          ? { open_url: (m.payload as { open_url: string }).open_url }
          : {}),
        // operator identity on human replies — gated by each operator's
        // show_identity profile setting, not a per-channel flag
        ...(m.direction === 'human' && m.author_id && authors.has(m.author_id)
          ? { author: authors.get(m.author_id) }
          : {}),
      })),
      state: conv.state,
      participant,
      conversation_id: conv.id,
      // an operator composing in the console — the widget/rail render dots;
      // name is null when the operator opted out of identity sharing
      operator_typing: await operatorTyping(db, conv.id),
      // a message.user was dispatched to the agent and no reply has landed
      // yet — real signal, unlike the post-send guess clients already make
      agent_typing: await agentWorking(db, conv.id),
      // only meaningful on full-page loads — incremental `after` polls omit it
      ...(afterDate ? {} : { has_more: hasMore }),
    });
  });

  // Visitor typing ping — ephemeral bus event to the console, never stored.
  // Throttled client-side; drops silently when the thread doesn't exist yet.
  app.post(
    '/:token/typing',
    zValidator(
      'json',
      z.object({
        visitor_id: z.string().regex(VISITOR_RE),
        thread: z.string().max(48).optional(),
      }),
    ),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id, thread } = c.req.valid('json');
      const resolved = simVisitor(channel, visitor_id)
        ? undefined
        : await resolveIdentity(c, db, channel, undefined);
      const participant = participantFor(resolved, visitor_id, threadFor(thread));
      const conv = await findConversation(db, channel, participant);
      if (!conv) return c.json({ ok: true });
      const [agent] = await db
        .select({ workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, channel.agentId))
        .limit(1);
      if (agent) {
        const name = (conv.userProfile as { name?: string } | null)?.name;
        // the typer's own Janis account, when session-bound — lets the
        // console suppress "visitor is typing" for your own rail chats.
        // Internal test channels omit it: there the operator IS role-playing
        // the visitor, and seeing the dots land in the console is the point.
        const internal = (channel.credentials as ChannelCredentials).internal === true;
        bus.publish(agent.workspaceId, {
          type: 'typing',
          data: {
            conversation_id: conv.id,
            name,
            user_id: internal
              ? null
              : participant.startsWith('u:')
                ? participant.slice(2).split(':')[0]
                : null,
          },
        });
      }
      return c.json({ ok: true });
    },
  );

  // Customer-initiated "End chat" (widget ⋯ menu) — archives the thread the
  // same way an operator's archive does: CSAT prompt + resolved webhook.
  app.post(
    '/:token/end',
    rateLimit({ scope: 'chat-end', windowMs: 60_000, max: 10 }),
    zValidator(
      'json',
      z.object({
        visitor_id: z.string().regex(VISITOR_RE),
        thread: z.string().max(48).optional(),
      }),
    ),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id, thread } = c.req.valid('json');
      const resolved = simVisitor(channel, visitor_id)
        ? undefined
        : await resolveIdentity(c, db, channel, undefined);
      const participant = participantFor(resolved, visitor_id, threadFor(thread));
      const conv = await findConversation(db, channel, participant);
      if (!conv || conv.state === 'archived') return c.json({ ok: true, state: 'archived' });
      const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1);
      if (!agent) return c.json({ error: 'not found' }, 404);
      await processEvents(db, agent, [
        {
          type: 'resolve',
          conversation_id: conv.externalId,
          reason: 'customer ended the chat',
        },
      ]);
      return c.json({ ok: true, state: 'archived' });
    },
  );

  // "Start a new chat" — after a chat has ended, the visitor's binding moves
  // to a fresh conversation so the next thread starts empty (the archived
  // one keeps its transcript). No-op while a chat is still open.
  app.post(
    '/:token/new',
    rateLimit({ scope: 'chat-new', windowMs: 60_000, max: 5 }),
    zValidator(
      'json',
      z.object({
        visitor_id: z.string().regex(VISITOR_RE),
        thread: z.string().max(48).optional(),
      }),
    ),
    async (c) => {
      const channel = await findChannel(db, c.req.param('token'));
      if (!channel) return c.json({ error: 'not found' }, 404);
      const { visitor_id, thread } = c.req.valid('json');
      const resolved = simVisitor(channel, visitor_id)
        ? undefined
        : await resolveIdentity(c, db, channel, undefined);
      const participant = participantFor(resolved, visitor_id, threadFor(thread));
      const conv = await findConversation(db, channel, participant);
      if (!conv) return c.json({ ok: true, state: 'new' });
      if (conv.state !== 'archived') return c.json({ ok: true, state: conv.state });
      const [created] = await db
        .insert(conversations)
        .values({
          agentId: conv.agentId,
          externalId: `${conv.externalId}#${Date.now().toString(36)}`,
          // The profile stays behind — a new chat is a fresh context, so the
          // agent doesn't open already "knowing" the visitor's name, email,
          // or traits they shared last time. Verified identity re-derives on
          // the next inbound for signed-in/host-identified visitors. The
          // contact link is different: it's the CRM spine for the same
          // browser human (re-linked on first inbound anyway) and it feeds
          // the verified-email anchor, not the model's prompt context.
          contactId: conv.contactId,
        })
        .returning();
      emitHookEvent(db, created.agentId, 'new_conversation', created);
      await db
        .update(channelBindings)
        .set({ conversationId: created.id })
        .where(
          and(
            eq(channelBindings.channelId, channel.id),
            eq(channelBindings.platformUserId, participant),
          ),
        );
      const [agent] = await db
        .select({ workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, created.agentId))
        .limit(1);
      if (agent) {
        bus.publish(agent.workspaceId, {
          type: 'conversation',
          data: { id: created.id, state: created.state },
        });
      }
      return c.json({ ok: true, state: 'new' });
    },
  );

  return app;
}
