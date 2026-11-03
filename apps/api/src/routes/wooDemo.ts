import { Hono } from 'hono';

// Demo WooCommerce store — canned wc/v3 responses for exercising the
// woocommerce connector card end-to-end (identity-bound order reads,
// product search, approval-gated notes) without standing up WordPress.
// Sits at the exact /wp-json/wc/v3 paths the template calls, gated by a
// public demo consumer pair — not a real secret, just keeps scanners out.

export const WOO_DEMO_KEY = 'ck_demo';
export const WOO_DEMO_SECRET = 'cs_demo';

const PRODUCTS = [
  {
    id: 11,
    name: 'Demo Hoodie',
    price: '49.00',
    regular_price: '59.00',
    sale_price: '49.00',
    stock_status: 'instock',
    permalink: 'https://demo.janis.ai/product/demo-hoodie',
    sku: 'DEMO-HOODIE',
  },
  {
    id: 12,
    name: 'Demo Mug',
    price: '14.00',
    regular_price: '14.00',
    stock_status: 'outofstock',
    permalink: 'https://demo.janis.ai/product/demo-mug',
    sku: 'DEMO-MUG',
  },
  {
    id: 13,
    name: 'Demo Cap',
    price: '22.00',
    regular_price: '22.00',
    stock_status: 'instock',
    permalink: 'https://demo.janis.ai/product/demo-cap',
    sku: 'DEMO-CAP',
  },
];

const ORDERS = [
  {
    id: 1042,
    number: '1042',
    status: 'completed',
    date_created: '2026-10-28T14:31:00',
    total: '63.00',
    currency: 'USD',
    billing: {
      first_name: 'Jane',
      last_name: 'Demo',
      email: 'michael.nathanson@gmail.com',
    },
    shipping: { city: 'Toronto', country: 'CA' },
    line_items: [
      { id: 1, name: 'Demo Hoodie', quantity: 1, total: '49.00' },
      { id: 2, name: 'Demo Mug', quantity: 1, total: '14.00' },
    ],
    meta_data: [{ key: 'tracking_number', value: '1Z-DEMO-0001' }],
  },
  {
    id: 1043,
    number: '1043',
    status: 'processing',
    date_created: '2026-10-31T09:12:00',
    total: '22.00',
    currency: 'USD',
    billing: {
      first_name: 'Jane',
      last_name: 'Demo',
      email: 'michael.nathanson@gmail.com',
    },
    shipping: { city: 'Toronto', country: 'CA' },
    line_items: [{ id: 3, name: 'Demo Cap', quantity: 1, total: '22.00' }],
    meta_data: [],
  },
  {
    id: 1044,
    number: '1044',
    status: 'on-hold',
    date_created: '2026-11-01T17:45:00',
    total: '49.00',
    currency: 'USD',
    billing: {
      first_name: 'Raj',
      last_name: 'Demo',
      email: 'raj.demo@example.com',
    },
    shipping: { city: 'Vancouver', country: 'CA' },
    line_items: [{ id: 4, name: 'Demo Hoodie', quantity: 1, total: '49.00' }],
    meta_data: [],
  },
];

export function wooDemoRoutes() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const want = `Basic ${Buffer.from(`${WOO_DEMO_KEY}:${WOO_DEMO_SECRET}`).toString('base64')}`;
    if (c.req.header('authorization') !== want) {
      return c.json(
        { code: 'woocommerce_rest_cannot_view', message: `demo store — use consumer pair ${WOO_DEMO_KEY} / ${WOO_DEMO_SECRET}` },
        401,
      );
    }
    return next();
  });

  // GET /wp-json/wc/v3/orders?search={term} — Woo searches billing fields.
  app.get('/wc/v3/orders', (c) => {
    const q = (c.req.query('search') ?? '').toLowerCase();
    const rows = q
      ? ORDERS.filter(
          (o) =>
            o.billing.email.toLowerCase().includes(q) ||
            o.billing.first_name.toLowerCase().includes(q) ||
            o.billing.last_name.toLowerCase().includes(q) ||
            String(o.id) === q,
        )
      : ORDERS;
    return c.json(rows.slice(0, Number(c.req.query('per_page') ?? 10)));
  });

  app.get('/wc/v3/orders/:id', (c) => {
    const order = ORDERS.find((o) => o.id === Number(c.req.param('id')));
    if (!order) {
      return c.json({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' }, 404);
    }
    return c.json(order);
  });

  app.post('/wc/v3/orders/:id/notes', async (c) => {
    const order = ORDERS.find((o) => o.id === Number(c.req.param('id')));
    if (!order) {
      return c.json({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(
      {
        id: 9001,
        order_id: order.id,
        note: body.note ?? '',
        customer_note: false,
        date_created: new Date().toISOString().replace('T', ' ').slice(0, 19),
        note_label: 'demo — nothing was actually saved',
      },
      201,
    );
  });

  app.get('/wc/v3/products', (c) => {
    const q = (c.req.query('search') ?? '').toLowerCase();
    const rows = q ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) : PRODUCTS;
    return c.json(
      rows
        .filter((p) => !c.req.query('status') || p.stock_status !== 'trash')
        .slice(0, Number(c.req.query('per_page') ?? 10)),
    );
  });

  return app;
}
