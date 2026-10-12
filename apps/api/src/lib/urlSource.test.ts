import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  assertPublicUrl,
  fetchUrlText,
  htmlToText,
  normalizeSourceUrl,
  refreshKnowledgeSource,
  setHostLookupForTests,
} from './urlSource.js';
import type { Db } from '../db/client.js';
import type { knowledgeFiles } from '../db/schema.js';

const PAGE = 'https://agent.example/properties/42-oak-st';
const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];

function stubPage(html: string, type = 'text/html') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'content-type': type } }),
    ),
  );
}

beforeEach(() => setHostLookupForTests(async () => PUBLIC_DNS));
afterEach(() => {
  vi.unstubAllGlobals();
  setHostLookupForTests(null);
});

describe('htmlToText', () => {
  it('drops tags and script/style/head', () => {
    const text = htmlToText(
      '<html><head><title>t</title><style>x{}</style></head><body><h1>Hi</h1><script>bad()</script><p>Body <b>text</b></p></body></html>',
    );
    expect(text).toContain('Body text');
    expect(text).not.toContain('bad()');
    expect(text).not.toContain('x{}');
  });
});

describe('fetchUrlText image extraction', () => {
  it('captures og:image', async () => {
    stubPage(
      '<html><head><meta property="og:image" content="https://cdn.example/hero.jpg"></head><body><p>Listing text here.</p></body></html>',
    );
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBe('https://cdn.example/hero.jpg');
    expect(r.text).toContain('Listing text here.');
  });

  it('captures twitter:image and tolerates attribute order', async () => {
    stubPage(
      '<html><head><meta content="/img/t.png" name="twitter:image"></head><body><p>Body.</p></body></html>',
    );
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBe('https://agent.example/img/t.png');
  });

  it('resolves a relative og:image against the page URL', async () => {
    stubPage(
      '<html><head><meta property="og:image" content="wp-content/uploads/p.jpg"></head><body><p>Body.</p></body></html>',
    );
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBe('https://agent.example/properties/wp-content/uploads/p.jpg');
  });

  it('falls back to the first content <img>, skipping chrome images', async () => {
    stubPage(
      '<html><body><img src="/logo.svg"><img src="/icons/star.png"><img src="/media/living-room.webp"><p>Body.</p></body></html>',
    );
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBe('https://agent.example/media/living-room.webp');
  });

  it('returns no imageUrl when the page has none', async () => {
    stubPage('<html><body><p>No pictures here.</p></body></html>');
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBeUndefined();
  });

  it('skips image extraction on non-HTML bodies', async () => {
    stubPage('plain text body', 'text/plain');
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBeUndefined();
    expect(r.text).toBe('plain text body');
  });
});

describe('entity decoding in extracted URLs', () => {
  it('decodes &#x3D;/&amp; so the stored URL is usable', async () => {
    stubPage(
      '<html><head><meta property="og:image" content="https://cdn.example/i?q&#x3D;85&amp;w&#x3D;960"></head><body><p>Body.</p></body></html>',
    );
    const r = await fetchUrlText(PAGE);
    expect(r.imageUrl).toBe('https://cdn.example/i?q=85&w=960');
  });
});

describe('normalizeSourceUrl', () => {
  it('rewrites a Google Doc /edit link to the txt export', () => {
    expect(
      normalizeSourceUrl('https://docs.google.com/document/d/abc123-_/edit?usp=sharing'),
    ).toBe('https://docs.google.com/document/d/abc123-_/export?format=txt');
  });

  it('rewrites a Google Sheet to the csv export', () => {
    expect(normalizeSourceUrl('https://docs.google.com/spreadsheets/d/xyz/edit#gid=0')).toBe(
      'https://docs.google.com/spreadsheets/d/xyz/export?format=csv',
    );
  });

  it('rewrites a GitHub blob page to raw', () => {
    expect(normalizeSourceUrl('https://github.com/acme/docs/blob/main/faq.md')).toBe(
      'https://raw.githubusercontent.com/acme/docs/main/faq.md',
    );
  });

  it('leaves ordinary URLs alone', () => {
    expect(normalizeSourceUrl(PAGE)).toBe(PAGE);
    expect(normalizeSourceUrl('not a url')).toBe('not a url');
  });
});

describe('SSRF guard', () => {
  it('blocks private IP literals and internal hostnames', async () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:8787/health',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://metadata.google.internal/',
      'http://localhost:8787/',
      'file:///etc/passwd',
    ]) {
      await expect(assertPublicUrl(u)).rejects.toThrow();
    }
  });

  it('blocks a public hostname that resolves to a private address', async () => {
    setHostLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicUrl('https://innocent.example/x')).rejects.toThrow(/private/i);
  });

  it('blocks a redirect hop into a private target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } }),
      ),
    );
    await expect(fetchUrlText(PAGE)).rejects.toThrow();
  });

  it('follows safe redirects and reports the final URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: '/moved' } }),
      )
      .mockResolvedValueOnce(
        new Response('<html><body><p>Moved body.</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchUrlText(PAGE);
    expect(r.finalUrl).toBe('https://agent.example/moved');
    expect(r.text).toContain('Moved body.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

type FileRow = typeof knowledgeFiles.$inferSelect;

function fakeDb() {
  const writes: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        writes.push(v);
        return { where: async () => [] };
      },
    }),
  } as unknown as Db;
  return { db, writes };
}

function fileRow(over: Partial<FileRow>): FileRow {
  return { id: 'f1', sourceUrl: PAGE, refreshHours: 24, text: '', ...over } as FileRow;
}

describe('refreshKnowledgeSource last-good retention', () => {
  it('marks a shrunken page degraded and keeps prior text', async () => {
    stubPage('<html><body><p>Sign in</p></body></html>');
    const { db, writes } = fakeDb();
    const ok = await refreshKnowledgeSource(db, fileRow({ text: 'x'.repeat(2000) }));
    expect(ok).toBe(false);
    expect(writes[0].status).toBe('degraded');
    expect(writes[0].text).toBeUndefined();
    expect(String(writes[0].error)).toMatch(/shrank/);
  });

  it('marks an off-site redirect degraded', async () => {
    const { db, writes } = fakeDb();
    const f = fileRow({ text: 'x'.repeat(2000), sourceUrl: 'https://docs.example/page' });
    // fetchPublic reports the hop's URL — a redirect to a different host is rot.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: 'https://accounts.example/login' } }),
        )
        .mockResolvedValueOnce(
          new Response('<html><body><p>Sign in to continue with lots of chrome text around it.</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        ),
    );
    const ok = await refreshKnowledgeSource(db, f);
    expect(ok).toBe(false);
    expect(writes[0].status).toBe('degraded');
    expect(String(writes[0].error)).toMatch(/off-site|redirect/i);
  });

  it('degrades on fetch failure when prior text exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('HTTP 429')));
    const { db, writes } = fakeDb();
    const ok = await refreshKnowledgeSource(db, fileRow({ text: 'last good content' }));
    expect(ok).toBe(false);
    expect(writes[0].status).toBe('degraded');
    expect(writes[0].text).toBeUndefined();
  });

  it('fails (not degrades) a source that never had text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('HTTP 404')));
    const { db, writes } = fakeDb();
    const ok = await refreshKnowledgeSource(db, fileRow({ text: '' }));
    expect(ok).toBe(false);
    expect(writes[0].status).toBe('failed');
  });

  it('swaps in fresh text on a healthy re-crawl', async () => {
    stubPage('<html><body><p>Fresh content here.</p></body></html>');
    const { db, writes } = fakeDb();
    const ok = await refreshKnowledgeSource(db, fileRow({ text: 'old short text' }));
    expect(ok).toBe(true);
    expect(writes[0].status).toBe('ready');
    expect(writes[0].text).toBe('Fresh content here.');
  });
});
