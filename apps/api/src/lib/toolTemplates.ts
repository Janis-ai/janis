import type { ToolTemplateInfo } from '@janis/shared';
import type { ToolWidgetConfig } from './widgets.js';

interface CatalogTool {
  name: string;
  /** Short human label for the approval toggles, e.g. "Cancel subscription". */
  label: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** 'form' = application/x-www-form-urlencoded (Stripe); default JSON. */
  bodyFormat?: 'json' | 'form';
  /** Shaped JSON body — {param} args substitute as JSON values, {{secrets.*}}
   *  expand like headers (see ToolDef.bodyTemplate in toolExec). */
  bodyTemplate?: string;
  /** Mutating/money-moving calls — the agent proposes, a teammate approves. */
  approval?: boolean;
  /** Customer-record tool — args hard-bind to the conversation's verified
   *  identity at runtime (see ToolDef.identity in toolExec). */
  identity?: boolean;
  /** Live data binding — JSON results render as cards/options. */
  widget?: ToolWidgetConfig;
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
  /** Janis-owned OAuth app — the card renders a Connect link to this API
   *  path instead of a credentials form; the OAuth callback creates the
   *  agent_connection row AND installs the tools. */
  oauth_connect?: string;
  tools: CatalogTool[];
}

/** Public catalog view — never ships the secrets function or full tool defs. */
export function templateInfo(t: ToolTemplate): ToolTemplateInfo {
  const { tools, connection, ...rest } = t;
  return {
    ...rest,
    auth: connection ? 'oauth' : 'secrets',
    tools: tools.map(({ name, label, description, approval }) => ({ name, label, description, approval })),
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
    blurb: 'Track and look up orders, cancel, edit addresses, create draft orders — customers can buy and manage orders in chat.',
    docs_url: 'https://shopify.dev/docs/api/admin-graphql',
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
        label: 'Look up order',
        description:
          'Look up a Shopify order by order number + the email it was placed under — the pair verifies the shopper (same model as Shopify guest order tracking; a guest needs no sign-in). Returns status, items, totals, fulfilment/tracking info, the customer gid (customer.id — feed it to shopify_update_customer) and fulfillmentLineItem ids (feed them to shopify_request_return).',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!){orders(first:1,query:$q){nodes{id name email customer{id} displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} createdAt cancelledAt lineItems(first:10){nodes{title quantity}} fulfillments{status trackingInfo{number url company} fulfillmentLineItems(first:10){nodes{id quantity lineItem{title}}}}}}}","variables":{"q":"name:${order_number:text} email:${email:text}"}}',
        params: {
          order_number: 'the order number including the # prefix, e.g. #1234',
          email: 'the email the order was placed under — required alongside the order number',
        },
      },
      {
        name: 'shopify_customer_orders',
        label: 'Customer orders',
        description: 'List the most recent Shopify orders for the verified customer email address.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!){orders(first:5,query:$q,sortKey:CREATED_AT,reverse:true){nodes{id name email displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} createdAt}}}","variables":{"q":"email:${email:text}"}}',
        params: { email: "the verified customer's own email address" },
        identity: true,
      },
      {
        name: 'shopify_search_products',
        label: 'Search products',
        description:
          'Search or browse the Shopify product catalogue. Returns up to 12 product cards with images and prices, plus productsCount — the TRUE total of matching products (always quote THIS number when asked how many products there are, never the card count) and pageInfo. When productsCount exceeds the cards returned, say so — then either pass the endCursor as `after` for the next page ("show me more") or suggest narrowing the search. Each node also carries a short description you can summarise when they ask about a product, and variants.nodes[0].availableForSale — if it is FALSE the item is out of stock: say so plainly and do NOT move toward a purchase of it. TRUE means purchasable — NEVER call a product out of stock on a true or missing flag (untracked inventory returns true; a title like "Not Tracked" says nothing about stock). STOCK RULES — mechanically enforced on the cards: out-of-stock products are hidden from the rendered cards on browse/search calls UNLESS you pass include_unavailable:"1" — do that ONLY when the customer asked about a specific product by name (their card then renders with the Out of stock badge and you call it out: "it\'s out of stock right now — want the closest alternative?") or explicitly wants to see unavailable items. If an expected product is missing from a browse result, it may be out of stock — say so rather than claiming it doesn\'t exist. When you name a product in text that the cards don\'t show (out of stock or otherwise unbuyable), say why in the same breath ("the Gift Card is out of stock right now") — never present an unrendered product as if it were purchasable. Only products a storefront visitor can actually buy ever appear (draft, archived and unpublished products are filtered out mechanically — their page and cart links would be dead, so there is nothing to show); productsCount counts only those too. If the customer sends a PHOTO asking for something similar, describe what you see in concrete attributes (product type, colour, material, use) and pass those as the query plus limit:"1"–"3" so the shopper sees the closest match, not a page of neighbours — that is the photo-search path; never claim you cannot look at images when one is attached. On a Shopify storefront each rendered card also carries an "Add to cart" button the shopper can tap themselves — for a buy-it ask you can point them at it or at their cart (the /cart page on the store), and still create a draft order when they want you to do it all for them.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!,$after:String){productsCount(query:$q){count} products(first:12,query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{title handle vendor productType tags description(truncateAt:80) featuredImage{url} priceRangeV2{minVariantPrice{amount currencyCode}} variants(first:10){nodes{id availableForSale price}}}}}","variables":{"q":"${query:text} status:active published_status:published","after":${after?}}}',
        params: {
          query:
            'Shopify catalogue search string — use "title:*snowboard*" to match a keyword, or " product_type:…" / " vendor:…" to filter. Leave it empty ("") to browse the whole catalogue. The search is mechanically constrained to active products published to the Online Store — draft, archived and unpublished products NEVER appear (their product page and Add to cart would 404 anyway). If a customer names a product that comes back empty, it is not sold on the storefront — say it isn\'t available rather than claiming it never existed.',
          'after?':
            'optional — the previous result\'s pageInfo.endCursor; pass it to fetch the NEXT page when the customer asks for more. You MUST repeat the EXACT SAME `query` you used for the page before — the cursor is bound to it; a rephrased or emptied query silently restarts at page one and shows the same products again. Omit for the first page.',
          'include_unavailable?':
            'optional — ALWAYS pass "1" when the customer names a specific product or asks about availability of a named item: it can do no harm (in-stock results are unchanged) and it is the ONLY way an out-of-stock product can render its card — without it the row is filtered out and no card exists. Also pass it when they explicitly ask to see unavailable items. Omit only for browse/list requests — out-of-stock products are hidden from those cards. This relaxes STOCK only — unpublished/draft products are never returned at all.',
          'only_unavailable?':
            'optional — pass "1" when the customer asks to see JUST the out-of-stock / unavailable items ("what\'s out of stock?", "show me only sold-out products"): the rendered cards then contain ONLY the out-of-stock rows, each badged. Do not combine with include_unavailable.',
          'limit?':
            'optional — how many product cards to render (max 10). Omit for browse/list asks (shows up to 10). Pass "1"–"3" for a specific-product or photo-match ask so the shopper sees THE match, not a page of similar items.',
        },
        widget: {
          type: 'cards',
          items: 'data.products.nodes',
          link_label: 'View product',
          // One variant answers the price AND the Add button — the cheapest
          // available one ("from" price + a button that adds it). First-
          // variant pricing showed $24.95 for a product whose card read $9.95.
          pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
          availability: {
            field: '__v.availableForSale',
            unless_arg: 'include_unavailable',
            only_arg: 'only_unavailable',
          },
          row_limit_arg: 'limit',
          map: {
            title: 'title',
            subtitle: 'vendor',
            image: 'featuredImage.url',
            // Price the variant the Add button actually adds — minVariantPrice
            // can belong to a DIFFERENT variant (a $949.95 card adding a
            // $902.45 variant is a bait-and-switch the cart then exposes).
            // Variant price is a scalar Money; :money borrows the row's code.
            price: '{__v.price:money}',
            stock: '{__v.availableForSale:stock}',
            cart_variant_id: '{__v.id:gidnum}',
            link: 'https://{{secrets.SHOPIFY_SHOP}}/products/{handle}',
          },
        },
      },
      {
        name: 'shopify_cancel_order',
        label: 'Cancel order',
        description:
          'Cancel a Shopify order by its numeric order id (from shopify_lookup_order) — the same self-serve cancel a website offers: cancels with reason CUSTOMER, restocks items, notifies the customer. Only for orders that are not yet fulfilled; if the customer wants money back on a paid/fulfilled order that is a REFUND — escalate to a human instead of guessing.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!){orderCancel(orderId:$id,restock:true,reason:CUSTOMER,notifyCustomer:true){job{id} orderCancelUserErrors{field message}}}","variables":{"id":"gid://shopify/Order/${order_id:text}"}}',
        params: { order_id: 'numeric Shopify order id (not the #number) from shopify_lookup_order' },
      },
      {
        name: 'shopify_create_draft_order',
        label: 'Create draft order',
        description:
          'Create a Shopify draft order — the done-for-you checkout: it returns an invoiceUrl they tap to pay on the real checkout (addresses, shipping, payment all handled there). On a storefront where the shopper already added items via a card\'s Add to cart button, prefer pointing them to their cart (the /cart page on the store) — the cart preserves their other items; draft orders create a standalone checkout instead. When the customer has picked a product and confirmed they want it, call this straight away — do NOT re-show the product, do NOT ask them to confirm again, and do NOT gate it on email (the invoice page collects everything). When you ask first ("want me to set that up?"), end the offer with a BUTTON: chip like "BUTTON: Yes, check out" so the yes is one tap — never leave an offer as text alone. Never draft an item that shopify_search_products flagged out of stock (availableForSale:false) — say it\'s unavailable and offer an alternative instead. If a shopper wants a product the catalogue search can\'t surface (it isn\'t published to the storefront, so no card/link exists), a draft order still sells it — the invoice checkout does not depend on the online-store channel; use a variantId only if one came back in an earlier result, otherwise a custom line item with title+price. On success, give them the invoiceUrl as a "complete your purchase" link — present it as a link or button, never a bare URL. Draft-order totals use the store\'s list prices, which can differ from the market-adjusted price the shopper sees on the storefront — if the customer asks about a difference, explain the invoice uses standard pricing.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{id name invoiceUrl totalPriceSet{shopMoney{amount currencyCode}}} userErrors{field message}}}","variables":{"input":${draft_order}}}',
        params: {
          draft_order:
            'JSON object — a DraftOrderInput. For a catalogue product use its variantId from shopify_search_products (variants.nodes[0].id), e.g. {"lineItems":[{"variantId":"gid://shopify/ProductVariant/…","quantity":1}]}. Add "email" ONLY if the customer already gave it (then call shopify_send_invoice too so the pay link also reaches their inbox) — otherwise omit it, the invoice checkout collects their details. For items not in the catalogue use {"title":"…","originalUnitPrice":"19.99","quantity":1} instead.',
        },
        // The pay link renders as a real card button, not a bare URL.
        widget: {
          type: 'cards',
          items: 'data.draftOrderCreate.draftOrder',
          link_label: 'Complete your purchase',
          map: {
            title: 'Order {name} — ready to pay',
            price: '{totalPriceSet.shopMoney.amount:money}',
            link: '{invoiceUrl}',
          },
        },
      },
      {
        name: 'shopify_send_invoice',
        label: 'Send order invoice email',
        description:
          'Email the draft order\'s payment link to the customer — call right AFTER shopify_create_draft_order when the customer gave their email (which must also be on the draft order\'s "email" field). The emailed link opens the same checkout as the in-chat pay button.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!){draftOrderInvoiceSend(id:$id){draftOrder{id name invoiceUrl} userErrors{field message}}}","variables":{"id":"${draft_order_id:text}"}}',
        params: {
          draft_order_id:
            'the draftOrder.id gid returned by shopify_create_draft_order — gid://shopify/DraftOrder/…',
        },
      },
      {
        name: 'shopify_update_shipping_address',
        label: 'Update shipping address',
        description:
          'Change the shipping address on an unfulfilled Shopify order by numeric order id (from shopify_lookup_order).',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!,$a:MailingAddressInput!){orderUpdate(input:{id:$id,shippingAddress:$a}){order{id shippingAddress{address1 city province zip countryCodeV2}} userErrors{field message}}}","variables":{"id":"gid://shopify/Order/${order_id:text}","a":${shipping_address}}}',
        params: {
          order_id: 'numeric Shopify order id',
          shipping_address:
            'JSON object — a MailingAddressInput, e.g. {"address1":"123 Main St","city":"Austin","province":"TX","zip":"78701","countryCode":"US"}',
        },
      },
      {
        name: 'shopify_update_order_tags',
        label: 'Update order tags',
        description: 'Set the tags on a Shopify order by numeric order id (from shopify_lookup_order). Replaces all existing tags.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!,$tags:[String!]!){orderUpdate(input:{id:$id,tags:$tags}){order{id tags} userErrors{field message}}}","variables":{"id":"gid://shopify/Order/${order_id:text}","tags":${tags}}}',
        params: {
          order_id: 'numeric Shopify order id',
          tags: 'JSON array of tag strings, e.g. ["vip","chat-order"]',
        },
      },
      {
        name: 'shopify_update_customer',
        label: 'Update customer record',
        description:
          'Update the VERIFIED customer\'s own Shopify customer record — name, email, phone, note, marketing consent. Use when they ask to change their account details (self-serve, like the website account page). The customer id comes from shopify_lookup_order\'s customer.id — never invent it.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($input:CustomerInput!){customerUpdate(input:$input){customer{id email firstName lastName phone displayName} userErrors{field message}}}","variables":{"input":${customer}}}',
        params: {
          customer:
            'JSON CustomerInput — {"id":"gid://shopify/Customer/…" (from shopify_lookup_order customer.id) plus only the fields to change, e.g. {"phone":"+1…"} or {"email":"new@x.com"}',
        },
        identity: true,
      },
      {
        name: 'shopify_request_return',
        label: 'Request a return',
        description:
          'File a return request on a fulfilled Shopify order — the store-side equivalent of the customer returns portal. Flow: shopify_lookup_order → pick the fulfillmentLineItems to return → call this with orderId + returnLineItems. A teammate approves before it\'s filed; tell the customer their request is submitted for review, not confirmed. For an EXCHANGE ("swap for a different size"), file this for the item going back, then offer to create a draft order for the replacement — that pair is the exchange.',
        approval: true,
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($input:ReturnRequestInput!){returnRequest(input:$input){returnRequest{id status} userErrors{field message}}}","variables":{"input":${return_request}}}',
        params: {
          return_request:
            'JSON ReturnRequestInput — {"orderId":"gid://shopify/Order/…","returnLineItems":[{"fulfillmentLineItemId":"gid://shopify/FulfillmentLineItem/…","quantity":1,"customerNote":"…"}]} — ids come from shopify_lookup_order (order.id + fulfillments[].fulfillmentLineItems[].id)',
        },
      },
      {
        name: 'shopify_create_discount',
        label: 'Create discount code',
        description:
          'Create a one-off Shopify discount code — the "save the sale" move when a shopper hesitates. A teammate approves before the code goes live; on approval the result carries the code to share with the customer.',
        approval: true,
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($d:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$d){codeDiscountNode{id codeDiscount{__typename ... on DiscountCodeBasic{codes(first:1){nodes{code}}}}} userErrors{field message}}}","variables":{"d":${discount}}}',
        params: {
          discount:
            'JSON DiscountCodeBasicInput — {"title":"…","code":"CHAT10","customerGets":{"value":{"percentage":0.1},"items":{"all":true}},"customerSelection":{"all":true},"usageLimit":1}. percentage is 0–1 (0.1 = 10%).',
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
        label: 'Get contact',
        description: 'Look up a HubSpot contact by email address.',
        method: 'GET',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/{email}?idProperty=email&properties=email,firstname,lastname,phone,company,lifecyclestage,hs_lead_status',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: { email: "the verified customer's own email address" },
        identity: true,
      },
      {
        name: 'hubspot_search_contacts',
        label: 'Search contacts',
        description: 'Search HubSpot contacts with a filterGroups JSON array — must filter on the verified customer email.',
        method: 'POST',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: {
          filterGroups:
            'JSON array, e.g. [{"filters":[{"propertyName":"email","operator":"EQ","value":"a@b.com"}]}]',
        },
        identity: true,
      },
      {
        name: 'hubspot_create_ticket',
        label: 'Create ticket',
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
        label: 'Update contact',
        description: 'Update properties on a HubSpot contact — phone, lifecycle stage, notes.',
        method: 'PATCH',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/{contact_id}',
        headers: { authorization: 'Bearer {{secrets.HUBSPOT_TOKEN}}' },
        params: {
          contact_id: 'HubSpot contact id from hubspot_get_contact or hubspot_search_contacts',
          properties:
            'JSON object of properties to update, e.g. {"phone":"+1…","lifecyclestage":"customer"}',
        },
        identity: true,
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
        label: 'Search',
        description: 'Search Zendesk tickets and users — must scope the query to the verified customer (e.g. requester:their-verified-email).',
        method: 'GET',
        url: 'https://{{secrets.ZENDESK_SUBDOMAIN}}.zendesk.com/api/v2/search.json?query={query}',
        headers: { authorization: 'Basic {{secrets.ZENDESK_AUTH}}' },
        params: {
          query: 'Zendesk search query, e.g. "type:ticket requester:customer@email.com"',
        },
        identity: true,
      },
      {
        name: 'zendesk_create_ticket',
        label: 'Create ticket',
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
        label: 'Search',
        description: 'Search Zendesk tickets and users — must scope the query to the verified customer (e.g. requester:their-verified-email).',
        method: 'GET',
        url: 'https://{{secrets.ZENDESK_OAUTH_SUBDOMAIN}}.zendesk.com/api/v2/search.json?query={query}',
        headers: { authorization: 'Bearer {{secrets.CONN_ZENDESK_OAUTH_TOKEN}}' },
        params: {
          query: 'Zendesk search query, e.g. "type:ticket requester:customer@email.com"',
        },
        identity: true,
      },
      {
        name: 'zendesk_oauth_create_ticket',
        label: 'Create ticket',
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
        label: 'Find contact',
        description: 'Find a Salesforce contact by email — returns name, account and phone.',
        method: 'GET',
        url: "https://{{secrets.SALESFORCE_HOST}}/services/data/v62.0/query?q=SELECT+Id,Name,Email,Phone,Account.Name+FROM+Contact+WHERE+Email='{email}'",
        headers: { authorization: 'Bearer {{secrets.CONN_SALESFORCE_TOKEN}}' },
        params: { email: "the verified customer's own email address" },
        identity: true,
      },
      {
        name: 'salesforce_query',
        label: 'Run query',
        description: 'Run a read-only SOQL query against Salesforce — must be scoped to the verified customer (e.g. WHERE Contact.Email = their verified address).',
        method: 'GET',
        url: 'https://{{secrets.SALESFORCE_HOST}}/services/data/v62.0/query?q={soql}',
        headers: { authorization: 'Bearer {{secrets.CONN_SALESFORCE_TOKEN}}' },
        params: {
          soql: "SOQL SELECT query, e.g. SELECT Id, Subject, Status FROM Case WHERE Contact.Email = 'a@b.com'",
        },
        identity: true,
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
        label: 'Web search',
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
    docs_url: 'https://docs.stripe.com/keys#limit-access',
    fields: [
      {
        key: 'restricted_key',
        label: 'Restricted API key',
        placeholder: 'e.g. rk_live_… (rk_test_… while testing)',
        help: 'Stripe Dashboard → Developers → API keys → Create restricted key → name it e.g. "janis-agent" → permissions: Read on Customers, Charges, Products; Write on Prices and Subscriptions (plan changes/cancels) — add Write on Refunds too if the agent may propose them. Reads run unattended; writes wait for approval — toggle per action once connected.',
      },
    ],
    secrets: (f) => ({ STRIPE_RESTRICTED_KEY: f.restricted_key.trim() }),
    tools: [
      {
        name: 'stripe_find_customer',
        label: 'Find customer',
        description: "Find a Stripe customer — only the verified customer's own email address.",
        method: 'GET',
        url: 'https://api.stripe.com/v1/customers?email={email}&limit=3',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { email: "the verified customer's own email address" },
        identity: true,
      },
      {
        name: 'stripe_customer_charges',
        label: 'List charges',
        description: 'List recent charges for a Stripe customer id (cus_…) from stripe_find_customer.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/charges?customer={customer_id}&limit=5',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { customer_id: 'Stripe customer id, e.g. cus_…' },
        identity: true,
      },
      {
        name: 'stripe_customer_subscriptions',
        label: 'List subscriptions',
        description:
          'List a customer\'s subscriptions — returns each sub_… id with status, current period, and its subscription items (si_…) with the price/plan on each.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/subscriptions?customer={customer_id}&status=all&limit=10&expand[]=data.items.data.price',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { customer_id: 'Stripe customer id, e.g. cus_…' },
        identity: true,
      },
      {
        name: 'stripe_list_products',
        label: 'List products',
        description:
          'List active Stripe products — use this to resolve a plan name (e.g. "Pro") into a prod_… id before looking up its prices.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/products?active=true&limit=20',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        widget: {
          type: 'cards',
          items: 'data',
          map: { title: 'name', subtitle: 'description', image: 'images.0' },
        },
      },
      {
        name: 'stripe_list_prices',
        label: 'List prices',
        description:
          'List active prices for a Stripe product — returns price_… ids with amounts, currency and billing interval.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/prices?active=true&limit=20&product={product_id}&expand[]=data.product',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        params: { product_id: 'Stripe product id prod_… from stripe_list_products' },
      },
      {
        name: 'stripe_create_refund',
        label: 'Create refund',
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
        identity: true,
      },
      {
        name: 'stripe_cancel_subscription',
        label: 'Cancel subscription',
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
        identity: true,
      },
      {
        name: 'stripe_update_subscription',
        label: 'Update subscription',
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
        identity: true,
      },
    ],
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    category: 'Scheduling',
    blurb:
      'Check real slot availability, book the appointment in-chat, and list bookings — confirmations come from Cal.com.',
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
        label: 'Check availability',
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
        name: 'calcom_create_booking',
        label: 'Book appointment',
        description:
          'Book a real appointment on the configured event type — only call after the customer picked a start time calcom_availability returned AND confirmed their name and email. Cal.com emails the confirmation to the attendee.',
        method: 'POST',
        url: 'https://api.cal.com/v2/bookings',
        headers: {
          authorization: 'Bearer {{secrets.CALCOM_API_KEY}}',
          'cal-api-version': '2024-08-13',
        },
        bodyTemplate:
          '{"eventTypeId":{{secrets.CALCOM_EVENT_TYPE}},"start":{start},"attendee":{"name":{name},"email":{email},"timeZone":{time_zone}}}',
        params: {
          start:
            'booking start — ISO 8601 UTC, e.g. 2026-10-15T14:00:00Z — must be a start time calcom_availability returned',
          name: "the customer's full name",
          email: "the customer's email — the booking confirmation goes here",
          time_zone:
            "the customer's IANA timezone, e.g. America/New_York — ask or infer from their city; a wrong zone books the wrong wall-clock time",
        },
      },
      {
        name: 'calcom_list_bookings',
        label: 'List bookings',
        description: 'List recent bookings to confirm whether a callback or meeting was scheduled.',
        method: 'GET',
        url: 'https://api.cal.com/v2/bookings?status=upcoming&take=10&attendeeEmail={email}',
        headers: {
          authorization: 'Bearer {{secrets.CALCOM_API_KEY}}',
          'cal-api-version': '2024-08-13',
        },
        params: { email: "the verified customer's own email address" },
        identity: true,
      },
    ],
  },
  {
    id: 'calendly',
    name: 'Calendly',
    category: 'Scheduling',
    blurb:
      'Share booking links, check real slot availability, and look up a customer’s scheduled events — cancellations wait for teammate approval.',
    docs_url: 'https://developer.calendly.com/api-docs',
    fields: [
      {
        key: 'api_key',
        label: 'Personal access token',
        placeholder: 'e.g. eyJraWQiOi…',
        help: 'Calendly → Integrations & apps → API and webhooks → Personal access tokens → Generate new token → copy it — it is only shown once.',
      },
    ],
    secrets: (f) => ({ CALENDLY_TOKEN: f.api_key.trim() }),
    tools: [
      {
        name: 'calendly_me',
        label: 'Get account',
        description:
          'Get the connected Calendly account — returns the user_uri (resource.uri) the other Calendly tools need. Call this first.',
        method: 'GET',
        url: 'https://api.calendly.com/users/me',
        headers: { authorization: 'Bearer {{secrets.CALENDLY_TOKEN}}' },
      },
      {
        name: 'calendly_event_types',
        label: 'Event types',
        description:
          'List the account’s active event types with their booking links — renders as tappable cards the customer books from. Needs user_uri from calendly_me.',
        method: 'GET',
        url: 'https://api.calendly.com/event_types?user={user_uri}&active=true&count=20',
        headers: { authorization: 'Bearer {{secrets.CALENDLY_TOKEN}}' },
        params: { user_uri: 'the resource.uri returned by calendly_me' },
        widget: {
          type: 'cards',
          items: 'collection',
          map: { title: 'name', subtitle: 'description_plain', link: 'scheduling_url' },
          link_label: 'Book a time',
        },
      },
      {
        name: 'calendly_available_times',
        label: 'Check availability',
        description:
          'List open booking slots for one event type inside a window (7 days max). Needs the event_type uri from calendly_event_types.',
        method: 'GET',
        url: 'https://api.calendly.com/event_type_available_times?event_type={event_type_uri}&start_time={start_time}&end_time={end_time}',
        headers: { authorization: 'Bearer {{secrets.CALENDLY_TOKEN}}' },
        params: {
          event_type_uri:
            'event type uri from calendly_event_types, e.g. https://api.calendly.com/event_types/AAAA…',
          start_time: 'window start — ISO 8601 UTC, e.g. 2026-10-13T00:00:00Z',
          end_time: 'window end — ISO 8601 UTC, at most 7 days after start_time',
        },
      },
      {
        name: 'calendly_scheduled_events',
        label: 'Customer bookings',
        description:
          "List the verified customer's upcoming scheduled Calendly events — confirms whether they already booked. Needs user_uri from calendly_me.",
        method: 'GET',
        url: 'https://api.calendly.com/scheduled_events?user={user_uri}&invitee_email={email}&status=active&sort=start_time:asc&count=10',
        headers: { authorization: 'Bearer {{secrets.CALENDLY_TOKEN}}' },
        params: {
          user_uri: 'the resource.uri returned by calendly_me',
          email: "the verified customer's own email address",
        },
        identity: true,
      },
      {
        name: 'calendly_cancel_event',
        label: 'Cancel event',
        description:
          'Cancel a scheduled Calendly event by uuid — the last segment of the event uri from calendly_scheduled_events. Needs a teammate to approve.',
        method: 'POST',
        approval: true,
        url: 'https://api.calendly.com/scheduled_events/{event_uuid}/cancellation',
        headers: { authorization: 'Bearer {{secrets.CALENDLY_TOKEN}}' },
        params: {
          event_uuid: 'event uuid — the last path segment of the event uri from calendly_scheduled_events',
          reason: 'cancellation reason shown to the invitee',
        },
      },
    ],
  },
  // OAuth variant — same tool set, tokens minted from the agent_connection
  // the /calendly/callback flow stores (Janis-owned app, refresh-rotated).
  // Installing overwrites the PAT tools by name and vice-versa, so the
  // connect method is swappable without touching approvals.
  {
    id: 'calendly-connect',
    name: 'Calendly (OAuth)',
    category: 'Scheduling',
    blurb:
      'One-click Calendly connect — share booking links, check real slot availability, and look up a customer’s scheduled events.',
    docs_url: 'https://developer.calendly.com/api-docs',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'calendly',
      label: () => 'Calendly',
      credentials: () => ({}),
    },
    oauth_connect: '/api/calendly/connect',
    tools: [], // filled from the `calendly` template below — one source of truth
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
        label: 'Search',
        description:
          'Search Apple’s catalog for songs, albums or artists. Returns real links to share with the customer.',
        method: 'GET',
        url: 'https://itunes.apple.com/search?media=music&limit=3&term={term}',
        params: { term: 'search term — song, album or artist name' },
        // Results auto-render as tappable cards — artwork, track, album, and
        // a link out to Apple Music — so the model never has to retell the
        // list (or hand-roll a WIDGET: line that can fail to parse).
        widget: {
          type: 'cards',
          items: 'results',
          map: {
            title: 'trackName',
            subtitle: 'collectionName',
            image: 'artworkUrl100',
            link: 'trackViewUrl',
          },
          link_label: 'Apple Music ↗',
          // Apple's search is fuzzy — "now and then" returns filler tracks
          // sharing no tokens. Drop them so cards and narration stay honest.
          relevance: {
            arg: 'term',
            fields: ['trackName', 'collectionName', 'artistName'],
          },
        },
      },
    ],
  },
  {
    id: 'webhook',
    name: 'Webhook (Zapier / Make)',
    category: 'Automation',
    blurb:
      'Let the agent trigger anything — paste a Zapier/Make/n8n catch-hook URL and it POSTs the payload you describe. The escape hatch for every tool we don\'t ship.',
    docs_url: 'https://zapier.com/apps/webhook/integrations',
    fields: [
      {
        key: 'hook_url',
        label: 'Webhook URL',
        placeholder: 'https://hooks.zapier.com/hooks/catch/…',
        help: 'Zapier → Webhooks by Zapier → Catch Hook → copy the URL. Same for Make/n8n custom webhook triggers.',
      },
    ],
    secrets: (f) => ({ WEBHOOK_URL: f.hook_url.trim() }),
    tools: [
      {
        name: 'webhook_send',
        label: 'Send webhook',
        description:
          'POST a JSON payload to the configured automation webhook. Use it to trigger a Zap/Make/n8n workflow — log a lead, open a ticket, notify a channel — for systems with no dedicated integration.',
        method: 'POST',
        url: '{{secrets.WEBHOOK_URL}}',
        params: {
          data: 'JSON object with the fields the workflow expects, e.g. {"email":"…","summary":"…","conversation_id":"…"}',
        },
        approval: true,
      },
    ],
  },
];

// The OAuth Calendly card shares the PAT card's tool defs with the
// connection token swapped in — declared once, bound to either secret.
{
  const pat = TOOL_TEMPLATES.find((t) => t.id === 'calendly');
  const oauth = TOOL_TEMPLATES.find((t) => t.id === 'calendly-connect');
  if (pat && oauth) {
    oauth.tools = pat.tools.map((t) => ({
      ...t,
      headers: Object.fromEntries(
        Object.entries(t.headers ?? {}).map(([k, v]) => [
          k,
          v.replaceAll('{{secrets.CALENDLY_TOKEN}}', '{{secrets.CONN_CALENDLY_TOKEN}}'),
        ]),
      ),
    }));
  }
}

/** Names of catalog tools bound to the verified customer identity — applied
 *  by toolsFor at load time so tools installed before the flag existed are
 *  covered too (stored config.tools can't carry a stale unflagged def). */
export const IDENTITY_TOOL_NAMES = new Set(
  TOOL_TEMPLATES.flatMap((t) => t.tools.filter((x) => x.identity).map((x) => x.name)),
);

/** Every catalog tool name — lets toolsFor tell "catalog def changed"
 *  apart from "operator-authored custom tool" when deciding whether a
 *  stored flag is stale. */
export const CATALOG_TOOL_NAMES = new Set(
  TOOL_TEMPLATES.flatMap((t) => t.tools.map((x) => x.name)),
);

/** Catalog tool name → its widget binding — backfilled by toolsFor onto
 *  installs that predate the binding (stored config.tools won't carry it). */
export const TEMPLATE_WIDGETS = new Map<string, ToolWidgetConfig>(
  TOOL_TEMPLATES.flatMap((t) =>
    t.tools.filter((x) => x.widget).map((x) => [x.name, x.widget!] as const),
  ),
);

/** Catalog tool name → its bodyTemplate — backfilled by toolsFor so stored
 *  defs stripped by older schema versions (the AgentConfig zod used to drop
 *  the field on any config write) still execute the shaped request. */
export const TEMPLATE_BODY_TEMPLATES = new Map<string, string>(
  TOOL_TEMPLATES.flatMap((t) =>
    t.tools.filter((x) => x.bodyTemplate).map((x) => [x.name, x.bodyTemplate!] as const),
  ),
);
