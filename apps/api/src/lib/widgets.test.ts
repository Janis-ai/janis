import { describe, expect, it, vi } from 'vitest';
import { availabilityDropped, dedupeToolWidgets, dedupeWidgetList, filterRowsByQuery, internalDataResult, namedProductsInReply, reconcilePagedResult, titlesMatch, toolResultEmpty, toolResultNotes, widgetFromToolResult } from './widgets.js';

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

  it('reorders rows by a sort path — Stripe newest-first buries old products', () => {
    const w = widgetFromToolResult(
      { type: 'cards', items: 'data', sort: 'created', map: { title: 'name' } },
      JSON.stringify({
        data: [
          { name: 'Janis AI usage', created: 2000 },
          { name: 'Janis Starter', created: 1000 },
          { name: 'Janis Pro', created: 1500 },
        ],
      }),
    );
    expect(w?.type).toBe('cards');
    if (w?.type !== 'cards') return;
    expect(w.items.map((i) => i.title)).toEqual(['Janis Starter', 'Janis Pro', 'Janis AI usage']);
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

  it('availability: browse badges OOS rows by default; in_stock_only hides them', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      availability: {
        field: 'variants.nodes.0.availableForSale',
        unless_arg: 'include_unavailable',
        in_stock_arg: 'in_stock_only',
      },
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
    // Browse — everything renders; the gift card carries the OOS badge.
    const browse = widgetFromToolResult(cfg, result);
    expect(browse?.type === 'cards' && browse.items.map((i) => i.title)).toEqual([
      'Gift Card',
      'Snowboard',
      'Untracked Tee',
    ]);
    expect(browse?.type === 'cards' && browse.items[0].stock).toBe('Out of stock');
    // Explicit in-stock ask — the OOS row drops out entirely.
    const inStock = widgetFromToolResult(cfg, result, {}, { in_stock_only: '1' });
    expect(inStock?.type === 'cards' && inStock.items.map((i) => i.title)).toEqual([
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
    // All rows OOS on a named ask → the result IS the answer; render the
    // rows badged rather than a blank that invites a badge-less model card.
    const allOos = JSON.stringify({
      data: { products: { nodes: [{ title: 'X', variants: { nodes: [{ availableForSale: false }] } }] } },
    });
    const oos = widgetFromToolResult(cfg, allOos);
    expect(oos?.type === 'cards' && oos.items[0].stock).toBe('Out of stock');
    // A truly empty result still renders nothing — the model narrates.
    expect(
      widgetFromToolResult(cfg, JSON.stringify({ data: { products: { nodes: [] } } })),
    ).toBeNull();
  });

  it('price window: "under $800" cards never render an over-limit product', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
      map: { title: 'title', price: '{__v.price:money}' },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [
            { title: 'Cheap Board', variants: { nodes: [{ id: 'v1', price: '600.00', availableForSale: true }] } },
            { title: 'Pricey Board', variants: { nodes: [{ id: 'v2', price: '973.75', availableForSale: true }] } },
          ],
        },
      },
    });
    // Dedicated arg…
    const w1 = widgetFromToolResult(cfg, result, {}, { price_max: '800' });
    expect(w1?.type === 'cards' && w1.items.map((i) => i.title)).toEqual(['Cheap Board']);
    // …and a clause embedded in the search query itself.
    const w2 = widgetFromToolResult(cfg, result, {}, { query: 'product_type:snowboard variants.price:<=800' });
    expect(w2?.type === 'cards' && w2.items.map((i) => i.title)).toEqual(['Cheap Board']);
    // Over-eager bound that empties the set → no carousel at all.
    expect(widgetFromToolResult(cfg, result, {}, { price_max: '10' })).toBeNull();
  });

  it('availability only_arg keeps JUST the unavailable rows badged', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      availability: {
        field: 'variants.nodes.0.availableForSale',
        unless_arg: 'include_unavailable',
        only_arg: 'only_unavailable',
      },
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
          ],
        },
      },
    });
    const w = widgetFromToolResult(cfg, result, {}, { only_unavailable: '1' });
    expect(w?.type === 'cards' && w.items.map((i) => i.title)).toEqual(['Gift Card']);
    expect(w?.type === 'cards' && w.items[0].stock).toBe('Out of stock');
    // Nothing unavailable in the set → no widget at all.
    const allIn = JSON.stringify({
      data: { products: { nodes: [{ title: 'Snowboard', variants: { nodes: [{ availableForSale: true }] } }] } },
    });
    expect(widgetFromToolResult(cfg, allIn, {}, { only_unavailable: '1' })).toBeNull();
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

  it('stamps total when the query outgrows the carousel (and not otherwise)', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      map: { title: 'title' },
    };
    const mk = (count: number, n: number, hasNext = true) =>
      JSON.stringify({
        data: {
          productsCount: { count },
          products: {
            pageInfo: { hasNextPage: hasNext, endCursor: 'cur1' },
            nodes: Array.from({ length: n }, (_, i) => ({ title: `P${i}` })),
          },
        },
      });
    // 13 in the catalogue, 10 rendered, page 2 exists → total stamps.
    const w = widgetFromToolResult(cfg, mk(13, 12));
    expect(w?.type === 'cards' && w.items.length).toBe(10);
    expect(w?.type === 'cards' && w.total).toBe(13);
    // Everything fit → no total, no tile.
    const fit = widgetFromToolResult(cfg, mk(3, 3));
    expect(fit?.type === 'cards' && fit.total).toBeUndefined();
    // Last page of a bigger set — count exceeds items but there's no next
    // page, so no tile (it would just loop).
    const lastPage = widgetFromToolResult(cfg, mk(13, 2, false));
    expect(lastPage?.type === 'cards' && lastPage.items.length).toBe(2);
    expect(lastPage?.type === 'cards' && lastPage.total).toBeUndefined();
    // only_arg views count rows the filter dropped — never a total.
    const cfgOnly = {
      ...cfg,
      availability: { field: 'variants.nodes.0.availableForSale', unless_arg: 'include_unavailable', only_arg: 'only_unavailable' },
    };
    const oosResult = JSON.stringify({
      data: {
        productsCount: { count: 13 },
        products: {
          nodes: Array.from({ length: 3 }, (_, i) => ({
            title: `OOS ${i}`,
            variants: { nodes: [{ availableForSale: false }] },
          })),
        },
      },
    });
    const oos = widgetFromToolResult(cfgOnly, oosResult, {}, { only_unavailable: '1' });
    expect(oos?.type === 'cards' && oos.items.length).toBe(3);
    expect(oos?.type === 'cards' && oos.total).toBeUndefined();
  });

  it('pick: the card price and Add-to-cart id come from the SAME cheapest available variant', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
      availability: { field: '__v.availableForSale', unless_arg: 'include_unavailable' },
      map: {
        title: 'title',
        price: '{__v.price:money}',
        stock: '{__v.availableForSale:stock}',
        cart_variant_id: '{__v.id:gidnum}',
      },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [
            {
              title: 'Ski Wax',
              priceRangeV2: { minVariantPrice: { amount: '9.95', currencyCode: 'USD' } },
              variants: {
                nodes: [
                  // Shopify returns cheapest-first here — but nodes[0] is
                  // NOT always the min across stores, so the pick, not the
                  // position, must decide.
                  { id: 'gid://shopify/ProductVariant/1001', availableForSale: true, price: '24.95' },
                  { id: 'gid://shopify/ProductVariant/1002', availableForSale: true, price: '9.95' },
                  { id: 'gid://shopify/ProductVariant/1003', availableForSale: false, price: '4.95' },
                ],
              },
            },
            {
              title: 'All OOS Board',
              variants: {
                nodes: [
                  { id: 'gid://shopify/ProductVariant/2001', availableForSale: false, price: '99.95' },
                  { id: 'gid://shopify/ProductVariant/2002', availableForSale: false, price: '89.95' },
                ],
              },
            },
          ],
        },
      },
    });
    const w = widgetFromToolResult(cfg, result);
    expect(w?.type === 'cards' && w.items.map((i) => i.title)).toEqual([
      'Ski Wax',
      'All OOS Board',
    ]);
    const item = w?.type === 'cards' ? w.items[0] : undefined;
    // Cheapest AVAILABLE is 1002 ($9.95) — the $4.95 one is out of stock.
    // Two purchasable variants → "from" pricing + an options line.
    expect(item?.price).toBe('from $9.95');
    expect(item?.options).toBe('2 variants');
    expect(item?.cart_variant_id).toBe('1002');
    expect(item?.stock).toBeUndefined();
    // The all-OOS row renders alongside, badged and unbuyable.
    const oosItem = w?.type === 'cards' ? w.items[1] : undefined;
    expect(oosItem?.stock).toBe('Out of stock');
    expect(oosItem?.cart_variant_id).toBeUndefined();
    // All-OOS rows still render badged when they're the whole answer —
    // and the picked variant is the first (cheapest pool is empty).
    const allOos = JSON.stringify({
      data: { products: { nodes: [JSON.parse(result).data.products.nodes[1]] } },
    });
    const w2 = widgetFromToolResult(cfg, allOos);
    expect(w2?.type === 'cards' && w2.items[0].stock).toBe('Out of stock');
    expect(w2?.type === 'cards' && w2.items[0].cart_variant_id).toBeUndefined();
  });

  it('selling plans suppress the Add button and surface on the options line', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
      map: {
        title: 'title',
        price: '{__v.price:money}',
        cart_variant_id: '{__v.id:gidnum}',
      },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [
            {
              title: 'Sub Wax',
              variants: {
                nodes: [
                  { id: 'gid://shopify/ProductVariant/3001', availableForSale: true, price: '9.45' },
                  { id: 'gid://shopify/ProductVariant/3002', availableForSale: true, price: '47.45' },
                ],
              },
              sellingPlanGroups: {
                nodes: [
                  { name: 'Subscription', sellingPlans: { nodes: [{ name: 'Weekly wax' }] } },
                  { name: 'Preorder', sellingPlans: { nodes: [{ name: 'Early drop' }] } },
                ],
              },
            },
          ],
        },
      },
    });
    const w = widgetFromToolResult(cfg, result);
    const item = w?.type === 'cards' ? w.items[0] : undefined;
    // A subscription product one-tap-added as one-time purchase is a silent
    // contract choice — the button must not exist; the plans must show.
    expect(item?.cart_variant_id).toBeUndefined();
    expect(item?.price).toBe('from $9.45');
    expect(item?.options).toContain('Subscription');
    expect(item?.options).toContain('Preorder');
    expect(item?.options).toContain('2 variants');
  });

  it('named product options render on the options line', () => {
    const cfg = {
      type: 'cards' as const,
      items: 'data.products.nodes',
      pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
      map: { title: 'title', price: '{__v.price:money}', cart_variant_id: '{__v.id:gidnum}' },
    };
    const result = JSON.stringify({
      data: {
        products: {
          nodes: [
            {
              title: 'Gift Card',
              options: [{ name: 'Denominations', values: ['$10', '$25', '$50', '$100'] }],
              variants: {
                nodes: [{ id: 'gid://shopify/ProductVariant/4001', availableForSale: true, price: '10.00' }],
              },
            },
          ],
        },
      },
    });
    const w = widgetFromToolResult(cfg, result);
    const item = w?.type === 'cards' ? w.items[0] : undefined;
    expect(item?.options).toBe('Denominations: $10·$25·$50·$100');
    // No selling plans → a plain add is still offered (it adds the shown variant).
    expect(item?.cart_variant_id).toBe('4001');
  });

  it('end_cursor stamps on non-final pages so a fumbled `after` can recover', () => {
    const cfg = { type: 'cards' as const, items: 'data.products.nodes', map: { title: 'title' } };
    const mk = (hasNext: boolean) =>
      JSON.stringify({
        data: {
          products: {
            pageInfo: { hasNextPage: hasNext, endCursor: 'REAL_CURSOR_9' },
            nodes: [{ title: 'P1' }],
          },
        },
      });
    const w = widgetFromToolResult(cfg, mk(true));
    expect(w?.type === 'cards' && w.end_cursor).toBe('REAL_CURSOR_9');
    const last = widgetFromToolResult(cfg, mk(false));
    expect(last?.type === 'cards' && last.end_cursor).toBeUndefined();
  });
});

describe('availabilityDropped', () => {
  const cfg = {
    type: 'cards' as const,
    items: 'data.products.nodes',
    availability: {
      field: 'variants.nodes.0.availableForSale',
      unless_arg: 'include_unavailable',
      in_stock_arg: 'in_stock_only',
    },
    map: { title: 'title' },
  };
  const result = JSON.stringify({
    data: {
      products: {
        nodes: [
          { title: 'Gift Card', variants: { nodes: [{ availableForSale: false }] } },
          { title: 'Snowboard', variants: { nodes: [{ availableForSale: true }] } },
          { title: 'OOS Board', variants: { nodes: [{ availableForSale: false }] } },
        ],
      },
    },
  });
  it('counts rows the filter hid on an explicit in-stock ask', () => {
    expect(availabilityDropped(cfg, { in_stock_only: '1' }, result)).toBe(2);
  });
  it('returns 0 on a plain browse — OOS rows render badged, nothing is hidden', () => {
    expect(availabilityDropped(cfg, {}, result)).toBe(0);
  });
  it('returns 0 when the call opted into unavailable rows', () => {
    expect(availabilityDropped(cfg, { include_unavailable: '1' }, result)).toBe(0);
  });
  it('returns 0 when EVERY row is OOS — they render badged, nothing is hidden', () => {
    const allOos = JSON.stringify({
      data: { products: { nodes: [{ title: 'G', variants: { nodes: [{ availableForSale: false }] } }] } },
    });
    expect(availabilityDropped(cfg, {}, allOos)).toBe(0);
  });
  it('evaluates availability on the picked variant, not nodes[0]', () => {
    const pickCfg = {
      ...cfg,
      pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
      availability: {
        field: '__v.availableForSale',
        unless_arg: 'include_unavailable',
        in_stock_arg: 'in_stock_only',
      },
    };
    const r = JSON.stringify({
      data: {
        products: {
          nodes: [
            // nodes[0] is OOS but a later variant is buyable → row is NOT
            // hidden, must not count as dropped.
            {
              title: 'Mixed',
              variants: {
                nodes: [
                  { id: 'gid://shopify/ProductVariant/1', availableForSale: false, price: '5.00' },
                  { id: 'gid://shopify/ProductVariant/2', availableForSale: true, price: '9.00' },
                ],
              },
            },
          ],
        },
      },
    });
    expect(availabilityDropped(pickCfg, { in_stock_only: '1' }, r)).toBe(0);
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

  it('parses a pretty-printed multi-line WIDGET: block — no JSON leaks', async () => {
    const { extractWidgets } = await import('./widgets.js');
    // Real incident: the model pretty-printed the spec and the raw JSON
    // rendered verbatim to the customer.
    const out = extractWidgets(
      'Here is the tracker:\nWIDGET: {\n "type": "status",\n "title": "Order #1001",\n "steps": [\n  { "label": "Paid", "state": "done" },\n  { "label": "Shipped", "state": "todo" }\n ]\n}\nAnything else?',
    );
    expect(out.text).toBe('Here is the tracker:\nAnything else?');
    expect(out.widgets).toHaveLength(1);
    expect(out.widgets[0]).toMatchObject({ type: 'status', title: 'Order #1001' });
    expect(out.dropped).toBe(0);
  });

  it('drops an unterminated WIDGET: block whole — continuation never leaks', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'Here it is:\nWIDGET: {\n "type": "status",\n "steps": [ broken\n\nAll prose after a blank line stays.',
    );
    expect(out.widgets).toHaveLength(0);
    expect(out.dropped).toBe(1);
    // The unterminated block is consumed; prose after a blank line survives.
    expect(out.text).toBe('Here it is:\n\nAll prose after a blank line stays.');
  });

  it('resolves a WIDGET_REF whose data object spans lines', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'WIDGET_REF: order-status {\n "order_id": "#1001"\n}\nDone.',
    );
    expect(out.refs).toEqual([{ name: 'order-status', data: { order_id: '#1001' } }]);
    expect(out.text).toBe('Done.');
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

  it('fills a status tracker\'s steps from tool rows — :stepstate normalises statuses', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            events: [
              { name: 'Ordered', status: 'confirmed', eta: 'Nov 2' },
              { name: 'Shipped', status: 'in_transit' },
              { name: 'Delivered', status: 'pending' },
            ],
          }),
          { status: 200 },
        ),
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
        title: 'Order {order_id}',
        steps: [{ label: 'template', state: 'todo' }],
      },
      tool: {
        name: 'get_order',
        props: { order_id: 'order.id' },
        items: 'events',
        item_map: { label: 'name', state: '{status:stepstate}', note: 'eta' },
      },
    } as never;
    const cap: { args?: Record<string, unknown>; result?: string; error?: string } = {};
    const spec = await resolveWidgetRef(def, {}, [tool], {}, ctx, new Set(), cap);
    expect(spec).toMatchObject({
      type: 'status',
      steps: [
        { label: 'Ordered', state: 'done', note: 'Nov 2' },
        { label: 'Shipped', state: 'current' },
        { label: 'Delivered', state: 'todo' },
      ],
    });
    expect(cap.args).toEqual({});
    expect(cap.result).toContain('in_transit');
    vi.unstubAllGlobals();
  });

  it('fills a receipt\'s rows from tool rows', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lines: [
              { name: 'Board', amount: { amount: '499.00', currencyCode: 'USD' } },
              { name: 'Bindings', amount: { amount: '129.00', currencyCode: 'USD' } },
            ],
            total: '628.00',
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tool = { name: 'get_order', method: 'GET', url: 'http://localhost/o' } as never;
    const def = {
      spec: {
        type: 'receipt',
        title: 'Order summary',
        rows: [{ label: 'template', value: 'x' }],
        total: { label: 'Total', value: '{total}' },
      },
      tool: {
        name: 'get_order',
        props: { total: 'total' },
        items: 'lines',
        item_map: { label: 'name', value: '{amount.amount:money}' },
      },
    } as never;
    const spec = await resolveWidgetRef(def, {}, [tool], {}, ctx, new Set());
    expect(spec).toMatchObject({
      type: 'receipt',
      rows: [
        { label: 'Board', value: '$499.00' },
        { label: 'Bindings', value: '$129.00' },
      ],
      total: { label: 'Total', value: '628.00' },
    });
    vi.unstubAllGlobals();
  });

  it(':date and :pretty make raw API values readable', async () => {
    const { propsFromResult } = await import('./widgets.js');
    const props = propsFromResult(
      {
        when: '{createdAt:date}',
        status: '{displayFulfillmentStatus:pretty}',
        transit: '{trackingStatus:pretty}',
        bad: '{missing:date}',
      },
      {
        createdAt: '2026-10-16T23:20:13Z',
        displayFulfillmentStatus: 'UNFULFILLED',
        trackingStatus: 'out_for_delivery',
      },
    );
    expect(props).toEqual({
      when: 'Oct 16, 2026',
      status: 'Unfulfilled',
      transit: 'Out for delivery',
    });
  });

  it(':trackstate picks cancelled/delivered/transit variants from the order node', async () => {
    const { propsFromResult } = await import('./widgets.js');
    const track = (node: unknown) =>
      propsFromResult({ state: '{.:trackstate}' }, node as never).state;
    const order = (over: Record<string, unknown>) => ({
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [],
      ...over,
    });
    expect(track(order({ cancelledAt: '2026-10-17T00:00:00Z' }))).toBe('cancelled');
    expect(track(order({}))).toBe('unfulfilled');
    expect(track(order({ displayFulfillmentStatus: 'FULFILLED' }))).toBe('shipped');
    expect(
      track(
        order({
          fulfillments: [{ events: { nodes: [{ status: 'delivered' }] } }],
        }),
      ),
    ).toBe('delivered');
    expect(
      track(order({ fulfillments: [{ events: { nodes: [{ status: 'out_for_delivery' }] } }] })),
    ).toBe('in_transit');
    // a held order is not mid-shipment — its own variant
    expect(track(order({ displayFulfillmentStatus: 'ON_HOLD' }))).toBe('on_hold');
    // cancelled still outranks everything
    expect(
      track(order({ cancelledAt: 'x', displayFulfillmentStatus: 'ON_HOLD' })),
    ).toBe('cancelled');
    // digital orders never ship — no delivery pipeline
    expect(track(order({ displayFulfillmentStatus: 'FULFILLMENT_NOT_REQUIRED' }))).toBe('no_shipping');
    expect(
      track(
        order({
          lineItems: { nodes: [{ requiresShipping: false }, { requiresShipping: false }] },
        }),
      ),
    ).toBe('no_shipping');
    // one shippable item keeps the pipeline
    expect(
      track(
        order({
          lineItems: { nodes: [{ requiresShipping: false }, { requiresShipping: true }] },
        }),
      ),
    ).toBe('unfulfilled');
    // pickup orders: a shipping line (the pickup point) but NO shipping
    // address — nothing travels, so no Shipped→Delivered pipeline
    expect(
      track(order({ shippingAddress: null, shippingLine: { title: 'Front counter' } })),
    ).toBe('pickup');
    expect(
      track(
        order({
          shippingAddress: null,
          shippingLine: { title: 'Front counter' },
          displayFulfillmentStatus: 'FULFILLED',
        }),
      ),
    ).toBe('picked_up');
    // a POS-style order (no address, no shipping line) is NOT pickup
    expect(track(order({ shippingAddress: null }))).toBe('unfulfilled');
    // a real shippable order keeps its pipeline even with fields present
    expect(
      track(
        order({
          shippingAddress: { city: 'Toronto' },
          shippingLine: { title: 'Standard' },
        }),
      ),
    ).toBe('unfulfilled');
  });

  it(':orderline gives cancelled/refunded orders an honest one-line status', async () => {
    const { propsFromResult } = await import('./widgets.js');
    const line = (node: unknown) =>
      propsFromResult({ s: '{.:orderline}' }, node as never).s;
    expect(line({ cancelledAt: 'x', displayFulfillmentStatus: 'FULFILLMENT_NOT_REQUIRED' })).toBe('Cancelled');
    expect(line({ displayFinancialStatus: 'REFUNDED' })).toBe('Refunded');
    expect(line({ displayFinancialStatus: 'PARTIALLY_REFUNDED' })).toBe('Partially refunded');
    expect(line({ displayFulfillmentStatus: 'UNFULFILLED' })).toBe('Unfulfilled');
    expect(line({ displayFulfillmentStatus: 'FULFILLMENT_NOT_REQUIRED' })).toBe('No shipping needed');
    // pickup orders never ship — "Unfulfilled" undersells "waiting at the counter"
    expect(
      line({
        displayFulfillmentStatus: 'UNFULFILLED',
        shippingAddress: null,
        shippingLine: { title: 'Front counter' },
      }),
    ).toBe('Awaiting pickup');
    expect(
      line({
        displayFulfillmentStatus: 'FULFILLED',
        shippingAddress: null,
        shippingLine: { title: 'Front counter' },
      }),
    ).toBe('Picked up');
  });

  it(':nonzero drops zero money values and :paren wraps codes', async () => {
    const { propsFromResult } = await import('./widgets.js');
    const props = propsFromResult(
      {
        disc: '{o.totalDiscountsSet.shopMoney.amount:money:nonzero}',
        ship: '{o.totalShippingPriceSet.shopMoney.amount:money:nonzero}',
        code: '{o.discountCodes.0:paren}',
        code2: '{o.discountCodes.1:paren}',
      },
      {
        o: {
          totalDiscountsSet: { shopMoney: { amount: '88.59', currencyCode: 'USD' } },
          totalShippingPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
          discountCodes: ['TEST10'],
        },
      } as never,
    );
    expect(props.disc).toBe('$88.59');
    expect(props.ship).toBeUndefined();
    expect(props.code).toBe('(TEST10)');
    expect(props.code2).toBeUndefined();
  });

  it('a cancelled order selects the cancelled tracker variant', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    vi.stubGlobal('fetch', vi.fn());
    const tool = {
      name: 'lookup_order',
      method: 'POST',
      url: 'http://localhost/graphql',
      bodyTemplate: '{"email":{email},"order":{order_number}}',
    } as never;
    const def = {
      spec: {
        type: 'status',
        title: 'Order {order_name}',
        steps: [
          { label: 'Ordered & paid', state: 'done', note: '{fin_status} {total}' },
          { label: 'Shipped', state: 'todo' },
          { label: 'Delivered', state: 'todo' },
        ],
      },
      states: [
        {
          name: 'cancelled',
          spec: {
            type: 'status',
            title: 'Order {order_name} — Cancelled',
            steps: [
              { label: 'Ordered', state: 'done', note: '{fin_status} {total}' },
              { label: 'Cancelled', state: 'current', note: '{cancel_reason}' },
            ],
          },
        },
      ],
      tool: {
        name: 'lookup_order',
        props: {
          order_name: 'data.orders.nodes.0.name',
          total: '{data.orders.nodes.0.totalPriceSet.shopMoney.amount:money}',
          fin_status: '{data.orders.nodes.0.displayFinancialStatus:pretty}',
          cancel_reason: '{data.orders.nodes.0.cancelReason:pretty}',
          state: '{data.orders.nodes.0:trackstate}',
        },
      },
    } as never;
    const prior = JSON.stringify({
      data: {
        orders: {
          nodes: [
            {
              name: '#1007',
              cancelledAt: '2026-10-17T14:18:14Z',
              cancelReason: 'CUSTOMER',
              displayFinancialStatus: 'PAID',
              displayFulfillmentStatus: 'FULFILLMENT_NOT_REQUIRED',
              totalPriceSet: { shopMoney: { amount: '10.00' } },
              fulfillments: [],
            },
          ],
        },
      },
    });
    const spec = await resolveWidgetRef(def, {}, [tool], {}, ctx, new Set(), undefined, prior);
    expect(spec).toMatchObject({
      title: 'Order #1007 — Cancelled',
      steps: [
        { label: 'Ordered', state: 'done', note: 'Paid $10.00' },
        { label: 'Cancelled', state: 'current', note: 'Customer' },
      ],
    });
    vi.unstubAllGlobals();
  });

  it('a bare ref reuses the bound tool\'s earlier result instead of re-calling with empty args', async () => {
    const { resolveWidgetRef } = await import('./hostedAgent.js');
    // Real incident: the model ran shopify_lookup_order itself then emitted
    // "WIDGET_REF: order-tracker" with no data — the resolver re-called the
    // tool with empty args, hit "missing required args" and the component
    // silently vanished, leaving a bare lead-in.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tool = {
      name: 'lookup_order',
      method: 'POST',
      url: 'http://localhost/graphql',
      bodyTemplate: '{"email":{email},"order":{order_number}}',
    } as never;
    const def = {
      spec: {
        type: 'status',
        title: 'Order {order_name}',
        steps: [{ label: 'Ordered', state: 'done', note: 'Paid {total}' }],
      },
      tool: {
        name: 'lookup_order',
        props: {
          order_name: 'data.orders.nodes.0.name',
          total: '{data.orders.nodes.0.totalPriceSet.shopMoney.amount:money}',
        },
      },
    } as never;
    const prior = JSON.stringify({
      data: { orders: { nodes: [{ name: '#1001', totalPriceSet: { shopMoney: { amount: '949.95' } } }] } },
    });
    const spec = await resolveWidgetRef(def, {}, [tool], {}, ctx, new Set(), undefined, prior);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spec).toMatchObject({
      title: 'Order #1001',
      steps: [{ label: 'Ordered', state: 'done', note: 'Paid $949.95' }],
    });
    // …but a ref carrying its own args still re-fetches (the data may ask
    // for a different record than the earlier call).
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"data":{"orders":{"nodes":[{"name":"#2000","totalPriceSet":{"shopMoney":{"amount":"10.00"}}}]}}}', { status: 200 })),
    );
    const spec2 = await resolveWidgetRef(
      def,
      { email: 'a@b.c', order_number: '#2000' },
      [tool],
      {},
      ctx,
      new Set(),
      undefined,
      prior,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(spec2).toMatchObject({ title: 'Order #2000' });
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

describe('toolResultEmpty / toolResultNotes', () => {
  const cfg = { type: 'cards' as const, items: 'data.products.nodes' };

  it('flags a zero-row result, not a populated or unparseable one', () => {
    expect(toolResultEmpty(cfg, JSON.stringify({ data: { products: { nodes: [] } } }))).toBe(true);
    expect(
      toolResultEmpty(cfg, JSON.stringify({ data: { products: { nodes: [{ title: 'X' }] } } })),
    ).toBe(false);
    expect(toolResultEmpty(cfg, 'not json')).toBe(false);
  });

  it('surfaces the authoritative count and the verbatim next-page call', () => {
    const result = JSON.stringify({
      data: {
        productsCount: { count: 13 },
        products: {
          pageInfo: { hasNextPage: true, endCursor: 'CURSOR123' },
          nodes: [{ title: 'X' }],
        },
      },
    });
    const notes = toolResultNotes(result, { query: 'snowboard' });
    expect(notes).toContain('total for this query is 13');
    expect(notes).toContain('query:"snowboard" after:"CURSOR123"');
    expect(notes).toContain('resets the cursor');
  });

  it('stays silent when there is no next page', () => {
    const result = JSON.stringify({
      data: { products: { pageInfo: { hasNextPage: false }, nodes: [{ title: 'X' }] } },
    });
    expect(toolResultNotes(result)).toBe('');
  });

  it('never promises more on the last page and never says "first" on a continuation', () => {
    const lastPage = JSON.stringify({
      data: {
        productsCount: { count: 13 },
        products: { pageInfo: { hasNextPage: false }, nodes: [{ title: 'X' }, { title: 'Y' }] },
      },
    });
    // Count exceeds rendered but nothing follows — "ask for more" is a dead end.
    const tail = toolResultNotes(lastPage, {}, 2);
    expect(tail).toContain('do NOT promise more pages');
    expect(tail).not.toContain('ask for more');
    // A cursor call marks this as page 2+ — "the remaining", not "the first K".
    const cont = toolResultNotes(lastPage, { query: '', after: 'cur1' }, 2);
    expect(cont).toContain('continuation page');
    expect(cont).toContain('the remaining items');
    expect(cont).toContain('never "the first');
  });
});

describe('internalDataResult — sales analytics minimization', () => {
  it('strips units_sold from ShopifyQL rows, leaving ranked titles only', () => {
    const raw = JSON.stringify({
      data: {
        shopifyqlQuery: {
          tableData: {
            rows: JSON.stringify([
              { product_title: 'Wax', units_sold: 42 },
              { product_title: 'Board', units_sold: 7 },
            ]),
          },
          parseErrors: [],
          parseWarnings: [],
        },
      },
    });
    const out = internalDataResult('shopify_analytics', raw);
    expect(JSON.parse(out!)).toEqual({ ranked_products: ['Wax', 'Board'] });
    expect(out).not.toContain('units_sold');
    expect(out).not.toContain('42');
  });

  it('surfaces parseErrors so a broken query still narrates honestly', () => {
    const raw = JSON.stringify({
      data: {
        shopifyqlQuery: { tableData: null, parseErrors: [{ code: 'X', message: 'bad field' }] },
      },
    });
    expect(JSON.parse(internalDataResult('shopify_analytics', raw)!)).toEqual({
      parseErrors: [{ code: 'X', message: 'bad field' }],
    });
  });

  it('aggregates sales_stats orders into ranked titles — no counts, no order fields', () => {
    const raw = JSON.stringify({
      data: {
        ordersCount: { count: 3 },
        orders: {
          nodes: [
            { createdAt: 'd1', lineItems: { nodes: [{ quantity: 2, product: { title: 'Wax' } }] } },
            {
              createdAt: 'd2',
              lineItems: {
                nodes: [{ quantity: 5, product: { title: 'Board' } }, { quantity: 1, product: { title: 'Wax' } }],
              },
            },
          ],
        },
      },
    });
    const out = internalDataResult('shopify_sales_stats', raw);
    expect(JSON.parse(out!)).toEqual({ ranked_products: ['Board', 'Wax'] });
    expect(out).not.toContain('quantity');
    expect(out).not.toContain('ordersCount');
  });

  it('passes non-analytics tools and non-JSON results through untouched', () => {
    expect(internalDataResult('shopify_search_products', '{"data":{}}')).toBeUndefined();
    expect(internalDataResult('shopify_analytics', 'error: timeout')).toBeUndefined();
  });
});

describe('filterRowsByQuery — strong_fields (Shopify product search)', () => {
  const cfg = {
    type: 'cards' as const,
    items: 'data.products.nodes',
    relevance: {
      arg: 'query',
      fields: ['title', 'description'],
      strong_fields: ['title', 'productType', 'tags'],
    },
  };
  const result = JSON.stringify({
    data: {
      products: {
        nodes: [
          { title: 'Gift Card', productType: 'Gift Cards', tags: [], description: 'For any snowboarder' },
          { title: 'The Collection Snowboard: Liquid', productType: 'Snowboards', tags: ['snowboard'], description: 'Blue top graphic, purple base' },
          { title: 'The Videographer Snowboard', productType: 'Snowboards', tags: ['snow'], description: 'All-mountain' },
        ],
      },
    },
  });

  it('drops rows whose identifying fields share no token with the query', () => {
    const out = JSON.parse(filterRowsByQuery(cfg, { query: 'snowboard' }, result));
    const titles = out.data.products.nodes.map((r: { title: string }) => r.title);
    expect(titles).toEqual(['The Collection Snowboard: Liquid', 'The Videographer Snowboard']);
  });

  it('keeps title-token rows on descriptive multi-term queries (no 50% bar)', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { query: 'snowboard blue cloud purple sale' }, result),
    );
    const titles = out.data.products.nodes.map((r: { title: string }) => r.title);
    // Both snowboards keep their 'snowboard' title token; the gift card's
    // only hit was prose/description — not an identifying field.
    expect(titles).toEqual(['The Collection Snowboard: Liquid', 'The Videographer Snowboard']);
  });

  it('still matches whole phrases in the loose fields', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { query: 'for any snowboarder' }, result),
    );
    const titles = out.data.products.nodes.map((r: { title: string }) => r.title);
    expect(titles).toEqual(['Gift Card']);
  });

  it('passes rows through on operator-only queries — collection_id: is a filter, not a term', () => {
    // Prod bug: "collection_id:361138290865" tokenized to {collection, id,
    // 361138290865} and dropped every row whose title lacked those words —
    // an 8-product collection rendered only the two "Collection Snowboard"s.
    const out = JSON.parse(
      filterRowsByQuery(cfg, { query: 'collection_id:361138290865' }, result),
    );
    expect(out.data.products.nodes).toHaveLength(3);
  });

  it('passes rows through on wildcard operator queries — title:* is not the word "title"', () => {
    // Prod bug: "title:*" left token {title} and dropped every card,
    // shipping "Here are some of our popular boards:" with zero widgets.
    const out = JSON.parse(filterRowsByQuery(cfg, { query: 'title:*' }, result));
    expect(out.data.products.nodes).toHaveLength(3);
  });

  it('passes rows through on compare_at_price:>0 sale filters', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { query: 'compare_at_price:>0' }, result),
    );
    expect(out.data.products.nodes).toHaveLength(3);
  });

  it('still filters by the free-text tail of a mixed query', () => {
    const out = JSON.parse(
      filterRowsByQuery(cfg, { query: 'snowboard product_type:snowboards vendor:x' }, result),
    );
    const titles = out.data.products.nodes.map((r: { title: string }) => r.title);
    expect(titles).toEqual(['The Collection Snowboard: Liquid', 'The Videographer Snowboard']);
  });
});

describe('titlesMatch / namedProductsInReply', () => {
  it('matches full titles, articles, colons and short forms', () => {
    expect(titlesMatch('**The Collection Snowboard: Liquid**', 'The Collection Snowboard: Liquid')).toBe(true);
    expect(titlesMatch('Collection Snowboard Liquid', 'The Collection Snowboard: Liquid')).toBe(true);
    expect(titlesMatch('Liquid', 'The Collection Snowboard: Liquid')).toBe(true);
    expect(titlesMatch('Gift Card', 'The Collection Snowboard: Liquid')).toBe(false);
  });

  it('finds corpus titles mentioned in the reply plus bold spans', () => {
    const named = namedProductsInReply(
      'The match is **The Collection Snowboard: Liquid** — others might be **Hydrogen** or **Oxygen**. Total: **$10.00**.',
      ['collection snowboard liquid', 'the videographer snowboard'],
    );
    expect(named).toContain('collection snowboard liquid');
    expect(named).toContain('Hydrogen');
    expect(named).not.toContain('the videographer snowboard');
    expect(named).not.toContain('$10.00');
  });
});

describe('filterRowsByQuery — store-general cases', () => {
  const cfg = {
    type: 'cards' as const,
    items: 'rows',
    relevance: {
      arg: 'query',
      fields: ['title', 'description'],
      strong_fields: ['title', 'productType', 'tags'],
    },
  };
  const result = JSON.stringify({
    rows: [
      { title: 'Gift Card', productType: 'Gift Cards', tags: [], description: 'x' },
      { title: 'スノーボード Deluxe', productType: 'Boards', tags: [], description: 'x' },
      { title: 'Café Mug', productType: 'Mugs', tags: [], description: 'x' },
    ],
  });

  it('passes CJK/non-latin queries through untouched — tokenising is impossible', () => {
    // A スノーボード query produces zero latin tokens; filtering would empty
    // the carousel for a whole class of storefront languages.
    const out = JSON.parse(filterRowsByQuery(cfg, { query: 'スノーボード' }, result));
    expect(out.rows).toHaveLength(3);
  });

  it('folds accents — "cafe" matches "Café Mug"', () => {
    const out = JSON.parse(filterRowsByQuery(cfg, { query: 'cafe mug' }, result));
    expect(out.rows.map((r: { title: string }) => r.title)).toEqual(['Café Mug']);
  });
});

describe('reconcilePagedResult — filtered pages stay honest', () => {
  const cfg = {
    type: 'cards' as const,
    items: 'data.products.nodes',
    relevance: {
      arg: 'query',
      fields: ['title', 'description'],
      strong_fields: ['title', 'productType', 'tags'],
    },
  };
  const board = (i: number) => ({
    title: `Snowboard ${i}`,
    productType: 'Snowboards',
    tags: ['snowboard'],
    description: 'x',
  });
  const page = (nodes: unknown[], hasNextPage: boolean, startCur = 0) =>
    JSON.stringify({
      data: {
        productsCount: { count: 12 },
        products: {
          pageInfo: { hasNextPage, endCursor: `c${startCur + nodes.length - 1}` },
          edges: nodes.map((_, i) => ({ cursor: `c${startCur + i}` })),
          nodes,
        },
      },
    });

  it('backfills a shorted page and rewrites the count to the filtered total', async () => {
    // Shopify matched 12: 11 snowboards + a gift card dropped by relevance.
    const p1 = page(
      [{ title: 'Gift Card', productType: 'Gift Cards', tags: [], description: 'x' },
        ...Array.from({ length: 9 }, (_, i) => board(i))],
      true,
    );
    const p2 = page([board(9), board(10)], false, 10);
    const out = JSON.parse(
      await reconcilePagedResult(cfg, { query: 'snowboard' }, p1, async () => p2),
    );
    const titles = out.data.products.nodes.map((r: { title: string }) => r.title);
    expect(titles).toHaveLength(10);
    expect(titles[0]).toBe('Snowboard 0');
    // Rendered rows come from both pages; the stamped cursor is the LAST
    // RENDERED row (Snowboard 9 on page 2), not the raw page endCursor — the
    // next `after` call resumes mid-page so the surplus row isn't skipped.
    expect(out.data.products.pageInfo.endCursor).toBe('c10');
    expect(out.data.products.pageInfo.hasNextPage).toBe(true);
    expect(out.data.productsCount.count).toBe(11);
  });

  it('page 2 of the same query renders the one remaining row', async () => {
    const p2 = page([board(10)], false, 10);
    const out = JSON.parse(
      await reconcilePagedResult(cfg, { query: 'snowboard', after: 'c10' }, p2, async () => null, {
        priorShown: 10,
      }),
    );
    expect(out.data.products.nodes).toHaveLength(1);
    expect(out.data.productsCount.count).toBe(11);
    expect(out.data.products.pageInfo.hasNextPage).toBe(false);
  });

  it('is a no-op when a clean single page already equals the count', async () => {
    const p = page([board(1)], false, 0);
    const out = await reconcilePagedResult(cfg, { query: 'snowboard' }, p, async () => {
      throw new Error('must not fetch');
    });
    expect(out).toBe(p);
  });

  it('marks the count a floor when the match set outlasts the scan budget', async () => {
    // Page 1: gift card dropped, 9 boards. Every chased page keeps returning
    // hasNextPage so the budget (5 pages) truncates the scan.
    const p1 = page(
      [{ title: 'Gift Card', productType: 'Gift Cards', tags: [], description: 'x' },
        ...Array.from({ length: 9 }, (_, i) => board(i))],
      true,
    );
    const big = page(Array.from({ length: 10 }, (_, i) => board(10 + i)), true, 10);
    const out = JSON.parse(
      await reconcilePagedResult(cfg, { query: 'snowboard' }, p1, async () => big, { maxPages: 3 }),
    );
    expect(out.data.products.nodes).toHaveLength(10);
    expect(out.data.productsCount.count).toBe(29); // 9 kept + 10+10 scanned
    expect(out.__countFloor).toBe(true);
    expect(out.data.products.pageInfo.hasNextPage).toBe(true);
  });

  it('leaves an uncontradicted raw count alone — chase saw no drops', async () => {
    const p1 = page(Array.from({ length: 10 }, (_, i) => board(i)), true);
    const p2 = page(Array.from({ length: 10 }, (_, i) => board(10 + i)), true, 10);
    const out = JSON.parse(
      await reconcilePagedResult(cfg, { query: 'snowboard' }, p1, async () => p2, { maxPages: 2 }),
    );
    // No drops anywhere → the raw productsCount stands (12 in the fixture).
    expect(out.data.productsCount.count).toBe(12);
    expect(out.__countFloor).toBeUndefined();
  });
});

describe('storefrontProduct market context', () => {
  // Multi-market stores price/stock per market — the probe must pin the
  // shopper's market via the localization cookie, or a wrong-market answer
  // ships a dead Add button (or hides a sellable one).
  it('sends a localization cookie and keys the cache per market', async () => {
    const { storefrontProduct, clearStorefrontCache } = await import('./widgets.js');
    clearStorefrontCache();
    const seen: { url: string; cookie?: string }[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), cookie: init?.headers?.cookie });
      return new Response(JSON.stringify({ title: 'X', variants: [{ id: 1, available: true }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await storefrontProduct('shop.myshopify.com', 'blue-tee', undefined, 'CA');
      await storefrontProduct('shop.myshopify.com', 'blue-tee', undefined, 'US');
      await storefrontProduct('shop.myshopify.com', 'blue-tee', undefined, 'CA'); // cached
      expect(seen).toHaveLength(2);
      expect(seen[0].cookie).toBe('localization=CA');
      expect(seen[1].cookie).toBe('localization=US');
    } finally {
      vi.unstubAllGlobals();
      clearStorefrontCache();
    }
  });

  it('probes without a localization cookie when no market is known', async () => {
    const { storefrontProduct, clearStorefrontCache } = await import('./widgets.js');
    clearStorefrontCache();
    const seen: { cookie?: string }[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ cookie: init?.headers?.cookie });
      return new Response(JSON.stringify({ title: 'X', variants: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await storefrontProduct('shop.myshopify.com', 'blue-tee');
      await storefrontProduct('shop.myshopify.com', 'blue-tee', undefined, 'bad-market!!');
      expect(seen).toHaveLength(1); // invalid market falls back to the unmarketed cache slot
      expect(seen[0].cookie).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      clearStorefrontCache();
    }
  });
});
