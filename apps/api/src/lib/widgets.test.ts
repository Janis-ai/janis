import { describe, expect, it, vi } from 'vitest';
import { dedupeToolWidgets, dedupeWidgetList, filterRowsByQuery, widgetFromToolResult } from './widgets.js';

const products = JSON.stringify({
  products: [
    {
      title: 'Blue Tee',
      handle: 'blue-tee',
      vendor: 'Acme',
      images: [{ src: 'https://cdn.example.com/blue.png' }],
      variants: [{ price: '19.99' }],
    },
    {
      title: 'Red Tee',
      handle: 'red-tee',
      vendor: 'Acme',
      images: [{ src: 'https://cdn.example.com/red.png' }],
      variants: [{ price: '21.50' }],
    },
  ],
});

describe('widgetFromToolResult', () => {
  it('maps a products envelope into cards with templated links', () => {
    const w = widgetFromToolResult(
      {
        type: 'cards',
        items: 'products',
        link_label: 'View product',
        select_label: "I'm interested in the {title}",
        map: {
          title: 'title',
          subtitle: 'vendor',
          image: 'images.0.src',
          price: 'variants.0.price',
          link: 'https://{{secrets.SHOP}}/products/{handle}',
        },
      },
      products,
      { SHOP: 'acme.myshopify.com' },
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items).toHaveLength(2);
    expect(w.items[0]).toMatchObject({
      title: 'Blue Tee',
      subtitle: 'Acme',
      image: 'https://cdn.example.com/blue.png',
      price: '19.99',
      link: 'https://acme.myshopify.com/products/blue-tee',
      link_label: 'View product',
      select_label: "I'm interested in the Blue Tee",
    });
  });

  it('finds the first array-valued property without an items path', () => {
    const w = widgetFromToolResult(
      { type: 'options', map: { label: 'name' } },
      JSON.stringify({ meta: 1, results: [{ name: 'Tue 3pm' }, { name: 'Wed 10am' }] }),
    );
    expect(w?.type).toBe('options');
    if (w?.type !== 'options') return;
    expect(w.items.map((i) => i.label)).toEqual(['Tue 3pm', 'Wed 10am']);
  });

  it('accepts a top-level array', () => {
    const w = widgetFromToolResult(
      { type: 'cards', map: { title: 'name', price: 'cost' } },
      JSON.stringify([{ name: 'Starter', cost: '£29/mo' }]),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items[0]).toMatchObject({ title: 'Starter', price: '£29/mo' });
  });

  it('returns null on truncated/non-JSON results — model narration still carries it', () => {
    expect(
      widgetFromToolResult({ type: 'cards' }, '{"products": [{"title": "Blue'),
    ).toBeNull();
    expect(widgetFromToolResult({ type: 'cards' }, 'not json', {})).toBeNull();
  });

  it('returns null when no rows map (missing required field)', () => {
    const w = widgetFromToolResult(
      { type: 'cards', map: { title: 'nonexistent_field' } },
      products,
    );
    expect(w).toBeNull();
  });

  it('drops rows without a title but keeps the mappable ones', () => {
    const w = widgetFromToolResult(
      { type: 'cards', items: 'products', map: { title: 'title' } },
      JSON.stringify({ products: [{ title: 'Blue Tee' }, { vendor: 'no title here' }] }),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items).toHaveLength(1);
  });

  it('"{path:money}" formats MoneyV2 rows with the currency symbol', () => {
    const w = widgetFromToolResult(
      {
        type: 'cards',
        items: 'data.products.nodes',
        map: {
          title: 'title',
          price: '{priceRangeV2.minVariantPrice.amount:money}',
        },
      },
      JSON.stringify({
        data: {
          products: {
            nodes: [
              {
                title: 'Wax',
                priceRangeV2: { minVariantPrice: { amount: '9.95', currencyCode: 'USD' } },
              },
              {
                title: 'Board',
                priceRangeV2: { minVariantPrice: { amount: '699.95', currencyCode: 'EUR' } },
              },
            ],
          },
        },
      }),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items[0].price).toBe('$9.95');
    expect(w.items[1].price).toBe('€699.95');
  });

  it('"{path:stock}" flags only a real false — true/untracked stays silent', () => {
    const w = widgetFromToolResult(
      {
        type: 'cards',
        items: 'data.products.nodes',
        map: {
          title: 'title',
          stock: '{variants.nodes.0.availableForSale:stock}',
          cart_variant_id: '{variants.nodes.0.id:gidnum}',
        },
      },
      JSON.stringify({
        data: {
          products: {
            nodes: [
              { title: 'Wax', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', availableForSale: false }] } },
              { title: 'Board', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/22', availableForSale: true }] } },
              // Untracked inventory (gift card) — no flag at all.
              { title: 'Gift Card', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/33' }] } },
            ],
          },
        },
      }),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items[0].stock).toBe('Out of stock');
    expect(w.items[1].stock).toBeUndefined();
    expect(w.items[2].stock).toBeUndefined();
    // gid tails become storefront-cart variant ids.
    expect(w.items[0].cart_variant_id).toBe('11');
    expect(w.items[1].cart_variant_id).toBe('22');
    expect(w.items[2].cart_variant_id).toBe('33');
  });

  it('items pointing at a single object renders a one-card widget (pay link)', () => {
    const w = widgetFromToolResult(
      {
        type: 'cards',
        items: 'data.draftOrderCreate.draftOrder',
        link_label: 'Complete your purchase',
        map: {
          title: 'Order {name} — ready to pay',
          price: '{totalPriceSet.shopMoney.amount:money}',
          link: '{invoiceUrl}',
        },
      },
      JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/1',
              name: '#D12',
              invoiceUrl: 'https://shop.example/invoices/abc',
              totalPriceSet: { shopMoney: { amount: '10.0', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        },
      }),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items).toHaveLength(1);
    expect(w.items[0].title).toBe('Order #D12 — ready to pay');
    expect(w.items[0].price).toBe('$10.00');
    expect(w.items[0].link).toBe('https://shop.example/invoices/abc');
    expect(w.items[0].link_label).toBe('Complete your purchase');
  });

  it('availability: hides availableForSale:false rows on browse, keeps them when the call opts in', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      availability: { field: 'variants.nodes.0.availableForSale', unless_arg: 'include_unavailable' },
      map: {
        title: 'title',
        stock: '{variants.nodes.0.availableForSale:stock}',
      },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [
            { title: 'Gift Card', variants: { nodes: [{ availableForSale: false }] } },
            { title: 'Snowboard', variants: { nodes: [{ availableForSale: true }] } },
            { title: 'Untracked Tee', variants: { nodes: [] } },
          ],
        },
      },
    });
    // Browse — the OOS gift card drops out; untracked inventory stays.
    const browse = widgetFromToolResult(cfg, result);
    expect(browse?.type === 'cards' && browse.items.map((i) => i.title)).toEqual([
      'Snowboard',
      'Untracked Tee',
    ]);
    // Opted in (specific-product ask) — the OOS card renders WITH the badge.
    const asked = widgetFromToolResult(cfg, result, {}, { include_unavailable: '1' });
    expect(asked?.type === 'cards' && asked.items.map((i) => i.title)).toEqual([
      'Gift Card',
      'Snowboard',
      'Untracked Tee',
    ]);
    expect(
      asked?.type === 'cards' && asked.items[0].stock,
    ).toBe('Out of stock');
    // All rows OOS on a browse → no widget, the model narrates instead.
    const allOos = JSON.stringify({
      data: { products: { nodes: [{ title: 'X', variants: { nodes: [{ availableForSale: false }] } }] } },
    });
    expect(widgetFromToolResult(cfg, allOos)).toBeNull();
  });

  it('row_limit_arg caps rendered rows for focused asks', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      row_limit_arg: 'limit',
      map: { title: 'title' },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [{ title: 'Match' }, { title: 'Neighbour A' }, { title: 'Neighbour B' }],
        },
      },
    });
    // Browse — no cap arg → every row renders.
    const browse = widgetFromToolResult(cfg, result);
    expect(browse?.type === 'cards' && browse.items.length).toBe(3);
    // Photo/specific ask — limit narrows the cards, not the result text.
    const one = widgetFromToolResult(cfg, result, {}, { limit: '1' });
    expect(one?.type === 'cards' && one.items.map((i) => i.title)).toEqual(['Match']);
    // Junk caps are ignored.
    const bad = widgetFromToolResult(cfg, result, {}, { limit: 'all' });
    expect(bad?.type === 'cards' && bad.items.length).toBe(3);
  });
});

describe('extractWidgets', () => {
  it('strips WIDGET_REF lines and returns the names for resolution', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'Here are our plans:\nWIDGET_REF: plans\nWIDGET_REF: Pricing Table\nanything else?',
    );
    expect(out.text).toBe('Here are our plans:\nanything else?');
    expect(out.refs).toEqual([{ name: 'plans' }, { name: 'pricing-table' }]);
  });

  it('captures a WIDGET_REF data object for props/tool args', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'status:\nWIDGET_REF: order-status {"order_id":"#1932","state":"in_transit"}\nWIDGET: {"type":"options","items":[{"label":"Yes"}]}',
    );
    expect(out.text).toBe('status:');
    expect(out.refs).toEqual([
      { name: 'order-status', data: { order_id: '#1932', state: 'in_transit' } },
    ]);
    expect(out.widgets).toHaveLength(1);
  });

  it('still parses WIDGET: JSON alongside refs', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'WIDGET: {"type":"options","items":[{"label":"Yes"},{"label":"No"}]}\nWIDGET_REF: plans',
    );
    expect(out.widgets).toHaveLength(1);
    expect(out.widgets[0].type).toBe('options');
    expect(out.refs).toEqual([{ name: 'plans' }]);
    expect(out.dropped).toBe(0);
  });

  it('consumes a directive that starts mid-line — the colon lead-in stays', async () => {
    const { extractWidgets } = await import('./widgets.js');
    // Real incident: the model emitted 'options: WIDGET: {…}' — the anchor
    // missed it and the raw JSON rendered to the customer.
    const out = extractWidgets(
      'Here are our available meeting options: WIDGET: {"type":"cards","items":[{"title":"30 Minute Meeting","link":"https://calendly.com/x/30min"}]}',
    );
    expect(out.text).toBe('Here are our available meeting options:');
    expect(out.widgets).toHaveLength(1);
    expect(out.widgets[0].type).toBe('cards');
    const ref = extractWidgets('the tracker: WIDGET_REF: order-status {"order_id":"1"}');
    expect(ref.text).toBe('the tracker:');
    expect(ref.refs).toEqual([{ name: 'order-status', data: { order_id: '1' } }]);
  });

  it('counts WIDGET: lines that fail to parse — the caller can regenerate', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'Here are our tunes:\nWIDGET: {"type":"cards","items":[{"title":"Tenth Stair"\nWIDGET: cards',
    );
    expect(out.text).toBe('Here are our tunes:');
    expect(out.widgets).toHaveLength(0);
    expect(out.dropped).toBe(2);
  });

  it('accepts an itemless cart widget — and dedupe survives it', async () => {
    const { extractWidgets, dedupeToolWidgets } = await import('./widgets.js');
    const out = extractWidgets('Your cart:\nWIDGET: {"type":"cart","title":"Your cart"}');
    expect(out.widgets).toEqual([{ type: 'cart', title: 'Your cart' }]);
    // widgetItemKeys returns [] for cart — no crash against a tool list.
    expect(
      dedupeToolWidgets([{ type: 'cart' as const }], out.widgets),
    ).toHaveLength(1);
  });
});

describe('specProps / interpolateSpec / stripEmptyStrings', () => {
  it('derives prop names from {placeholders} and fills them', async () => {
    const { specProps, interpolateSpec, stripEmptyStrings } = await import('./widgets.js');
    const spec = {
      type: 'status',
      title: 'Return {exchange_id}',
      steps: [
        { label: 'Received', state: 'done', note: '{received_note}' },
        { label: 'Refunded', state: 'todo' },
      ],
    };
    expect(specProps(spec)).toEqual(['exchange_id', 'received_note']);
    const filled = stripEmptyStrings(
      interpolateSpec(spec, { exchange_id: '#1932' }),
    ) as typeof spec;
    expect(filled.title).toBe('Return #1932');
    // missing prop → '' → stripped → optional field absent
    expect(filled.steps[0]).toEqual({ label: 'Received', state: 'done' });
  });
});

describe('resolveWidgetRef', () => {
  const ctx = { db: null, convId: 'c1', workspaceId: 'w1' } as never;

  it('fills placeholders from inline ref data', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    const spec = await resolveWidgetRef(
      {
        spec: {
          type: 'receipt',
          title: 'Order {order_id}',
          rows: [{ label: 'Status', value: '{status}' }],
          total: { label: 'Total', value: '{total}' },
        },
      },
      { order_id: '#1932', status: 'Refunded', total: '$29.00' },
      [],
      {},
      ctx,
      new Set(),
    );
    expect(spec).toMatchObject({
      type: 'receipt',
      title: 'Order #1932',
      rows: [{ label: 'Status', value: 'Refunded' }],
      total: { label: 'Total', value: '$29.00' },
    });
  });

  it('selects a named state variant and drops on missing required props', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    const def = {
      spec: {
        type: 'status',
        title: 'Static',
        steps: [{ label: 'Ordered', state: 'todo' }],
      },
      states: [
        {
          name: 'in-transit',
          spec: {
            type: 'status',
            title: 'On the way',
            steps: [
              { label: 'Ordered', state: 'done' },
              { label: 'Shipped', state: 'current' },
            ],
          },
        },
      ],
    } as never;
    const picked = await resolveWidgetRef(def, { state: 'In Transit' }, [], {}, ctx, new Set());
    expect(picked).toMatchObject({ title: 'On the way' });
    // a required {prop} that never fills → the whole ref drops
    const missing = await resolveWidgetRef(
      { spec: { type: 'options', items: [{ label: '{label}' }] } },
      {},
      [],
      {},
      ctx,
      new Set(),
    );
    expect(missing).toBeNull();
  });

  it('runs a bound tool, maps result props, and honours identity blocking', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ order: { id: '#1932', state: 'in transit' } }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tool = {
      name: 'get_order',
      method: 'GET',
      url: 'http://localhost/orders/{order_id}',
      params: { order_id: 'order id' },
    } as never;
    const def = {
      spec: {
        type: 'status',
        title: 'Order {order_id} — {state}',
        steps: [{ label: 'Ordered', state: 'done' }],
      },
      tool: { name: 'get_order', props: { state: 'order.state', order_id: 'order.id' } },
    } as never;
    const spec = await resolveWidgetRef(def, { order_id: '#1932' }, [tool], {}, ctx, new Set());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(spec).toMatchObject({ title: 'Order #1932 — in transit' });
    // a second resolution: tool props fill, inline data overrides them
    const spec2 = await resolveWidgetRef(
      def,
      { order_id: '#1932', state: 'delivered' },
      [tool],
      {},
      ctx,
      new Set(),
    );
    expect(spec2).toMatchObject({ title: 'Order #1932 — delivered' });
    vi.unstubAllGlobals();
  });
});

describe('dedupeToolWidgets', () => {
  const toolCards = {
    type: 'cards' as const,
    items: [
      { title: 'Tenth Stair', link: 'https://music.apple.com/a' },
      { title: 'Dress Renee', link: 'https://music.apple.com/b' },
      { title: 'Chasing the Lights', link: 'https://music.apple.com/c' },
    ],
  };

  it('drops a model cards row that restates the tool-bound render', () => {
    const modelCards = {
      type: 'cards' as const,
      items: [
        { title: 'Tenth Stair', link: 'https://music.apple.com/a' },
        { title: 'Dress Renee', link: 'https://music.apple.com/b' },
        { title: 'Chasing the Lights', link: 'https://music.apple.com/c' },
      ],
    };
    expect(dedupeToolWidgets([toolCards], [modelCards])).toEqual([]);
  });

  it('strips only the duplicate items from a partially-overlapping row', () => {
    const mixed = {
      type: 'cards' as const,
      items: [
        { title: 'Tenth Stair', link: 'https://music.apple.com/a' }, // dup
        { title: 'A Different Song', link: 'https://music.apple.com/x' },
      ],
    };
    expect(dedupeToolWidgets([toolCards], [mixed])).toEqual([
      {
        type: 'cards',
        items: [{ title: 'A Different Song', link: 'https://music.apple.com/x' }],
      },
    ]);
  });

  it('keeps components with genuinely different items', () => {
    const other = {
      type: 'cards' as const,
      items: [{ title: 'Something Else', link: 'https://music.apple.com/z' }],
    };
    expect(dedupeToolWidgets([toolCards], [other])).toEqual([other]);
  });

  it('passes through when there is nothing to dedupe against', () => {
    const w = { type: 'cards' as const, items: [{ title: 'x' }] };
    expect(dedupeToolWidgets([], [w])).toEqual([w]);
    expect(dedupeToolWidgets([toolCards], [])).toEqual([]);
  });
});

describe('dedupeWidgetList', () => {
  const cards = {
    type: 'cards' as const,
    items: [
      { title: 'Tenth Stair', link: 'https://music.apple.com/a' },
      { title: 'Dress Rehearsal', link: 'https://music.apple.com/b' },
      { title: 'Gone', link: 'https://music.apple.com/c' },
    ],
  };

  it('collapses a tool-bound widget emitted twice', () => {
    expect(dedupeWidgetList([cards, cards])).toEqual([cards]);
  });

  it('strips restated items from a later row but keeps its new items', () => {
    const later = {
      type: 'cards' as const,
      items: [
        { title: 'Gone', link: 'https://music.apple.com/c' }, // dup
        { title: 'New Track', link: 'https://music.apple.com/d' },
      ],
    };
    expect(dedupeWidgetList([cards, later])).toEqual([
      cards,
      { type: 'cards', items: [{ title: 'New Track', link: 'https://music.apple.com/d' }] },
    ]);
  });

  it('keeps genuinely different cards rows', () => {
    const other = {
      type: 'cards' as const,
      items: [{ title: 'Merch Tee', link: 'https://shop.test/t' }],
    };
    expect(dedupeWidgetList([cards, other])).toEqual([cards, other]);
  });

  it('dedupes model-emitted dupes too (WIDGET: line twice)', () => {
    const opts = {
      type: 'options' as const,
      items: [{ label: 'Yes' }, { label: 'No' }],
    };
    expect(dedupeWidgetList([opts, { ...opts }])).toEqual([opts]);
  });

  it('dedupes a model restatement that drops link/reformats price', () => {
    // Live case: shopify_search_products renders tool cards with
    // link+select_label, then the model emits its own cards of the same
    // products with "$"-prefixed prices and no link — item keys must still
    // collide on title or the customer sees the row twice.
    const model = {
      type: 'cards' as const,
      items: [
        { title: 'tenth stair', price: '$9.00', image: 'https://img.test/a' },
        { title: '  Dress Rehearsal ', price: '$9.00' },
      ],
    };
    expect(dedupeWidgetList([cards, model])).toEqual([cards]);
  });

  it('does not collapse different widget types sharing item titles', () => {
    const status = {
      type: 'status' as const,
      title: 'Order',
      steps: [
        { label: 'Tenth Stair', state: 'done' as const },
        { label: 'Shipped', state: 'current' as const },
      ],
    };
    expect(dedupeWidgetList([cards, status])).toEqual([cards, status]);
  });
});

describe('filterRowsByQuery', () => {
  const cfg = {
    type: 'cards' as const,
    items: 'results',
    relevance: { arg: 'term', fields: ['trackName', 'collectionName', 'artistName'] },
  };
  const result = JSON.stringify({
    resultCount: 3,
    results: [
      { trackName: 'Now and Then', collectionName: 'Now and Then - Single', artistName: 'The Beatles' },
      { trackName: 'Now and Then (Remix)', collectionName: 'Now and Then', artistName: 'The Beatles' },
      { trackName: 'Drive My Car', collectionName: 'Rubber Soul', artistName: 'The Beatles' },
    ],
  });

  it('drops rows sharing no tokens with the query', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { term: 'now and then' }, result),
    );
    expect(out.resultCount).toBe(2);
    expect(out.results.map((r: { trackName: string }) => r.trackName)).toEqual([
      'Now and Then',
      'Now and Then (Remix)',
    ]);
  });

  it('empties the list when nothing matches — honest "no match" narration', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { term: 'songs by abba' }, result),
    );
    expect(out.results).toEqual([]);
  });

  it('is a no-op without a relevance spec or matching rows path', () => {
    const noRel = { type: 'cards' as const, items: 'results' };
    expect(filterRowsByQuery(noRel, { term: 'x' }, result)).toBe(result);
    expect(
      filterRowsByQuery(cfg, { term: 'now' }, JSON.stringify({ ok: 1 })),
    ).toBe(JSON.stringify({ ok: 1 }));
  });

  it('matches whole words, not substrings', () => {
    const r = JSON.stringify({
      results: [
        { trackName: 'Knowing You', collectionName: 'X', artistName: 'Y' },
        { trackName: 'Snow', collectionName: 'X', artistName: 'Y' },
      ],
    });
    const out = JSON.parse(filterRowsByQuery(cfg, { term: 'snow' }, r));
    expect(out.results).toEqual([
      { trackName: 'Snow', collectionName: 'X', artistName: 'Y' },
    ]);
  });
});
