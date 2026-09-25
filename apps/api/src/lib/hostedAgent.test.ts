import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, uploads, workspaces } from '../db/schema.js';
import { blessedUrlsFor, controlTag, extractLearns, fileAnalysisAllowed, guardReplyLinks, transcriptFor } from './hostedAgent.js';

let db: Db;
let convId: string;
let wsId: string;

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'Test', plan: 'pro' }).returning();
  wsId = ws.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: 'h', apiKeyPreview: 'p', hosted: true })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'webchat:vis1', state: 'active' })
    .returning();
  convId = conv.id;

  await db.insert(uploads).values([
    { filename: 'k-note', name: 'note.txt', type: 'text/plain', size: 17, data: Buffer.from('refund policy: 30d') },
    { filename: 'k-img', name: 'shot.png', type: 'image/png', size: PNG.length, data: PNG },
  ]);

  const atts = (list: { name: string; url: string; type: string; size: number }[]) => ({ attachments: list });
  // Anchor in the past so `new Date()` inserts in later tests sort newest.
  const t0 = Date.now() - 60_000;
  await db.insert(messages).values([
    {
      conversationId: conv.id,
      direction: 'in',
      text: 'here is the file',
      payload: atts([{ name: 'note.txt', url: '/uploads/k-note', type: 'text/plain', size: 17 }]),
      createdAt: new Date(t0),
    },
    {
      conversationId: conv.id,
      direction: 'in',
      text: 'and a screenshot',
      payload: atts([{ name: 'shot.png', url: '/uploads/k-img', type: 'image/png', size: PNG.length }]),
      createdAt: new Date(t0 + 1000),
    },
  ]);
});

describe('transcriptFor file analysis', () => {
  it('inlines text files and image parts when enabled', async () => {
    const history = await transcriptFor(db, convId, true);
    expect(history).toHaveLength(2);

    // text file → content inlined into the text part
    const first = history[0];
    expect(typeof first.content).toBe('string');
    expect(first.content as string).toContain('refund policy: 30d');
    expect(first.content as string).toContain('<file name="note.txt">');

    // image → multipart content with an image_url part
    const second = history[1];
    expect(Array.isArray(second.content)).toBe(true);
    const parts = second.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('and a screenshot');
    const img = parts.find((p) => p.type === 'image_url');
    expect(img).toBeTruthy();
    expect(img!.image_url!.url).toMatch(/^data:image\/png;base64,/); // dev apiOrigin is http → data URI
  });

  it('keeps name annotations when file analysis is off', async () => {
    const history = await transcriptFor(db, convId, false);
    for (const m of history) {
      expect(typeof m.content).toBe('string');
    }
    expect(history[0].content as string).toContain('[attachments: note.txt]');
    expect(history[1].content as string).toContain('[attachments: shot.png]');
  });

  it('annotates missing upload rows instead of dropping the message', async () => {
    await db.insert(messages).values({
      conversationId: convId,
      direction: 'in',
      text: 'gone file',
      payload: { attachments: [{ name: 'gone.pdf', url: '/uploads/k-gone', type: 'application/pdf', size: 10 }] },
      createdAt: new Date(),
    });
    const history = await transcriptFor(db, convId, true);
    const last = history.at(-1)!;
    expect(last.content as string).toContain('[attachments: gone.pdf]');
  });
});

describe('fileAnalysisAllowed', () => {
  it('is paid-plan only', async () => {
    expect(await fileAnalysisAllowed(db, wsId)).toBe(true);
    const [free] = await db.insert(workspaces).values({ name: 'Free', plan: 'free' }).returning();
    expect(await fileAnalysisAllowed(db, free.id)).toBe(false);
    const [unset] = await db.insert(workspaces).values({ name: 'Unset' }).returning();
    expect(await fileAnalysisAllowed(db, unset.id)).toBe(false); // unknown plan → free
  });
});

describe('guardReplyLinks', () => {
  const blessed = ['https://app.janis.ai/agents', 'https://janis.ai/pricing'];
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 })); // default: dead link
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps URLs verbatim from the blessed set', async () => {
    const r = await guardReplyLinks('Add one at https://app.janis.ai/agents.', blessed);
    expect(r.text).toBe('Add one at https://app.janis.ai/agents.');
    expect(r.fixed).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps deep links on a blessed domain', async () => {
    const r = await guardReplyLinks('see https://app.janis.ai/settings?x=1', blessed);
    expect(r.text).toContain('https://app.janis.ai/settings?x=1');
  });

  it('swaps a corrupted domain when the path matches a blessed URL', async () => {
    const r = await guardReplyLinks('Go to https://app.native.ai/agents to add one.', blessed);
    expect(r.text).toBe('Go to https://app.janis.ai/agents to add one.');
    expect(r.fixed).toEqual(['https://app.native.ai/agents']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a bare corrupted domain to the first blessed origin', async () => {
    const r = await guardReplyLinks('visit https://native.ai', blessed);
    expect(r.text).toBe('visit https://app.janis.ai/');
    expect(r.fixed).toHaveLength(1);
  });

  it('strips invented URLs that do not resolve', async () => {
    const r = await guardReplyLinks('Check https://evil.example.com/steal for details.', blessed);
    expect(r.text).toBe('Check for details.');
    expect(r.stripped).toEqual(['https://evil.example.com/steal']);
  });

  it('passes an unblessed link that actually resolves', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const r = await guardReplyLinks(
      'listen https://music.apple.com/us/search?term=bobby',
      blessed,
    );
    expect(r.text).toContain('https://music.apple.com/us/search?term=bobby');
    expect(r.verified).toEqual(['https://music.apple.com/us/search?term=bobby']);
  });

  it('keeps but flags a link that cannot be verified', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const r = await guardReplyLinks('see https://blocked.example/x', blessed);
    expect(r.text).toContain('https://blocked.example/x');
    expect(r.unverified).toHaveLength(1);
  });

  it('strips private-network targets without fetching', async () => {
    const r = await guardReplyLinks('hit http://169.254.169.254/latest/meta', blessed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.stripped).toEqual(['http://169.254.169.254/latest/meta']);
  });

  it('unwraps markdown links emptied by a strip', async () => {
    const r = await guardReplyLinks('see [this page](https://bogus.io/deep/path) now', blessed);
    expect(r.text).toBe('see this page now');
  });

  it('blesses customer-shared links, tool endpoints, and config domains', async () => {
    const agent = {
      config: {
        allowed_link_domains: ['ups.com'],
        tools: [{ name: 'lookup', url: 'https://api.shop.example/lookup', method: 'GET' }],
      },
    } as never;
    const urls = blessedUrlsFor(agent, 'prompt https://app.janis.ai/agents', [
      { role: 'user', content: 'my tracking link https://tracking.ups.com/1Z999' },
    ]);
    // customer-shared link echoes back fine
    expect(
      (await guardReplyLinks('your tracking: https://tracking.ups.com/1Z999', urls)).stripped,
    ).toHaveLength(0);
    // config-blessed domain (tool return values) and the tool's own origin pass
    expect((await guardReplyLinks('see https://ups.com/hub/1Z999', urls)).stripped).toHaveLength(0);
    expect(
      (await guardReplyLinks('via https://api.shop.example/item/5', urls)).stripped,
    ).toHaveLength(0);
    // subdomains of a blessed domain count; lookalikes get checked (dead → strip)
    expect(
      (await guardReplyLinks('via https://static.api.shop.example/img.png', urls)).stripped,
    ).toHaveLength(0);
    expect(
      (await guardReplyLinks('no https://notshop.example/x', urls)).stripped,
    ).toHaveLength(1);
    // but an invented link is still caught
    expect((await guardReplyLinks('bad https://evil.io/x', urls)).stripped).toHaveLength(1);
  });
});

describe('controlTag', () => {
  it('detects misspelled handoff tokens and strips them', () => {
    // prod incident: the model emitted [HANDOF] — exact-match parsing
    // delivered the raw tag to the customer and skipped the escalation
    const r = controlTag("I've alerted the team again. A human teammate will be with you shortly![HANDOF]");
    expect(r?.kind).toBe('handoff');
    expect(r?.partial).toBe("I've alerted the team again. A human teammate will be with you shortly!");
  });

  it('classifies each control token', () => {
    expect(controlTag('bringing in a human [HANDOFF]')?.kind).toBe('handoff');
    expect(controlTag('want me to ask? [OFFER_HUMAN]')?.kind).toBe('offer');
    expect(controlTag('got it [CANCEL_HANDOFF]')?.kind).toBe('cancel');
    // a cancel tag contains HANDOF — must not misclassify as handoff
    expect(controlTag('ok [CANCEL_HANDOF]')?.kind).toBe('cancel');
    expect(controlTag('ok [ofer human]')?.kind).toBe('offer');
  });

  it('returns null for plain replies and strips every occurrence', () => {
    expect(controlTag('Just a normal answer.')).toBeNull();
    expect(controlTag('[HANDOFF]').partial).toBe('');
    expect(controlTag('a [HANDOF] b [handoff] c').partial).toBe('a  b  c');
  });
});

describe('extractLearns', () => {
  it('strips LEARN lines from the reply and returns them', () => {
    const r = extractLearns('Here is your answer.\nLEARN: returns are 30 days\nlearn: see /returns');
    expect(r.text).toBe('Here is your answer.');
    expect(r.learns).toEqual(['returns are 30 days', 'see /returns']);
  });

  it('leaves plain replies untouched', () => {
    const r = extractLearns('Nothing to learn here.');
    expect(r.text).toBe('Nothing to learn here.');
    expect(r.learns).toHaveLength(0);
  });
});
