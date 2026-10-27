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

describe('calendly tool template', () => {
  const calendly = TOOL_TEMPLATES.find((t) => t.id === 'calendly')!;
  const tool = (name: string) => calendly.tools.find((t) => t.name === name)!;
  it('exists with a bearer-token secret', () => {
    expect(calendly).toBeTruthy();
    expect(calendly.category).toBe('Scheduling');
    expect(calendly.secrets({ api_key: ' tok ' })).toEqual({ CALENDLY_TOKEN: 'tok' });
  });
  it('chains user_uri through reads and keeps them ungated', () => {
    for (const name of [
      'calendly_me',
      'calendly_event_types',
      'calendly_available_times',
      'calendly_scheduled_events',
    ]) {
      const t = tool(name);
      expect(t.method).toBe('GET');
      expect(t.approval).toBeUndefined();
      expect(t.headers?.authorization).toBe('Bearer {{secrets.CALENDLY_TOKEN}}');
    }
    expect(tool('calendly_event_types').url).toContain('user={user_uri}');
    expect(tool('calendly_event_types').widget?.items).toBe('collection');
  });
  it('identity-binds the customer booking lookup', () => {
    const t = tool('calendly_scheduled_events');
    expect(t.identity).toBe(true);
    expect(t.url).toContain('invitee_email={email}');
  });
  it('gates cancellation behind approval', () => {
    const t = tool('calendly_cancel_event');
    expect(t.approval).toBe(true);
    expect(t.method).toBe('POST');
    expect(t.url).toContain('/scheduled_events/{event_uuid}/cancellation');
  });

  it('oauth variant mirrors the tool set against CONN_CALENDLY_TOKEN', () => {
    const oauth = TOOL_TEMPLATES.find((t) => t.id === 'calendly-connect')!;
    expect(oauth.fields).toEqual([]);
    expect(oauth.oauth_connect).toBe('/api/calendly/connect');
    expect(oauth.connection?.provider).toBe('calendly');
    // same names/urls/approval+identity flags; only the auth header differs
    for (const pt of calendly.tools) {
      const ot = oauth.tools.find((t) => t.name === pt.name)!;
      expect(ot).toBeTruthy();
      expect(ot.url).toBe(pt.url);
      expect(ot.method).toBe(pt.method);
      expect(ot.approval).toBe(pt.approval);
      expect(ot.identity).toBe(pt.identity);
      expect(ot.headers?.authorization).toBe('Bearer {{secrets.CONN_CALENDLY_TOKEN}}');
    }
  });
});

describe('shopify self-service tools', () => {
  const shopify = TOOL_TEMPLATES.find((t) => t.id === 'shopify')!;
  const tool = (name: string) => shopify.tools.find((t) => t.name === name)!;

  it('lookup_order exposes the ids the self-service tools need', () => {
    const t = tool('shopify_lookup_order');
    expect(t.bodyTemplate).toContain('customer{id}');
    expect(t.bodyTemplate).toContain('fulfillmentLineItems');
    // The description is the model's only pointer at these fields.
    expect(t.description).toContain('shopify_update_customer');
    expect(t.description).toContain('shopify_request_return');
  });

  it('customerUpdate is identity-bound self-service — never gated', () => {
    const t = tool('shopify_update_customer');
    expect(t.identity).toBe(true);
    expect(t.approval).toBeUndefined();
    expect(t.bodyTemplate).toContain('customerUpdate');
    expect(Object.keys(t.params!)).toContain('customer');
  });

  it('returnRequest files immediately — the parked decision card is the human gate', () => {
    const t = tool('shopify_request_return');
    // Not approval-gated itself: a successful file parks a shopify_return_decision
    // card, and THAT approve/decline is the teammate's call.
    expect(t.approval).toBeUndefined();
    expect(t.bodyTemplate).toContain('returnRequest');
    expect(t.bodyTemplate).toContain('ReturnRequestInput');
    expect(t.params?.return_request).toContain('fulfillmentLineItemId');
  });

  it('discountCodeBasicCreate is approval-gated save-the-sale', () => {
    const t = tool('shopify_create_discount');
    expect(t.approval).toBe(true);
    expect(t.bodyTemplate).toContain('discountCodeBasicCreate');
    expect(t.params?.discount).toContain('DiscountCodeBasicInput');
  });
});
