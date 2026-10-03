import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agentTests,
  agents,
  evalSuggestions,
  conversations,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { agentRoutes } from './agents.js';

let app: Hono;
let db: Db;
let cookie: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/agents', agentRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'WS' }).returning();
  const [u] = await db.insert(users).values({ email: 'a@b.c', name: 'A' }).returning();
  await db.insert(memberships).values({
    userId: u.id,
    workspaceId: ws.id,
    role: 'admin',
    acceptedAt: new Date(),
  });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  cookie = `${SESSION_COOKIE}=${token}`;

  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot' })
    .returning();
  agentId = agent.id;
});

const get = async () =>
  app.request(`/api/agents/${agentId}/test-suggestions`, {
    headers: { cookie },
  });

const mkConv = async (externalId: string, name?: string) => {
  const [c] = await db
    .insert(conversations)
    .values({
      agentId,
      externalId,
      channel: 'webchat',
      userProfile: name ? { name } : {},
      lastMessageAt: new Date(),
    })
    .returning();
  return c.id;
};

describe('GET /:id/test-suggestions', () => {
  it('suggests a rescued conversation and hides it once tested or dismissed', async () => {
    // conv 1: a failure-flagged turn (model rescue marker)
    const convFlag = await mkConv('w1', 'Flag Cust');
    await db.insert(messages).values([
      { conversationId: convFlag, direction: 'in', text: 'help me' },
      {
        conversationId: convFlag,
        direction: 'out',
        text: 'bad reply',
        flags: { failure: true, help_requested: false, custom_alert: false, handoff_offer: false },
      },
    ]);
    // conv 2: an operator reply (non-internal human direction)
    const convHuman = await mkConv('w2', 'Human Cust');
    await db.insert(messages).values([
      { conversationId: convHuman, direction: 'in', text: 'refund?' },
      { conversationId: convHuman, direction: 'human', text: 'on it' },
    ]);
    // conv 3: internal note only — NOT a rescue
    const convNote = await mkConv('w3', 'Note Cust');
    await db.insert(messages).values([
      { conversationId: convNote, direction: 'in', text: 'hi' },
      {
        conversationId: convNote,
        direction: 'human',
        text: 'watch this one',
        payload: { internal: true },
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const { suggestions } = await res.json();
    const ids = suggestions.map((s: { conversation_id: string }) => s.conversation_id);
    expect(ids).toContain(convFlag);
    expect(ids).toContain(convHuman);
    expect(ids).not.toContain(convNote);
    const flagSug = suggestions.find(
      (s: { conversation_id: string }) => s.conversation_id === convFlag,
    );
    expect(flagSug.name).toBe('Flag Cust');
    expect(flagSug.rescues).toBe(1);

    // covered by a test → drops off the list
    await db.insert(agentTests).values({
      agentId,
      workspaceId: (await db.select({ wid: agents.workspaceId }).from(agents).where(eq(agents.id, agentId)))[0].wid,
      name: 't',
      expectation: '',
      turns: [],
      sourceConversationId: convFlag,
    });
    const res2 = await get();
    const ids2 = (await res2.json()).suggestions.map(
      (s: { conversation_id: string }) => s.conversation_id,
    );
    expect(ids2).not.toContain(convFlag);
    expect(ids2).toContain(convHuman);

    // dismissed via config → drops off
    await db
      .update(agents)
      .set({ config: { dismissed_test_suggestions: [convHuman] } as never })
      .where(eq(agents.id, agentId));
    const res3 = await get();
    const ids3 = (await res3.json()).suggestions.map(
      (s: { conversation_id: string }) => s.conversation_id,
    );
    expect(ids3).not.toContain(convHuman);
  });
});

describe('POST /:id/tests from a rescued conversation', () => {
  it('auto-drafts an expectation and clears the flag on edit', async () => {
    // BYOK config so llmFor resolves; the completion itself is stubbed.
    await db
      .update(agents)
      .set({ config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } } as never })
      .where(eq(agents.id, agentId));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Offers the returns portal link; never promises a refund.' } }],
        }),
      })),
    );

    const convId = await mkConv('draft-1', 'Draft Cust');
    await db.insert(messages).values([
      { conversationId: convId, direction: 'in', text: 'I want a refund' },
      {
        conversationId: convId,
        direction: 'out',
        text: 'sure, refunding now',
        flags: { failure: true, help_requested: false, custom_alert: false, handoff_offer: false },
      },
      { conversationId: convId, direction: 'human', text: 'I will handle this' },
    ]);

    const res = await app.request(`/api/agents/${agentId}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'draft test', conversation_id: convId }),
    });
    expect(res.status).toBe(201);
    const { tests } = await res.json();
    expect(tests.length).toBeGreaterThan(0);
    expect(tests[0].expectation).toContain('returns portal');
    expect(tests[0].expectation_draft).toBe(true);

    // Operator edit → draft flag clears.
    const patch = await app.request(`/api/agents/${agentId}/tests/${tests[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ expectation: 'Reviewed expectation' }),
    });
    expect(patch.status).toBe(200);
    const { test } = await patch.json();
    expect(test.expectation).toBe('Reviewed expectation');
    expect(test.expectation_draft).toBe(false);
  });
});

describe('eval-suggestions routes', () => {
  const wsId = async () =>
    (await db.select({ wid: agents.workspaceId }).from(agents).where(eq(agents.id, agentId)))[0].wid;

  const mkSuggestion = async (over: Partial<typeof evalSuggestions.$inferInsert> = {}) => {
    const [s] = await db
      .insert(evalSuggestions)
      .values({
        workspaceId: await wsId(),
        agentId,
        batchId: crypto.randomUUID(),
        kind: 'knowledge_gap',
        summary: 'reply lacked the new price',
        patch: { type: 'knowledge', entry: 'The Starter plan is $29/mo.' },
        verified: { pass_rate: 1, baseline_rate: 0.5, broke: 0 },
        ...over,
      })
      .returning();
    return s;
  };

  it('lists pending suggestions, applies a patch, and dismisses', async () => {
    const s = await mkSuggestion();
    const hyp = await mkSuggestion({ kind: 'hypothesis', patch: null, verified: null });

    const res = await app.request(`/api/agents/${agentId}/eval-suggestions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { suggestions } = await res.json();
    const ids = suggestions.map((x: { id: string }) => x.id);
    expect(ids).toContain(s.id);
    expect(ids).toContain(hyp.id);
    expect(suggestions.find((x: { id: string }) => x.id === s.id).kind).toBe('knowledge_gap');

    // hypothesis has no patch — apply 400s
    const badApply = await app.request(
      `/api/agents/${agentId}/eval-suggestions/${hyp.id}/apply`,
      { method: 'POST', headers: { cookie } },
    );
    expect(badApply.status).toBe(400);

    // knowledge patch applies to config.knowledge
    const apply = await app.request(
      `/api/agents/${agentId}/eval-suggestions/${s.id}/apply`,
      { method: 'POST', headers: { cookie } },
    );
    expect(apply.status).toBe(200);
    const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((a.config as { knowledge?: string[] }).knowledge).toContain('The Starter plan is $29/mo.');

    // decided rows leave the pending list; re-deciding 404s
    const res2 = await app.request(`/api/agents/${agentId}/eval-suggestions`, { headers: { cookie } });
    const ids2 = (await res2.json()).suggestions.map((x: { id: string }) => x.id);
    expect(ids2).not.toContain(s.id);
    expect(
      (await app.request(`/api/agents/${agentId}/eval-suggestions/${s.id}/apply`, {
        method: 'POST',
        headers: { cookie },
      })).status,
    ).toBe(404);

    const dis = await app.request(
      `/api/agents/${agentId}/eval-suggestions/${hyp.id}/dismiss`,
      { method: 'POST', headers: { cookie } },
    );
    expect(dis.status).toBe(200);
    const [row] = await db.select().from(evalSuggestions).where(eq(evalSuggestions.id, hyp.id));
    expect(row.status).toBe('dismissed');
  });
});
