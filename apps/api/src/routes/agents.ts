import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AgentConfig } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, agentConnections, agentSecrets, channels, conversations, knowledgeFiles, webhookDeliveries, workspaces } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { generateApiKey, generateWebhookSecret } from '../lib/crypto.js';
import { env } from '../env.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { extractKnowledgeText, UnsupportedFileError } from '../lib/knowledge.js';
import {
  detectKnowledgeGaps,
  draftKnowledgeEntry,
  gapsCacheFresh,
  listLearnNotes,
  markGapsAdded,
  readGapsCache,
  recheckGaps,
} from '../services/knowledgeGaps.js';
import { encryptSecret } from '../lib/secrets.js';
import { llmFor } from '../lib/hostedAgent.js';
import { meteredAccounts } from '../lib/llm.js';
import { processEvents } from '../services/ingest.js';
import { toAgent } from '../lib/serializers.js';
import { invalidateChannelCache } from '../lib/channels.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';
import { connectionToken } from '../lib/connections.js';
import {
  createSlackChannel,
  getInstallation,
  inviteWorkspaceMembers,
  sanitizeChannelName,
  slackChannelInfo,
} from '../lib/slack.js';

const createAgent = z.object({
  name: z.string().min(1).max(120),
  webhook_url: z.string().url().optional(),
  hosted: z.boolean().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).optional(),
});
const updateAgent = z.object({
  name: z.string().min(1).max(120).optional(),
  webhook_url: z.string().url().nullable().optional(),
  hosted: z.boolean().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).nullable().optional(),
  // null clears the override back to the workspace alert channel
  slack_channel_id: z.string().nullable().optional(),
  config: AgentConfig.optional(),
});

export function agentRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, c.get('workspaceId')))
      .orderBy(desc(agents.createdAt));
    return c.json({ agents: rows.map(toAgent) });
  });

  app.post('/', adminOnly, zValidator('json', createAgent), async (c) => {
    const body = c.req.valid('json');
    // Agency children ride on the parent's plan but can't grow the fleet —
    // new agents need a subscription of their own (or the parent's help).
    const [ws] = await db
      .select({
        parentWorkspaceId: workspaces.parentWorkspaceId,
        parentContact: workspaces.parentContact,
        stripeSubscriptionId: workspaces.stripeSubscriptionId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, c.get('workspaceId')))
      .limit(1);
    if (ws?.parentWorkspaceId && !ws.stripeSubscriptionId) {
      const [parent] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, ws.parentWorkspaceId))
        .limit(1);
      return c.json(
        {
          error: `This account is covered by ${parent?.name ?? 'an agency plan'}. Contact ${ws.parentContact ?? 'your account administrator'} to add agents, or subscribe to your own plan.`,
          covered_by: parent?.name,
          contact: ws.parentContact,
        },
        402,
      );
    }
    const [row] = await db
      .insert(agents)
      .values({
        workspaceId: c.get('workspaceId'),
        name: body.name,
        // no API key until the operator generates one — hosted agents never call /v1
        webhookSecret: generateWebhookSecret(),
        webhookUrl: body.webhook_url ?? null,
        hosted: body.hosted ?? false,
        autoResumeMinutes: body.auto_resume_minutes ?? 10,
      })
      .returning();
    // Give the agent its own Slack alert channel (#janis-{name}) when the
    // workspace is connected — best-effort: failures just fall back to the
    // workspace channel.
    const inst = await getInstallation(db, c.get('workspaceId'));
    if (inst) {
      const slug = sanitizeChannelName(`janis-${row.name}`) || 'janis-agent';
      const { channel } = await createSlackChannel(inst, slug);
      if (channel) {
        await db
          .update(agents)
          .set({ slackChannelId: channel.id })
          .where(eq(agents.id, row.id));
        row.slackChannelId = channel.id;
        void inviteWorkspaceMembers(db, inst, channel.id);
      }
    }
    return c.json({ agent: toAgent(row) }, 201);
  });

  app.patch('/:id', adminOnly, zValidator('json', updateAgent), async (c) => {
    const body = c.req.valid('json');
    // A non-null override must be a real channel — otherwise alerts would
    // silently fail to post.
    const inst = body.slack_channel_id
      ? await getInstallation(db, c.get('workspaceId'))
      : undefined;
    if (body.slack_channel_id && inst) {
      const info = await slackChannelInfo(inst.botToken, body.slack_channel_id);
      if (!info) return c.json({ error: 'channel not found in Slack' }, 400);
      if (info.isArchived) return c.json({ error: 'that channel is archived' }, 400);
    }
    let configToSave = body.config;
    // llm.api_key is write-only — reads return key_set instead. Merge so a
    // config save doesn't wipe the key: undefined/'' keep, null clears,
    // a real string replaces.
    if (body.config?.llm) {
      const [existing] = await db
        .select({ config: agents.config })
        .from(agents)
        .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
        .limit(1);
      const storedKey =
        (((existing?.config ?? {}) as { llm?: { api_key?: string } }).llm?.api_key as string) ?? '';
      const { key_set: _ignored, ...llm } = body.config.llm;
      if (llm.api_key === null) delete llm.api_key;
      else if (!llm.api_key) llm.api_key = storedKey || undefined;
      configToSave = { ...body.config, llm };
    }
    const [row] = await db
      .update(agents)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.webhook_url !== undefined ? { webhookUrl: body.webhook_url } : {}),
        ...(body.hosted !== undefined ? { hosted: body.hosted } : {}),
        ...(body.auto_resume_minutes !== undefined
          ? { autoResumeMinutes: body.auto_resume_minutes }
          : {}),
        ...(body.slack_channel_id !== undefined
          ? { slackChannelId: body.slack_channel_id }
          : {}),
        ...(configToSave !== undefined ? { config: configToSave } : {}),
      })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    // New alert channel → every member needs to be in it to see/act on alerts.
    if (body.slack_channel_id && inst) {
      void inviteWorkspaceMembers(db, inst, body.slack_channel_id);
    }
    return c.json({ agent: toAgent(row) });
  });

  // Live model list from an OpenAI-compatible endpoint. metered (or no
  // override) resolves env; otherwise fetches base_url/models with the
  // caller's key — or the stored key when the endpoint matches what's saved.
  // The env key is never sent to a non-env base_url.
  app.post(
    '/:id/llm-models',
    adminOnly,
    zValidator(
      'json',
      z.object({
        base_url: z.string().optional(),
        api_key: z.string().optional(),
        metered: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      let baseUrl = (body.base_url ?? '').replace(/\/+$/, '');
      let apiKey = body.api_key ?? '';
      if (body.metered || (!baseUrl && !apiKey)) {
        // Every configured metered account — the picker shows the catalog
        // filtered to vendors Janis actually has keys for.
        const accs = meteredAccounts();
        if (!accs.length) {
          return c.json({ accounts: [], models: [], error: 'no metered provider configured' });
        }
        const accounts = await Promise.all(
          accs.map(async (a) => {
            try {
              const res = await fetch(`${a.baseUrl}/models`, {
                headers: a.apiKey ? { authorization: `Bearer ${a.apiKey}` } : {},
                signal: AbortSignal.timeout(8000),
              });
              if (!res.ok) {
                return { vendor: a.vendor, base_url: a.baseUrl, models: [], error: `provider returned ${res.status}` };
              }
              const data = (await res.json()) as { data?: { id?: string }[] };
              return {
                vendor: a.vendor,
                base_url: a.baseUrl,
                models: (data.data ?? [])
                  .map((m) => m.id)
                  .filter((s): s is string => Boolean(s))
                  .sort(),
              };
            } catch (e) {
              return {
                vendor: a.vendor,
                base_url: a.baseUrl,
                models: [] as string[],
                error: e instanceof Error ? e.message : 'fetch failed',
              };
            }
          }),
        );
        // models/base_url kept for older clients — the default account's
        return c.json({ accounts, models: accounts[0].models, base_url: accounts[0].base_url });
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        return c.json({ models: [], error: 'base_url must be an http(s) URL' }, 400);
      }
      if (!apiKey) {
        const [row] = await db
          .select({ config: agents.config })
          .from(agents)
          .where(
            and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))),
          )
          .limit(1);
        const stored =
          (((row?.config ?? {}) as { llm?: { api_key?: string; base_url?: string } }).llm) ?? {};
        if (stored.base_url === body.base_url && stored.api_key) apiKey = stored.api_key;
      }
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return c.json({ models: [], error: `provider returned ${res.status}` });
        const data = (await res.json()) as { data?: { id?: string }[] };
        const models = (data.data ?? [])
          .map((m) => m.id)
          .filter((s): s is string => Boolean(s))
          .sort();
        // base_url tells the UI which provider catalog applies to 'metered'
        return c.json({ models, base_url: baseUrl });
      } catch (e) {
        return c.json({ models: [], error: e instanceof Error ? e.message : 'fetch failed' });
      }
    },
  );

  app.post('/:id/rotate-key', adminOnly, async (c) => {
    const { key, hash, preview } = generateApiKey();
    const [row] = await db
      .update(agents)
      .set({ apiKeyHash: hash, apiKeyPreview: preview })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), api_key: key });
  });

  app.post('/:id/rotate-webhook-secret', adminOnly, async (c) => {
    const secret = generateWebhookSecret();
    const [row] = await db
      .update(agents)
      .set({ webhookSecret: secret })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), webhook_secret: secret });
  });

  app.post('/:id/webhook-test', adminOnly, async (c) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (!row.webhookUrl && !row.hosted) {
      return c.json({ error: 'no webhook_url configured' }, 400);
    }
    await deliverWebhook(db, row, 'message.human', {
      conversation_id: 'webhook-test',
      janis_conversation_id: 'webhook-test',
      text: 'Janis webhook test — if you received this, your endpoint works.',
    });
    return c.json({ ok: true });
  });

  // Get-or-create the console test-chat channel — a webchat channel flagged
  // internal so it stays out of Integrations, but messages ride the real
  // /chat pipeline (ingest → agent → reply), so testing exercises exactly
  // what a visitor would hit, including handoffs. Any member may test.
  app.post('/:id/test-channel', async (c) => {
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [existing] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.agentId, agent.id),
          eq(channels.kind, 'webchat'),
          sql`${channels.credentials}->>'internal' = 'true'`,
        ),
      )
      .limit(1);
    if (existing) return c.json({ channel_id: existing.id, agent_name: agent.name });
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        kind: 'webchat',
        name: `Test — ${agent.name}`,
        credentials: { internal: true },
      })
      .returning();
    invalidateChannelCache();
    return c.json({ channel_id: ch.id, agent_name: agent.name }, 201);
  });

  // Reveal the webhook secret (needed to verify signatures agent-side)
  app.get('/:id/webhook-secret', adminOnly, async (c) => {
    const [row] = await db
      .select({ webhookSecret: agents.webhookSecret })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ webhook_secret: row.webhookSecret });
  });

  // Recent outbound webhook deliveries — for debugging agent wiring
  app.get('/:id/deliveries', async (c) => {
    const [owned] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.agentId, owned.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(20);
    return c.json({
      deliveries: rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        attempts: r.attempts,
        last_error: r.lastError,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  // Test chat — try the agent without wiring a channel. One test conversation
  // per operator per agent.
  app.post(
    '/:id/chat',
    zValidator('json', z.object({ text: z.string().min(1) })),
    async (c) => {
      const user = c.get('user');
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
        .limit(1);
      if (!agent) return c.json({ error: 'not found' }, 404);

      const externalId = `webtest:${user.id}`;
      const { text } = c.req.valid('json');
      await processEvents(db, agent, [
        {
          type: 'message_in',
          conversation_id: externalId,
          text,
          user: { name: user.name, id: user.email },
        },
      ]);
      const [conv] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, externalId)))
        .limit(1);
      if (conv && conv.state !== 'human') {
        await deliverWebhook(db, agent, 'message.user', {
          conversation_id: externalId,
          janis_conversation_id: conv.id,
          text,
        });
      }
      return c.json({ conversation_id: conv?.id ?? null, state: conv?.state ?? null });
    },
  );

  const ownedAgent = async (c: {
    req: { param: (k: string) => string };
    get: (k: 'workspaceId') => string;
  }) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    return row ?? null;
  };

  // Knowledge files — uploaded docs whose extracted text feeds the agent's prompt
  app.get('/:id/knowledge', async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, c.req.param('id')))
      .orderBy(desc(knowledgeFiles.createdAt));
    return c.json({
      files: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime_type: r.mimeType,
        size_bytes: r.sizeBytes,
        chars: r.text.length,
        status: r.status,
        error: r.error,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.post('/:id/knowledge', adminOnly, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agent.id));
    if (count >= 50) return c.json({ error: 'knowledge file limit reached (50)' }, 409);

    const buf = Buffer.from(await file.arrayBuffer());
    let text: string;
    try {
      text = await extractKnowledgeText(buf, file.type, file.name, llmFor(agent));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'extraction failed';
      return c.json({ error: msg }, err instanceof UnsupportedFileError ? 415 : 422);
    }

    const [row] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        text,
      })
      .returning();
    return c.json(
      {
        file: {
          id: row.id,
          name: row.name,
          mime_type: row.mimeType,
          size_bytes: row.sizeBytes,
          chars: row.text.length,
          status: row.status,
          created_at: row.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  // Knowledge-gap loop: clusters of conversations where the agent asked for a
  // human — the recurring questions it's failing on. Operator drafts → edits →
  // approves; approved entries land in config.knowledge (prompt-visible).
  // Detection is cached on the agent (gaps_cache): recompute only when stale
  // or explicitly refreshed — otherwise every page load re-rolled the LLM
  // merge and the gap list visibly flickered.
  const computeAndCacheGaps = async (agent: typeof agents.$inferSelect) => {
    const gaps = await detectKnowledgeGaps(db, agent.id);
    const cache = { at: new Date().toISOString(), gaps };
    await db
      .update(agents)
      .set({
        config: { ...((agent.config ?? {}) as Record<string, unknown>), gaps_cache: cache },
      })
      .where(eq(agents.id, agent.id));
    return cache;
  };

  app.get('/:id/knowledge-gaps', async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cached = readGapsCache(agent.config);
    const cache = gapsCacheFresh(cached) ? cached! : await computeAndCacheGaps(agent);
    const learnings = await listLearnNotes(db, agent.id);
    return c.json({ gaps: cache.gaps, learnings, computed_at: cache.at });
  });

  // Force a fresh detection run — the operator's "Refresh" button.
  app.post('/:id/knowledge-gaps/refresh', adminOnly, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cache = await computeAndCacheGaps(agent);
    return c.json({ gaps: cache.gaps, computed_at: cache.at });
  });

  app.post(
    '/:id/knowledge-gaps/draft', adminOnly, zValidator(
      'json',
      z.object({
        questions: z.array(z.string().min(1)).min(1).max(10),
        resolutions: z.array(z.string()).max(5).default([]),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { questions, resolutions } = c.req.valid('json');
      const draft = await draftKnowledgeEntry(db, agent, questions, resolutions);
      return c.json({ draft });
    },
  );

  // Re-check clusters against the current knowledge base — the LLM marks
  // questions the agent can now handle; covered clusters are dismissed so
  // they stop surfacing.
  app.post('/:id/knowledge-gaps/recheck', adminOnly, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    // Audit the same clusters the operator sees — the cached set, not a fresh roll.
    const clusters = readGapsCache(agent.config)?.gaps ?? (await computeAndCacheGaps(agent)).gaps;
    const covered = await recheckGaps(db, agent, clusters);
    if (covered.length) {
      const cfg = (agent.config ?? {}) as Record<string, unknown> & {
        dismissed_gaps?: string[];
      };
      const dismissed = new Set(cfg.dismissed_gaps ?? []);
      for (const k of covered) {
        dismissed.add(k);
        // store every phrasing too — a reclustered group keeps all dismissed
        // variants and stays hidden until a genuinely new phrasing appears
        for (const q of clusters.find((cl) => cl.key === k)?.questions ?? []) {
          dismissed.add(q.toLowerCase().slice(0, 60));
        }
      }
      await db
        .update(agents)
        .set({ config: { ...cfg, dismissed_gaps: [...dismissed] } })
        .where(eq(agents.id, agent.id));
    }
    return c.json({ covered });
  });

  // Approve an entry — append to config.knowledge without clobbering other keys.
  app.post(
    '/:id/knowledge-gaps', adminOnly, zValidator('json', z.object({ entry: z.string().min(1).max(2000) })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const cfg = (agent.config ?? {}) as Record<string, unknown> & { knowledge?: string[] };
      const entry = c.req.valid('json').entry.trim();
      const knowledge = cfg.knowledge ?? [];
      if (!knowledge.includes(entry)) knowledge.push(entry);
      // Keep the cached gap set stable — only its "added" flags move, so the
      // page shows the approved cluster as covered instead of re-rolling.
      const cache = readGapsCache(agent.config);
      const gaps_cache = cache ? { ...cache, gaps: markGapsAdded(cache.gaps, knowledge) } : undefined;
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, knowledge, ...(gaps_cache ? { gaps_cache } : {}) } })
        .where(eq(agents.id, agent.id))
        .returning();
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Agent secrets — API keys/credentials for tool calls. Write-only: the
  // list endpoint returns names + timestamps, never values.
  app.get('/:id/secrets', async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({ name: agentSecrets.name, createdAt: agentSecrets.createdAt })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, c.req.param('id')))
      .orderBy(agentSecrets.name);
    return c.json({
      secrets: rows.map((r) => ({ name: r.name, created_at: r.createdAt.toISOString() })),
    });
  });

  const secretBody = z.object({
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'letters, digits, underscores — start with a letter'),
    value: z.string().min(1).max(4096),
  });

  app.put('/:id/secrets', adminOnly, zValidator('json', secretBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { name, value } = c.req.valid('json');
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, agent.id));
    const [existing] = await db
      .select({ id: agentSecrets.id })
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.name, name)))
      .limit(1);
    if (!existing && count >= 50) return c.json({ error: 'secret limit reached (50)' }, 409);

    const valueEnc = encryptSecret(value);
    const [row] = existing
      ? await db
          .update(agentSecrets)
          .set({ valueEnc, updatedAt: new Date() })
          .where(eq(agentSecrets.id, existing.id))
          .returning()
      : await db
          .insert(agentSecrets)
          .values({ workspaceId: agent.workspaceId, agentId: agent.id, name, valueEnc })
          .returning();
    return c.json({ secret: { name: row.name, created_at: row.createdAt.toISOString() } });
  });

  app.delete('/:id/secrets/:name', adminOnly, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .delete(agentSecrets)
      .where(
        and(
          eq(agentSecrets.agentId, c.req.param('id')),
          eq(agentSecrets.name, c.req.param('name')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Predefined connections — install a catalog template's tools + store its
  // credentials as agent secrets in one shot. Tools merge by name so
  // reinstalling updates rather than duplicating.
  app.post(
    '/:id/tools/install', adminOnly, zValidator(
      'json',
      z.object({
        template: z.string(),
        fields: z.record(z.string(), z.string()).default({}),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { template, fields } = c.req.valid('json');
      const tpl = TOOL_TEMPLATES.find((t) => t.id === template);
      if (!tpl) return c.json({ error: 'unknown template' }, 404);
      const missing = tpl.fields.filter((f) => !fields[f.key]?.trim()).map((f) => f.label);
      if (missing.length) return c.json({ error: `missing: ${missing.join(', ')}` }, 400);

      // OAuth templates: store the credentials and mint a token now so a bad
      // client_id/secret fails at connect time, not during a conversation.
      if (tpl.connection) {
        const { provider } = tpl.connection;
        const creds = tpl.connection.credentials(fields);
        const [conn] = await db
          .insert(agentConnections)
          .values({
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            provider,
            label: tpl.connection.label(fields),
            credentialsEnc: encryptSecret(JSON.stringify(creds)),
          })
          .onConflictDoUpdate({
            target: [agentConnections.agentId, agentConnections.provider],
            set: {
              label: tpl.connection.label(fields),
              credentialsEnc: encryptSecret(JSON.stringify(creds)),
              accessTokenEnc: null,
              expiresAt: null,
              updatedAt: new Date(),
            },
          })
          .returning();
        try {
          await connectionToken(db, conn);
        } catch (err) {
          await db.delete(agentConnections).where(eq(agentConnections.id, conn.id));
          return c.json(
            { error: `could not authenticate with ${tpl.name}: ${(err as Error).message}` },
            400,
          );
        }
      }

      for (const [name, value] of Object.entries(tpl.secrets(fields))) {
        const err = await upsertAgentSecret(db, agent.id, agent.workspaceId, name, value);
        if (err) return c.json({ error: err }, 409);
      }
      const cfg = (agent.config ?? {}) as AgentConfig;
      const names = new Set(tpl.tools.map((t) => t.name));
      const tools = [...(cfg.tools ?? []).filter((t) => !names.has(t.name)), ...tpl.tools];
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, tools } })
        .where(eq(agents.id, agent.id))
        .returning();
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Remove a template's tools; secrets stay (they may be shared with custom tools).
  app.delete('/:id/tools/:template', adminOnly, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const tpl = TOOL_TEMPLATES.find((t) => t.id === c.req.param('template'));
    if (!tpl) return c.json({ error: 'unknown template' }, 404);
    if (tpl.connection) {
      await db
        .delete(agentConnections)
        .where(
          and(
            eq(agentConnections.agentId, agent.id),
            eq(agentConnections.provider, tpl.connection.provider),
          ),
        );
    }
    const cfg = (agent.config ?? {}) as AgentConfig;
    const names = new Set(tpl.tools.map((t) => t.name));
    const tools = (cfg.tools ?? []).filter((t) => !names.has(t.name));
    const [updated] = await db
      .update(agents)
      .set({ config: { ...cfg, tools } })
      .where(eq(agents.id, agent.id))
      .returning();
    return c.json({ agent: toAgent(updated) });
  });

  app.delete('/:id/knowledge/:fileId', adminOnly, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .delete(knowledgeFiles)
      .where(
        and(eq(knowledgeFiles.id, c.req.param('fileId')), eq(knowledgeFiles.agentId, c.req.param('id'))),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/:id', adminOnly, async (c) => {
    const [row] = await db
      .delete(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** Insert or rotate an agent secret. Returns an error string on the cap. */
async function upsertAgentSecret(
  db: Db,
  agentId: string,
  workspaceId: string,
  name: string,
  value: string,
): Promise<string | null> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId));
  const [existing] = await db
    .select({ id: agentSecrets.id })
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)))
    .limit(1);
  if (!existing && count >= 50) return 'secret limit reached (50)';
  const valueEnc = encryptSecret(value);
  if (existing) {
    await db
      .update(agentSecrets)
      .set({ valueEnc, updatedAt: new Date() })
      .where(eq(agentSecrets.id, existing.id));
  } else {
    await db.insert(agentSecrets).values({ workspaceId, agentId, name, valueEnc });
  }
  return null;
}
