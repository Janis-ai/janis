import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { setCookie } from 'hono/cookie';
import {
  agentMembers,
  agents,
  channels,
  contacts,
  conversations,
  memberships,
  messages,
  pendingActions,
  sessions,
  shopifyShops,
  users,
  workspaces,
} from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { invalidateChannelCache } from '../lib/channels.js';
import { MAX_UPLOAD_BYTES, storeUpload } from '../lib/uploads.js';
import { generateDraft } from '../lib/agentBuilder.js';
import { messageCap, PLANS } from '../lib/plans.js';
import { adminOnly, sessionAuth, SESSION_COOKIE, type SessionEnv } from '../middleware/sessionAuth.js';
import { generateSessionToken } from '../lib/crypto.js';
import { sendEmail } from '../lib/notify.js';
import { toConversation, toMessage } from '../lib/serializers.js';
import {
  getConversationForWorkspace,
  humanReply,
  resume,
  takeover,
  TakeoverError,
} from '../services/takeover.js';
import { adminToken } from '../lib/shopifyToken.js';
import {
  bindShop,
  embedEnabled,
  ensureShopForSession,
  SHOPIFY_API_VERSION,
  handleShopifyWebhook,
  mintEmbeddedSession,
  signAccessCode,
  verifyAccessCode,
  provisionShopWorkspace,
  shopBilling,
  shopifyAppConfigured,
  shopIsDevelopment,
  shopifyCustomerClaim,
  staffUserFor,
  startBillingSubscription,
  signLinkCode,
  unbindShop,
  verifyLinkCode,
  verifyProxySig,
  verifySessionToken,
  verifyWebhookHmac,
  shopifyStats,
  shopSettings,
  verifyRecoveryUnsub,
} from '../lib/shopifyApp.js';
import { MERCHANT_CONV } from '../lib/convFilters.js';
import { runHostedEvent } from '../lib/hostedAgent.js';
import { decidePendingAction } from '../lib/approvals.js';

/**
 * Embedded-app endpoints — three trust domains, three mounts:
 *   /api/shopify/*  session-token authed (the Shopify admin iframe — the
 *                   App Bridge JWT is the credential, no cookies)
 *   /shopify/*      provider-signed webhooks (HMAC with the app secret)
 *   api/shopify/*   session-authed console endpoints (the link flow)
 *
 * The api key doubles as the session-token aud and is safe to expose to
 * the storefront; the secret never leaves the API.
 */

async function sessionShop(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ shop: string; sub?: string; token: string } | null> {
  const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return null;
  const claims = verifySessionToken(body.token);
  return claims ? { ...claims, token: body.token } : null;
}

/** /api/shopify — session-token authed (embedded iframe). */
export function shopifyPublicRoutes(db: Db) {
  const app = new Hono();

  // App Bridge bootstrap — the SPA reads the (public) client id for the
  // shopify-api-key meta. 404 when the deployment isn't a Shopify app.
  app.get('/app-config', (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    return c.json({ api_key: env.shopifyAppApiKey });
  });

  // Embedded load — App Bridge hands us a session token; we answer with
  // the shop's link state so the iframe can render connect vs. status.
  app.post('/session', async (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    const sess = await sessionShop(c);
    if (!sess) return c.json({ error: 'invalid session token' }, 401);

    let row;
    try {
      row = await ensureShopForSession(db, sess.shop, sess.token);
    } catch (err) {
      return c.json({ error: `install failed: ${(err as Error).message}` }, 502);
    }

    const out: Record<string, unknown> = {
      shop: row.shop,
      state: row.state,
      // The Shopify JWT is only a bootstrap credential — the iframe runs on
      // this Janis-minted session so App Bridge expiry can't kill it.
      janis_token: mintEmbeddedSession(sess.shop, sess.sub),
    };
    if (row.state === 'unlinked' && !row.provisionedAt) {
      // Zero-login install — the App Bridge token is the credential, so the
      // merchant never sees a Janis login: provision the workspace + agent
      // on the spot and come back bound. unbindShop stamps provisionedAt,
      // so a deliberate unlink falls through to the manual link flow.
      try {
        row = await provisionShopWorkspace(db, row);
        out.state = row.state;
        out.provisioned = row.state === 'linked';
      } catch (err) {
        console.error(`shopify auto-provision ${row.shop}:`, err);
        out.provision_error = (err as Error).message;
      }
    }
    if (row.state === 'unlinked') {
      out.link_url = `${env.webOrigin}/shopify-link?code=${signLinkCode(row.id)}`;
    } else if (row.state === 'linked' && row.agentId) {
      const [[agent], [ws]] = await Promise.all([
        db
          .select({ name: agents.name, config: agents.config })
          .from(agents)
          .where(eq(agents.id, row.agentId))
          .limit(1),
        db
          .select({ name: workspaces.name, ownerUserId: workspaces.ownerUserId })
          .from(workspaces)
          .where(eq(workspaces.id, row.workspaceId!))
          .limit(1),
      ]);
      out.agent = agent?.name ?? null;
      out.agent_id = row.agentId;
      out.workspace = ws?.name ?? null;
      // Ownerless = provisioned but never claimed — the iframe sends
      // console-bound clicks through claim_url so the merchant picks up
      // membership instead of 403ing on a workspace they can't see.
      out.claimed = Boolean(ws?.ownerUserId);
      // Setup-card fields — the in-frame brief approval edits these via
      // POST /api/shopify/agent.
      const cfg = (agent?.config ?? {}) as {
        purpose?: string;
        greeting?: string;
        quick_replies?: string[];
      };
      out.purpose = cfg.purpose ?? null;
      out.greeting = cfg.greeting ?? null;
      out.quick_replies = cfg.quick_replies ?? [];
      // Billing + usage state for the plan card: current plan, this period's
      // message count, cap status, and any pending/active AppSubscription.
      const [cap, enabled] = await Promise.all([
        row.workspaceId ? messageCap(db, row.workspaceId) : Promise.resolve(null),
        embedEnabled(db, row),
      ]);
      const [wsPlan] = await db
        .select({ plan: workspaces.plan, billingProvider: workspaces.billingProvider })
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId!))
        .limit(1);
      out.plan = wsPlan?.plan ?? 'free';
      out.usage = cap
        ? { used: cap.used, included: cap.plan.includedMessages, capped: cap.capped }
        : null;
      // The shop row's AppSubscription record is only meaningful while
      // Shopify is (or is becoming) the billing rail — a stale PENDING left
      // behind after the shop re-bound to a Stripe/internal workspace is
      // noise, not an actionable approval.
      out.billing =
        wsPlan?.billingProvider === 'shopify' || wsPlan?.plan === 'free'
          ? shopBilling(row)
          : null;
      out.embed_enabled = enabled; // null = read_themes not granted yet
      // Store account email — console-access prefills with it (staff
      // emails need the gated read_users scope; this is all Shopify gives).
      out.contact_email = row.contactEmail ?? null;
      // Merchant settings (abandoned-checkout nudge) + 30-day stats for
      // the Store tab cards — orders attributed to chat, revenue, topic mix.
      out.settings = {
        nudge: true,
        nudge_after_minutes: 30,
        recovery_email: true,
        ...shopSettings(row),
      };
      out.stats = await shopifyStats(db, row, agent?.config);
      // The staff member's persistent Ask-Janis thread — lets the Ask tab
      // reload prior Q&A instead of opening blank every visit.
      const [askConv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, row.agentId),
            eq(conversations.externalId, `shopify-ask:${sess.sub ?? 'staff'}`),
          ),
        )
        .limit(1);
      out.ask_conversation_id = askConv?.id ?? null;
      out.plans = (['starter', 'pro', 'scale'] as const).map((key) => ({
        key,
        name: PLANS[key].name,
        price_cents: PLANS[key].baseCents,
        included_messages: PLANS[key].includedMessages,
      }));
      // A linked shop can still re-enter the link flow — the console page
      // rebinds to whichever agent the merchant picks (or creates).
      out.link_url = `${env.webOrigin}/shopify-link?code=${signLinkCode(row.id)}`;
      // Zero-login installs land on an ownerless workspace — this signed
      // link lets the merchant claim it into their Janis account.
      out.claim_url = `${env.webOrigin}/shopify-claim?code=${signLinkCode(row.id)}`;
    }
    return c.json(out);
  });

  // The setup step — the provisioned agent's name/purpose/greeting are
  // editable in-frame before the merchant enables the storefront embed.
  // A changed purpose re-drafts the hosted config (system prompt, tone,
  // greeting) through the same generator the console bootstrap uses; a
  // greeting edit applies directly without a regen.
  app.post(
    '/agent',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        name: z.string().min(1).max(120).optional(),
        purpose: z.string().max(4000).optional(),
        greeting: z.string().max(2000).optional(),
        quick_replies: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const sess = await sessionShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      const body = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(eq(shopifyShops.shop, sess.shop))
        .limit(1);
      if (!row || row.state !== 'linked' || !row.agentId) {
        return c.json({ error: 'no bound agent' }, 409);
      }
      const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId)).limit(1);
      if (!agent) return c.json({ error: 'agent not found' }, 404);

      const cfg = (agent.config ?? {}) as Record<string, unknown>;
      const nextCfg = { ...cfg };
      if (body.greeting !== undefined && body.greeting !== cfg.greeting) {
        nextCfg.greeting = body.greeting;
        if (body.greeting) nextCfg.greeting_enabled = true;
      }
      // Agent-level starter chips — the widget falls back to these when the
      // channel carries no quick_replies of its own (theme embeds can
      // still override per-storefront).
      if (body.quick_replies !== undefined) {
        if (body.quick_replies.length) nextCfg.quick_replies = body.quick_replies;
        else delete nextCfg.quick_replies;
      }
      if (body.purpose && body.purpose !== cfg.purpose) {
        nextCfg.purpose = body.purpose;
        const draft = await generateDraft(body.purpose).catch(() => null);
        if (draft) {
          if (draft.system_prompt) nextCfg.system_prompt = draft.system_prompt;
          if (draft.tone) nextCfg.tone = draft.tone;
          if (draft.greeting && body.greeting === undefined) {
            nextCfg.greeting = draft.greeting;
            nextCfg.greeting_enabled = true;
          }
          nextCfg.builder = { description: body.purpose, generated_at: new Date().toISOString() };
        }
      }
      await db
        .update(agents)
        .set({ ...(body.name ? { name: body.name } : {}), config: nextCfg })
        .where(eq(agents.id, agent.id));
      await audit(db, {
        workspaceId: row.workspaceId!,
        action: 'shopify.agent_setup',
        targetType: 'agent',
        targetId: agent.id,
        meta: { shop: row.shop, renamed: Boolean(body.name), redrafted: body.purpose !== cfg.purpose },
      });
      return c.json({ ok: true, greeting: (nextCfg.greeting as string) ?? null });
    },
  );

  // Plan subscription from inside the iframe — the session token is the
  // credential and Shopify's own confirmation page handles the money, so an
  // unclaimed (zero-login) merchant can subscribe without a Janis account.
  app.post(
    '/plan',
    zValidator('json', z.object({ token: z.string(), plan: z.enum(['starter', 'pro', 'scale']) })),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const sess = await sessionShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      const { plan } = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(eq(shopifyShops.shop, sess.shop))
        .limit(1);
      if (!row || row.state !== 'linked' || !row.workspaceId) {
        return c.json({ error: 'no bound workspace — link the shop first' }, 409);
      }
      // Shopify billing only applies when the bound workspace is on the free
      // plan or already billed by Shopify. A workspace on a Stripe-paid or
      // internal plan must not gain a second subscription here — approving it
      // would flip the whole workspace's plan + billing_provider.
      const [ws] = await db
        .select({ plan: workspaces.plan, billingProvider: workspaces.billingProvider })
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId))
        .limit(1);
      if (ws && ws.plan !== 'free' && ws.billingProvider !== 'shopify') {
        return c.json(
          { error: 'this workspace already has a plan — manage billing in the Janis console' },
          409,
        );
      }
      try {
        const { confirmationUrl, test } = await startBillingSubscription(db, row, plan);
        return c.json({ confirmation_url: confirmationUrl, test_mode: test });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : 'billing start failed' }, 502);
      }
    },
  );

  /* ── In-frame inbox ──────────────────────────────────────────────────
   * The App Bridge token is the credential and the shop's bound agent is
   * the scope — every endpoint below pins conversations to row.agentId.
   * A reply implies takeover (the staff member IS the human); the agent's
   * auto-resume timer hands the thread back after idle. Staff identity
   * comes from the JWT's sub → a loginless users row, so transcript and
   * Slack attribution read "Sarah", not "operator". */

  const linkedShop = async (c: Parameters<typeof sessionShop>[0]) => {
    const sess = await sessionShop(c);
    if (!sess) return { sess: null, row: null };
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, sess.shop))
      .limit(1);
    if (!row || row.state !== 'linked' || !row.workspaceId || !row.agentId) {
      return { sess, row: null };
    }
    return { sess, row };
  };

  // Conversation list for the bound agent — newest activity first, cursor
  // pagination identical to the console list.
  app.post(
    '/inbox',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const q = c.req.valid('json');

      const conditions = [
        eq(conversations.agentId, row.agentId!),
        ne(conversations.state, 'archived'),
        sql`not ${MERCHANT_CONV}`,
      ];
      const sortKey = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
      if (q.cursor) {
        const [ms, id] = q.cursor.split('_');
        conditions.push(
          sql`(${sortKey}, ${conversations.id}) < (${new Date(Number(ms)).toISOString()}::timestamptz, ${id}::uuid)`,
        );
      }
      const limit = q.limit ?? 50;
      const rows = await db
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(sql`${sortKey} desc`, desc(conversations.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return c.json({
        conversations: page.map((conv) => toConversation(conv)),
        next_cursor:
          hasMore && last
            ? `${(last.lastMessageAt ?? last.createdAt).getTime()}_${last.id}`
            : null,
      });
    },
  );

  // One thread — conversation meta plus a page of messages (?before for
  // history paging, same contract as the console's messages endpoint).
  app.post(
    '/inbox/thread',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        conversation_id: z.string().uuid(),
        before: z.string().optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const { conversation_id, before } = c.req.valid('json');
      try {
        const { conversation } = await getConversationForWorkspace(
          db,
          row.workspaceId!,
          conversation_id,
        );
        if (conversation.agentId !== row.agentId) {
          return c.json({ error: 'not found' }, 404);
        }
        const beforeDate =
          before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
        const PAGE = 100;
        const fetched = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              ...(beforeDate ? [lt(messages.createdAt, beforeDate)] : []),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(PAGE + 1);
        // Mark read — opening the thread in-frame counts as seeing it.
        if (conversation.isUnread) {
          await db
            .update(conversations)
            .set({ isUnread: false })
            .where(eq(conversations.id, conversation.id));
        }
        return c.json({
          conversation: toConversation({ ...conversation, isUnread: false }),
          messages: fetched.slice(0, PAGE).reverse().map(toMessage),
          has_more: fetched.length > PAGE,
        });
      } catch (err) {
        if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    },
  );

  // File upload for the composer's attachments — same storeUpload path as
  // /api/uploads, authed by the session token riding as a form field
  // (multipart bodies can't carry it in JSON).
  app.post('/inbox/upload', async (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token : '';
    const claims = token ? verifySessionToken(token) : null;
    if (!claims) return c.json({ error: 'invalid session token' }, 401);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, claims.shop))
      .limit(1);
    if (!row || row.state !== 'linked') return c.json({ error: 'no bound agent' }, 409);
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);
    const ref = await storeUpload(db, {
      name: file.name,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(ref, 201);
  });

  // Staff reply — implies takeover when the conversation isn't already in
  // human mode; the reply then travels via the same humanReply path the
  // console uses (channel delivery, Slack mirror, webhook event included).
  app.post(
    '/inbox/reply',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        conversation_id: z.string().uuid(),
        text: z.string().max(4000),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number(),
            }),
          )
          .optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const { conversation_id, text, attachments } = c.req.valid('json');
      if (!text.trim() && !attachments?.length) {
        return c.json({ error: 'text or attachments required' }, 400);
      }
      try {
        const { conversation } = await getConversationForWorkspace(
          db,
          row.workspaceId!,
          conversation_id,
        );
        if (conversation.agentId !== row.agentId) {
          return c.json({ error: 'not found' }, 404);
        }
        const staff = await staffUserFor(db, row, sess.sub);
        if (conversation.state !== 'human') {
          await takeover(db, row.workspaceId!, conversation_id, staff);
        }
        const { message, delivery } = await humanReply(
          db,
          row.workspaceId!,
          conversation_id,
          staff,
          text,
          attachments,
        );
        return c.json({ message: toMessage(message), delivery, state: 'human' }, 201);
      } catch (err) {
        if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    },
  );

  // Hand the thread back to the agent ahead of the auto-resume timer.
  app.post(
    '/inbox/resume',
    zValidator(
      'json',
      z.object({ token: z.string(), conversation_id: z.string().uuid() }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const { conversation_id } = c.req.valid('json');
      try {
        const { conversation } = await getConversationForWorkspace(
          db,
          row.workspaceId!,
          conversation_id,
        );
        if (conversation.agentId !== row.agentId) {
          return c.json({ error: 'not found' }, 404);
        }
        const staff = await staffUserFor(db, row, sess.sub);
        const updated = await resume(db, row.workspaceId!, conversation_id, staff);
        return c.json({ state: updated.state });
      } catch (err) {
        if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    },
  );

  // Merchant settings — today just the abandoned-checkout nudge (a
  // proactive agent message ~N min after a checkout starts and doesn't
  // convert). Read back via /session.
  app.post(
    '/settings',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        nudge: z.boolean().optional(),
        nudge_after_minutes: z.number().int().min(5).max(240).optional(),
        recovery_email: z.boolean().optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const q = c.req.valid('json');
      const next = {
        ...shopSettings(row),
        ...(q.nudge !== undefined ? { nudge: q.nudge } : {}),
        ...(q.nudge_after_minutes !== undefined
          ? { nudge_after_minutes: q.nudge_after_minutes }
          : {}),
        ...(q.recovery_email !== undefined ? { recovery_email: q.recovery_email } : {}),
      };
      const [updated] = await db
        .update(shopifyShops)
        .set({ settings: next, updatedAt: new Date() })
        .where(eq(shopifyShops.id, row.id))
        .returning();
      return c.json({
        settings: {
          nudge: true,
          nudge_after_minutes: 30,
          recovery_email: true,
          ...shopSettings(updated),
        },
      });
    },
  );

  // Ask Janis — the merchant copilot. A staff member chats with their own
  // agent from the embedded app ("how did we do this week?", "how many
  // orders shipped yesterday?") — the agent runs its real tool set with
  // operator-grade identity, so analytics/order tools answer for them.
  // One persistent thread per staff member (externalId shopify-ask:<sub>);
  // excluded from inbox lists everywhere via userProfile.kind.
  app.post(
    '/ask',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        text: z.string().max(4000),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number(),
            }),
          )
          .optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const { text, attachments } = c.req.valid('json');
      if (!text.trim() && !attachments?.length) {
        return c.json({ error: 'text or attachments required' }, 400);
      }
      const staff = await staffUserFor(db, row, sess.sub);
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, row.agentId!))
        .limit(1);

      const externalId = `shopify-ask:${sess.sub ?? 'staff'}`;
      let [conv] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.agentId, row.agentId!), eq(conversations.externalId, externalId)))
        .limit(1);
      if (!conv) {
        [conv] = await db
          .insert(conversations)
          .values({
            agentId: row.agentId!,
            externalId,
            userProfile: {
              kind: 'merchant_ask',
              name: staff.name,
              email: staff.email,
              identity_verified: true,
              external_id: staff.id,
              // The embedded app is scoped to the shop's bound agent — stamp
              // it as the "selected" agent so workspace tools (visitorAgent)
              // default to it the way the console's selection does.
              metadata: { current_agent: agent?.name ?? '' },
            },
          })
          .returning();
      } else {
        const p = conv.userProfile as { metadata?: { current_agent?: string } };
        const patch: Record<string, unknown> = {};
        // A dormant ask thread just wakes up — staff chats never park.
        if (conv.state === 'archived' || conv.state === 'human') patch.state = 'active';
        // Threads from before the current_agent stamp get it backfilled —
        // tools read it on every call, so one write fixes them forever.
        if (!p?.metadata?.current_agent && agent?.name) {
          patch.userProfile = {
            ...(conv.userProfile as Record<string, unknown>),
            metadata: { ...p?.metadata, current_agent: agent.name },
          };
        }
        if (Object.keys(patch).length) {
          await db.update(conversations).set(patch).where(eq(conversations.id, conv.id));
        }
      }
      await db.insert(messages).values({
        conversationId: conv.id,
        direction: 'in',
        authorId: staff.id,
        text,
        payload: {
          merchant_ask: true,
          ...(attachments?.length ? { attachments } : {}),
        },
      });
      await db
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          lastMessageDirection: 'in',
          lastMessagePreview: text.slice(0, 120),
          isUnread: false,
        })
        .where(eq(conversations.id, conv.id));
      if (agent) {
        void runHostedEvent(db, agent, {
          type: 'message.user',
          conversation_id: conv.externalId,
          janis_conversation_id: conv.id,
          timestamp: new Date().toISOString(),
        }).catch((err) => console.error(`shopify ask ${row.shop}:`, err));
      }
      return c.json({ conversation_id: conv.id });
    },
  );

  // Decide a copilot approval card — the copilot's writes (teach_agent,
  // config changes, new channels…) park as cards in the ask thread. Only the
  // staff member whose thread holds the card may decide it — the card's
  // conversation must be THIS staff member's ask thread on THIS shop's
  // agent. Workspace members can also decide from the console (the action
  // routes fall through to the member path for merchant_ask threads).
  app.post(
    '/ask/decide',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        action_id: z.string().uuid(),
        decision: z.enum(['approved', 'denied']),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      const { action_id, decision } = c.req.valid('json');
      const [action] = await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.id, action_id))
        .limit(1);
      if (!action) return c.json({ error: 'not found' }, 404);
      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, action.conversationId))
        .limit(1);
      if (
        !conv ||
        conv.agentId !== row.agentId ||
        conv.externalId !== `shopify-ask:${sess.sub ?? 'staff'}`
      ) {
        return c.json({ error: 'not found' }, 404);
      }
      const staff = await staffUserFor(db, row, sess.sub);
      const decided = await decidePendingAction(
        db,
        action.id,
        { id: staff.id, name: staff.name ?? 'Store staff' },
        decision === 'approved',
      );
      if (decided === 'not-pending') return c.json({ error: 'already decided' }, 409);
      if (!decided) return c.json({ error: 'not found' }, 404);
      return c.json({ ok: true, status: decided.action.status, result: decided.action.result });
    },
  );

  // Console access — staff types their email in the embedded app, we mail a
  // signed magic link. The session token already proves they're staff of
  // this shop; the link only works for the inbox it was sent to.
  app.post(
    '/console-access',
    zValidator(
      'json',
      z.object({
        token: z.string(),
        // Optional — defaults to the shop's contactEmail (the only address
        // Shopify exposes without the gated read_users scope). Shops
        // provisioned before the column existed lazy-fetch + persist here.
        email: z.string().email().max(320).optional(),
      }),
    ),
    async (c) => {
      if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
      const { sess, row } = await linkedShop(c);
      if (!sess) return c.json({ error: 'invalid session token' }, 401);
      if (!row) return c.json({ error: 'no bound agent' }, 409);
      let { email } = c.req.valid('json');
      if (!email && !row.contactEmail) {
        const token = row.accessTokenEnc ? await adminToken(db, row).catch(() => '') : '';
        if (token) {
          try {
            const res = await fetch(
              `https://${row.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-shopify-access-token': token,
                },
                body: JSON.stringify({ query: '{shop{contactEmail email}}' }),
              },
            );
            const json = (await res.json()) as {
              data?: { shop?: { contactEmail?: string; email?: string } };
            };
            const ce = json.data?.shop?.contactEmail || json.data?.shop?.email;
            if (ce) {
              await db
                .update(shopifyShops)
                .set({ contactEmail: ce })
                .where(eq(shopifyShops.id, row.id));
              row.contactEmail = ce;
            }
          } catch {
            /* fall through to the 400 below */
          }
        }
      }
      email = email ?? row.contactEmail ?? undefined;
      if (!email) {
        return c.json({ error: 'no store email on file — enter one' }, 400);
      }
      email = email.toLowerCase();
      // The staff member's real address just landed on our side — stamp it
      // on their synthetic staff row so inbox replies attribute to a person
      // ("mike@store.com took over") instead of "Store staff".
      if (sess.sub) {
        await db
          .update(users)
          .set({ name: email })
          .where(
            and(
              eq(users.email, `shopify-staff+${sess.sub}@${row.shop}`),
              eq(users.name, 'Store staff'),
            ),
          );
      }
      const code = signAccessCode(row.id, email);
      await sendEmail(
        [email],
        'Your Janis sign-in link',
        `Open the Janis console for ${row.shop} — this link signs you in and connects you to the store's workspace. It's valid for 24 hours.`,
        `/api/shopify/magic-login?code=${encodeURIComponent(code)}`,
      );
      return c.json({ ok: true, sent_to: email });
    },
  );

  // The emailed link redeems here: verify → find/create the user → claim
  // them into the bound workspace → console session cookie → console.
  app.get('/magic-login', async (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    const grant = verifyAccessCode(c.req.query('code') ?? '');
    if (!grant) return c.json({ error: 'invalid or expired link' }, 401);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.id, grant.shopId))
      .limit(1);
    if (!row || row.state !== 'linked' || !row.workspaceId) {
      return c.json({ error: 'store is no longer connected' }, 409);
    }
    const email = grant.email.toLowerCase();
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      [user] = await db
        .insert(users)
        .values({ email, name: email.split('@')[0] })
        .onConflictDoNothing()
        .returning();
      // Lost the insert race — the other writer's row is the one to use.
      user ??= (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    }
    // Access grant depends on who's redeeming:
    //  - ownerless provisioned workspace → the redeemer claims it
    //    (admin membership + owner), same as /shopify/claim.
    //  - owned workspace, new face → agent-scoped member on the bound agent
    //    only. A store employee must not inherit admin over an existing
    //    workspace's other agents, billing, or settings.
    //  - already a workspace member → their existing role stands.
    const [ws] = await db
      .select({ ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    const [existingMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.workspaceId, row.workspaceId),
          isNotNull(memberships.acceptedAt),
        ),
      )
      .limit(1);
    if (!ws?.ownerUserId) {
      await db
        .insert(memberships)
        .values({
          userId: user.id,
          workspaceId: row.workspaceId,
          role: 'admin',
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();
      await db
        .update(workspaces)
        .set({ ownerUserId: user.id })
        .where(and(eq(workspaces.id, row.workspaceId), isNull(workspaces.ownerUserId)));
    } else if (!existingMembership && row.agentId) {
      await db
        .insert(agentMembers)
        .values({
          agentId: row.agentId,
          userId: user.id,
          role: 'member',
          invitedBy: ws.ownerUserId,
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();
    }
    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId: user.id,
      workspaceId: row.workspaceId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect('/');
  });

  // Storefront loader — the theme app extension drops
  //   <script src="/api/shopify/storefront.js?s=<shop>">
  // on every page; we resolve shop → bound agent → its Bubble channel and
  // emit the widget.js bootstrap. Deliberately a silent no-op until the
  // merchant links (or if the channel was deleted) — a script 404/500 on
  // a storefront is worse than no bubble.
  app.get('/storefront.js', async (c) => {
    const js = (body: string) =>
      c.body(body, 200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=60',
      });
    const noop = () => js('/* janis: no storefront widget for this shop */');
    const shop = (c.req.query('s') ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return noop();
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, shop))
      .limit(1);
    if (row?.state !== 'linked' || !row.agentId) return noop();
    let chans = await db
      .select({ id: channels.id, credentials: channels.credentials })
      .from(channels)
      .where(and(eq(channels.agentId, row.agentId), eq(channels.kind, 'webchat')));
    // Internal test-chat channels never serve a storefront.
    let chan = chans.find(
      (ch) => !(ch.credentials as { internal?: boolean } | null)?.internal,
    );
    if (!chan && row.workspaceId) {
      // Self-heal: shops bound before the channel auto-create landed (or
      // merchants who deleted their Bubble) get one on first storefront
      // hit instead of silently serving nothing forever.
      [chan] = await db
        .insert(channels)
        .values({
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          kind: 'webchat',
          name: `Shopify — ${shop.replace(/\.myshopify\.com$/, '')}`,
          credentials: {},
        })
        .returning({ id: channels.id, credentials: channels.credentials });
      invalidateChannelCache();
    }
    if (!chan) return noop();
    // Theme-embed overrides — the merchant's Theme Settings values ride
    // as data attributes; widget.js applies them on top of the channel's
    // Bubble config. Whitelisted + validated: the query params are
    // storefront-controlled input.
    const q = c.req.query();
    const attrs: string[] = [];
    const accent = (q.accent ?? '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(accent)) attrs.push(`s.setAttribute('data-janis-accent',${JSON.stringify(accent)});`);
    const position = (q.position ?? '').trim();
    if (position === 'left' || position === 'right')
      attrs.push(`s.setAttribute('data-janis-position',${JSON.stringify(position)});`);
    // Shopify's image_url emits PROTOCOL-RELATIVE URLs (//shop/cdn/…) — lift
    // them to https so the value is absolute everywhere downstream. Anything
    // that isn't https (or the launcher keywords) drops.
    const absImg = (u: string) =>
      u.startsWith('//') ? `https:${u}` : /^https:\/\//.test(u) ? u : null;
    // Chat-window logo — the theme block's image_picker emits a cdn URL.
    const logo = absImg((q.logo ?? '').trim());
    if (logo && logo.length <= 500)
      attrs.push(`s.setAttribute('data-janis-logo',${JSON.stringify(logo)});`);
    // Launcher icon — 'glyph'/'logo' keywords or an image URL (the theme
    // block's image_picker emits a cdn URL). Anything else drops.
    const launcher = (q.launcher ?? '').trim();
    const launcherImg = launcher === 'glyph' || launcher === 'logo' ? launcher : absImg(launcher);
    if (launcherImg && launcherImg.length <= 500)
      attrs.push(`s.setAttribute('data-janis-launcher',${JSON.stringify(launcherImg)});`);
    for (const [param, attr] of [
      ['teaser', 'data-janis-teaser'],
      ['greeting', 'data-janis-greeting'],
    ] as const) {
      const v = (q[param] ?? '').trim().slice(0, 500);
      if (v) attrs.push(`s.setAttribute(${JSON.stringify(attr)},${JSON.stringify(v)});`);
    }
    // Comma-separated starter chips — the theme editor is single-line text,
    // so the merchant types "Track order, Returns, Talk to a human".
    const qrs = (q.qrs ?? '')
      .split(',')
      .map((s) => s.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 8);
    if (qrs.length)
      attrs.push(`s.setAttribute('data-janis-replies',${JSON.stringify(JSON.stringify(qrs))});`);
    // Signed-in shopper context — the theme embed passes the logged-in
    // Shopify customer as params. We forward them as an UNSIGNED identity
    // claim (self-reported tier: greeting/prefill, never proof — signing
    // raw params would make this endpoint a forgery oracle). Account-level
    // actions still verify via the order+email pair.
    const cid = (q.cid ?? '').trim();
    const cemail = (q.cemail ?? '').trim().slice(0, 200);
    const cname = (q.cname ?? '').trim().slice(0, 80);
    if (/^\d+$/.test(cid) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cemail)) {
      const claim: Record<string, string> = {};
      if (/^\d+$/.test(cid)) claim.id = `shopify:${cid}`;
      if (cemail) claim.email = cemail;
      if (cname) claim.name = cname;
      attrs.push(`s.setAttribute('data-janis-user',${JSON.stringify(JSON.stringify(claim))});`);
    }
    // Theme → channel sync: non-empty theme overrides persist into the
    // channel's credentials so the console Bubble editor shows the same
    // effective values (blank always means "channel default", so absent
    // params never clear a stored value). Write only on change — this
    // endpoint is hot (every storefront page load).
    {
      // Early deploys stored these under credentials.branding — a nested
      // blob nothing reads (flat keys are canonical). Fold leftovers into
      // the flat shape and drop the key so past theme edits finally land.
      const flat = { ...((chan.credentials ?? {}) as Record<string, unknown>) };
      const legacy = (flat.branding ?? {}) as Record<string, unknown>;
      const hadNested = 'branding' in flat;
      delete flat.branding;
      const current = { ...legacy, ...flat }; // flat wins over legacy nested
      const next: Record<string, unknown> = {};
      // Same validation as the attrs above — junk theme values are dropped,
      // not persisted into channel credentials.
      if (/^#[0-9a-fA-F]{6}$/.test(accent)) next.accent = accent;
      if (position === 'left' || position === 'right') next.position = position;
      if (logo && logo.length <= 500) next.logo_url = logo;
      if (launcherImg && launcherImg.length <= 500) next.launcher = launcherImg;
      const teaser = (q.teaser ?? '').trim().slice(0, 200);
      if (teaser) next.teaser_text = teaser;
      const greeting = (q.greeting ?? '').trim().slice(0, 500);
      if (greeting) next.greeting = greeting;
      if (qrs.length) next.quick_replies = qrs;
      const changed =
        hadNested ||
        Object.entries(next).some(([k, v]) => JSON.stringify(current[k]) !== JSON.stringify(v));
      if (changed)
        void db
          .update(channels)
          .set({ credentials: { ...current, ...next } } as never)
          .where(eq(channels.id, chan.id))
          .then(() => invalidateChannelCache())
          .catch((e) => console.error('shopify theme→channel sync:', e));
    }
    return js(
      `(function(){var s=document.createElement('script');s.src=${JSON.stringify(
        `${env.apiOrigin}/widget.js`,
      )};s.async=true;s.setAttribute('data-janis-token',${JSON.stringify(chan.id)});s.setAttribute('data-janis-cart','1');${attrs.join('')}document.head.appendChild(s);})();`,
    );
  });

  // Storefront app proxy — the widget calls /apps/janis/session on the
  // SHOP domain and Shopify forwards it here as /api/shopify/proxy/session
  // with its own signature + logged_in_customer_id when the shopper is
  // logged into their store account. A verified signature is real proof of
  // that login, so we answer with an identity claim signed by the channel's
  // identity_secret — self-reported context upgrades to verified identity
  // (external_id shopify:<cid>) and identity-bound tools unlock. See
  // shopify.app.toml [app_proxy] and lib/shopifyApp.ts verifyProxySig.
  app.get('/proxy/session', async (c) => {
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const q = c.req.queries();
    if (!shopifyAppConfigured() || !verifyProxySig(q))
      return c.json({ error: 'bad signature' }, 401);
    // The signature proves Shopify generated this request, but a captured
    // URL would replay forever — bound it to a fresh proxy timestamp.
    const ts = Number(first(q.timestamp) ?? NaN);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300)
      return c.json({ error: 'stale signature' }, 401);
    const shop = (first(q.shop) ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))
      return c.json({ error: 'bad shop' }, 400);
    const cid = (first(q.logged_in_customer_id) ?? '').trim();
    if (!cid) return c.json({ claim: null }); // visitor not logged in
    if (!/^\d+$/.test(cid)) return c.json({ error: 'bad customer id' }, 400);
    const claim = await shopifyCustomerClaim(db, shop, cid);
    return c.json({ claim });
  });

  return app;
}

/** /shopify — provider-signed webhooks. */
export function shopifyWebhookRoutes(db: Db) {
  const app = new Hono();

  app.post('/webhooks', async (c) => {
    const raw = await c.req.text();
    if (!verifyWebhookHmac(raw, c.req.header('x-shopify-hmac-sha256'))) {
      return c.json({ error: 'bad signature' }, 401);
    }
    const shop = c.req.header('x-shopify-shop-domain') ?? '';
    const topic = c.req.header('x-shopify-topic') ?? '';
    const payload = (JSON.parse(raw || '{}') as Record<string, unknown>) ?? {};
    try {
      await handleShopifyWebhook(db, shop, topic, payload);
    } catch (err) {
      // Still 200 after verified receipt — a handler bug is ours to fix,
      // not Shopify's to retry into a webhook-disable loop.
      console.error(`shopify webhook ${topic} ${shop}:`, err);
    }
    return c.json({ ok: true });
  });

  // Recovery-email unsubscribe — public, HMAC-signed per conversation
  // (the shopper-facing link in every recovery send). GET renders a
  // confirmation page; POST is the one-click action Gmail/Yahoo expect.
  const unsub = async (c: Context) => {
    const convId = c.req.query('c') ?? '';
    const sig = c.req.query('t') ?? '';
    if (!convId || !verifyRecoveryUnsub(convId, sig)) {
      return c.html('<p style="font-family:sans-serif">Invalid unsubscribe link.</p>', 400);
    }
    const [conv] = await db
      .select({ contactId: conversations.contactId })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);
    if (conv?.contactId) {
      const [contact] = await db
        .select({ id: contacts.id, metadata: contacts.metadata })
        .from(contacts)
        .where(eq(contacts.id, conv.contactId))
        .limit(1);
      if (contact) {
        await db
          .update(contacts)
          .set({
            metadata: {
              ...((contact.metadata as Record<string, unknown>) ?? {}),
              recovery_unsubscribed: true,
            },
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, contact.id));
      }
    }
    return c.html(
      '<div style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center">' +
        '<h2>Unsubscribed</h2><p>You won\'t receive cart reminder emails anymore.</p></div>',
    );
  };
  app.get('/recovery-unsubscribe', unsub);
  app.post('/recovery-unsubscribe', unsub);

  return app;
}

/** api/shopify — console-authed link management. */
export function shopifyApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // Shops bound to this workspace (the link flow + future settings UI).
  app.get('/shops', async (c) => {
    const rows = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.workspaceId, c.get('workspaceId')));
    return c.json({
      shops: rows.map((r) => ({
        id: r.id,
        shop: r.shop,
        agent_id: r.agentId,
        state: r.state,
        billing: shopBilling(r),
        created_at: r.createdAt,
      })),
    });
  });

  /* ── Billing rail (Phase 5) — the bound shop's AppSubscription drives
     workspaces.plan; Stripe stays untouched on non-shopify workspaces. ── */

  app.get('/billing', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db
      .select({ billingProvider: workspaces.billingProvider, plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(and(eq(shopifyShops.workspaceId, workspaceId), eq(shopifyShops.state, 'linked')))
      .limit(1);
    return c.json({
      provider: ws?.billingProvider ?? 'stripe',
      plan: ws?.plan ?? 'free',
      shop: row ? { id: row.id, shop: row.shop, subscription: shopBilling(row) } : null,
      test_mode: row ? await shopIsDevelopment(db, row) : false,
    });
  });

  app.post(
    '/billing/start',
    adminOnly,
    zValidator('json', z.object({ plan: z.enum(['starter', 'pro', 'scale']) })),
    async (c) => {
      const { plan } = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(and(eq(shopifyShops.workspaceId, c.get('workspaceId')), eq(shopifyShops.state, 'linked')))
        .limit(1);
      if (!row) return c.json({ error: 'no linked Shopify shop — connect a store first' }, 409);
      try {
        const { confirmationUrl, test } = await startBillingSubscription(db, row, plan);
        return c.json({ confirmation_url: confirmationUrl, test_mode: test });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : 'billing start failed' }, 502);
      }
    },
  );

  // What the link-code points at — the link page shows the shop domain
  // before the admin picks an agent to serve it.
  app.get('/link-info', adminOnly, async (c) => {
    const v = verifyLinkCode(c.req.query('code') ?? '');
    if (!v) return c.json({ error: 'invalid or expired link code' }, 400);
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, v.shopId)).limit(1);
    if (!row) return c.json({ error: 'shop not found' }, 404);
    return c.json({
      shop: row.shop,
      state: row.state,
      // An already-bound shop re-linking needs a conscious confirm in the UI.
      bound_agent_id: row.agentId,
    });
  });

  app.post(
    '/link',
    adminOnly,
    zValidator('json', z.object({ code: z.string(), agent_id: z.string() })),
    async (c) => {
      const { code, agent_id } = c.req.valid('json');
      const v = verifyLinkCode(code);
      if (!v) return c.json({ error: 'invalid or expired link code' }, 400);
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(eq(shopifyShops.id, v.shopId))
        .limit(1);
      if (!row) return c.json({ error: 'shop not found' }, 404);
      if (!row.accessTokenEnc) {
        return c.json({ error: 'shop has no install token — reload the app in Shopify admin first' }, 409);
      }
      const workspaceId = c.get('workspaceId');
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agent_id), eq(agents.workspaceId, workspaceId)))
        .limit(1);
      if (!agent) return c.json({ error: 'agent not found' }, 404);

      await bindShop(db, row, { workspaceId, agentId: agent_id });
      return c.json({ ok: true, shop: row.shop });
    },
  );

  // Claim a provisioned workspace — a zero-login install created the shop's
  // workspace ownerless; the merchant opens the signed claim link while
  // signed in to Janis and becomes admin + owner of it. sessionAuth only
  // (not adminOnly): the claimant's role in their *current* workspace is
  // irrelevant — the link code is the credential, same as the link flow.
  app.post(
    '/claim',
    zValidator('json', z.object({ code: z.string() })),
    async (c) => {
      const { code } = c.req.valid('json');
      const v = verifyLinkCode(code);
      if (!v) return c.json({ error: 'invalid or expired claim link' }, 400);
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(eq(shopifyShops.id, v.shopId))
        .limit(1);
      if (!row) return c.json({ error: 'shop not found' }, 404);
      if (row.state !== 'linked' || !row.workspaceId) {
        return c.json({ error: 'shop is not bound to a workspace — nothing to claim' }, 409);
      }

      const user = c.get('user');
      // Idempotent — repeat claims just keep you a member.
      await db
        .insert(memberships)
        .values({
          userId: user.id,
          workspaceId: row.workspaceId,
          role: 'admin',
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();
      // Take ownership of an ownerless (provisioned) workspace; a workspace
      // that already has an owner just gains another admin.
      const [ws] = await db
        .select({ ownerUserId: workspaces.ownerUserId, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId))
        .limit(1);
      if (ws && !ws.ownerUserId) {
        await db
          .update(workspaces)
          .set({ ownerUserId: user.id })
          .where(eq(workspaces.id, row.workspaceId));
      }
      await audit(db, {
        workspaceId: row.workspaceId,
        userId: user.id,
        userName: user.name,
        action: 'shopify.claim',
        targetType: 'shopify_shop',
        targetId: row.id,
        meta: { shop: row.shop },
      });
      return c.json({
        ok: true,
        shop: row.shop,
        workspace_id: row.workspaceId,
        workspace: ws?.name ?? null,
        agent_id: row.agentId,
      });
    },
  );

  app.post(
    '/unlink',
    adminOnly,
    zValidator('json', z.object({ shop_id: z.string() })),
    async (c) => {
      const { shop_id } = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(
          and(eq(shopifyShops.id, shop_id), eq(shopifyShops.workspaceId, c.get('workspaceId'))),
        )
        .limit(1);
      if (!row) return c.json({ error: 'shop not found' }, 404);
      await unbindShop(db, row);
      return c.json({ ok: true });
    },
  );

  return app;
}
