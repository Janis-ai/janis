import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchGoogleSourceText, googleSourceTarget } from './googleSource.js';
import { encryptSecret } from './secrets.js';
import { agentConnections } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { KnowledgeLlm } from './knowledge.js';

const noLlm = async (): Promise<KnowledgeLlm> => ({ apiKey: '', baseUrl: '', model: '' });

type ConnRow = typeof agentConnections.$inferSelect;
function connRow(): ConnRow {
  return {
    id: 'c1',
    provider: 'google',
    label: 'me@example.com',
    credentialsEnc: encryptSecret('{}'),
    accessTokenEnc: encryptSecret('test-token'),
    expiresAt: new Date(Date.now() + 3600e3),
  } as ConnRow;
}

function fakeDb(conn: ConnRow | null) {
  return {
    select: () => ({
      from: (t: unknown) => ({
        where: () => ({ limit: async () => (t === agentConnections && conn ? [conn] : []) }),
      }),
    }),
  } as unknown as Db;
}

/** Route-style fetch stub: url → Response (or status shorthand). */
function stubApi(routes: Record<string, Response | number>) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      seen.push(url);
      for (const [k, v] of Object.entries(routes)) {
        if (url.includes(k)) return typeof v === 'number' ? new Response(null, { status: v }) : v;
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return seen;
}

const DOC = () =>
  new Response(
    JSON.stringify({
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Pricing: $99/mo.\n' } }] } },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  { content: [{ paragraph: { elements: [{ textRun: { content: 'Cell A\n' } }] } }] },
                ],
              },
            ],
          },
        },
      ],
    },
  }),
    { status: 200 },
  );

const DECK = () =>
  new Response(
    JSON.stringify({
    slides: [
      {
        pageElements: [
          { shape: { text: { textElements: [{ textRun: { content: 'Q3 roadmap\n' } }] } } },
        ],
      },
    ],
  }),
  { status: 200 },
);

afterEach(() => vi.unstubAllGlobals());

describe('googleSourceTarget', () => {
  it('parses doc/sheet/slide share + normalized export links', () => {
    expect(googleSourceTarget('https://docs.google.com/document/d/abc_1-2/edit?usp=sharing')).toEqual({
      kind: 'document',
      id: 'abc_1-2',
    });
    expect(googleSourceTarget('https://docs.google.com/spreadsheets/d/xyz/export?format=csv')).toEqual(
      { kind: 'spreadsheet', id: 'xyz' },
    );
    expect(googleSourceTarget('https://docs.google.com/presentation/d/deck9/edit#slide=id.p')).toEqual(
      { kind: 'presentation', id: 'deck9' },
    );
  });

  it('parses drive file + open?id links, flags folders', () => {
    expect(googleSourceTarget('https://drive.google.com/file/d/f123/view?usp=sharing')).toEqual({
      kind: 'file',
      id: 'f123',
    });
    expect(googleSourceTarget('https://drive.google.com/open?id=f456')).toEqual({
      kind: 'file',
      id: 'f456',
    });
    expect(googleSourceTarget('https://drive.google.com/drive/folders/fold1')).toEqual({
      kind: 'folder',
      id: '',
    });
  });

  it('ignores non-google URLs', () => {
    expect(googleSourceTarget('https://example.com/doc.pdf')).toBeNull();
    expect(googleSourceTarget('not a url')).toBeNull();
  });
});

describe('fetchGoogleSourceText', () => {
  it('returns null without a connection so the caller falls back', async () => {
    const r = await fetchGoogleSourceText(
      fakeDb(null),
      'w1',
      'a1',
      'https://docs.google.com/document/d/abc/edit',
      noLlm,
    );
    expect(r).toBeNull();
  });

  it('reads a private doc via the Docs API and flattens tables', async () => {
    stubApi({ 'docs.googleapis.com/v1/documents/abc': DOC() });
    const r = await fetchGoogleSourceText(
      fakeDb(connRow()),
      'w1',
      'a1',
      'https://docs.google.com/document/d/abc/edit',
      noLlm,
    );
    expect(r?.text).toContain('Pricing: $99/mo.');
    expect(r?.text).toContain('Cell A');
  });

  it('reads a sheet: tab list then batchGet rendered as sections', async () => {
    stubApi({
      'spreadsheets/sheet1?fields=': new Response(
        JSON.stringify({ sheets: [{ properties: { title: 'Leads' } }] }),
        { status: 200 },
      ),
      'values:batchGet': new Response(
        JSON.stringify({ valueRanges: [{ range: 'Leads!A1:Z2', values: [['name', 'email'], ['Jo', 'jo@x.co']] }] }),
        { status: 200 },
      ),
    });
    const r = await fetchGoogleSourceText(
      fakeDb(connRow()),
      'w1',
      'a1',
      'https://docs.google.com/spreadsheets/d/sheet1/edit',
      noLlm,
    );
    expect(r?.text).toContain('# Leads');
    expect(r?.text).toContain('jo@x.co');
  });

  it('drive/file links probe native APIs when metadata 404s', async () => {
    const seen = stubApi({
      'drive/v3/files/f1': 404,
      'docs.googleapis.com': 404,
      'slides.googleapis.com': DECK(),
    });
    const r = await fetchGoogleSourceText(
      fakeDb(connRow()),
      'w1',
      'a1',
      'https://drive.google.com/file/d/f1/view',
      noLlm,
    );
    expect(r?.text).toContain('Q3 roadmap');
    expect(seen.some((u) => u.includes('slides.googleapis.com'))).toBe(true);
  });

  it('uses drive metadata to type picked files', async () => {
    stubApi({
      'drive/v3/files/f1': new Response(
        JSON.stringify({ id: 'f1', name: 'notes', mimeType: 'application/vnd.google-apps.document' }),
        { status: 200 },
      ),
      'docs.googleapis.com': DOC(),
    });
    const r = await fetchGoogleSourceText(
      fakeDb(connRow()),
      'w1',
      'a1',
      'https://drive.google.com/file/d/f1/view',
      noLlm,
    );
    expect(r?.text).toContain('Pricing: $99/mo.');
  });

  it('names the fix when the account cannot open the file', async () => {
    stubApi({ 'docs.googleapis.com': 403, 'drive/v3/files/f1': 404 });
    await expect(
      fetchGoogleSourceText(
        fakeDb(connRow()),
        'w1',
        'a1',
        'https://docs.google.com/document/d/abc/edit',
        noLlm,
      ),
    ).rejects.toThrow(/share it with me@example\.com|pick it/);
  });

  it('rejects folder links before any fetch', async () => {
    stubApi({});
    await expect(
      fetchGoogleSourceText(
        fakeDb(connRow()),
        'w1',
        'a1',
        'https://drive.google.com/drive/folders/fold1',
        noLlm,
      ),
    ).rejects.toThrow(/folder/i);
  });
});
