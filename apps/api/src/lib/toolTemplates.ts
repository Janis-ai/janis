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
          'Search or browse the Shopify product catalogue. Returns up to 10 product cards with images and prices, plus productsCount — the TRUE total of matching products (always quote THIS number when asked how many products there are, never the card count) and pageInfo. Each product node carries: title, handle, status, vendor, productType, tags, totalInventory, description, onlineStoreUrl, featuredImage + media previews, collections, taxonomy category, seo, price + compareAt ranges, each variant\'s title/sku/price/compareAtPrice/availableForSale/inventoryQuantity/inventoryPolicy/requiresShipping/weight/options/tracked flag, and metafields — answer detail questions (stock counts, sizes/colours, materials, shipping, collections) from these fields; if an answer needs a field not returned, say you can\'t see it rather than guessing. For cheapest/most-expensive asks compare EVERY node\'s priceRangeV2.minVariantPrice — never guess from result order. When productsCount exceeds the cards returned, say so — then either pass the endCursor as `after` for the next page ("show me more") or suggest narrowing the search. Each node also carries a short description you can summarise when they ask about a product, and variants.nodes[0].availableForSale — if it is FALSE the item is out of stock: say so plainly and do NOT move toward a purchase of it. TRUE means purchasable — NEVER call a product out of stock on a true or missing flag (untracked inventory returns true; a title like "Not Tracked" says nothing about stock). STOCK RULES — mechanically enforced on the cards: out-of-stock products render WITH an Out of stock badge and no Add to cart button on every browse/search call by default; pass in_stock_only:"1" ONLY when the customer explicitly asks for available items, and only_unavailable:"1" when they ask for JUST the out-of-stock items. When a badged card renders, call it out as unavailable in your text — "the Gift Card is out of stock right now" — never describe a badged card as purchasable, and never count it toward an in-stock list. Only products a storefront visitor can actually buy ever appear (draft, archived and unpublished products are filtered out mechanically — their page and cart links would be dead, so there is nothing to show); productsCount counts only those too. If the customer sends a PHOTO asking for something similar, describe what you see in concrete attributes (product type, colour, material, use) and pass those as the query plus limit:"1"–"3" so the shopper sees the closest match, not a page of neighbours — never run a title: search on a photo ask (a title query only returns the product you already guessed and confirms nothing); that is the photo-search path — after the search you may be shown the candidates\' own product photos: compare them against the customer\'s image and name the closest match by title (or say none resembles it); never claim you cannot look at images when one is attached — but if a message notes an attachment\'s contents did not load, the file genuinely did not reach you: say it did not come through and ask for a smaller file or a description, do not guess what was in it. On a Shopify storefront each rendered card also carries an "Add to cart" button the shopper can tap themselves — for a buy-it ask you can point them at it or at their cart (the /cart page on the store), and still create a draft order when they want you to do it all for them. OPTIONS & SUBSCRIPTIONS: a card showing "from $X" has multiple variants — quote "from" and name the options line rather than one flat price; a card with NO Add to cart button has selling plans (subscription/preorder/prepaid/trial via sellingPlanGroups) or an unpicked choice — those show a "See options" button that opens an in-chat picker (variant pills + purchase-plan choices), so narrate the plan names ("also available as a weekly subscription, or preorder at 20% off") and tell the shopper to tap "See options" — never imply the card\'s default button adds a configured product. COLLECTIONS & RANKING: pass `collection` with a handle to scope to one collection (list handles via shopify_list_collections); `sort` ranks by newest/stock/vendor/etc. For "popular/bestseller" asks use shopify_analytics (exact; needs read_reports) or shopify_sales_stats (orders fallback) — there is no sales-rank sort, and NEVER invent a ranking. MARKETS: the result also carries shop.shipsToCountries — the markets the store actually delivers to. If the shopper\'s storefront market (in the conversation context) is NOT in that list, products can ALL appear unavailable/sold-out on their screen even with full stock — say the store doesn\'t currently deliver to their market instead of claiming items are out of stock, and never flatly deny that their location affects what the storefront shows them.',
        method: 'POST',
        url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
        headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
        bodyTemplate:
          '{"query":"query($q:String!,$after:String,$sort:ProductSortKeys,$reverse:Boolean){shop{shipsToCountries currencyCode} productsCount(query:$q){count} products(first:10,query:$q,after:$after,sortKey:$sort,reverse:$reverse){pageInfo{hasNextPage endCursor} edges{cursor} nodes{id title handle status vendor productType tags totalInventory description(truncateAt:120) onlineStoreUrl featuredImage{url} images(first:3){nodes{url}} collections(first:3){nodes{title}} category{fullName} options{name values} sellingPlanGroups(first:5){nodes{name sellingPlans(first:3){nodes{name}}}} seo{title description} priceRangeV2{minVariantPrice{amount currencyCode} maxVariantPrice{amount currencyCode}} compareAtPriceRange{minVariantCompareAtPrice{amount currencyCode} maxVariantCompareAtPrice{amount currencyCode}} variants(first:10){nodes{id title sku price compareAtPrice availableForSale inventoryQuantity inventoryPolicy selectedOptions{name value} inventoryItem{tracked requiresShipping measurement{weight{value unit}}}}} metafields(first:10){nodes{namespace key value type}}}}}","variables":{"q":"${query:text} status:active published_status:published","after":${after?},"sort":${sort?},"reverse":${reverse?}}}',
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
            'JSON ReturnRequestInput — {"orderId":"gid://shopify/Order/…","returnLineItems":[{"fulfillmentLineItemId":"gid://shopify/FulfillmentLineItem/…","quantity":1,"returnReason":"DEFECTIVE","customerNote":"…"}]} — ids come from shopify_lookup_order (order.id + fulfillments[].fulfillmentLineItems[].id). returnReason is REQUIRED per line item — pick the closest of DEFECTIVE, WRONG_ITEM, NOT_AS_DESCRIBED, WRONG_SIZE (SIZE_TOO_LARGE/SIZE_TOO_SMALL), UNWANTED, STYLE, COLOR, OTHER and put the customer\'s own words in customerNote.',
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
          'List the account\u2019s most recently modified spreadsheets — returns ids the other Sheets tools need.',
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
          'List the account\u2019s most recently modified Google Docs — returns ids the other Docs tools need.',
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
        bodyTemplate: '{"title": "${title}"}',
      },
      {
        name: 'gdocs_append',
        label: 'Append text',
        description: 'Append text to the end of a Google Doc.',
        method: 'POST',
        url: 'https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate',
        headers: { authorization: 'Bearer {{secrets.CONN_GOOGLE_TOKEN}}' },
        params: { document_id: 'doc id', text: 'text to append' },
        bodyTemplate: '{"requests": [{"insertText": {"endOfSegmentLocation": {}, "text": "${text}\n"}}]}',
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
