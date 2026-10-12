import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchUrlText, htmlToText } from './urlSource.js';

const PAGE = 'https://agent.example/properties/42-oak-st';

function stubPage(html: string, type = 'text/html') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'content-type': type } }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

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
