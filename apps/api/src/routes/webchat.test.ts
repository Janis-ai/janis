import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, workspaces } from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Db;
let app: Hono;
let channelId: string;

const VISITOR_A = 'vis_aaaabbbbccccdddd';
const VISITOR_B = 'vis_eeeeffffgggghhhh';

const post = (text: string, visitor = VISITOR_A) =>
  app.request(`/chat/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitor, text }),
  });

beforeAll(async () => {
  // uploads land in a tmpdir, not the repo
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'janis-uploads-'));
  const { webchatRoutes } = await import('./webchat.js');
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/chat', webchatRoutes(db)); // mounted like production

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'Support Bot',
      apiKeyHash: hash,
      apiKeyPreview: preview,
      webhookUrl: 'https://agent.test/hook',
    })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'webchat',
      name: 'Acme website',
      credentials: { greeting: 'Hey there!' },
    })
    .returning();
  channelId = channel.id;
});

afterEach(() => vi.unstubAllGlobals());

describe('webchat widget endpoints', () => {
  it('bootstraps widget config without credentials', async () => {
    const res = await app.request(`/chat/${channelId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Acme website');
    expect(body.agent_name).toBe('Support Bot');
    expect(body.greeting).toBe('Hey there!');
    expect(body.credentials).toBeUndefined();
  });

  it('404s for unknown or non-webchat channel tokens', async () => {
    expect((await app.request('/chat/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const [meta] = await db
      .insert(channels)
      .values({
        workspaceId: (await db.select().from(workspaces))[0].id,
        agentId: (await db.select().from(agents))[0].id,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'p', access_token: 't' },
      })
      .returning();
    expect((await app.request(`/chat/${meta.id}`)).status).toBe(404);
  });

  it('ingests a visitor message into a conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const res = await post('hello from the website');
    expect(res.status).toBe(200);

    const [conv] = await db.select().from(conversations);
    expect(conv.externalId).toBe(`webchat:${VISITOR_A}`);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const body = await poll.json();
    expect(body.state).toBe('active');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('hello from the website');
    expect(body.messages[0].direction).toBe('in');
    // internal payloads must never leak to the widget
    expect(body.messages[0].payload).toBeUndefined();
  });

  it('isolates transcripts by visitor id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await post('a secret', VISITOR_B);
    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_B}`);
    const body = await poll.json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['a secret']);

    // visitor A can't see B's transcript and vice versa
    const a = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    expect((await a.json()).messages.map((m: { text: string }) => m.text)).toEqual([
      'hello from the website',
    ]);
  });

  it('returns messages from the cursor (inclusive — client dedupes by id)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const first = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const ts = (await first.json()).messages.at(-1).created_at;
    await post('second message');
    const second = await app.request(
      `/chat/${channelId}/messages?visitor_id=${VISITOR_A}&after=${encodeURIComponent(ts)}`,
    );
    const body = await second.json();
    expect(body.messages.at(-1).text).toBe('second message');
  });

  it('rejects malformed visitor ids and empty text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const bad = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: 'x', text: 'hi' }),
    });
    expect(bad.status).toBe(400);
    // valid format but no conversation yet → empty transcript
    const empty = await app.request(`/chat/${channelId}/messages?visitor_id=vis_unknown12`);
    const body = await empty.json();
    expect(body.messages).toEqual([]);
    expect(body.state).toBe('new');
    // malformed visitor id → 400
    expect(
      (await app.request(`/chat/${channelId}/messages?visitor_id=x`)).status,
    ).toBe(400);
  });

  it('accepts file uploads and attaches them to a message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const fd = new FormData();
    fd.append('visitor_id', VISITOR_A);
    fd.append('file', new File(['hello-bytes'], 'note.txt', { type: 'text/plain' }));
    const up = await app.request(`/chat/${channelId}/uploads`, { method: 'POST', body: fd });
    expect(up.status).toBe(201);
    const file = await up.json();
    expect(file.url).toMatch(/^\/uploads\//);

    // attachment-only message (no text) stores payload.attachments
    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: VISITOR_A, text: '', attachments: [file] }),
    });
    expect(res.status).toBe(200);

    const poll = await app.request(`/chat/${channelId}/messages?visitor_id=${VISITOR_A}`);
    const msgs = (await poll.json()).messages;
    const last = msgs.at(-1);
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0].name).toBe('note.txt');
    // stored text is a readable fallback so the agent/console isn't blank
    expect(last.text).toContain('note.txt');
  });

  it('rejects uploads with a bad visitor id and foreign attachment urls', async () => {
    const fd = new FormData();
    fd.append('visitor_id', 'x');
    fd.append('file', new File(['a'], 'a.txt'));
    expect((await app.request(`/chat/${channelId}/uploads`, { method: 'POST', body: fd })).status).toBe(400);

    const res = await app.request(`/chat/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: VISITOR_A,
        text: '',
        attachments: [{ name: 'evil', url: 'https://evil.test/f', type: 'text/plain', size: 1 }],
      }),
    });
    expect(res.status).toBe(400);
  });
});
