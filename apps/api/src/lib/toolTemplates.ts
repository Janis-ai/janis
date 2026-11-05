import type { ToolTemplateInfo } from '@janis/shared';
import type { ToolWidgetConfig } from './widgets.js';
import { mcpListTools } from './mcpClient.js';

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
  /** 'mcp' → JSON-RPC tools/call against the MCP server at `url`. */
  transport?: 'mcp';
  /** Remote tool name on the MCP server. */
  mcpTool?: string;
  /** The server's own JSON Schema for args — handed to the model verbatim. */
  inputSchema?: Record<string, unknown>;
}

export interface ToolTemplate {
  id: string;
  name: string;
  category: string;
  blurb: string;
  docs_url?: string;
  /** Credential/setup inputs the user fills in at connect time. */
  fields: { key: string; label: string; placeholder?: string; help?: string; optional?: boolean }[];
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
  /** Manual-credentials template(s) this OAuth card subsumes — the
   *  console collapses them into credential fallbacks inside the card
   *  instead of separate cards (Zendesk has two: PAT + BYO OAuth). */
  manual?: string | string[];
  tools: CatalogTool[];
  /** Dynamic tool discovery — the template's `tools` is empty and the
   *  install route calls this (after secrets land) to enumerate the real
   *  defs: MCP servers expose their own tool list. Returning [] or
   *  throwing fails the install cleanly. */
  discoverTools?: (fields: Record<string, string>) => Promise<CatalogTool[]>;
}

/** Public catalog view — never ships the secrets function or full tool defs. */
export function templateInfo(t: ToolTemplate): ToolTemplateInfo {
  const { tools, connection, discoverTools, ...rest } = t;
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
        help: 'Shopify admin → Settings → Apps and sales channels → Develop apps (enable app development if prompted) → Create an app → Admin API scopes: read_orders + write_orders + read_products + read_reports (write covers cancels/draft orders/tags; read_reports unlocks exact sales analytics) → Install app → API credentials → copy the Admin API access token.',
      },
      {
        key: 'storefront_password',
        label: 'Storefront password (if enabled)',
        optional: true,
        placeholder: 'Online store password',
        help: 'Only needed if the store is password-protected (Online Store → Preferences → password protection). Lets the server check real shopper-facing availability/prices behind the wall.',
      },
    ],
    secrets: (f) => ({
      SHOPIFY_SHOP: normHost(f.shop, '.myshopify.com'),
      SHOPIFY_TOKEN: f.token.trim(),
      ...(f.storefront_password?.trim()
        ? { SHOPIFY_STOREFRONT_PASSWORD: f.storefront_password.trim() }
        : {}),
    }),
    tools: [
      {
        name: 'shopify_lookup_order',
        label: 'Look up order',
        description:
          'Look up a Shopify order by order number for the VERIFIED customer — pass the order number; the identity anchor is bound automatically (a signed-in shopper\'s Shopify customer id covers orders placed under ANY email — PayPal/Apple-Pay mismatches and POS orders with no email — otherwise their verified email). The customer must be verified first: signed-in shopper, email-channel sender, or send_verification_email + check_verification_code — and when the order was placed under a DIFFERENT address than the one on file, verify THAT address with a code (each verified address stays an anchor). Returns financial detail — subtotal, shipping, tax, discounts + discount codes, total, total refunded, transactions (kind/status/gateway), and per-refund breakdowns — items (up to 50), fulfilment tracking (number/url/carrier) plus carrier events (in transit / out for delivery / delivered / exception with timestamps), cancel reason, the customer gid (feed it to shopify_update_customer) and fulfillmentLineItem ids (feed them to shopify_request_return). Answer ONLY from fields present — an empty fulfillments array means nothing has shipped, empty events means no carrier updates yet. Draft orders (staff-created unpaid invoices, #D-prefixed) are NOT orders and never match — say it\'s still a draft/invoice and offer a human. A cancelled order carries cancelledAt + cancelReason — state that plainly rather than describing a shipment in progress.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!){orders(first:1,query:$q){nodes{id name email phone createdAt closedAt cancelledAt cancelReason customer{id} displayFinancialStatus displayFulfillmentStatus subtotalPriceSet{shopMoney{amount currencyCode}} totalShippingPriceSet{shopMoney{amount currencyCode}} totalTaxSet{shopMoney{amount currencyCode}} totalDiscountsSet{shopMoney{amount currencyCode}} discountCodes totalPriceSet{shopMoney{amount currencyCode}} totalRefundedSet{shopMoney{amount currencyCode}} shippingLine{title} shippingAddress{city} lineItems(first:50){nodes{title quantity requiresShipping originalUnitPriceSet{shopMoney{amount currencyCode}}}} fulfillments{status createdAt estimatedDeliveryAt deliveredAt trackingInfo{number url company} fulfillmentLineItems(first:10){nodes{id quantity lineItem{title}}} events(first:10){nodes{status happenedAt}}} refunds{id createdAt note totalRefundedSet{shopMoney{amount currencyCode}} refundLineItems(first:10){nodes{quantity lineItem{title}}}} returns(first:5){nodes{id status}} transactions(first:10){id kind status gateway}}}}","variables":{"q":"name:${order_number:text} (${email:clause=email:missing@identity.invalid} OR ${customer_id:clause=customer_id:0})"}}',
        params: {
          order_number: 'the order number including the # prefix, e.g. #1234',
          'email?':
            "optional — a VERIFIED customer address to scope the lookup (e.g. the address the order was placed under, after code-verifying it). Omit for signed-in shoppers — their customer id binds automatically.",
        },
        identity: true,
      },
      {
        name: 'shopify_customer_orders',
        label: 'Customer orders',
        description:
          'List the most recent Shopify orders for the verified customer — pass no args for a signed-in shopper (their Shopify customer id binds automatically and covers orders under ANY email, including POS orders with no address); pass `email` only to scope to a specific verified address. Use this — not order lookup — whenever the customer asks about "my order"/"my purchases" without giving a number, so they can pick the right one. "sales"/"deals"/"what\'s on sale" means discounted PRODUCTS for browsing — that is shopify_search_products with sale_only, never this tool.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!){orders(first:5,query:$q,sortKey:CREATED_AT,reverse:true){nodes{id name email displayFinancialStatus displayFulfillmentStatus cancelledAt shippingLine{title} shippingAddress{city} totalPriceSet{shopMoney{amount currencyCode}} createdAt}}}","variables":{"q":"(${email:clause=email:missing@identity.invalid} OR ${customer_id:clause=customer_id:0})"}}',
        params: {
          'email?': "optional — a VERIFIED customer address; omit for signed-in shoppers",
        },
        identity: true,
      },
      {
        name: 'shopify_search_products',
        label: 'Search products',
        description:
          'Search or browse the Shopify product catalogue. Returns up to 10 product cards with images and prices, plus productsCount — the TRUE total of matching products (always quote THIS number when asked how many products there are, never the card count) and pageInfo. Each product node carries: title, handle, status, vendor, productType, tags, totalInventory, description, onlineStoreUrl, featuredImage + media previews, collections, taxonomy category, seo, price + compareAt ranges, each variant\'s title/sku/price/compareAtPrice/availableForSale/inventoryQuantity/inventoryPolicy/requiresShipping/weight/options/tracked flag, and metafields — answer detail questions (stock counts, sizes/colours, materials, shipping, collections) from these fields; if an answer needs a field not returned, say you can\'t see it rather than guessing. For cheapest/most-expensive asks compare EVERY node\'s priceRangeV2.minVariantPrice — never guess from result order. When productsCount exceeds the cards returned, say so — then either pass the endCursor as `after` for the next page ("show me more") or suggest narrowing the search. Each node also carries a short description you can summarise when they ask about a product, and variants.nodes[0].availableForSale — if it is FALSE the item is out of stock: say so plainly and do NOT move toward a purchase of it. TRUE means purchasable — NEVER call a product out of stock on a true or missing flag (untracked inventory returns true; a title like "Not Tracked" says nothing about stock). STOCK RULES — mechanically enforced on the cards: out-of-stock products render WITH an Out of stock badge and no Add to cart button on every browse/search call by default; pass in_stock_only:"1" ONLY when the customer explicitly asks for available items, and only_unavailable:"1" when they ask for JUST the out-of-stock items. When a badged card renders, call it out as unavailable in your text — "the Gift Card is out of stock right now" — never describe a badged card as purchasable, and never count it toward an in-stock list. Only products a storefront visitor can actually buy ever appear (draft, archived and unpublished products are filtered out mechanically — their page and cart links would be dead, so there is nothing to show); productsCount counts only those too. If the customer sends a PHOTO asking for something similar, describe what you see in concrete attributes (product type, colour, material, use) and pass those as the query plus limit:"1"–"3" so the shopper sees the closest match, not a page of neighbours — never run a title: search on a photo ask (a title query only returns the product you already guessed and confirms nothing); that is the photo-search path — after the search you may be shown the candidates\' own product photos: compare them against the customer\'s image and name the closest match by title (or say none resembles it); never claim you cannot look at images when one is attached — but if a message notes an attachment\'s contents did not load, the file genuinely did not reach you: say it did not come through and ask for a smaller file or a description, do not guess what was in it. On a Shopify storefront each rendered card also carries an "Add to cart" button the shopper can tap themselves — for a buy-it ask you can point them at it or at their cart (the /cart page on the store), and still create a draft order when they want you to do it all for them. OPTIONS & SUBSCRIPTIONS: a card showing "from $X" has multiple variants — quote "from" and name the options line rather than one flat price; a card with NO Add to cart button has selling plans (subscription/preorder/prepaid/trial via sellingPlanGroups) or an unpicked choice — those show a "See options" button that opens an in-chat picker (variant pills + purchase-plan choices), so narrate the plan names ("also available as a weekly subscription, or preorder at 20% off") and tell the shopper to tap "See options" — never imply the card\'s default button adds a configured product. COLLECTIONS & RANKING: pass `collection` with a handle to scope to one collection (list handles via shopify_list_collections); `sort` ranks by newest/stock/vendor/etc. For "popular/bestseller" asks use shopify_analytics (exact; needs read_reports) or shopify_sales_stats (orders fallback) — there is no sales-rank sort, and NEVER invent a ranking. MARKETS: the result also carries shop.shipsToCountries — the markets the store actually delivers to. If the shopper\'s storefront market (in the conversation context) is NOT in that list, products can ALL appear unavailable/sold-out on their screen even with full stock — say the store doesn\'t currently deliver to their market instead of claiming items are out of stock, and never flatly deny that their location affects what the storefront shows them. PRICES: when the shopper\'s market is known each product/variant also carries contextualPricing — the market-adjusted price they\'d actually pay; quote THAT when present, and the plain price/compareAtPrice fields otherwise (store defaults, which the storefront may localize).',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!,$after:String,$sort:ProductSortKeys,$reverse:Boolean,$context:ContextualPricingContext){shop{shipsToCountries currencyCode} productsCount(query:$q){count} products(first:10,query:$q,after:$after,sortKey:$sort,reverse:$reverse){pageInfo{hasNextPage endCursor} edges{cursor} nodes{id title handle status vendor productType tags totalInventory description(truncateAt:120) onlineStoreUrl featuredImage{url} images(first:3){nodes{url}} collections(first:3){nodes{title}} category{fullName} options{name values} sellingPlanGroups(first:5){nodes{name sellingPlans(first:3){nodes{name}}}} seo{title description} priceRangeV2{minVariantPrice{amount currencyCode} maxVariantCompareAtPrice{amount currencyCode}} compareAtPriceRange{minVariantCompareAtPrice{amount currencyCode} maxVariantCompareAtPrice{amount currencyCode}} contextualPricing(context:$context){priceRange{minVariantPrice{amount currencyCode} maxVariantPrice{amount currencyCode}} maxVariantPricing{price{amount currencyCode} compareAtPrice{amount currencyCode}} minVariantPricing{price{amount currencyCode} compareAtPrice{amount currencyCode}}} variants(first:10){nodes{id title sku price compareAtPrice availableForSale inventoryQuantity inventoryPolicy selectedOptions{name value} contextualPricing(context:$context){price{amount currencyCode} compareAtPrice{amount currencyCode}} inventoryItem{tracked requiresShipping measurement{weight{value unit}}}}} metafields(first:10){nodes{namespace key value type}}}}}","variables":{"q":"${query:text} status:active published_status:published","after":${after?},"sort":${sort?},"reverse":${reverse?},"context":${shopper_context?}}}',
        params: {
          query:
            'Shopify catalogue search string — use "title:*snowboard*" to match a keyword, or " product_type:…" / " vendor:…" to filter. Leave it empty ("") to browse the whole catalogue. For "on sale"/"discounted"/"clearance" asks pass `sale_only` — do NOT hand-write compare_at_price clauses, the arg does it mechanically. Do NOT write collection_id:… yourself — pass the `collection` arg instead; a self-written clause ANDs against the resolved handle and can intersect to almost nothing. The search is mechanically constrained to active products published to the Online Store — draft, archived and unpublished products NEVER appear (their product page and Add to cart would 404 anyway). If a customer names a product that comes back empty, it is not sold on the storefront — say it isn\'t available rather than claiming it never existed. WHEN YOUR REPLY NAMES A PRODUCT — an item you identified from a photo, a product you call the match, alternates you list by name ("it could also be the Hydrogen or Oxygen") — the cards MUST contain those products: search each product\'s own name ("title:*Collection Snowboard Liquid*"), because a broad category query buries the named match behind unrelated filler and the carousel then contradicts your text.',
          'after?':
            'optional — the previous result\'s pageInfo.endCursor; pass it to fetch the NEXT page when the customer asks for more. You MUST repeat the EXACT SAME `query` you used for the page before — the cursor is bound to it; a rephrased or emptied query silently restarts at page one and shows the same products again. Omit for the first page.',
          'in_stock_only?':
            'optional — pass "1" ONLY when the customer explicitly asks for in-stock/available items ("what do you have in stock?", "items I can buy now"): out-of-stock rows then drop from the cards entirely. Omit for everything else — browse results show unavailable products with an Out of stock badge by default.',
          'include_unavailable?':
            'optional — legacy no-op kept for compatibility: unavailable products render badged by default now, so nothing needs opting in. (Unpublished/draft products are still never returned at all.)',
          'only_unavailable?':
            'optional — pass "1" when the customer asks to see JUST the out-of-stock / unavailable items ("what\'s out of stock?", "show me only sold-out products"): the rendered cards then contain ONLY the out-of-stock rows, each badged. Do not combine with include_unavailable.',
          'sale_only?':
            'optional — pass "1" when the customer asks for sale/discounted/clearance items ("what\'s on sale?", "show me your sales", "any deals?"): the query mechanically gains compare_at_price:>0 upstream (productsCount then counts the SALE set, so you can quote it truthfully) and cards showing no marked-down price are dropped. Omit for everything else — a browse should show full-price items too.',
          'limit?':
            'optional — how many product cards to render (max 10). Omit for browse/list asks (shows up to 10). Pass "1"–"3" for a specific-product or photo-match ask so the shopper sees THE match, not a page of similar items.',
          'price_min?':
            'optional — for "over $X" asks, the lower bound as a bare number (e.g. "100"). Cards showing cheaper variants are mechanically dropped so the carousel never contradicts your "over $X" claim.',
          'price_max?':
            'optional — for "under $X" asks, the upper bound as a bare number (e.g. "800"). Cards above it are mechanically dropped — combine with a "product_type:…" query clause when the ask names a category.',
          'collection?':
            'optional — a collection handle (e.g. "hydrogen", from shopify_list_collections); scopes results to that collection. Use it whenever the customer asks about/browses a named collection.',
          'sort?':
            'optional — rank the results: "newest", "oldest", "a-z", "z-a", "vendor", "product_type", "most_stock", "least_stock", "updated". Omit for relevance order. There is NO popularity sort on this query — for bestseller/popular asks call shopify_analytics (or shopify_sales_stats when it\'s scope-denied) to rank by units sold, then search those products.',
          'reverse?':
            'optional — "1" flips the sort direction; usually unnecessary since the sort aliases already carry their direction.',
        },
        widget: {
          type: 'cards',
          items: 'data.products.nodes',
          link_label: 'View product',
          // One variant answers the price AND the Add button — the cheapest
          // available one. Multi-variant rows price "from $X"; rows with
          // selling plans lose the Add button entirely (a subscription/
          // preorder choice can't be made silently — the card links to the
          // PDP instead). Variant/option/plan names ride on the card's
          // options line via purchaseOptionInfo in widgets.ts.
          pick: { from: 'variants.nodes', into: '__v', by: 'price', require: 'availableForSale' },
          availability: {
            field: '__v.availableForSale',
            unless_arg: 'include_unavailable',
            in_stock_arg: 'in_stock_only',
            only_arg: 'only_unavailable',
          },
          row_limit_arg: 'limit',
          sale: {
            arg: 'sale_only',
            compare_at_field: '__v.compareAtPrice',
            price_field: '__v.price',
          },
          // Shopify's own text search is loose enough to answer a
          // "snowboard" query with a gift card. A row needs the query in
          // its identifying fields — title/type/tags/vendor — or the whole
          // phrase in title+description, so filler can't crowd the cards.
          relevance: {
            arg: 'query',
            fields: ['title', 'description'],
            // Vendor is deliberately absent — real stores fill it with junk
            // like "Snowboard Vendor" on gift cards, which would re-admit
            // the exact filler this filter exists to drop.
            strong_fields: ['title', 'productType', 'tags'],
          },
          map: {
            title: 'title',
            subtitle: 'vendor',
            image: 'featuredImage.url',
            // Price the variant the Add button actually adds — minVariantPrice
            // can belong to a DIFFERENT variant (a $949.95 card adding a
            // $902.45 variant is a bait-and-switch the cart then exposes).
            // Variant price is a scalar Money; :money borrows the row's code.
            price: '{__v.price:money}',
            // Same variant's compare-at — a set value means the card's
            // price IS a sale price; renderers strike it + "Sale" badge.
            compare_at: '{__v.compareAtPrice:money}',
            stock: '{__v.availableForSale:stock}',
            cart_variant_id: '{__v.id:gidnum}',
            link: 'https://{{secrets.SHOPIFY_SHOP}}/products/{handle}',
          },
        },
      },
      {
        name: 'shopify_stock_by_location',
        label: 'Stock by location',
        description:
          'Per-location stock truth for one product — the "is it at my store?" / store-pickup ask. Pass a product gid (the `id` field from shopify_search_products). Returns each active location with per-variant available/committed/incoming counts — answer from the location the customer names, and say when a product is online-only.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($id:ID!){product(id:$id){title variants(first:30){nodes{id title sku availableForSale inventoryItem{id inventoryLevels(first:50){nodes{location{id name isActive}quantities(names:[\\"available\\",\\"committed\\",\\"incoming\\"]){name quantity}}}}}}}}","variables":{"id":"${product_id:text}"}}',
        params: {
          product_id:
            'product gid from shopify_search_products — the `id` field (gid://shopify/Product/…)',
        },
      },
      {
        name: 'shopify_list_collections',
        label: 'List collections',
        description:
          'List the shop\'s collections (the product groupings the store maintains — custom and smart/automated). Returns collection cards: each shows its product count and tapping one sends "show me the X collection" — then call shopify_search_products with `collection` set to that collection\'s handle (the card\'s link ends with /collections/<handle>). Use when the customer asks what collections/categories/departments exist — when they already NAME a collection, skip this tool and go straight to shopify_search_products with `collection` so the carousel isn\'t padded with a redundant collections list.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"{collectionsCount{count} collections(first:25){nodes{id title handle description(truncateAt:120) image{url} productsCount{count}}}}","variables":{"_pad":${noop?}}}',
        params: {},
        widget: {
          type: 'cards',
          items: 'data.collections.nodes',
          link_label: 'View collection',
          map: {
            title: 'title',
            subtitle: '{productsCount.count} product{productsCount.count:s}',
            image: 'image.url',
            link: 'https://{{secrets.SHOPIFY_SHOP}}/collections/{handle}',
            select_label: 'Show me the {title} collection',
          },
        },
      },
      {
        name: 'shopify_sales_stats',
        label: 'Sales stats',
        description:
          'Approximate sales ranking aggregated server-side from the newest 50 orders\' line items — returns ranked_products: product titles ordered by units sold (first = bestseller). FALLBACK for popularity asks ("what sells best?", "top products?"): try shopify_analytics first — it is the authoritative ranking — and come here only when it errors with an access/scope denial. This window is approximate (recent orders only, not lifetime) — say "our recent bestsellers" rather than claiming all-time. A product absent from ranked_products sold zero units in the window. EMPTY ranked_products = no orders yet: say there is no sales data to rank by — never fabricate a ranking, and do NOT call any product "popular"/"a bestseller"/"top-selling" — with zero orders nothing is a bestseller; offer the catalogue instead. Sales figures are merchant-internal by design: ONLY titles come back, never counts — answer with product names/cards and never claim units sold or sell-through percentages.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"{ordersCount{count} orders(first:50,sortKey:CREATED_AT,reverse:true){nodes{createdAt lineItems(first:20){nodes{quantity title product{title handle}}}}}}","variables":{"_pad":${noop?}}}',
        params: {},
      },
      {
        name: 'shopify_analytics',
        label: 'Sales analytics',
        description:
          'Exact sales ranking via ShopifyQL — returns ranked_products: product titles ordered by units sold (first = bestseller) over a real lookback window. PREFER this for bestseller / "top products" / popular asks: it ranks by actual sales, not recency. Requires the shop\'s connection to grant read_reports (and, on non-development stores, Shopify protected-data approval) — an ACCESS_DENIED/authorization error means it isn\'t granted: fall back to shopify_sales_stats and say the ranking is approximate. A product absent from ranked_products sold nothing in the window; empty list = no sales yet — say so and never invent a ranking. Sales figures are merchant-internal by design: ONLY titles come back, never counts — answer with product names/cards ("our bestsellers are…") via shopify_search_products, and never claim sell-through percentages or units sold.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!){shopifyqlQuery(query:$q){tableData{rows} parseErrors{code message} parseWarnings{code message}}}","variables":{"q":"FROM sales SHOW units_sold GROUP BY product_title SINCE -${days:text}d ORDER BY units_sold DESC LIMIT 25"}}',
        params: {
          days: 'lookback window in days as a bare number — "30", "90", "365". Required — SINCE clause has no default.',
        },
      },
      {
        name: 'shopify_cancel_order',
        label: 'Cancel order',
        description:
          'Cancel a Shopify order by its numeric order id (from shopify_lookup_order — the customer must be verified) — the same self-serve cancel a website offers: cancels with reason CUSTOMER, restocks items, notifies the customer. Only for orders that are not yet fulfilled; if the customer wants money back on a paid/fulfilled order that is a REFUND — escalate to a human instead of guessing.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!){orderCancel(orderId:$id,restock:true,reason:CUSTOMER,notifyCustomer:true){job{id} orderCancelUserErrors{field message}}}","variables":{"id":"gid://shopify/Order/${order_id:text}"}}',
        params: { order_id: 'numeric Shopify order id (not the #number) from shopify_lookup_order' },
        identity: true,
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
          'Change the shipping address on an unfulfilled Shopify order by numeric order id (from shopify_lookup_order — the customer must be verified).',
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
        identity: true,
      },
      {
        name: 'shopify_update_order_tags',
        label: 'Update order tags',
        description: 'Set the tags on a Shopify order by numeric order id (from shopify_lookup_order — the customer must be verified). Replaces all existing tags.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($id:ID!,$tags:[String!]!){orderUpdate(input:{id:$id,tags:$tags}){order{id tags} userErrors{field message}}}","variables":{"id":"gid://shopify/Order/${order_id:text}","tags":${tags}}}',
        params: {
          order_id: 'numeric Shopify order id',
          tags: 'JSON array of tag strings, e.g. ["vip","chat-order"]',
        },
        identity: true,
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
          'File a return REQUEST on a fulfilled Shopify order — the store-side equivalent of the customer returns portal; it lands in Shopify admin as REQUESTED and a teammate approves or declines it there. Flow: shopify_lookup_order → pick the fulfillmentLineItems to return → call this with orderId + returnLineItems. CHECK order.returns first — if a return on these items already exists in REQUESTED or OPEN status, do NOT re-file: tell the customer their request is already under review. Tell the customer their request is submitted for review, not confirmed. For an EXCHANGE ("swap for a different size"), file this for the item going back, then offer to create a draft order for the replacement — that pair is the exchange.',
        identity: true,
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($input:ReturnRequestInput!){returnRequest(input:$input){return{id name status} userErrors{field message}}}","variables":{"input":${return_request}}}',
        params: {
          return_request:
            'JSON ReturnRequestInput — {"orderId":"gid://shopify/Order/…","returnLineItems":[{"fulfillmentLineItemId":"gid://shopify/FulfillmentLineItem/…","quantity":1,"returnReason":"DEFECTIVE","customerNote":"…"}]} — ids come from shopify_lookup_order (order.id + fulfillments[].fulfillmentLineItems[].id). quantity AND returnReason are REQUIRED per line item — pick the closest of DEFECTIVE, WRONG_ITEM, NOT_AS_DESCRIBED, WRONG_SIZE (SIZE_TOO_LARGE/SIZE_TOO_SMALL), UNWANTED, STYLE, COLOR, OTHER and put the customer\'s own words in customerNote.',
        },
      },
      {
        name: 'shopify_refund',
        label: 'Issue a refund',
        description:
          'Issue a REFUND on a Shopify order — money out the door; a teammate approves before it executes. Use after the order is verified (shopify_lookup_order gives lineItem ids + totals). For returns with physical goods coming back, file shopify_request_return instead and refund on inspection. Tell the customer a refund is pending approval, never that it\'s already processed.',
        approval: true,
        identity: true,
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"mutation($input:RefundInput!){refundCreate(input:$input){refund{id totalRefundedSet{shopMoney{amount currencyCode}}} userErrors{field message}}}","variables":{"input":${refund}}}',
        params: {
          refund:
            'JSON RefundInput — {"orderId":"gid://shopify/Order/…","refundLineItems":[{"lineItemId":"gid://shopify/LineItem/…","quantity":1,"restockType":"RETURN"}],"note":"…","notify":true} — ids come from shopify_lookup_order (order.id + lineItems[].id). restockType: RETURN | NO_RESTOCK | LEGACY_RESTOCK | CANCEL. Set notify:false to skip the customer email.',
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
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'E-commerce',
    blurb:
      'Look up orders and products on a WooCommerce store — answers "where\'s my order" and can leave private notes for the team.',
    docs_url: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    fields: [
      { key: 'store_url', label: 'Store URL', placeholder: 'mystore.com' },
      {
        key: 'consumer_key',
        label: 'Consumer key (ck_…)',
        placeholder: 'ck_…',
        help: 'WooCommerce admin → Settings → Advanced → REST API → Add key → Read/Write → copy the Consumer key.',
      },
      {
        key: 'consumer_secret',
        label: 'Consumer secret (cs_…)',
        placeholder: 'cs_…',
        help: 'Shown once with the consumer key — copy the Consumer secret.',
      },
    ],
    secrets: (f) => ({
      WOO_HOST: normHost(f.store_url),
      WOO_AUTH: Buffer.from(`${f.consumer_key.trim()}:${f.consumer_secret.trim()}`).toString(
        'base64',
      ),
    }),
    tools: [
      {
        name: 'woo_lookup_order',
        label: 'Look up order',
        description:
          'Look up a WooCommerce order by its numeric id for the VERIFIED customer — returns status, line items, totals, shipping/billing and tracking meta when present. The customer must be verified first: signed-in shopper, email-channel sender, or send_verification_email + check_verification_code — and the billing.email on the result must match the verified customer; if it doesn\'t, it\'s not their order — say so, never reveal its contents.',
        method: 'GET',
        // verified_email rides as an ignored query param — it exists purely
        // as the identity anchor the gate binds the verified address into.
        url: 'https://{{secrets.WOO_HOST}}/wp-json/wc/v3/orders/{order_id}?verified_email={email}',
        headers: { authorization: 'Basic {{secrets.WOO_AUTH}}' },
        params: {
          order_id: 'the numeric order number the customer gave, e.g. 1042',
          'email?':
            'optional — a VERIFIED customer address; the verified identity binds automatically for signed-in/code-verified customers, so omit it unless the customer proved a different address',
        },
        identity: true,
      },
      {
        name: 'woo_customer_orders',
        label: 'Customer orders',
        description:
          'List the most recent WooCommerce orders for the verified customer by billing email — use this whenever the customer asks about "my order"/"my purchases" without giving a number, so they can pick the right one. The customer must be verified first — pass only an address they verified (signed-in shopper, email-channel sender, or a code-verified email).',
        method: 'GET',
        url: 'https://{{secrets.WOO_HOST}}/wp-json/wc/v3/orders?search={email}&per_page=10',
        headers: { authorization: 'Basic {{secrets.WOO_AUTH}}' },
        params: {
          email: 'a VERIFIED customer email address — never a guessed or unverified one',
        },
        identity: true,
      },
      {
        name: 'woo_search_products',
        label: 'Search products',
        description:
          'Search the WooCommerce product catalogue — returns up to 10 published products with name, price, sale price, stock status and permalink. Answer stock questions from each item\'s stock_status (instock/outofstock/onbackorder) — a published product that is outofstock cannot be bought; say so plainly.',
        method: 'GET',
        url: 'https://{{secrets.WOO_HOST}}/wp-json/wc/v3/products?search={query}&per_page=10&status=publish',
        headers: { authorization: 'Basic {{secrets.WOO_AUTH}}' },
        params: {
          query: 'product search text — a name, keyword or SKU',
        },
      },
      {
        name: 'woo_add_order_note',
        label: 'Add order note',
        description:
          'Add a private staff note to a WooCommerce order — use to flag follow-ups for the team (notes are never customer-visible). Propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://{{secrets.WOO_HOST}}/wp-json/wc/v3/orders/{order_id}/notes',
        headers: {
          authorization: 'Basic {{secrets.WOO_AUTH}}',
          'content-type': 'application/json',
        },
        bodyTemplate: '{"note":{note}}',
        params: {
          order_id: 'numeric order id — from woo_lookup_order or woo_customer_orders',
          note: 'private note text — the context the team needs',
        },
        approval: true,
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
    id: 'hubspot-connect',
    name: 'HubSpot (OAuth)',
    category: 'CRM',
    blurb: 'Same HubSpot tools via one-click OAuth — no private-app token to paste.',
    docs_url: 'https://developers.hubspot.com/docs/api/oauth-quickstart-guide',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'hubspot',
      label: () => 'HubSpot',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/hubspot/connect',
    manual: 'hubspot',
    tools: [], // filled from the `hubspot` template below — one source of truth
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
    name: 'Zendesk (client credentials)',
    category: 'Support desk',
    blurb:
      'Same ticket tools via your own OAuth client — the future-proof auth; Zendesk retires API tokens April 2027.',
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
    id: 'zendesk-connect',
    name: 'Zendesk (OAuth)',
    category: 'Support desk',
    blurb:
      'Same Zendesk tools via one-click OAuth consent — no client to register (Janis global client).',
    docs_url: 'https://developer.zendesk.com/documentation/api-basics/using-oauth-authentication/',
    // The only field OAuth can't supply: the customer's subdomain drives
    // both authorize and token hosts. The card appends it to the connect
    // URL as a query param.
    fields: [
      { key: 'subdomain', label: 'Zendesk subdomain', placeholder: 'acme', help: 'the acme part of acme.zendesk.com' },
    ],
    secrets: () => ({}),
    connection: {
      provider: 'zendesk',
      label: () => 'Zendesk',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/zendesk/connect',
    manual: ['zendesk', 'zendesk-oauth'],
    tools: [], // filled from the `zendesk-oauth` template below — same tickets surface
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
    id: 'salesforce-connect',
    name: 'Salesforce (OAuth)',
    category: 'CRM',
    blurb:
      'Same Salesforce tools via one-click OAuth — no connected app to configure per org.',
    docs_url: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'salesforce',
      label: () => 'Salesforce',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/salesforce/connect',
    manual: 'salesforce',
    tools: [], // filled from the `salesforce` template below — one source of truth
  },
  {
    id: 'jira',
    name: 'Jira',
    category: 'Issue tracking',
    blurb:
      'Check ticket status for customers and file engineering issues on escalation — the customer email on the ticket keys the lookup.',
    docs_url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    fields: [
      { key: 'site', label: 'Site', placeholder: 'yourcompany.atlassian.net' },
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@company.com' },
      {
        key: 'api_token',
        label: 'API token',
        help: 'id.atlassian.com → Security → API tokens → Create API token → copy it (shown once). The account needs Browse Projects plus Create/Comment Issues on the projects the agent should touch.',
      },
    ],
    secrets: (f) => ({
      JIRA_HOST: normHost(f.site, '.atlassian.net'),
      JIRA_AUTH: Buffer.from(`${f.email.trim()}:${f.api_token.trim()}`).toString('base64'),
    }),
    tools: [
      {
        name: 'jira_list_projects',
        label: 'List projects',
        description:
          'List the Jira projects this connection can see — call before jira_create_issue to pick a real project key; a guessed key always fails.',
        method: 'GET',
        url: 'https://{{secrets.JIRA_HOST}}/rest/api/3/project/search?maxResults=50',
        headers: { authorization: 'Basic {{secrets.JIRA_AUTH}}' },
        params: {},
      },
      {
        name: 'jira_search',
        label: 'Search issues',
        description:
          'Search Jira issues with JQL — must scope the query to the verified customer (e.g. text ~ "their-verified-email" OR reporter = "their-verified-email"). Returns issue keys, summaries, statuses and priorities — feed keys to jira_get_issue or jira_add_comment.',
        method: 'GET',
        url: 'https://{{secrets.JIRA_HOST}}/rest/api/3/search/jql?jql={jql}&maxResults=10&fields=summary,status,priority,issuetype,created,updated',
        headers: { authorization: 'Basic {{secrets.JIRA_AUTH}}' },
        params: {
          jql: 'JQL query — must include the verified customer email, e.g. text ~ "customer@email.com" OR reporter = "customer@email.com"',
        },
        identity: true,
      },
      {
        name: 'jira_get_issue',
        label: 'Get issue',
        description:
          'Fetch a single Jira issue by key (e.g. SUP-123) — scoped to the verified customer: the ticket must reference their email (reporter, description or comments) or the lookup returns nothing. Returns full detail including description and recent comments.',
        method: 'GET',
        url: 'https://{{secrets.JIRA_HOST}}/rest/api/3/search/jql?jql=key%20%3D%20%22{issue_key}%22%20AND%20%28text%20~%20%22{email}%22%20OR%20reporter%20%3D%20%22{email}%22%29&maxResults=1&fields=summary,description,status,priority,issuetype,reporter,created,updated,comment',
        headers: { authorization: 'Basic {{secrets.JIRA_AUTH}}' },
        params: {
          issue_key: 'issue key, e.g. SUP-123 — from jira_search results or the customer',
          email: "the verified customer's own email address",
        },
        identity: true,
      },
      {
        name: 'jira_create_issue',
        label: 'Create issue',
        description:
          "File a Jira issue for a bug or request the agent could not resolve — records the customer's verified email on the ticket so engineering can follow up and jira_get_issue can find it for them later. When the issue files, tell the customer its key with a clickable link — the response's `self` carries the site host, so link https://<host>/browse/<key> (markdown [KEY-123](url) or the bare URL both render).",
        method: 'POST',
        url: 'https://{{secrets.JIRA_HOST}}/rest/api/3/issue',
        headers: { authorization: 'Basic {{secrets.JIRA_AUTH}}' },
        bodyTemplate:
          '{"fields":{"project":{"key":{project}},"summary":{summary},"issuetype":{"name":{issue_type}},"description":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Reported via Janis — customer email: {customer_email:text}"}]},{"type":"paragraph","content":[{"type":"text","text":{description}}]}]}}}',
        params: {
          project:
            'project key — from jira_list_projects (call it first), an earlier issue lookup, or the customer/operator; a guessed key always 400s',
          summary: 'one-line issue title',
          issue_type: 'issue type name — "Bug" for defects, "Task" otherwise',
          customer_email: "the verified customer's email — written onto the ticket",
          description: 'what the customer reported, steps to reproduce, and what they expected',
        },
        identity: true,
        approval: true,
      },
      {
        name: 'jira_add_comment',
        label: 'Add comment',
        description:
          'Add a comment to an existing Jira issue — propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://{{secrets.JIRA_HOST}}/rest/api/3/issue/{issue_key}/comment',
        headers: { authorization: 'Basic {{secrets.JIRA_AUTH}}' },
        bodyTemplate:
          '{"body":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":{comment}}]}]}}',
        params: {
          issue_key: 'issue key from jira_search or jira_get_issue, e.g. SUP-123',
          comment: "comment text — the context the team needs, e.g. the customer's follow-up",
        },
        approval: true,
      },
    ],
  },
  {
    id: 'jira-connect',
    name: 'Jira (OAuth)',
    category: 'Issue tracking',
    blurb: 'Same Jira tools via one-click OAuth — no API token to paste.',
    docs_url: 'https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'jira',
      label: () => 'Jira site',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/jira/connect',
    manual: 'jira',
    tools: [], // filled from the `jira` template below — one source of truth
  },
  {
    id: 'confluence',
    name: 'Confluence',
    category: 'Docs & data',
    blurb:
      'Search and read Confluence pages — the agent grounds answers in your runbooks and docs.',
    docs_url: 'https://developer.atlassian.com/cloud/confluence/rest/v1/',
    fields: [
      { key: 'site', label: 'Site', placeholder: 'yourcompany.atlassian.net' },
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@company.com' },
      {
        key: 'api_token',
        label: 'API token',
        placeholder: 'id.atlassian.com → Security → API tokens',
      },
    ],
    secrets: (f) => ({
      CONFLUENCE_HOST: normHost(f.site, '.atlassian.net'),
      CONFLUENCE_AUTH: Buffer.from(`${f.email.trim()}:${f.api_token.trim()}`).toString('base64'),
    }),
    tools: [
      {
        name: 'confluence_search',
        label: 'Search pages',
        description:
          'Search Confluence pages with CQL — find the runbook or doc that answers the customer question.',
        method: 'GET',
        url: 'https://{{secrets.CONFLUENCE_HOST}}/wiki/rest/api/content/search?cql={cql}&limit=10',
        headers: { authorization: 'Basic {{secrets.CONFLUENCE_AUTH}}' },
        params: {
          cql: 'Confluence Query Language — e.g. text ~ "password reset" AND type = page',
        },
      },
      {
        name: 'confluence_get_page',
        label: 'Get page',
        description:
          "Fetch a Confluence page's title and rendered body — read the runbook before answering.",
        method: 'GET',
        url: 'https://{{secrets.CONFLUENCE_HOST}}/wiki/rest/api/content/{page_id}?expand=body.view',
        headers: { authorization: 'Basic {{secrets.CONFLUENCE_AUTH}}' },
        params: {
          page_id: 'page id from confluence_search results (the id field)',
        },
      },
    ],
  },
  {
    id: 'confluence-connect',
    name: 'Confluence (OAuth)',
    category: 'Docs & data',
    blurb: 'Same Confluence tools via one-click OAuth — no API token to paste.',
    docs_url: 'https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'confluence',
      label: () => 'Confluence',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/confluence/connect',
    manual: 'confluence',
    tools: [], // filled from the `confluence` template above — one source of truth
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Issue tracking',
    blurb:
      'Check issue status for customers and file Linear issues on escalation — filed issues carry the customer email so status lookups stay scoped.',
    docs_url: 'https://linear.app/developers/graphql',
    fields: [
      {
        key: 'api_key',
        label: 'Personal API key',
        placeholder: 'lin_api_…',
        help: 'Linear → Settings → Security & access → Personal API keys → create a key with read + write access. Paste it as-is — no "Bearer" prefix.',
      },
    ],
    secrets: (f) => ({ LINEAR_API_KEY: f.api_key.trim() }),
    tools: [
      {
        name: 'linear_teams',
        label: 'List teams',
        description: 'List Linear teams — the id is the team_id linear_create_issue needs.',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: { authorization: '{{secrets.LINEAR_API_KEY}}' },
        bodyTemplate:
          '{"query":"{teams(first:50){nodes{id key name}}}","variables":{"_pad":${noop?}}}',
        params: {},
      },
      {
        name: 'linear_search_issues',
        label: 'Search issues',
        description:
          'Search Linear issues with an IssueFilter JSON object — must scope to the verified customer via {"description":{"contains":"their-verified-email"}} (issues filed through Janis always carry it). Returns identifiers, titles, states and priorities — feed the issue id to linear_add_comment, the numeric part of the identifier to linear_get_issue.',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: { authorization: '{{secrets.LINEAR_API_KEY}}' },
        bodyTemplate:
          '{"query":"query($f:IssueFilter!){issues(first:10,filter:$f){nodes{id identifier title description state{name type position} priorityLabel assignee{displayName} team{key name} labels{nodes{name}} createdAt updatedAt url}}}","variables":{"f":${filter}}}',
        params: {
          filter:
            'JSON IssueFilter, e.g. {"and":[{"description":{"contains":"customer@email.com"}},{"title":{"contains":"checkout"}}]} — must include the verified customer email',
        },
        identity: true,
      },
      {
        name: 'linear_get_issue',
        label: 'Get issue',
        description:
          'Fetch a Linear issue by its numeric key — scoped to the verified customer: the issue description must contain their email or nothing returns. Returns full detail including recent comments.',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: { authorization: '{{secrets.LINEAR_API_KEY}}' },
        bodyTemplate:
          '{"query":"query($f:IssueFilter!){issues(first:5,filter:$f){nodes{id identifier title description state{name type position} priorityLabel assignee{displayName} team{key name} comments(first:10){nodes{body user{displayName} createdAt}} createdAt updatedAt url}}}","variables":{"f":{"and":[{"number":{"eq":${number:text}}},{"description":{"contains":"${email:text}"}}]}}}',
        params: {
          number: 'numeric part of the issue key — ENG-123 → 123',
          email: "the verified customer's own email address",
        },
        identity: true,
      },
      {
        name: 'linear_create_issue',
        label: 'Create issue',
        description:
          "File a Linear issue for a bug or request the agent could not resolve — records the customer's verified email in the description so the team can follow up and linear_get_issue can find it. Get team_id from linear_teams. When the issue files, tell the customer its identifier with a clickable link — the result's url field (markdown [ABC-123](url) or the bare URL both render).",
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: { authorization: '{{secrets.LINEAR_API_KEY}}' },
        bodyTemplate:
          '{"query":"mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier title url state{name}}}}","variables":{"input":{"teamId":"${team_id:text}","title":"${title:text}","description":"Reported via Janis chat — customer email: ${customer_email:text}\\n\\n${description:text}","priority":${priority?:text}}}}',
        params: {
          team_id: 'team UUID — the id field from linear_teams',
          title: 'one-line issue title',
          customer_email: "the verified customer's email — written onto the issue",
          description: 'what the customer reported, steps to reproduce, and what they expected',
          'priority?': 'optional — 0 none, 1 urgent, 2 high, 3 normal, 4 low',
        },
        identity: true,
        approval: true,
      },
      {
        name: 'linear_add_comment',
        label: 'Add comment',
        description:
          'Comment on an existing Linear issue — propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: { authorization: '{{secrets.LINEAR_API_KEY}}' },
        bodyTemplate:
          '{"query":"mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}","variables":{"input":{"issueId":"${issue_id:text}","body":"${comment:text}"}}}',
        params: {
          issue_id:
            'issue UUID — the id field (not the ABC-123 identifier) from linear_search_issues or linear_get_issue',
          comment: 'comment text — the context the team needs',
        },
        approval: true,
      },
    ],
  },
  {
    id: 'linear-connect',
    name: 'Linear (OAuth)',
    category: 'Issue tracking',
    blurb:
      'Same Linear tools via one-click OAuth — issues post as the app, not whoever connected.',
    docs_url: 'https://linear.app/developers/oauth-2-0-authentication',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'linear',
      label: () => 'Linear',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/linear/connect',
    manual: 'linear',
    tools: [], // filled from the `linear` template below — one source of truth
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Issue tracking',
    blurb:
      'Check issue status for customers and file GitHub issues on escalation — filed issues carry the customer email so status lookups stay scoped.',
    docs_url: 'https://docs.github.com/en/rest/issues',
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        placeholder: 'github_pat_… or ghp_…',
        help: 'github.com → Settings → Developer settings → Personal access tokens → a fine-grained token with Issues read + write on the repo (a classic token needs the repo scope instead).',
      },
      {
        key: 'repo',
        label: 'Repository',
        placeholder: 'owner/repo',
        help: 'The repository the agent searches and files issues in — owner/repo exactly as it appears in the GitHub URL (a pasted URL works too).',
      },
    ],
    secrets: (f) => ({
      GITHUB_TOKEN: f.token.trim(),
      GITHUB_REPO: f.repo
        .trim()
        .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
        .replace(/\.git$/, '')
        .replace(/^\/+|\/+$/g, ''),
    }),
    tools: [
      {
        name: 'github_search_issues',
        label: 'Search issues',
        description:
          'Search issues in the connected GitHub repository — scoped to the verified customer: their email must appear in the issue body (issues filed through Janis always carry it). Returns issue numbers, titles, states and labels — feed the number to github_get_issue or github_add_comment.',
        method: 'GET',
        url: 'https://api.github.com/search/issues?q=repo:{{secrets.GITHUB_REPO}}+is:issue+{query}+{email}+in:body&per_page=10',
        headers: {
          authorization: 'Bearer {{secrets.GITHUB_TOKEN}}',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        params: {
          query:
            "keywords to narrow the search — may include GitHub qualifiers like state:open or label:bug; pass an empty string for all of the customer's issues",
          email: "the verified customer's own email address",
        },
        identity: true,
      },
      {
        name: 'github_get_issue',
        label: 'Get issue',
        description:
          'Fetch a GitHub issue by its number — scoped to the verified customer: the issue body must contain their email or nothing returns. Returns full detail including state, labels and comment count.',
        method: 'GET',
        url: 'https://api.github.com/search/issues?q=repo:{{secrets.GITHUB_REPO}}+is:issue+{number}+{email}+in:body&per_page=5',
        headers: {
          authorization: 'Bearer {{secrets.GITHUB_TOKEN}}',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        params: {
          number: 'issue number — the # field from github_search_issues results, e.g. 123',
          email: "the verified customer's own email address",
        },
        identity: true,
      },
      {
        name: 'github_create_issue',
        label: 'Create issue',
        description:
          "File a GitHub issue for a bug or request the agent could not resolve — records the customer's verified email in the body so the team can follow up and github_get_issue can find it for them later.",
        method: 'POST',
        url: 'https://api.github.com/repos/{{secrets.GITHUB_REPO}}/issues',
        headers: {
          authorization: 'Bearer {{secrets.GITHUB_TOKEN}}',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        bodyTemplate:
          '{"title":{title},"body":"Reported via Janis chat — customer email: {customer_email:text}\\n\\n{description:text}"}',
        params: {
          title: 'one-line issue title',
          customer_email: "the verified customer's email — written onto the issue",
          description:
            'what the customer reported, steps to reproduce, and what they expected',
        },
        identity: true,
        approval: true,
      },
      {
        name: 'github_add_comment',
        label: 'Add comment',
        description:
          'Comment on an existing GitHub issue — propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://api.github.com/repos/{{secrets.GITHUB_REPO}}/issues/{number}/comments',
        headers: {
          authorization: 'Bearer {{secrets.GITHUB_TOKEN}}',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        bodyTemplate: '{"body":{comment}}',
        params: {
          number: 'issue number — from github_search_issues or github_get_issue',
          comment: 'comment text — the context the team needs',
        },
        approval: true,
      },
    ],
  },
  {
    id: 'github-connect',
    name: 'GitHub (OAuth)',
    category: 'Issue tracking',
    blurb:
      'Same GitHub tools via one-click OAuth — no personal access token to paste.',
    docs_url:
      'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'github',
      label: () => 'GitHub',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/github/connect',
    manual: 'github',
    tools: [], // filled from the `github` template below — one source of truth
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    blurb:
      'Post escalations into a Slack channel — the agent can page the team with the conversation context.',
    docs_url: 'https://api.slack.com/apps',
    fields: [
      {
        key: 'bot_token',
        label: 'Bot User OAuth Token (xoxb-…)',
        placeholder: 'xoxb-…',
        help: 'api.slack.com/apps → your app → OAuth & Permissions → add bot scopes chat:write + channels:read → Install to workspace → copy the Bot User OAuth Token.',
      },
    ],
    secrets: (f) => ({ SLACK_TOKEN: f.bot_token.trim() }),
    tools: [
      {
        name: 'slack_list_channels',
        label: 'List channels',
        description:
          'List public channels in the Slack workspace (id + name) — use to find the channel id slack_post_message needs.',
        method: 'GET',
        url: 'https://slack.com/api/conversations.list?limit=200&types=public_channel',
        headers: { authorization: 'Bearer {{secrets.SLACK_TOKEN}}' },
        params: {},
      },
      {
        name: 'slack_post_message',
        label: 'Post message',
        description:
          'Post a message to a Slack channel — use to escalate a conversation to the team with the customer context. Propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        headers: {
          authorization: 'Bearer {{secrets.SLACK_TOKEN}}',
          'content-type': 'application/json',
        },
        bodyTemplate: '{"channel":"${channel:text}","text":"${text:text}"}',
        params: {
          channel: 'Slack channel ID (C…) from slack_list_channels',
          text: 'message text — the escalation context the team needs',
        },
        approval: true,
      },
    ],
  },
  {
    id: 'slack-connect',
    name: 'Slack (OAuth)',
    category: 'Communication',
    blurb:
      'Same Slack tools via one-click OAuth — Janis installs as a bot into your workspace.',
    docs_url: 'https://docs.slack.dev/authentication/installing-with-oauth/',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'slack',
      label: () => 'Slack workspace',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/slack/connect',
    manual: 'slack',
    tools: [], // filled from the `slack` template above — one source of truth
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Docs & data',
    blurb:
      'Search and read pages and databases in the workspace — the agent answers from your team\'s docs and can file new pages.',
    docs_url: 'https://developers.notion.com/docs/authorization',
    fields: [
      {
        key: 'token',
        label: 'Internal integration secret (ntn_…)',
        placeholder: 'ntn_…',
        help: 'notion.so/my-integrations → New integration → copy the Internal Integration Secret → in Notion, share the pages/databases the agent should reach with the integration (Connections → add).',
      },
    ],
    secrets: (f) => ({ NOTION_TOKEN: f.token.trim() }),
    tools: [
      {
        name: 'notion_search',
        label: 'Search workspace',
        description:
          'Search pages and databases the integration can access — returns titles, ids and last-edited times. Feed page ids to notion_get_page / notion_read_page and database ids to notion_query_database.',
        method: 'POST',
        url: 'https://api.notion.com/v1/search',
        headers: {
          authorization: 'Bearer {{secrets.NOTION_TOKEN}}',
          'notion-version': '2022-06-28',
          'content-type': 'application/json',
        },
        bodyTemplate: '{"query":{query},"page_size":10}',
        params: { query: 'search text — a page title, topic or database name' },
      },
      {
        name: 'notion_get_page',
        label: 'Get page',
        description:
          'Fetch a Notion page\'s metadata (title, url, parent, last edited) — pair with notion_read_page for the actual content.',
        method: 'GET',
        url: 'https://api.notion.com/v1/pages/{page_id}',
        headers: {
          authorization: 'Bearer {{secrets.NOTION_TOKEN}}',
          'notion-version': '2022-06-28',
        },
        params: { page_id: 'Notion page id (UUID) — from notion_search' },
      },
      {
        name: 'notion_read_page',
        label: 'Read page content',
        description:
          'Read a Notion page\'s block content — the paragraphs, headings and lists that carry the actual text. Answer ONLY from the returned blocks; a short or empty list means the page is thin, say so rather than guessing.',
        method: 'GET',
        url: 'https://api.notion.com/v1/blocks/{page_id}/children?page_size=100',
        headers: {
          authorization: 'Bearer {{secrets.NOTION_TOKEN}}',
          'notion-version': '2022-06-28',
        },
        params: { page_id: 'Notion page id (UUID) — from notion_search' },
      },
      {
        name: 'notion_query_database',
        label: 'Query database',
        description:
          'Query a Notion database — returns up to 25 rows with their property values. Use after notion_search surfaces a database id.',
        method: 'POST',
        url: 'https://api.notion.com/v1/databases/{database_id}/query',
        headers: {
          authorization: 'Bearer {{secrets.NOTION_TOKEN}}',
          'notion-version': '2022-06-28',
          'content-type': 'application/json',
        },
        bodyTemplate: '{"page_size":25}',
        params: {
          database_id: 'Notion database id (UUID) — from notion_search',
        },
      },
      {
        name: 'notion_create_page',
        label: 'Create page',
        description:
          'Create a Notion page under a parent page — use to file escalation notes, summaries or follow-ups the team should see. Propose it, a teammate approves before it posts.',
        method: 'POST',
        url: 'https://api.notion.com/v1/pages',
        headers: {
          authorization: 'Bearer {{secrets.NOTION_TOKEN}}',
          'notion-version': '2022-06-28',
          'content-type': 'application/json',
        },
        bodyTemplate:
          '{"parent":{"page_id":{parent_page_id}},"properties":{"title":{"title":[{"text":{"content":{title}}}]}},"children":[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":{content}}}]}}]}',
        params: {
          parent_page_id: 'parent Notion page id (UUID) — from notion_search',
          title: 'page title',
          content: 'body text — the context the team needs',
        },
        approval: true,
      },
    ],
  },
  {
    id: 'notion-connect',
    name: 'Notion (OAuth)',
    category: 'Docs & data',
    blurb:
      'Same Notion tools via one-click OAuth — pick the pages to share during consent, no token to paste.',
    docs_url: 'https://developers.notion.com/docs/authorization',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'notion',
      label: () => 'Notion workspace',
      credentials: () => ({}),
    },
    oauth_connect: '/api/oauth/notion/connect',
    manual: 'notion',
    tools: [], // filled from the `notion` template above — one source of truth
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
          'List active Stripe products for BILLING/PLAN questions only — resolves a plan name (e.g. "Pro") into a prod_… id before looking up its prices. Never for agent knowledge, config or content questions.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/products?active=true&limit=20',
        headers: { authorization: 'Bearer {{secrets.STRIPE_RESTRICTED_KEY}}' },
        widget: {
          type: 'cards',
          items: 'data',
          // Stripe lists newest-first — ascending `created` puts the
          // original plan products ahead of newer usage-meter products.
          sort: 'created',
          select_label: 'Tell me more about {title}',
          select_button: 'Tell me more…',
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
    manual: 'calendly',
    tools: [], // filled from the `calendly` template below — one source of truth
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'Docs & data',
    blurb:
      'Read rows and append to Google Sheets — Connect grants read+write on the signed-in account\u2019s spreadsheets.',
    docs_url: 'https://developers.google.com/sheets/api',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'google',
      label: () => 'Google',
      credentials: () => ({}),
    },
    oauth_connect: '/api/google/connect',
    tools: [
      {
        name: 'gsheets_list',
        label: 'List spreadsheets',
        description:
          'List spreadsheets the integration created or the user opened via Google — returns ids the other Sheets tools need. For an existing sheet, ask the user for its link or id instead.',
        method: 'GET',
        url: "https://www.googleapis.com/drive/v3/files?q=mimeType%3D'application%2Fvnd.google-apps.spreadsheet'&fields=files(id,name,modifiedTime)&orderBy=modifiedTime+desc&pageSize=20",
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
      },
      {
        name: 'gsheets_read',
        label: 'Read a range',
        description:
          'Read a cell range from a spreadsheet — returns the rows as a 2-D array. Range like "Sheet1!A1:D50".',
        method: 'GET',
        url: 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}?majorDimension=ROWS',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { spreadsheet_id: 'sheet id from gsheets_list', range: 'A1 range, e.g. Sheet1!A1:D50' },
      },
      {
        name: 'gsheets_update',
        label: 'Update a row',
        description:
          'Overwrite a specific range in a sheet — use it to update an EXISTING row (e.g. a contact whose email is already present): first call gsheets_read, find the matching row number, then update range like Sheet1!A{row}:D{row}. Never use this to add a new row — use gsheets_append.',
        method: 'PUT',
        url: 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}?valueInputOption=USER_ENTERED',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { spreadsheet_id: 'sheet id', range: 'target range, e.g. Sheet1!A3:D3', values: 'JSON array of row arrays' },
        bodyTemplate: '{"values": ${values}}',
      },
      {
        name: 'gsheets_append',
        label: 'Append rows',
        description:
          'Append rows to a sheet — values is a JSON array of rows, e.g. [["name","email"],["a","b"]].',
        method: 'POST',
        url: 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}:append?valueInputOption=USER_ENTERED',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { spreadsheet_id: 'sheet id from gsheets_list', range: 'target range, e.g. Sheet1!A1', values: 'JSON array of row arrays' },
        bodyTemplate: '{"values": ${values}}',
      },
    ],
  },
  {
    id: 'google-docs',
    name: 'Google Docs',
    category: 'Docs & data',
    blurb:
      'Read, create, and append to Google Docs — Connect grants access on the signed-in account\u2019s documents.',
    docs_url: 'https://developers.google.com/docs/api',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'google',
      label: () => 'Google',
      credentials: () => ({}),
    },
    oauth_connect: '/api/google/connect',
    tools: [
      {
        name: 'gdocs_list',
        label: 'List documents',
        description:
          'List docs the integration created or the user opened via Google — returns ids the other Docs tools need. For an existing doc, ask the user for its link or id instead.',
        method: 'GET',
        url: "https://www.googleapis.com/drive/v3/files?q=mimeType%3D'application%2Fvnd.google-apps.document'&fields=files(id,name,modifiedTime)&orderBy=modifiedTime+desc&pageSize=20",
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
      },
      {
        name: 'gdocs_read',
        label: 'Read a document',
        description:
          'Read a Google Doc — returns the document structure including its text content.',
        method: 'GET',
        url: 'https://docs.googleapis.com/v1/documents/{document_id}',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { document_id: 'doc id from gdocs_list' },
      },
      {
        name: 'gdocs_create',
        label: 'Create a document',
        description: 'Create a new empty Google Doc — returns its document_id.',
        method: 'POST',
        url: 'https://docs.googleapis.com/v1/documents',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { title: 'document title' },
        bodyTemplate: '{"title": "${title:text}"}',
      },
      {
        name: 'gdocs_append',
        label: 'Append text',
        description: 'Append text to the end of a Google Doc.',
        method: 'POST',
        url: 'https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { document_id: 'doc id', text: 'text to append' },
        bodyTemplate:
          '{"requests": [{"insertText": {"endOfSegmentLocation": {}, "text": "${text:text}\\n"}}]}',
      },
    ],
  },
  {
    id: 'google-slides',
    name: 'Google Slides',
    category: 'Docs & data',
    blurb:
      'Read slide decks — titles, body text, and speaker notes — and create new presentations.',
    docs_url: 'https://developers.google.com/slides/api',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'google',
      label: () => 'Google',
      credentials: () => ({}),
    },
    oauth_connect: '/api/google/connect',
    tools: [
      {
        name: 'gslides_list',
        label: 'List presentations',
        description:
          'List presentations the integration created or the user opened via Google — for an existing deck, ask the user for its link or id.',
        method: 'GET',
        url: "https://www.googleapis.com/drive/v3/files?q=mimeType%3D'application%2Fvnd.google-apps.presentation'&fields=files(id,name,modifiedTime)&orderBy=modifiedTime+desc&pageSize=20",
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
      },
      {
        name: 'gslides_read',
        label: 'Read a presentation',
        description:
          'Read a Google Slides presentation — returns slide titles, body text, and speaker notes.',
        method: 'GET',
        url: 'https://slides.googleapis.com/v1/presentations/{presentation_id}',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { presentation_id: 'deck id from gslides_list or a pasted link' },
      },
      {
        name: 'gslides_create',
        label: 'Create a presentation',
        description: 'Create a new empty presentation — returns its presentation_id.',
        method: 'POST',
        url: 'https://slides.googleapis.com/v1/presentations',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { title: 'presentation title' },
        bodyTemplate: '{"title": "${title:text}"}',
      },
    ],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Docs & data',
    blurb:
      'Read any file the user picks in Drive — Google Docs/Sheets/Slides export to text, Office files (docx/xlsx/pptx) convert to Google format first.',
    docs_url: 'https://developers.google.com/drive/api',
    fields: [],
    secrets: () => ({}),
    connection: {
      provider: 'google',
      label: () => 'Google',
      credentials: () => ({}),
    },
    oauth_connect: '/api/google/connect',
    tools: [
      {
        name: 'gdrive_files',
        label: 'List visible files',
        description:
          'List every Drive file the integration can see — files it created plus any the user picked via "Pick Drive files" in the console. For a file not listed, ask the user to pick it or paste its link.',
        method: 'GET',
        url: 'https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime+desc&pageSize=50',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
      },
      {
        name: 'gdrive_read',
        label: 'Export a file to text',
        description:
          'Export a Google-native file (doc, sheet, slide) to plain text — pass format text/csv for spreadsheets. For Office files (docx/xlsx/pptx) call gdrive_convert first, then read the converted file.',
        method: 'GET',
        url: 'https://www.googleapis.com/drive/v3/files/{file_id}/export?mimeType={format}',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: {
          file_id: 'file id from gdrive_files or a pasted link',
          format: 'text/plain (default) or text/csv for spreadsheets',
        },
      },
      {
        name: 'gdrive_convert',
        label: 'Convert Office file',
        description:
          'Convert an Office file to Google format so it can be read — target is document (docx), spreadsheet (xlsx/csv), or presentation (pptx). Returns the new Google file id; read it with gdrive_read or the matching app tool.',
        method: 'POST',
        url: 'https://www.googleapis.com/drive/v3/files/{file_id}/copy',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: {
          file_id: 'the Office file id',
          to: 'document | spreadsheet | presentation',
        },
        bodyTemplate: '{"mimeType": "application/vnd.google-apps.${to:text}"}',
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
  {
    id: 'mcp-server',
    name: 'MCP server',
    category: 'Automation',
    blurb:
      'Connect any hosted MCP server (Asana, Sentry, Airtable, internal tools) — its tools are discovered at install; read-only tools run freely, mutations ask for approval first.',
    docs_url: 'https://modelcontextprotocol.io/docs',
    fields: [
      {
        key: 'name',
        label: 'Short name',
        placeholder: 'asana',
        help: 'Lowercase letters/digits/dashes — namespaces the tools (mcp_asana_*) and secrets.',
      },
      {
        key: 'server_url',
        label: 'Server URL',
        placeholder: 'https://mcp.example.com/mcp',
        help: 'The server\'s streamable-HTTP MCP endpoint (POST JSON-RPC).',
      },
      {
        key: 'auth_token',
        label: 'Bearer token (if required)',
        optional: true,
        placeholder: 'token…',
        help: 'Sent as Authorization: Bearer on every call — stays server-side, the model never sees it.',
      },
    ],
    secrets: (f) => {
      const p = `MCP_${f.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').toUpperCase()}`;
      return {
        [`${p}_URL`]: f.server_url.trim().replace(/\/+$/, ''),
        ...(f.auth_token?.trim() ? { [`${p}_TOKEN`]: f.auth_token.trim() } : {}),
      };
    },
    tools: [], // discovered from the server at install — see discoverTools
    discoverTools: async (fields) => {
      const slug = fields.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!slug) throw new Error('name must contain letters or digits');
      const url = fields.server_url.trim();
      if (!/^https?:\/\//.test(url)) throw new Error('server URL must be http(s)');
      const p = `MCP_${slug.toUpperCase()}`;
      const auth = fields.auth_token?.trim();
      const { tools } = await mcpListTools(
        url.replace(/\/+$/, ''),
        auth ? { authorization: `Bearer ${auth}` } : {},
      );
      return tools.map((t): CatalogTool => {
        const local = `mcp_${slug}_${t.name}`
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 64);
        return {
          name: local,
          label: t.name.replace(/[_-]+/g, ' '),
          description:
            t.description ??
            `MCP tool ${t.name} — args follow the server's schema, shown to the model.`,
          method: 'POST',
          url: `{{secrets.${p}_URL}}`,
          headers: auth ? { authorization: `Bearer {{secrets.${p}_TOKEN}}` } : {},
          transport: 'mcp',
          mcpTool: t.name,
          // The server's own JSON Schema — dropped (not truncated) when
          // it's absurdly large so a hostile schema can't bloat the agent
          // config or the model's tools payload.
          ...(() => {
            try {
              return t.inputSchema &&
                Object.keys(t.inputSchema).length &&
                JSON.stringify(t.inputSchema).length <= 20_000
                ? { inputSchema: t.inputSchema }
                : {};
            } catch {
              return {};
            }
          })(),
          // Security defaults: read-only tools run free; anything else
          // proposes first. No `identity` flag — discovered tools can
          // never bind to the verified customer record.
          ...(t.annotations?.readOnlyHint && !t.annotations?.destructiveHint
            ? {}
            : { approval: true }),
        };
      });
    },
  },
];

// OAuth cards share the PAT/BYO card's tool defs with the connection
// token (and host, for 3LO-style APIs) swapped in — declared once, bound
// to either credential shape.
for (const v of [
  { from: 'calendly', to: 'calendly-connect', auth: 'Bearer {{secrets.CONN_CALENDLY_TOKEN}}' },
  {
    from: 'hubspot',
    to: 'hubspot-connect',
    auth: 'Bearer {{secrets.CONN_HUBSPOT_TOKEN}}',
  },
  {
    from: 'salesforce',
    to: 'salesforce-connect',
    // BYO rows store the instance host as a plain secret; OAuth rows
    // carry instance_url on the connection (exposed via exposeSecrets).
    urlFrom: 'https://{{secrets.SALESFORCE_HOST}}',
    urlTo: 'https://{{secrets.CONN_SALESFORCE_INSTANCE_URL}}',
    auth: 'Bearer {{secrets.CONN_SALESFORCE_TOKEN}}',
  },
  {
    from: 'jira',
    to: 'jira-connect',
    // 3LO tokens call api.atlassian.com with the granted site's cloud
    // id, not the site's own host.
    urlFrom: 'https://{{secrets.JIRA_HOST}}',
    urlTo: 'https://api.atlassian.com/ex/jira/{{secrets.CONN_JIRA_CLOUD_ID}}',
    auth: 'Bearer {{secrets.CONN_JIRA_TOKEN}}',
  },
  {
    from: 'confluence',
    to: 'confluence-connect',
    // Same Atlassian 3LO shape as Jira — wiki REST via ex/confluence.
    urlFrom: 'https://{{secrets.CONFLUENCE_HOST}}',
    urlTo: 'https://api.atlassian.com/ex/confluence/{{secrets.CONN_CONFLUENCE_CLOUD_ID}}',
    auth: 'Bearer {{secrets.CONN_CONFLUENCE_TOKEN}}',
  },
  {
    from: 'linear',
    to: 'linear-connect',
    // OAuth tokens need Bearer — raw-key auth is the personal-API-key path.
    auth: 'Bearer {{secrets.CONN_LINEAR_TOKEN}}',
  },
  {
    from: 'zendesk-oauth',
    to: 'zendesk-connect',
    // OAuth rows store the subdomain on the connection (exposed); BYO
    // rows carry it as a plain secret — same host slot, different source.
    urlFrom: '{{secrets.ZENDESK_OAUTH_SUBDOMAIN}}',
    urlTo: '{{secrets.CONN_ZENDESK_SUBDOMAIN}}',
    auth: 'Bearer {{secrets.CONN_ZENDESK_TOKEN}}',
  },
  {
    from: 'slack',
    to: 'slack-connect',
    // OAuth mints a xoxb bot token — same Bearer header the BYO card uses.
    auth: 'Bearer {{secrets.CONN_SLACK_TOKEN}}',
  },
  {
    from: 'notion',
    to: 'notion-connect',
    // OAuth mints a bot token — same Bearer + version headers the
    // internal-token card sends.
    headers: { 'notion-version': '2022-06-28' },
    auth: 'Bearer {{secrets.CONN_NOTION_TOKEN}}',
  },
  {
    from: 'github',
    to: 'github-connect',
    // One OAuth grant covers every repo the connecting user can reach —
    // the repo becomes a per-call tool arg instead of a PAT-card secret.
    urlFrom: '{{secrets.GITHUB_REPO}}',
    urlTo: '{repo}',
    params: {
      repo: 'the repository to search/file in, owner/repo form — e.g. acme/storefront',
    },
    // The auth swap replaces the whole headers object — keep the GitHub
    // REST accept/version headers the PAT tools send.
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    auth: 'Bearer {{secrets.CONN_GITHUB_TOKEN}}',
  },
]) {
  const src = TOOL_TEMPLATES.find((t) => t.id === v.from);
  const dst = TOOL_TEMPLATES.find((t) => t.id === v.to);
  if (src && dst) {
    dst.tools = src.tools.map((t) => ({
      ...t,
      ...(v.urlFrom ? { url: t.url.replaceAll(v.urlFrom!, v.urlTo!) } : {}),
      headers: { ...v.headers, authorization: v.auth } as Record<string, string>,
      ...(v.params ? { params: { ...t.params, ...v.params } } : {}),
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
