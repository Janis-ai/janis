// Provider webhooks — reverse sync for filed tickets. At OAuth-connect we
// register a webhook on the customer's Linear org / Jira site (per-
// connection secret); when engineering moves the issue to a terminal state
// the filing conversation gets a customer-visible update — "your ticket
// JAN-9 was marked Done". Registration is best-effort at connect time;
// the receiver verifies, dedupes, and posts.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentConnections, agents, conversations, messages } from '../db/schema.js';
import { connectionCreds, type ConnRow } from '../lib/connections.js';
import { encryptSecret } from '../lib/secrets.js';
import { bus } from '../lib/bus.js';
import { toMessage } from '../lib/serializers.js';

const TERMINAL_LINEAR = new Set(['completed', 'canceled']);

/** Register the issue-state webhook on the customer's org at connect time —
 *  per-connection secret lives encrypted in creds. Idempotent: a stored
 *  webhook_secret means it's already registered (reconnects don't pile up). */
export async function registerIssueWebhook(
  db: Db,
  conn: ConnRow,
  accessToken: string,
  apiBase: string,
): Promise<void> {
  const creds = connectionCreds(conn);
  if (creds.webhook_secret) return;
  const secret = randomBytes(24).toString('hex');
  let webhookId: string | undefined;
  if (conn.provider === 'linear') {
    const url = `${apiBase}/webhooks/linear/${conn.agentId}`;
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'mutation($i:WebhookCreateInput!){webhookCreate(input:$i){success webhook{id}}}',
        variables: {
          i: { url, secret, resourceTypes: ['Issue'], allPublicTeams: true },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const d = (await res.json().catch(() => null)) as {
      data?: { webhookCreate?: { success?: boolean; webhook?: { id?: string } } };
    } | null;
    if (!d?.data?.webhookCreate?.success) {
      throw new Error(`linear webhookCreate failed: ${JSON.stringify(d).slice(0, 200)}`);
    }
    webhookId = d.data.webhookCreate.webhook?.id;
  } else if (conn.provider === 'jira') {
    if (!creds.cloud_id) return;
    const url = `${apiBase}/webhooks/jira/${conn.agentId}/${secret}`;
    const res = await fetch(
      `https://api.atlassian.com/ex/jira/${creds.cloud_id}/rest/api/3/webhook`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url,
          webhooks: [
            { jqlFilter: '', events: ['jira:issue_updated', 'jira:issue_deleted'] },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const d = (await res.json().catch(() => null)) as
      | { createdWebhookId?: number; errors?: unknown[] }[]
      | null;
    if (!res.ok || !Array.isArray(d) || d[0]?.errors || d[0]?.createdWebhookId == null) {
      throw new Error(`jira webhook register failed: ${JSON.stringify(d).slice(0, 200)}`);
    }
    webhookId = String(d[0].createdWebhookId);
  } else {
    return;
  }
  const next = { ...creds, webhook_secret: secret, webhook_id: webhookId };
  await db
    .update(agentConnections)
    .set({ credentialsEnc: encryptSecret(JSON.stringify(next)) })
    .where(eq(agentConnections.id, conn.id));
}

/** Conversations on this agent that filed/lookup'd the issue — the create
 *  tool's result bakes the identifier into message payloads. */
async function filingConversations(
  db: Db,
  agentId: string,
  identifier: string,
): Promise<{ id: string }[]> {
  return db
    .selectDistinct({ id: conversations.id })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.agentId, agentId),
        sql`${messages.payload}::text LIKE ${'%' + identifier + '%'}`,
      ),
    )
    .limit(10);
}

/** Post the "ticket closed" note once per conversation — dedupes on the
 *  closed_ticket stamp so repeated update events don't spam the thread. */
async function postTicketClosed(
  db: Db,
  workspaceId: string,
  agentId: string,
  identifier: string,
  title: string,
  stateName: string,
): Promise<number> {
  const convs = await filingConversations(db, agentId, identifier);
  const text = `Your ticket ${identifier} "${title}" was marked ${stateName} by our team — nice to close the loop on that one.`;
  let posted = 0;
  for (const c of convs) {
    const dupe = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, c.id),
          sql`${messages.payload}->>'closed_ticket' = ${identifier}`,
        ),
      )
      .limit(1);
    if (dupe.length) continue;
    const [row] = await db
      .insert(messages)
      .values({
        conversationId: c.id,
        direction: 'out',
        text,
        payload: { via: 'webhook', event: 'ticket closed', closed_ticket: identifier },
      })
      .returning();
    await db
      .update(conversations)
      .set({
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 160),
        lastMessageDirection: 'out',
      })
      .where(eq(conversations.id, c.id));
    bus.publish(workspaceId, { type: 'message', data: toMessage(row) });
    posted++;
  }
  return posted;
}

async function connFor(db: Db, agentId: string, provider: string) {
  const [conn] = await db
    .select()
    .from(agentConnections)
    .where(
      and(eq(agentConnections.agentId, agentId), eq(agentConnections.provider, provider)),
    )
    .limit(1);
  return conn;
}

export function providerWebhookRoutes(db: Db) {
  const app = new Hono();

  // Linear signs deliveries: linear-signature = hex HMAC-SHA256(body, secret).
  app.post('/linear/:agentId', async (c) => {
    const conn = await connFor(db, c.req.param('agentId'), 'linear');
    const secret = conn ? connectionCreds(conn).webhook_secret : undefined;
    if (!conn || !secret) return c.json({ error: 'unknown webhook' }, 404);
    const raw = await c.req.text();
    const expect = createHmac('sha256', secret).update(raw).digest('hex');
    const got = c.req.header('linear-signature') ?? '';
    if (got.length !== expect.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expect))) {
      return c.json({ error: 'bad signature' }, 401);
    }
    const ev = JSON.parse(raw) as {
      action?: string;
      type?: string;
      data?: {
        identifier?: string;
        title?: string;
        state?: { name?: string; type?: string };
      };
      updatedFrom?: Record<string, unknown>;
    };
    // Only a real state transition into a terminal state posts — Linear
    // fires Issue.update on every field change.
    const st = ev.data?.state;
    if (
      ev.type === 'Issue' &&
      ev.action === 'update' &&
      ev.updatedFrom &&
      'stateId' in ev.updatedFrom &&
      st?.type &&
      TERMINAL_LINEAR.has(st.type) &&
      ev.data?.identifier
    ) {
      const n = await postTicketClosed(
        db,
        conn.workspaceId,
        conn.agentId,
        ev.data.identifier,
        ev.data.title ?? '',
        st.name ?? 'Done',
      );
      return c.json({ posted: n });
    }
    return c.json({ skipped: true });
  });

  // Jira doesn't sign webhooks — the per-connection URL token is the auth.
  app.post('/jira/:agentId/:token', async (c) => {
    const conn = await connFor(db, c.req.param('agentId'), 'jira');
    const secret = conn ? connectionCreds(conn).webhook_secret : undefined;
    if (!conn || !secret || secret !== c.req.param('token')) {
      return c.json({ error: 'bad token' }, 401);
    }
    const ev = (await c.req.json().catch(() => null)) as {
      webhookEvent?: string;
      issue?: {
        key?: string;
        fields?: {
          summary?: string;
          status?: { name?: string; statusCategory?: { key?: string } };
        };
      };
      changelog?: { items?: { field?: string }[] };
    } | null;
    const status = ev?.issue?.fields?.status;
    const statusChanged = ev?.changelog?.items?.some((i) => i.field === 'status');
    const deleted = ev?.webhookEvent === 'jira:issue_deleted';
    if (
      ev?.issue?.key &&
      (deleted || (statusChanged && status?.statusCategory?.key === 'done'))
    ) {
      const n = await postTicketClosed(
        db,
        conn.workspaceId,
        conn.agentId,
        ev.issue.key,
        ev.issue.fields?.summary ?? '',
        deleted ? 'deleted' : status?.name ?? 'Done',
      );
      return c.json({ posted: n });
    }
    return c.json({ skipped: true });
  });

  return app;
}
