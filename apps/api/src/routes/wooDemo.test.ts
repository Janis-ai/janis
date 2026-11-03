import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { wooDemoRoutes, WOO_DEMO_KEY, WOO_DEMO_SECRET } from './wooDemo.js';

const app = new Hono().route('/wp-json', wooDemoRoutes());
const AUTH = {
  authorization: `Basic ${Buffer.from(`${WOO_DEMO_KEY}:${WOO_DEMO_SECRET}`).toString('base64')}`,
};

describe('woo demo store', () => {
  it('rejects calls without the demo consumer pair', async () => {
    const res = await app.request('/wp-json/wc/v3/products');
    expect(res.status).toBe(401);
  });

  it('looks up an order by id and filters orders by billing email', async () => {
    const order = await (
      await app.request('/wp-json/wc/v3/orders/1042', { headers: AUTH })
    ).json();
    expect(order.status).toBe('completed');
    expect(order.billing.email).toBe('michael.nathanson@gmail.com');

    const miss = await app.request('/wp-json/wc/v3/orders/9999', { headers: AUTH });
    expect(miss.status).toBe(404);

    const search = await (
      await app.request('/wp-json/wc/v3/orders?search=michael.nathanson%40gmail.com&per_page=10', {
        headers: AUTH,
      })
    ).json();
    expect(search.map((o: { id: number }) => o.id)).toEqual([1042, 1043]);
  });

  it('searches products and accepts order notes', async () => {
    const products = await (
      await app.request('/wp-json/wc/v3/products?search=hoodie&per_page=10&status=publish', {
        headers: AUTH,
      })
    ).json();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe('Demo Hoodie');
    expect(products[0].stock_status).toBe('instock');

    const note = await (
      await app.request('/wp-json/wc/v3/orders/1042/notes', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'customer asked about tracking' }),
      })
    ).json();
    expect(note.note).toBe('customer asked about tracking');
    expect(note.customer_note).toBe(false); // staff notes are never customer-visible
  });
});
