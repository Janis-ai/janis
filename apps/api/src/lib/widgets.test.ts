import { describe, expect, it, vi } from 'vitest';
import { widgetFromToolResult } from './widgets.js';

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
