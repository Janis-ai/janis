import { describe, expect, it } from 'vitest';
import { TOOL_TEMPLATES } from './toolTemplates.js';

const stripe = TOOL_TEMPLATES.find((t) => t.id === 'stripe')!;
const tool = (name: string) => stripe.tools.find((t) => t.name === name)!;

describe('stripe tool template', () => {
  it('lists customer subscriptions read-only', () => {
    const t = tool('stripe_customer_subscriptions');
    expect(t.method).toBe('GET');
    expect(t.approval).toBeUndefined();
    expect(t.url).toContain('customer={customer_id}');
    expect(t.url).toContain('expand[]=data.items.data.price');
  });

  it('lists products and prices read-only for plan resolution', () => {
    expect(tool('stripe_list_products').method).toBe('GET');
    const prices = tool('stripe_list_prices');
    expect(prices.method).toBe('GET');
    expect(prices.approval).toBeUndefined();
    expect(prices.url).toContain('product={product_id}');
  });

  it('gates the subscription change behind approval', () => {
    const t = tool('stripe_update_subscription');
    expect(t.approval).toBe(true);
    expect(t.method).toBe('POST');
    expect(t.bodyFormat).toBe('form');
    expect(t.url).toContain('/v1/subscriptions/{subscription_id}');
    // required args cover the swap: sub id, existing item, new price, proration
    expect(Object.keys(t.params!)).toEqual(
      expect.arrayContaining([
        'subscription_id',
        'items[0][id]',
        'items[0][price]',
        'proration_behavior',
      ]),
    );
  });

  it('keeps refunds and cancels approval-gated too', () => {
    expect(tool('stripe_create_refund').approval).toBe(true);
    expect(tool('stripe_cancel_subscription').approval).toBe(true);
  });
});
