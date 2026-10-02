import { describe, expect, it } from 'vitest';
import { harvestProducedIds, identityBlockReason, toolsFor, type ToolDef } from './toolExec.js';
import type { agents } from '../db/schema.js';

const VERIFIED = new Set(['me@example.com']);

describe('identityBlockReason', () => {
  it('passes when the only email is the verified one', () => {
    expect(
      identityBlockReason({ email: 'Me@Example.com' }, VERIFIED, new Set()),
    ).toBeNull();
  });

  it('blocks a foreign email — a typed address is a claim, not proof', () => {
    const r = identityBlockReason({ email: 'victim@x.com' }, VERIFIED, new Set());
    expect(r).toContain('identity check');
    expect(r).toContain('victim@x.com');
  });

  it('blocks when nothing anchors the call — no verified identity at all', () => {
    expect(identityBlockReason({ email: 'me@example.com' }, new Set(), new Set())).toContain(
      'identity check',
    );
    expect(identityBlockReason({}, VERIFIED, new Set())).toContain('identity check');
  });

  it('anchors on a produced provider id; blocks an invented one', () => {
    expect(identityBlockReason({ customer_id: 'cus_ABC123' }, VERIFIED, new Set(['cus_ABC123']))).toBeNull();
    expect(
      identityBlockReason({ customer_id: 'cus_FAKE999' }, VERIFIED, new Set(['cus_ABC123'])),
    ).toContain('not produced');
  });

  it('blocks foreign emails hiding inside free-text args (search queries, SOQL)', () => {
    expect(
      identityBlockReason(
        { query: 'type:ticket requester:victim@x.com' },
        VERIFIED,
        new Set(),
      ),
    ).toContain('victim@x.com');
    expect(
      identityBlockReason({ query: 'requester:me@example.com status:open' }, VERIFIED, new Set()),
    ).toBeNull();
  });

  it('bare numerics never hard-block — ticket refs and phones must pass', () => {
    expect(
      identityBlockReason(
        { query: 'requester:me@example.com phone:14155551234' },
        VERIFIED,
        new Set(),
      ),
    ).toBeNull();
  });
});

describe('harvestProducedIds', () => {
  it('collects prefixed provider ids and long numerics from results', () => {
    const s = new Set<string>();
    harvestProducedIds('{"data":[{"id":"cus_OK12345"},{"id":"sub_OK12345"},{"vid":123456789}]}', s);
    expect(s.has('cus_OK12345')).toBe(true);
    expect(s.has('sub_OK12345')).toBe(true);
    expect(s.has('123456789')).toBe(true);
  });
});

describe('toolsFor identity backfill', () => {
  const fakeAgent = (tools: ToolDef[]) =>
    ({ config: { tools } }) as unknown as typeof agents.$inferSelect;

  it('marks catalog customer-record tools even when stored config predates the flag', () => {
    const t = toolsFor(
      fakeAgent([
        {
          name: 'stripe_find_customer',
          description: 'd',
          method: 'GET',
          url: 'https://api.stripe.com/v1/customers?email={email}',
          params: { email: 'e' },
          // note: no identity flag — this is how the leaked agent's stored
          // config actually looked
        },
      ]),
    );
    expect(t[0].identity).toBe(true);
  });

  it('leaves non-catalog tools alone', () => {
    const t = toolsFor(
      fakeAgent([{ name: 'my_webhook', description: 'd', method: 'POST', url: 'https://x.example' }]),
    );
    expect(t[0].identity).toBeUndefined();
  });
});
