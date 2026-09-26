import type { ToolTemplateInfo } from '@janis/shared';

interface CatalogTool {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** 'form' = application/x-www-form-urlencoded (Stripe); default JSON. */
  bodyFormat?: 'json' | 'form';
  /** Mutating/money-moving calls — the agent proposes, a teammate approves. */
  approval?: boolean;
}

export interface ToolTemplate {
  id: string;
  name: string;
  category: string;
  blurb: string;
  docs_url?: string;
  /** Credential/setup inputs the user fills in at connect time. */
  fields: { key: string; label: string; placeholder?: string; help?: string }[];
  /** name → value stored in agent_secrets at install. Derived values are
   *  allowed (e.g. Zendesk basic-auth = base64(email/token:key)). */
  secrets: (fields: Record<string, string>) => Record<string, string>;
  /** OAuth client-credentials connection — the credentials payload is stored
   *  encrypted on agent_connections and the runtime mints/caches access
   *  tokens, exposed to tools as {{secrets.CONN_<PROVIDER>_TOKEN}}. */
  connection?: {
    provider: string;
    label: (fields: Record<string, string>) => string;
    credentials: (fields: Record<string, string>) => Record<string, string>;
  };
  tools: CatalogTool[];
}

/** Public catalog view — never ships the secrets function or full tool defs. */
export function templateInfo(t: ToolTemplate): ToolTemplateInfo {
  const { tools, connection, ...rest } = t;
  return {
    ...rest,
    auth: connection ? 'oauth' : 'secrets',
    tools: tools.map(({ name, description, approval }) => ({ name, description, approval })),
  };
}

const normHost = (v: string, suffix?: string) => {
  let h = v.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (suffix && !h.includes('.')) h += suffix;
  return h;
};

export const TOOL_TEMPLATES: ToolTemplate[] = [
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'E-commerce',
    blurb: 'Look up orders and a customer’s order history — answers "where is my order".',
    docs_url: 'https://shopify.dev/docs/api/admin-rest',
    fields: [
      { key: 'shop', label: 'Shop domain', placeholder: 'mystore.myshopify.com' },
      {
        key: 'token',
        label: 'Admin API access token',
        placeholder: 'e.g. shpat_…',
        help: 'Shopify admin → Settings → Apps and sales channels → Develop apps (enable app development if prompted) → Create an app → Admin API scopes: read_orders + write_orders (write covers cancels/draft orders/tags) → Install app → API credentials → copy the Admin API access token.',
      },
    ],
    secrets: (f) => ({
      SHOPIFY_SHOP: normHost(f.shop, '.myshopify.com'),
      SHOPIFY_TOKEN: f.token.trim(),
    }),
    tools: [
      {
        name: 'shopify_lookup_order',
        description:
          'Look up a Shopify order by order number. Returns status, items, totals and fulfilment/tracking info.',
        method: 'GET',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2024-10/orders.json?status=any&limit=1&fields=id,name,order_number,email,financial_status,fulfillment_status,total_price,currency,created_at,cancelled_at,line_items,fulfillments&name={order_number}',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        params: { order_number: 'the order number including the # prefix, e.g. #1234' },
      },
      {
        name: 'shopify_customer_orders',
        description: 'List the most recent Shopify orders for a customer email address.',
        method: 'GET',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2024-10/orders.json?status=any&limit=5&fields=id,name,order_number,email,financial_status,fulfillment_status,total_price,currency,created_at&email={email}',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        params: { email: 'customer email address' },
      },
      {
        name: 'shopify_cancel_order',
        description:
          'Cancel a Shopify order by its numeric order id (from shopify_lookup_order). Money-moving — needs a teammate to approve.',
        method: 'POST',
        approval: true,
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2024-10/orders/{order_id}/cancel.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        params: { order_id: 'numeric Shopify order id (not the #number) from shopify_lookup_order' },
      },
      {
        name: 'shopify_create_draft_order',
        description:
          'Create a Shopify draft order (custom sale, phone order, invoice). Needs a teammate to approve.',
        method: 'POST',
        approval: true,
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2024-10/draft_orders.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        params: {
          draft_order:
            'JSON object, e.g. {"line_items":[{"title":"…","price":"19.99","quantity":1}],"email":"customer@email.com","note":"…"}',
        },
      },
      {
        name: 'shopify_update_order_tags',
        description: 'Set the tags on a Shopify order by numeric order id (from shopify_lookup_order).',
        method: 'PUT',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2024-10/orders/{order_id}.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        params: {
          order_id: 'numeric Shopify order id',
          order: 'JSON object, e.g. {"id":123,"tags":"vip, follow-up"} — tags is a comma-separated string',
        },
      },
    ],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    blurb: 'Find and create contacts, and open tickets from escalations.',
    docs_url: 'https://developers.hubspot.com/docs/api/overview',
    fields: [
      {
        key: 'token',
        label: 'Private app access token',
        placeholder: 'e.g. pat-…',
        help: 'Settings → Integrations → Private Apps → Create a private app (newer accounts: Development → Legacy apps → Create legacy app → Private). Scopes needed: crm.objects.contacts.read, tickets write.',
      },
    ],
    secrets: (f) => ({ HUBSPOT_TOKEN: f.token.trim() }),
    tools: [
      {
        name: 'hubspot_get_contact',
        description: 'Look up a HubSpot contact by email address.',
        method: 'GET',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/{email}?idProperty=email&properties=email,firstname,lastname,phone,company,lifecyclestage,hs_lead_status',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: { email: 'contact email address' },
      },
      {
        name: 'hubspot_search_contacts',
        description: 'Search HubSpot contacts with a filterGroups JSON array (e.g. by name or company).',
        method: 'POST',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: {
          filterGroups:
            'JSON array, e.g. [{"filters":[{"propertyName":"email","operator":"EQ","value":"a@b.com"}]}]',
        },
      },
      {
        name: 'hubspot_create_ticket',
        description: 'Create a HubSpot support ticket for an issue the agent could not resolve.',
        method: 'POST',
        url: 'https://api.hubapi.com/crm/v3/objects/tickets',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: {
          properties:
            'JSON object, e.g. {"subject":"Refund request","content":"…","hs_ticket_priority":"HIGH"}',
        },
      },
      {
        name: 'hubspot_update_contact',
        description: 'Update properties on a HubSpot contact — phone, lifecycle stage, notes.',
        method: 'PATCH',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/{contact_id}',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: {
          contact_id: 'HubSpot contact id from hubspot_get_contact or hubspot_search_contacts',
          properties:
            'JSON object of properties to update, e.g. {"phone":"+1…","lifecyclestage":"customer"}',
        },
      },
    ],
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    category: 'Support desk',
    blurb: 'Search existing tickets and create tickets on escalation.',
    docs_url: 'https://developer.zendesk.com/api-reference/',
    fields: [
      { key: 'subdomain', label: 'Subdomain', placeholder: 'yourcompany.zendesk.com' },
      { key: 'email', label: 'Agent email', placeholder: 'you@company.com' },
      {
        key: 'api_token',
        label: 'API token',
        help: 'Admin Center → Apps and integrations → APIs → API tokens → Add API token (enable "Token access" under APIs → Zendesk API → Settings first). Heads-up: Zendesk retires API tokens April 2027 — OAuth migration will be needed later.',
      },
    ],
    secrets: (f) => ({
      ZENDESK_SUBDOMAIN: normHost(f.subdomain).replace(/\.zendesk\.com$/, ''),
      ZENDESK_AUTH: Buffer.from(`${f.email.trim()}/token:${f.api_token.trim()}`).toString('base64'),
    }),
    tools: [
      {
        name: 'zendesk_search',
        description: 'Search Zendesk tickets and users, e.g. by requester email or keyword.',
        method: 'GET',
        url: 'https://{{secrets.ZENDESK_SUBDOMAIN}}.zendesk.com/api/v2/search.json?query={query}',
        headers: { authorization: 'Basic {{secrets.ZENDESK_AUTH}}' },
        params: {
          query: 'Zendesk search query, e.g. "type:ticket requester:customer@email.com"',
        },
      },
      {
        name: 'zendesk_create_ticket',
        description: 'Create a Zendesk ticket for an issue the agent could not resolve.',
        method: 'POST',
        url: 'https://{{secrets.ZENDESK_SUBDOMAIN}}.zendesk.com/api/v2/tickets.json',
        headers: { authorization: 'Basic {{secrets.ZENDESK_AUTH}}' },
        params: {
          ticket:
            'JSON object, e.g. {"subject":"…","comment":{"body":"…"},"requester":{"name":"…","email":"…"},"priority":"normal"}',
        },
      },
    ],
  },
  {
    id: 'zendesk-oauth',
    name: 'Zendesk (OAuth)',
    category: 'Support desk',
    blurb:
      'Same ticket tools via an OAuth client — the future-proof auth; Zendesk retires API tokens April 2027.',
    docs_url: 'https://developer.zendesk.com/api-reference/sales-force-service-apps/',
    fields: [
      { key: 'subdomain', label: 'Subdomain', placeholder: 'yourcompany.zendesk.com' },
      {
        key: 'client_id',
        label: 'OAuth client ID',
        help: 'Admin Center → Apps and integrations → OAuth → OAuth clients → Add client → grant type: client credentials. The client_id is shown after saving.',
      },
      {
        key: 'client_secret',
        label: 'OAuth client secret',
        help: 'Shown once on the OAuth client details page — copy it before leaving.',
      },
    ],
    secrets: (f) => ({
      ZENDESK_OAUTH_SUBDOMAIN: normHost(f.subdomain).replace(/\.zendesk\.com$/, ''),
    }),
    connection: {
      provider: 'zendesk-oauth',
      label: (f) => `${normHost(f.subdomain).replace(/\.zendesk\.com$/, '')}.zendesk.com`,
      credentials: (f) => ({
        host: `${normHost(f.subdomain).replace(/\.zendesk\.com$/, '')}.zendesk.com`,
        client_id: f.client_id.trim(),
        client_secret: f.client_secret.trim(),
      }),
    },
    tools: [
      {
        name: 'zendesk_oauth_search',
        description: 'Search Zendesk tickets and users, e.g. by requester email or keyword.',
        method: 'GET',
        url: 'https://{{secrets.ZENDESK_OAUTH_SUBDOMAIN}}.zendesk.com/api/v2/search.json?query={query}',
        headers: { authorization: 'Bearer {{secrets.CONN_ZENDESK_OAUTH_TOKEN}}' },
        params: {
          query: 'Zendesk search query, e.g. "type:ticket requester:customer@email.com"',
        },
      },
      {
        name: 'zendesk_oauth_create_ticket',
        description: 'Create a Zendesk ticket for an issue the agent could not resolve.',
        method: 'POST',
        url: 'https://{{secrets.ZENDESK_OAUTH_SUBDOMAIN}}.zendesk.com/api/v2/tickets.json',
        headers: { authorization: 'Bearer {{secrets.CONN_ZENDESK_OAUTH_TOKEN}}' },
        params: {
          ticket:
            'JSON object, e.g. {"subject":"…","comment":{"body":"…"},"requester":{"name":"…","email":"…"},"priority":"normal"}',
        },
      },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'CRM',
    blurb: 'Query contacts, accounts and cases — answers account questions and logs escalations.',
    docs_url: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_client_credentials_setup.htm',
    fields: [
      {
        key: 'instance',
        label: 'Instance host',
        placeholder: 'mycompany.my.salesforce.com',
        help: 'Your org’s My Domain host — Setup → My Domain.',
      },
      {
        key: 'client_id',
        label: 'Connected app consumer key',
        help: 'Setup → App Manager → New Connected App → enable OAuth + "Client Credentials Flow" → copy Consumer Key. Requires API-enabled edition (Enterprise+).',
      },
      {
        key: 'client_secret',
        label: 'Connected app consumer secret',
        help: 'Same connected app → Manage Consumer Details → Consumer Secret.',
      },
    ],
    secrets: (f) => ({ SALESFORCE_HOST: normHost(f.instance) }),
    connection: {
      provider: 'salesforce',
      label: (f) => normHost(f.instance),
      credentials: (f) => ({
        host: normHost(f.instance),
        client_id: f.client_id.trim(),
        client_secret: f.client_secret.trim(),
      }),
    },
    tools: [
      {
        name: 'salesforce_find_contact',
        description: 'Find a Salesforce contact by email — returns name, account and phone.',
        method: 'GET',
        url: "https://{{secrets.SALESFORCE_HOST}}/services/data/v62.0/query?q=SELECT+Id,Name,Email,Phone,Account.Name+FROM+Contact+WHERE+Email='{email}'",
        headers: { authorization: 'Bearer {{secrets.CONN_SALESFORCE_TOKEN}}' },
        params: { email: 'customer email address' },
      },
      {
        name: 'salesforce_query',
        description: 'Run a read-only SOQL query against Salesforce for account, case or order lookups.',
        method: 'GET',
        url: 'https://{{secrets.SALESFORCE_HOST}}/services/data/v62.0/query?q={soql}',
        headers: { authorization: 'Bearer {{secrets.CONN_SALESFORCE_TOKEN}}' },
        params: {
          soql: "SOQL SELECT query, e.g. SELECT Id, Subject, Status FROM Case WHERE Contact.Email = 'a@b.com'",
        },
      },
    ],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    category: 'Web search',
    blurb: 'Let the agent search the web for answers, links and current information.',
    docs_url: 'https://brave.com/search/api/',
    fields: [
      {
        key: 'api_key',
        label: 'API key',
        placeholder: 'e.g. BSA…',
        help: 'api-dashboard.search.brave.com → subscribe to a plan (Free tier available; a card is required) → API Keys → Add API key → copy the token.',
      },
    ],
    secrets: (f) => ({ BRAVE_API_KEY: f.api_key.trim() }),
    tools: [
      {
        name: 'web_search',
        description: 'Search the web for current information, links, products or answers.',
        method: 'GET',
        url: 'https://api.search.brave.com/res/v1/web/search?q={q}&count=5',
        headers: { 'X-Subscription-Token': '{{secrets.BRAVE_API_KEY}}' },
        params: { q: 'search query' },
      },
    ],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Billing',
    blurb: 'Look up customers and their charges — answers "why was I charged" questions.',
    docs_url: 'https://docs.stripe.com/api',
    fields: [
      {
        key: 'restricted_key',
        label: 'Restricted API key',
        placeholder: 'e.g. rk_live_…',
        help: 'Dashboard → Developers → API keys → Create restricted key (asks for 2FA) → grant Read on Customers, Charges, Subscriptions, Prices and Products; add Write on Refunds and Subscriptions if you want the agent to propose those actions.',
      },
    ],
    secrets: (f) => ({ STRIPE_RESTRICTED_KEY: f.restricted_key.trim() }),
    tools: [
      {
        name: 'stripe_find_customer',
        description: 'Find a Stripe customer by email address.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/customers?email={email}&limit=3',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { email: 'customer email address' },
      },
      {
        name: 'stripe_customer_charges',
        description: 'List recent charges for a Stripe customer id (cus_…) from stripe_find_customer.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/charges?customer={customer_id}&limit=5',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { customer_id: 'Stripe customer id, e.g. cus_…' },
      },
      {
        name: 'stripe_customer_subscriptions',
        description:
          'List a customer\'s subscriptions — returns each sub_… id with status, current period, and its subscription items (si_…) with the price/plan on each.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/subscriptions?customer={customer_id}&status=all&limit=10&expand[]=data.items.data.price',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { customer_id: 'Stripe customer id, e.g. cus_…' },
      },
      {
        name: 'stripe_list_products',
        description:
          'List active Stripe products — use this to resolve a plan name (e.g. "Pro") into a prod_… id before looking up its prices.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/products?active=true&limit=20',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
      },
      {
        name: 'stripe_list_prices',
        description:
          'List active prices for a Stripe product — returns price_… ids with amounts, currency and billing interval.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/prices?active=true&limit=20&product={product_id}&expand[]=data.product',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { product_id: 'Stripe product id prod_… from stripe_list_products' },
      },
      {
        name: 'stripe_create_refund',
        description:
          'Refund a Stripe charge or payment intent. Money-moving — needs a teammate to approve.',
        method: 'POST',
        bodyFormat: 'form',
        approval: true,
        url: 'https://api.stripe.com/v1/refunds',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: {
          charge: 'charge id ch_… from stripe_customer_charges (or use payment_intent instead)',
          amount: 'refund amount in cents — pass the charge\'s full amount for a full refund',
        },
      },
      {
        name: 'stripe_cancel_subscription',
        description:
          'Cancel a Stripe subscription at the end of the paid period. Needs a teammate to approve.',
        method: 'POST',
        bodyFormat: 'form',
        approval: true,
        url: 'https://api.stripe.com/v1/subscriptions/{subscription_id}',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: {
          subscription_id: 'subscription id sub_…',
          cancel_at_period_end: 'always "true" — cancels at period end, not immediately',
        },
      },
      {
        name: 'stripe_update_subscription',
        description:
          'Change the plan on a Stripe subscription — swaps a subscription item to a new price. Changes billing — needs a teammate to approve.',
        method: 'POST',
        bodyFormat: 'form',
        approval: true,
        url: 'https://api.stripe.com/v1/subscriptions/{subscription_id}',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: {
          subscription_id: 'subscription id sub_… from stripe_customer_subscriptions',
          'items[0][id]': 'existing subscription item id si_… being changed (from stripe_customer_subscriptions)',
          'items[0][price]': 'new price id price_… (from stripe_list_prices)',
          proration_behavior:
            '"always_invoice" (bill the difference now), "create_prorations" (apply at next invoice) or "none"',
        },
      },
    ],
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    category: 'Scheduling',
    blurb: 'Check booking availability and list bookings — schedule callbacks.',
    docs_url: 'https://cal.com/docs/api-reference',
    fields: [
      {
        key: 'api_key',
        label: 'API key',
        placeholder: 'e.g. cal_live_…',
        help: 'Cal.com → Settings → Developer → API Keys → + Add. Pick the longest expiry offered and copy the key — it is only shown once.',
      },
      {
        key: 'event_type_id',
        label: 'Event type ID',
        help: 'The numeric ID of the event type to check availability for — visible in the event type’s URL on your Cal.com dashboard.',
      },
    ],
    secrets: (f) => ({
      CALCOM_API_KEY: f.api_key.trim(),
      CALCOM_EVENT_TYPE: f.event_type_id.trim(),
    }),
    tools: [
      {
        name: 'calcom_availability',
        description: 'Check available booking slots for a date (YYYY-MM-DD).',
        method: 'GET',
        url: 'https://api.cal.com/v2/slots?eventTypeId={{secrets.CALCOM_EVENT_TYPE}}&start={date}&end={date}',
        headers: {
          authorization: 'Bearer {{secrets.CALCOM_API_KEY}}',
          'cal-api-version': '2024-08-13',
        },
        params: { date: 'date to check, YYYY-MM-DD' },
      },
      {
        name: 'calcom_list_bookings',
        description: 'List recent bookings to confirm whether a callback or meeting was scheduled.',
        method: 'GET',
        url: 'https://api.cal.com/v2/bookings?status=upcoming&take=10',
        headers: {
          authorization: 'Bearer {{secrets.CALCOM_API_KEY}}',
          'cal-api-version': '2024-08-13',
        },
      },
    ],
  },
  {
    id: 'itunes',
    name: 'iTunes Search',
    category: 'Media lookup',
    blurb: 'Find songs, albums and artists with real store links — no credentials needed.',
    docs_url: 'https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/',
    fields: [],
    secrets: () => ({}),
    tools: [
      {
        name: 'itunes_search',
        description:
          'Search Apple’s catalog for songs, albums or artists. Returns real links to share with the customer.',
        method: 'GET',
        url: 'https://itunes.apple.com/search?media=music&limit=3&term={term}',
        params: { term: 'search term — song, album or artist name' },
      },
    ],
  },
];
