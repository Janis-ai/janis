import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, type ToolDef } from './toolExec.js';
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

describe('jira tool template', () => {
  const jira = TOOL_TEMPLATES.find((t) => t.id === 'jira')!;
  const tool = (name: string) => jira.tools.find((t) => t.name === name)! as ToolDef;
  const secrets = jira.secrets({
    site: 'acme',
    email: 'ops@acme.com',
    api_token: 'ATATT_x',
  });
  const fetchMock = vi.fn();
  const sentUrl = () => fetchMock.mock.calls[0][0] as string;
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('derives host + basic auth from site/email/token', () => {
    expect(secrets.JIRA_HOST).toBe('acme.atlassian.net');
    expect(Buffer.from(secrets.JIRA_AUTH, 'base64').toString()).toBe('ops@acme.com:ATATT_x');
    expect(jira.secrets({ site: 'https://acme.atlassian.net/', email: 'e', api_token: 't' }).JIRA_HOST).toBe(
      'acme.atlassian.net',
    );
  });

  it('searches the enhanced jql endpoint, identity-bound', async () => {
    const t = tool('jira_search');
    expect(t.identity).toBe(true);
    expect(t.url).toContain('/rest/api/3/search/jql');
    await callTool(t, { jql: 'reporter = "me@x.com"' }, secrets);
    expect(sentUrl()).toBe(
      'https://acme.atlassian.net/rest/api/3/search/jql?jql=' +
        encodeURIComponent('reporter = "me@x.com"') +
        '&maxResults=10&fields=summary,status,priority,issuetype,created,updated',
    );
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(`Basic ${secrets.JIRA_AUTH}`);
  });

  it('get_issue mechanically scopes the key lookup to the verified email', async () => {
    const t = tool('jira_get_issue');
    expect(t.identity).toBe(true);
    await callTool(t, { issue_key: 'SUP-12', email: 'me@x.com' }, secrets);
    const jql = new URL(sentUrl()).searchParams.get('jql')!;
    expect(jql).toBe('key = "SUP-12" AND (text ~ "me@x.com" OR reporter = "me@x.com")');
  });

  it('create_issue files an ADF description carrying the verified email', async () => {
    const t = tool('jira_create_issue');
    expect(t.identity).toBe(true);
    await callTool(
      t,
      {
        project: 'SUP',
        summary: 'Checkout 500s',
        issue_type: 'Bug',
        customer_email: 'me@x.com',
        description: 'Payment step returns a 500',
      },
      secrets,
    );
    expect(sentUrl()).toBe('https://acme.atlassian.net/rest/api/3/issue');
    const fields = sentBody().fields;
    expect(fields.project).toEqual({ key: 'SUP' });
    expect(fields.issuetype).toEqual({ name: 'Bug' });
    const paras = fields.description.content.map((p: { content: { text: string }[] }) => p.content[0].text);
    expect(paras[0]).toContain('me@x.com');
    expect(paras[1]).toBe('Payment step returns a 500');
  });

  it('add_comment is approval-gated and posts ADF', async () => {
    const t = tool('jira_add_comment');
    expect(t.approval).toBe(true);
    await callTool(t, { issue_key: 'SUP-12', comment: 'Customer followed up' }, secrets);
    expect(sentUrl()).toBe('https://acme.atlassian.net/rest/api/3/issue/SUP-12/comment');
    expect(sentBody().body.content[0].content[0].text).toBe('Customer followed up');
  });
});

describe('oauth-connect template variants', () => {
  const tpl = (id: string) => TOOL_TEMPLATES.find((t) => t.id === id)!;

  it('every variant exists, connects via /api/oauth, and clones the PAT tool set', () => {
    for (const [from, to] of [
      ['jira', 'jira-connect'],
      ['confluence', 'confluence-connect'],
      ['linear', 'linear-connect'],
      ['slack', 'slack-connect'],
      ['hubspot', 'hubspot-connect'],
      ['salesforce', 'salesforce-connect'],
      ['github', 'github-connect'],
    ]) {
      const pat = tpl(from);
      const oauth = tpl(to);
      expect(oauth.fields).toEqual([]);
      expect(oauth.oauth_connect).toBe(`/api/oauth/${from}/connect`);
      expect(oauth.connection?.provider).toBe(from === 'hubspot' ? 'hubspot' : from);
      expect(oauth.tools.map((t) => t.name)).toEqual(pat.tools.map((t) => t.name));
      // flags carry over verbatim — identity binding and approval gating
      // must not silently drop on the OAuth path
      for (const pt of pat.tools) {
        const ot = oauth.tools.find((t) => t.name === pt.name)!;
        expect(ot.method).toBe(pt.method);
        expect(ot.approval).toBe(pt.approval);
        expect(ot.identity).toBe(pt.identity);
      }
    }
  });

  it('jira-connect swaps the site host for the 3LO cloudId path', () => {
    const search = tpl('jira-connect').tools.find((t) => t.name === 'jira_search')!;
    expect(search.url).toContain('api.atlassian.com/ex/jira/{{secrets.CONN_JIRA_CLOUD_ID}}');
    expect(search.headers?.authorization).toBe('Bearer {{secrets.CONN_JIRA_TOKEN}}');
  });

  it('salesforce-connect swaps the secret host for the OAuth instance_url', () => {
    const q = tpl('salesforce-connect').tools.find((t) => t.name === 'salesforce_query')!;
    expect(q.url).toContain('{{secrets.CONN_SALESFORCE_INSTANCE_URL}}');
    expect(q.headers?.authorization).toBe('Bearer {{secrets.CONN_SALESFORCE_TOKEN}}');
  });

  it('linear/hubspot OAuth tools go Bearer on the connection token', () => {
    expect(
      tpl('linear-connect').tools.find((t) => t.name === 'linear_teams')?.headers
        ?.authorization,
    ).toBe('Bearer {{secrets.CONN_LINEAR_TOKEN}}');
    expect(
      tpl('hubspot-connect').tools.find((t) => t.name === 'hubspot_get_contact')?.headers
        ?.authorization,
    ).toBe('Bearer {{secrets.CONN_HUBSPOT_TOKEN}}');
    expect(
      tpl('github-connect').tools.find((t) => t.name === 'github_search_issues')?.headers
        ?.authorization,
    ).toBe('Bearer {{secrets.CONN_GITHUB_TOKEN}}');
  });

  it('github-connect keeps the REST headers and swaps the repo secret for an arg', () => {
    const search = tpl('github-connect').tools.find((t) => t.name === 'github_search_issues')!;
    // One OAuth grant covers every repo — the PAT-card's GITHUB_REPO secret
    // becomes a per-call tool arg.
    expect(search.url).toContain('repo:{repo}');
    expect(search.params?.repo).toContain('owner/repo');
    expect(search.headers?.accept).toBe('application/vnd.github+json');
    expect(search.headers?.['x-github-api-version']).toBe('2022-11-28');
    const comment = tpl('github-connect').tools.find((t) => t.name === 'github_add_comment')!;
    expect(comment.url).toBe('https://api.github.com/repos/{repo}/issues/{number}/comments');
    expect(comment.headers?.authorization).toBe('Bearer {{secrets.CONN_GITHUB_TOKEN}}');
  });
});

describe('linear tool template', () => {
  const linear = TOOL_TEMPLATES.find((t) => t.id === 'linear')!;
  const tool = (name: string) => linear.tools.find((t) => t.name === name)! as ToolDef;
  const secrets = linear.secrets({ api_key: 'lin_api_x' });
  const fetchMock = vi.fn();
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the personal key raw — Linear rejects a Bearer prefix', async () => {
    await callTool(tool('linear_teams'), {}, secrets);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('lin_api_x');
    expect(sentBody().query).toContain('teams');
  });

  it('search is identity-bound and passes the filter through as typed JSON', async () => {
    const t = tool('linear_search_issues');
    expect(t.identity).toBe(true);
    await callTool(
      t,
      { filter: '{"and":[{"description":{"contains":"me@x.com"}},{"title":{"contains":"checkout"}}]}' },
      secrets,
    );
    expect(sentBody().variables.f.and[1].title.contains).toBe('checkout');
  });

  it('get_issue mechanically scopes by issue number + verified email', async () => {
    const t = tool('linear_get_issue');
    expect(t.identity).toBe(true);
    await callTool(t, { number: '123', email: 'me@x.com' }, secrets);
    const f = sentBody().variables.f;
    expect(f.and[0].number.eq).toBe(123); // bare number, not a string
    expect(f.and[1].description.contains).toBe('me@x.com');
  });

  it('create_issue embeds the verified email and keeps priority numeric', async () => {
    const t = tool('linear_create_issue');
    expect(t.identity).toBe(true);
    await callTool(
      t,
      {
        team_id: 'team-uuid',
        title: 'Checkout 500s',
        customer_email: 'me@x.com',
        description: 'Payment step returns a 500',
        priority: '2',
      },
      secrets,
    );
    const input = sentBody().variables.input;
    expect(input.teamId).toBe('team-uuid');
    expect(input.priority).toBe(2);
    expect(input.description).toContain('me@x.com');
    expect(input.description).toContain('Payment step returns a 500');
  });

  it('create_issue omits priority cleanly when unset', async () => {
    await callTool(
      tool('linear_create_issue'),
      { team_id: 't', title: 'x', customer_email: 'me@x.com', description: 'd' },
      secrets,
    );
    expect(sentBody().variables.input.priority).toBeNull();
  });

  it('add_comment is approval-gated', async () => {
    const t = tool('linear_add_comment');
    expect(t.approval).toBe(true);
    await callTool(t, { issue_id: 'uuid-1', comment: 'Customer followed up' }, secrets);
    expect(sentBody().variables.input).toEqual({ issueId: 'uuid-1', body: 'Customer followed up' });
  });
});

describe('catalog bodyTemplates', () => {
  it('every embedded GraphQL document has balanced braces', () => {
    // fetch-mocked tests only see the JSON envelope — a stray '}' in the
    // query string still ships and the provider answers GRAPHQL_PARSE_FAILED
    for (const t of TOOL_TEMPLATES.flatMap((x) => x.tools)) {
      const m = t.bodyTemplate?.match(/"query":"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      let depth = 0;
      for (const ch of m[1]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        expect(depth, `${t.name} query closes early`).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${t.name} query braces unbalanced`).toBe(0);
    }
  });
});
