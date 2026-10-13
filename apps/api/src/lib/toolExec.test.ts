import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  harvestProducedIds,
  identityBlockReason,
  toolsFor,
  type ToolDef,
} from './toolExec.js';
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

  it('backfills the catalog widget binding onto installs that predate it', () => {
    const t = toolsFor(
      fakeAgent([
        {
          name: 'itunes_search',
          description: 'd',
          method: 'GET',
          url: 'https://itunes.apple.com/search?term={term}',
          // stored install predates the template's widget binding
        },
      ]),
    );
    expect(t[0].widget?.type).toBe('cards');
    expect(t[0].widget?.items).toBe('results');
  });

  it('a stored widget config wins over the catalog backfill', () => {
    const mine = { type: 'options' as const, map: { label: 'name' } };
    const t = toolsFor(
      fakeAgent([
        { name: 'itunes_search', description: 'd', method: 'GET', url: 'https://x.example', widget: mine },
      ]),
    );
    expect(t[0].widget).toBe(mine);
  });
});

describe('callTool bodyTemplate', () => {
  const bookingTool: ToolDef = {
    name: 'calcom_create_booking',
    description: 'd',
    method: 'POST',
    url: 'https://api.cal.com/v2/bookings',
    headers: { authorization: 'Bearer {{secrets.CALCOM_API_KEY}}' },
    bodyTemplate:
      '{"eventTypeId":{{secrets.CALCOM_EVENT_TYPE}},"start":{start},"attendee":{"name":{name},"email":{email},"timeZone":{time_zone}}}',
    params: { start: 's', name: 'n', email: 'e', time_zone: 'tz' },
  };
  const secrets = { CALCOM_API_KEY: 'cal_live_x', CALCOM_EVENT_TYPE: '12345' };
  const fetchMock = vi.fn();
  const booked = {
    start: '2026-10-15T14:00:00Z',
    name: 'Mike',
    email: 'mike@x.com',
    time_zone: 'America/New_York',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('builds a shaped JSON body — args as typed values, secrets expanded server-side', async () => {
    const out = await callTool(bookingTool, booked, secrets);
    expect(out).toContain('"status":"ok"');
    const body = sentBody();
    expect(body.eventTypeId).toBe(12345); // numeric — secret expanded raw
    expect(body.start).toBe('2026-10-15T14:00:00Z');
    expect(body.attendee).toEqual({
      name: 'Mike',
      email: 'mike@x.com',
      timeZone: 'America/New_York',
    });
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer cal_live_x');
  });

  it('nests arg objects the model supplies as JSON text or real objects', async () => {
    const tool: ToolDef = {
      ...bookingTool,
      bodyTemplate: '{"eventTypeId":{{secrets.CALCOM_EVENT_TYPE}},"start":{start},"attendee":{attendee}}',
      params: { start: 's', attendee: 'a' },
    };
    await callTool(tool, {
      start: '2026-10-15T14:00:00Z',
      attendee: '{"name":"Mike","email":"mike@x.com","timeZone":"UTC"}',
    }, secrets);
    expect(sentBody().attendee).toEqual({ name: 'Mike', email: 'mike@x.com', timeZone: 'UTC' });
  });

  it('fails closed when the model omits a templated arg — no request leaves', async () => {
    const out = await callTool(bookingTool, { ...booked, time_zone: undefined as never }, secrets);
    expect(out).toContain('missing required args: time_zone');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when a templated secret is unconfigured', async () => {
    const out = await callTool(bookingTool, booked, { CALCOM_API_KEY: 'k' });
    expect(out).toContain('CALCOM_EVENT_TYPE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('model args can never trigger secret expansion — {{secrets.*}} stays literal', async () => {
    await callTool(bookingTool, { ...booked, name: '{{secrets.CALCOM_API_KEY}}' }, secrets);
    expect(sentBody().attendee.name).toBe('{{secrets.CALCOM_API_KEY}}');
  });
});

describe('callTool bodyTemplate {key:text}', () => {
  const searchTool: ToolDef = {
    name: 'shopify_lookup_order',
    description: 'd',
    method: 'POST',
    url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
    headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
    bodyTemplate:
      '{"query":"query($q:String!){orders(first:1,query:$q){nodes{id name}}}","variables":{"q":"name:${order_number:text} email:${email:text}","id":"gid://shopify/Order/${order_id:text}"}}',
    params: { order_number: 'n', email: 'e', order_id: 'i' },
  };
  const secrets = { SHOPIFY_SHOP: 's.myshopify.com', SHOPIFY_TOKEN: 'shpat_x' };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('injects raw text inside JSON strings — builds compound search clauses', async () => {
    await callTool(
      searchTool,
      { order_number: '#1234', email: 'm@x.com', order_id: '555' },
      secrets,
    );
    const vars = sentBody().variables;
    expect(vars.q).toBe('name:#1234 email:m@x.com');
    expect(vars.id).toBe('gid://shopify/Order/555');
  });

  it('JSON-escapes so quotes in args cannot break out of the string', async () => {
    await callTool(
      searchTool,
      { order_number: '#1", "evil": "', email: 'm@x.com', order_id: '5' },
      secrets,
    );
    expect(sentBody().variables.q).toBe('name:#1", "evil": " email:m@x.com');
  });

  it(':text args still count for the missing-arg check', async () => {
    const out = await callTool(searchTool, { order_number: '#1', email: 'm@x.com' }, secrets);
    expect(out).toContain('missing required args: order_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
