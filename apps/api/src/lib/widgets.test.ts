import { describe, expect, it } from 'vitest';
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
    expect(out.refs).toEqual(['plans', 'pricing-table']);
  });

  it('still parses WIDGET: JSON alongside refs', async () => {
    const { extractWidgets } = await import('./widgets.js');
    const out = extractWidgets(
      'WIDGET: {"type":"options","items":[{"label":"Yes"},{"label":"No"}]}\nWIDGET_REF: plans',
    );
    expect(out.widgets).toHaveLength(1);
    expect(out.widgets[0].type).toBe('options');
    expect(out.refs).toEqual(['plans']);
  });
});
