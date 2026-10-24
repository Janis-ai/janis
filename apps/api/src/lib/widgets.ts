// In-conversation widgets — interactive components the agent renders inside
// chat (Chatbase-style): product cards, option pickers, forms, status
// trackers, receipts. The model emits "WIDGET: {json}" lines; the reply path
// strips them from the text and stores the validated components on
// payload.widgets. widget.js renders them; taps submit back through the
// normal inbound-message path (sendText), so interactions need no new wire.
import { z } from 'zod';

const s = (max: number) => z.string().min(1).max(max);
const url = z
  .string()
  .max(500)
  // A bare {prop} is legal at template-save time — interpolation either fills
  // it with a real URL or empties it, and the field is optional so it drops.
  .refine((u) => /^https?:\/\//.test(u) || u.startsWith('/') || /^\{[a-z][a-z0-9_]*\}$/.test(u), 'not a url');

export const WidgetComponent = z.discriminatedUnion('type', [
  // Product/recommendation carousel — image, title, price, a link and/or a
  // "select" action that sends the customer a tappable choice.
  z.object({
    type: z.literal('cards'),
    items: z
      .array(
        z.object({
          title: s(120),
          subtitle: s(200).optional(),
          image: url.optional(),
          price: s(40).optional(),
          // Availability badge — the :stock map modifier emits "Out of
          // stock" when the source flag is false, otherwise the field drops.
          stock: s(30).optional(),
          // Numeric variant id for the storefront Ajax cart API — the
          // :gidnum map modifier strips the gid:// wrapper. widget.js
          // renders an "Add to cart" button when present (storefront only).
          cart_variant_id: s(30).optional(),
          // Variant / purchase-option summary ("3 styles · Subscription,
          // Preorder available") — a silent one-variant Add to cart on a
          // configurable product is a contract the chat can't represent.
          options: s(240).optional(),
          // Compare-at ("was") price of the shown variant — a real one
          // means the product is on sale; renderers strike it through.
          compare_at: s(40).optional(),
          link: url.optional(),
          link_label: s(30).optional(),
          // Interpolated labels carry a full title ("I'm interested in the
          // {title}") — the cap must clear a 120-char product name.
          select_label: s(160).optional(), // tapping sends this as a message
          // Optional shorter display text for the select button — the sent
          // message stays select_label. Falls back to select_label.
          select_button: s(60).optional(),
        }),
      )
      .min(1)
      .max(10),
    // Query total when it exceeds the rendered items — cards cap at 10 while
    // the catalogue may hold more, and "all 13" over a 10-card carousel is a
    // lie. Renderers show "K of N" plus a load-more affordance; narrators
    // must say "the first K of N", never "all N".
    total: z.number().int().optional(),
    // The source result's pageInfo.endCursor — internal plumbing so a later
    // turn can recover a fumbled `after` argument; renderers ignore it.
    end_cursor: s(200).optional(),
    // The tool args that produced this page — internal plumbing; a "show me
    // more" tap replays them verbatim with `after: end_cursor` so the
    // continuation can't drift to a different query. Renderers ignore it.
    page_args: z.record(z.unknown()).optional(),
  }),
  // Booking-slot style picker — one tap sends the label as a message.
  z.object({
    type: z.literal('options'),
    title: s(120).optional(),
    items: z
      .array(z.object({ label: s(60), description: s(200).optional() }))
      .min(1)
      .max(12),
  }),
  // Support/contact form — fields submit as a structured customer message.
  z.object({
    type: z.literal('form'),
    title: s(120).optional(),
    submit_label: s(30).optional(),
    // Server-stamped collect-form name (cfg.collect_forms) — marks the
    // submission for structured handling (contact enrich + destinations).
    // Renderers pass it back; ad-hoc WIDGET: forms never carry it.
    collect: s(40).optional(),
    fields: z
      .array(
        z.object({
          name: s(40).regex(/^[a-z][a-z0-9_]*$/i),
          label: s(60),
          type: z.enum(['text', 'email', 'tel', 'textarea', 'select']).default('text'),
          options: z.array(s(60)).max(10).optional(),
          required: z.boolean().optional(),
          // Prefill — server stamps a fact it already knows (email, name);
          // the renderer seeds the input, the customer can still edit it.
          value: s(160).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  // Order/application tracker — read-only step list.
  z.object({
    type: z.literal('status'),
    title: s(120).optional(),
    steps: z
      .array(
        z.object({
          label: s(80),
          // A bare {prop} / {prop:modifier} is legal at template-save time —
          // the resolve path interpolates first, and an unfilled placeholder
          // strips to the 'todo' default rather than dropping the component
          // (unknown → "upcoming" is the honest direction to err).
          state: z
            .union([z.enum(['done', 'current', 'todo']), z.string().regex(/^\{[a-z][a-z0-9_]*(:[^}]*)?\}$/)])
            .default('todo'),
          note: s(160).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  // Receipt/summary — label/value rows with an optional bold total.
  // `summary` rows render AFTER the item rows, above the total — the cost
  // breakdown (subtotal / shipping / tax / discounts / refunded). They
  // interpolate against tool props, and empty-valued rows drop out, so a
  // receipt can list every breakdown line and only nonzero ones show.
  z.object({
    type: z.literal('receipt'),
    title: s(120).optional(),
    rows: z.array(z.object({ label: s(80), value: s(160) })).min(1).max(15),
    summary: z.array(z.object({ label: s(80), value: s(160) })).max(8).optional(),
    total: z.object({ label: s(80), value: s(60) }).optional(),
  }),
  // Plan/pricing table — subscription tiers with monthly+annual lines and
  // feature bullets, rendered like a billing page rather than product
  // cards. Built for agents selling plans (or answering "what do you
  // cost?") — deterministic saved specs, never model-fabricated prices.
  z.object({
    type: z.literal('pricing'),
    title: s(120).optional(),
    items: z
      .array(
        z.object({
          name: s(60),
          // "$29/mo" — optional: a plan whose price isn't in context should
          // omit this, not guess (the field is post-verified verbatim
          // against the corpus in repairPricingItems).
          price: s(30).optional(),
          price_alt: s(80).optional(), // "$290/yr — pay 10 months, get 12"
          blurb: s(200).optional(),
          features: z.array(s(80)).max(8).optional(),
          // Featured/current plan styling, mirroring the billing card.
          highlight: z.boolean().optional(),
          current: z.boolean().optional(),
          // Tapping the plan sends this as the customer's message —
          // "Tell me more about Pro" / "I want to upgrade to Pro".
          select_label: s(160).optional(),
          // Short text shown ON the button when select_label is a whole
          // sentence — same split as cards: button shows "Tell me more…",
          // the tap still sends the full select_label.
          select_button: s(30).optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  // Live storefront cart (Shopify only) — widget.js hydrates it from the
  // shop's same-origin /cart.js: real line items with quantity steppers,
  // remove buttons, subtotal and a checkout button that opens the native
  // checkout. Intentionally itemless — the shopper's actual cart is the
  // data source, so the model can't fabricate cart contents.
  z.object({
    type: z.literal('cart'),
    title: s(120).optional(),
  }),
]);
export type WidgetComponent = z.infer<typeof WidgetComponent>;

/** A named variant of a component — a complete alternative spec the model
 *  selects with "state" in the WIDGET_REF data (WIDGET_REF: tracker
 *  {"state":"in_transit"}). States are how a component renders differently
 *  per outcome — a "not found" state can carry different steps, items or
 *  no buttons. */
export const WidgetState = z.object({ name: s(40), spec: WidgetComponent });
export type WidgetState = z.infer<typeof WidgetState>;

/** Tool binding — a widget that fetches live data when referenced. The
 *  model supplies `args` in the WIDGET_REF data (prop → tool-param via
 *  `args`, identity-mapped by default); `props`/`items`/`item_map` map the
 *  JSON result into {prop} placeholders / a list's item rows. */
export const WidgetToolBinding = z.object({
  name: s(64),
  args: z.record(z.string(), s(80)).optional(),
  props: z.record(z.string(), s(160)).optional(),
  items: s(120).optional(),
  item_map: z.record(z.string(), s(160)).optional(),
});
export type WidgetToolBinding = z.infer<typeof WidgetToolBinding>;

/** {prop} placeholder inside a spec string — the data-binding syntax. */
const PROP_RE = /\{([a-z][a-z0-9_]{0,39})\}/g;

/** Prop names a spec binds — every `{prop}` placeholder in its strings. */
export function specProps(spec: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PROP_RE)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(spec);
  return [...found];
}

/** Fill a spec's {prop} placeholders with bound values. Missing props render
 *  empty — an unset image/link/select_label field simply disappears (the
 *  field is optional in the schema), which is also how a state "hides" a
 *  button. Values are stringified, trimmed and length-capped; the result is
 *  re-validated against WidgetComponent by the caller. */
export function interpolateSpec(spec: unknown, props: Record<string, unknown>): unknown {
  if (typeof spec === 'string') {
    if (!spec.includes('{')) return spec;
    const out = spec.replace(PROP_RE, (_, p: string) => {
      const v = props[p];
      return v == null ? '' : String(v).trim().slice(0, 300);
    });
    return out.trim();
  }
  if (Array.isArray(spec)) return spec.map((v) => interpolateSpec(v, props));
  if (spec && typeof spec === 'object') {
    return Object.fromEntries(
      Object.entries(spec as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateSpec(v, props),
      ]),
    );
  }
  return spec;
}

/** Scalar props from a bound tool's JSON result — prop ← dotpath/template
 *  via the same mapValue syntax ToolWidgetConfig uses. */
export function propsFromResult(
  map: Record<string, string> | undefined,
  data: unknown,
  secrets: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, expr] of Object.entries(map ?? {})) {
    const v = mapValue(data, expr, secrets);
    if (v != null && v !== '') out[prop] = str(v);
  }
  return out;
}

/** List items from a bound tool's JSON result — for cards/options the rows
 *  replace spec.items outright (a template item is just the field shape). */
export function itemsFromResult(
  tool: WidgetToolBinding,
  data: unknown,
  secrets: Record<string, string> = {},
): Record<string, unknown>[] | null {
  let rows: unknown =
    tool.items != null ? digPath(data, tool.items) : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(rows) && data && typeof data === 'object') {
    rows = Object.values(data as Record<string, unknown>).find(Array.isArray);
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const map = tool.item_map ?? {};
  return rows
    .slice(0, 12)
    .map((r) =>
      Object.fromEntries(
        Object.entries(map).flatMap(([field, expr]) => {
          const v = str(mapValue(r, expr, secrets));
          return v ? [[field, v]] : [];
        }),
      ),
    )
    .filter((it) => Object.keys(it).length > 0);
}

/** Remove '' values recursively — an unfilled {prop} renders empty, which
 *  should mean "field absent" for optional fields (required empties still
 *  fail validation, which is the intended data-required behaviour). */
export function stripEmptyStrings(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripEmptyStrings);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== '')
        .map(([k, val]) => [k, stripEmptyStrings(val)]),
    );
  }
  return v;
}

const MAX_WIDGETS = 3;
// [\s\S] — the payload can span lines when the model pretty-prints the spec.
const WIDGET_LINE = /^WIDGET:\s*([\s\S]*)$/i;
// Saved components — "WIDGET_REF: plans" resolves the agent_widgets row's
// spec; "WIDGET_REF: tracker {"order_id":"#1932"}" also passes data that
// fills {prop} placeholders / feeds a bound tool's args. The model writes
// display-form names too ("WIDGET_REF: Pricing Table"), so the capture
// tolerates spaces; lookup normalizes. See normWidgetRef.
const WIDGET_REF_LINE = /^WIDGET_REF:\s*([a-z][a-z0-9_ -]{0,39}?)\s*(\{[\s\S]*\})?\s*$/i;

/** Lowercase + runs of space/dash/underscore collapse to one dash — "Pricing
 *  Table", "pricing_table" and "pricing-table" all name the same widget. */
export function normWidgetRef(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '-');
}

/**
 * Tool → widget binding (Chatbase-style live data): a custom tool declares
 * `widget` and its JSON result renders as a component automatically — the
 * model never has to transcribe the data itself. `map` keys are widget
 * fields; values are dot paths into each result row ("variants.0.price").
 * `items` is the dot path to the rows array when the result isn't one.
 */
export interface ToolWidgetConfig {
  type: 'cards' | 'options';
  /** Widget heading. */
  title?: string;
  /** Literal button labels applied to every card row. */
  link_label?: string;
  /** Tapping sends this text as the customer's message (cards only). */
  select_label?: string;
  /** Shorter text shown ON the select button when select_label is a long
   *  sentence ("Tell me more…" on the card, "Tell me more about Janis Pro"
   *  into the chat). Per-row {path} interpolation applies here too. */
  select_button?: string;
  /** Dot path to the rows array inside the result. Default: the result is
   *  an array, or its first array-valued property. */
  items?: string;
  /** Dot path to a per-row sort key — the API's default order is rarely the
   *  answer to the customer's question (Stripe lists newest-first, burying
   *  the flagship products under recent usage meters). Ascending; prefix
   *  "-" for descending. Numeric compare when both sides are numbers. */
  sort?: string;
  /** Widget field → dot path into each row object. cards: title, subtitle,
   *  image, price, link. options: label, description. */
  map?: Record<string, string>;
  /** Fuzzy-search APIs pad results with unrelated filler (iTunes "now and
   *  then" returns Drive My Car). When set, rows are filtered against the
   *  query arg before the model and the cards see them. */
  relevance?: {
    /** Tool arg carrying the search query. */
    arg: string;
    /** Row dot paths whose values are matched against the query. */
    fields: string[];
    /** When set, a row survives on ANY query-token hit in these fields (the
     *  identifying columns — title/type/tags) or a whole-phrase hit in
     *  `fields`; the ≥50% rule isn't used. Descriptive multi-term queries
     *  ("snowboard blue cloud") can't pass a 50% bar on real rows, but a
     *  "snowboard" query must still not return a gift card. */
    strong_fields?: string[];
  };
  /** Rows whose `field` resolves to === false are unpurchasable — they render
   *  WITH an Out of stock badge by default (a browsable catalogue shouldn't
   *  silently hide products) and are hidden only when the model passes
   *  `in_stock_arg` for an explicit in-stock ask. `only_arg` flips to an
   *  unavailable-only view. The model still sees every row in the result
   *  text and can narrate OOS truthfully; this only shapes the cards. */
  availability?: {
    /** Row dot path holding the purchasable flag (=== false ⇒ hide). */
    field: string;
    /** Tool arg that disables the drop when set to a truthy string. */
    unless_arg: string;
    /** Tool arg that drops unpurchasable rows when truthy — "items in
     *  stock" asks render the sellable set only. */
    in_stock_arg?: string;
    /** Tool arg that keeps ONLY the unavailable rows when truthy — "show me
     *  just the out-of-stock items" renders exactly those, badged. */
    only_arg?: string;
  };
  /** Cap rendered rows via a tool arg — a specific-product or photo-match
   *  ask should show THE match, not a page of neighbours. The result text
   *  still carries every row for narration; this only shapes the cards. */
  row_limit_arg?: string;
  /** Multi-variant rows need ONE node to price the card AND fill the Add
   *  button — picking variants[0] can pair a $9.95 min-price narrative with
   *  a $24.95 add. `by` picks the cheapest node where `require` isn't false
   *  (cheapest AVAILABLE variant); all failing → first node. Runs before
   *  the availability filter so `field` can point at the picked node. */
  pick?: {
    /** Dot path to the per-row nodes array (e.g. "variants.nodes"). */
    from: string;
    /** Key the picked node is written to on the row (e.g. "__variant"). */
    into: string;
    /** Node dot path minimized (e.g. "price") — omit for first-fit. */
    by?: string;
    /** Node dot path that must not be === false for a node to be eligible. */
    require?: string;
  };
}

/** Resolve a dot path ("a.b.0.c") against a row — numbers index arrays. */
function digPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** MoneyV2 formatting for the ":money" map modifier — "{…min.amount:money}"
 *  formats the dug amount through Intl with the sibling currencyCode, so a
 *  USD shop renders "$9.95" and a EUR one "€9.95" instead of "USD 9.95".
 *  Codes Intl doesn't know degrade to "CHF 9.95"-style. */
export function formatMoney(amount: unknown, code: unknown): string | undefined {
  const c = String(code ?? '').trim();
  const n = typeof amount === 'number' ? amount : Number.parseFloat(String(amount ?? ''));
  if (!Number.isFinite(n)) return undefined;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: c || 'USD',
      currencyDisplay: 'narrowSymbol',
    }).format(n);
  } catch {
    return c ? `${c} ${n}` : String(n);
  }
}

/** First `currencyCode` string anywhere in a row — the shop's currency is
 *  uniform per result, so a scalar Money field borrows its sibling's code. */
function firstCurrencyCode(obj: unknown, depth = 0): string | undefined {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === 'currencyCode' && typeof v === 'string' && v) return v;
    const found = firstCurrencyCode(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Map values may be a plain dot path ("variants.0.price") or a template
 *  with {path} placeholders ("https://shop/products/{handle}") — needed when
 *  the API returns handles, not URLs. {{secrets.X}} resolves too so store
 *  domains don't get hard-coded into mappings. A "{path:money}" modifier
 *  formats a MoneyV2-shaped amount ({amount, currencyCode} siblings). */
function mapValue(row: unknown, expr: string, secrets: Record<string, string>): unknown {
  if (expr.includes('{')) {
    const t = expr.replace(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g, (_, k: string) => secrets[k] ?? '');
    const out = t.replace(/\{([A-Za-z0-9_.]+)((?::[a-z]+)*)\}/g, (_, p: string, mods?: string) => {
      // "." addresses the row itself — whole-node modifiers like
      // :orderline/:trackstate need the object, not a leaf field.
      const v = p === '.' ? row : digPath(row, p);
      let cur = v;
      for (const mod of (mods ?? '').split(':').filter(Boolean)) {
        if (mod === 'nonzero') {
          // {path:money:nonzero} — drops the value entirely when it parses to
          // zero, so summary rows like "Refunded −$0.00" strip instead of
          // rendering noise. Works alone or after a formatter like :money.
          const n =
            typeof cur === 'number'
              ? cur
              : Number.parseFloat(String(cur ?? '').replace(/[^0-9.\-]/g, ''));
          if (!Number.isFinite(n) || Math.abs(n) < 0.005) return '';
          continue;
        }
        if (mod === 'trackstate') {
          // {orderNode:trackstate} — derives the tracker variant name: a
          // cancelled order must never render as a pending pipeline, and a
          // delivered carrier event beats the coarser fulfillment status.
          const n = cur as Record<string, unknown> | null;
          if (!n || typeof n !== 'object') return '';
          if (n.cancelledAt) return 'cancelled';
          const evs = (Array.isArray(n.fulfillments) ? n.fulfillments : []).flatMap(
            (f) => ((f as { events?: { nodes?: { status?: unknown }[] } })?.events?.nodes ?? []),
          );
          const ev = (s: string) => evs.some((e) => String(e.status ?? '').toLowerCase() === s);
          if (ev('delivered') || ev('picked_up')) return 'delivered';
          const ful = String(n.displayFulfillmentStatus ?? '').toUpperCase();
          // Held orders aren't a pipeline position — they get their own
          // variant so "on hold" doesn't render as mid-shipment.
          if (ful === 'ON_HOLD') return 'on_hold';
          // Nothing to ship (gift cards, digital goods) must not promise a
          // delivery pipeline: explicit status, or all-digital items while
          // the order is still open.
          const items = (
            (n.lineItems as { nodes?: { requiresShipping?: unknown }[] } | undefined)?.nodes ?? []
          );
          const allDigital =
            items.length > 0 && items.every((i) => i.requiresShipping === false);
          if (ful === 'FULFILLMENT_NOT_REQUIRED' || (ful === 'UNFULFILLED' && allDigital))
            return 'no_shipping';
          // BOPIS/local pickup: a shipping line exists (the pickup point)
          // but there's no shipping address — nothing travels, so a
          // Shipped→Delivered pipeline would be a lie.
          const isPickup = n.shippingAddress === null && n.shippingLine != null;
          if (isPickup) return ful === 'FULFILLED' ? 'picked_up' : 'pickup';
          if (ev('in_transit') || ev('out_for_delivery') || ful === 'PARTIALLY_FULFILLED')
            return 'in_transit';
          if (ful === 'FULFILLED' || evs.length) return 'shipped';
          return 'unfulfilled';
        }
        if (mod === 'orderline') {
          // {orderNode:orderline} — one-line status for list subtitles:
          // Cancelled / Refunded outrank the fulfillment word, which alone
          // would read "Fulfillment not required" on a cancelled order.
          const n = cur as Record<string, unknown> | null;
          if (!n || typeof n !== 'object') return '';
          if (n.cancelledAt) return 'Cancelled';
          const fin = String(n.displayFinancialStatus ?? '').toUpperCase();
          if (fin === 'REFUNDED') return 'Refunded';
          if (fin === 'PARTIALLY_REFUNDED') return 'Partially refunded';
          // "Fulfillment not required" reads like an error to a customer —
          // digital goods just have nothing to ship.
          if (String(n.displayFulfillmentStatus ?? '').toUpperCase() === 'FULFILLMENT_NOT_REQUIRED')
            return 'No shipping needed';
          // Pickup orders never ship — "Unfulfilled" undersells "waiting
          // for you at the counter".
          if (n.shippingAddress === null && n.shippingLine != null)
            return String(n.displayFulfillmentStatus ?? '').toUpperCase() === 'FULFILLED'
              ? 'Picked up'
              : 'Awaiting pickup';
          const s = String(n.displayFulfillmentStatus ?? '')
            .replace(/[_-]+/g, ' ')
            .trim()
            .toLowerCase();
          return s ? s[0].toUpperCase() + s.slice(1) : '';
        }
        if (mod === 'money') {
          const parent = p.slice(0, Math.max(0, p.lastIndexOf('.')));
          // Sibling currencyCode first (MoneyV2), then the row's own, then
          // any currencyCode in the row — a scalar Money field
          // (ProductVariant.price) has no sibling, but the row's priceRange
          // still carries the code.
          const code =
            digPath(row, parent ? `${parent}.currencyCode` : 'currencyCode') ??
            digPath(row, 'currencyCode') ??
            firstCurrencyCode(row);
          cur = formatMoney(cur, code) ?? '';
          continue;
        }
        // {flag:stock} — 'Out of stock' only when the source flag is a real
        // false; true/absent (untracked inventory, gift cards) stays silent.
        if (mod === 'stock') { cur = cur === false ? 'Out of stock' : ''; continue; }
        // {n:s} — plural suffix: 's' unless the value is exactly 1, so a
        // subtitle like "{count} item{count:s}" reads "1 item"/"8 items".
        if (mod === 's') { cur = Number(cur) === 1 ? '' : 's'; continue; }
        // {path:gidnum} — the numeric tail of a Shopify gid
        // (gid://shopify/ProductVariant/123 → '123') for the Ajax cart API.
        if (mod === 'gidnum') {
          const m = String(cur ?? '').match(/\/(\d+)$/);
          cur = m ? m[1] : '';
          continue;
        }
        // {status:stepstate} — normalises a raw API status ("in_transit",
        // "fulfilled") into the status widget's done/current/todo enum, so a
        // tool's event list can drive a progress tracker's steps.
        if (mod === 'stepstate') { cur = stepState(cur); continue; }
        // {ts:date} — ISO-ish timestamps → "Oct 16, 2026" (deterministic
        // short form; raw API dates are unreadable as subtitles).
        if (mod === 'date') {
          const d = new Date(String(cur ?? ''));
          cur = Number.isNaN(d.getTime())
            ? ''
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          continue;
        }
        // {code:paren} — wraps a present value in parens, empty stays empty,
        // so " −{discounts} {code:paren}" renders "−$5.00 (WELCOME10)".
        if (mod === 'paren') { cur = String(cur ?? '').trim() ? `(${String(cur).trim()})` : ''; continue; }
        // {status:pretty} — raw enum/property words → "In transit" —
        // underscores and SCREAMING_CASE are machine noise in a chat.
        if (mod === 'pretty') {
          const s = String(cur ?? '').replace(/[_-]+/g, ' ').trim().toLowerCase();
          cur = s ? s[0].toUpperCase() + s.slice(1) : '';
          continue;
        }
      }
      return cur == null ? '' : String(cur);
    });
    return out.trim() ? out : undefined;
  }
  return digPath(row, expr);
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : v == null ? undefined : String(v).slice(0, 500);

/** Normalise a provider status word into the status widget's step-state
 *  enum — terminal-positive words map to done, actively-in-flight words to
 *  current, everything else (pending, unknown, empty) to todo. */
const STEP_DONE = new Set([
  'done', 'delivered', 'fulfilled', 'complete', 'completed', 'closed',
  'resolved', 'paid', 'success', 'succeeded', 'arrived', 'approved',
  'confirmed', 'picked_up',
]);
const STEP_CURRENT = new Set([
  'current', 'shipped', 'in_transit', 'in-transit', 'in_progress',
  'in-progress', 'processing', 'out_for_delivery', 'partially_fulfilled',
  'active', 'open', 'on_hold',
]);
export function stepState(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (STEP_DONE.has(s)) return 'done';
  if (STEP_CURRENT.has(s)) return 'current';
  return 'todo';
}

/** Apply cfg.pick to one row — returns a new row with the chosen node at
 *  `into`. Cheapest eligible node wins; when none qualify (all OOS), the
 *  first node is picked so the row still describes a real variant. */
export function applyRowPick(
  row: unknown,
  pick: NonNullable<ToolWidgetConfig['pick']>,
): unknown {
  if (!row || typeof row !== 'object') return row;
  const nodes = digPath(row, pick.from);
  if (!Array.isArray(nodes) || !nodes.length) return row;
  const usable = pick.require
    ? nodes.filter((n) => digPath(n, pick.require!) !== false)
    : nodes;
  const pool = usable.length ? usable : nodes;
  let best = pool[0];
  if (pick.by) {
    let bestN = Infinity;
    for (const n of pool) {
      const v = Number(digPath(n, pick.by));
      if (Number.isFinite(v) && v < bestN) {
        bestN = v;
        best = n;
      }
    }
  }
  return { ...(row as Record<string, unknown>), [pick.into]: best };
}

/** Variant + purchase-option summary for a product row. Three facts decide
 *  the card's shape: how many variants are purchasable ("from" pricing),
 *  what options exist (the display line), and whether selling plans apply
 *  (an Add-to-cart must not silently pick one-time over subscription). */
function purchaseOptionInfo(row: unknown): { text?: string; suppressAdd?: boolean; multi?: boolean } {
  const variants = digPath(row, 'variants.nodes');
  const varr = Array.isArray(variants) ? variants : [];
  const purchasable = varr.filter((v) => (v as { availableForSale?: unknown }).availableForSale !== false);
  const opts = digPath(row, 'options');
  const optArr = Array.isArray(opts) ? opts : [];
  const groups = digPath(row, 'sellingPlanGroups.nodes');
  const garr = Array.isArray(groups) ? groups : [];
  const planNames = [
    ...new Set(
      garr
        .map((g) => String((g as { name?: unknown }).name ?? ''))
        .filter(Boolean),
    ),
  ];
  // Shopify synthesizes a "Title: Default Title" option on option-less
  // products — that's schema noise, not a choice. Real multi-value Title
  // options are variant names; "Options:" labels them better than "Title:".
  const optLines = optArr
    .map((o) => ({
      name: String((o as { name?: unknown }).name ?? ''),
      vals: Array.isArray((o as { values?: unknown }).values)
        ? ((o as { values?: unknown[] }).values as unknown[]).map(String)
        : [],
    }))
    .filter((o) => !(o.name === 'Title' && o.vals.length === 1 && o.vals[0] === 'Default Title'));
  return purchaseOptionsLine(optLines, planNames, purchasable.length);
}

/** Format the options line + Add-suppression decision from the extracted
 *  pieces — shared between widget-built cards and the model-authored card
 *  repair path (a hand-written "Add to cart" under a subscription product
 *  is the same silent contract either way). */
export function purchaseOptionsLine(
  optLines: { name: string; vals: string[] }[],
  planNames: string[],
  purchasableCount: number,
): { text?: string; suppressAdd?: boolean; multi?: boolean } {
  const parts: string[] = [];
  if (optLines.length) {
    parts.push(
      optLines
        .slice(0, 2)
        .map((o) => {
          const label = o.name === 'Title' ? 'Options' : o.name;
          const vl = o.vals.slice(0, 4).join('·');
          // Variant names that embed the product title ("Special Selling
          // Plans Ski Wax") repeat the card's own title — count them
          // instead of wrapping a wall of text around the image.
          if (vl.length > 40) return `${o.vals.length} variants`;
          const extra = o.vals.length > 4 ? ` +${o.vals.length - 4}` : '';
          return vl ? `${label}: ${vl}${extra}` : label;
        })
        .join(' · '),
    );
  } else if (purchasableCount > 1) {
    parts.push(`${purchasableCount} variants`);
  }
  // Plan names can be long ("Try Before You Buy") — a compact count keeps
  // the card scannable when they won't fit; the picker sheet carries the
  // full list anyway.
  if (planNames.length) {
    const joined = planNames.join(', ');
    parts.push(joined.length > 34 ? `${planNames.length} purchase options` : `${joined} available`);
  }
  return {
    text: parts.join(' — ') || undefined,
    suppressAdd: planNames.length > 0,
    multi: purchasableCount > 1,
  };
}

/** Sales-analytics results are merchant-internal data — units sold, order
 *  tallies, revenue. Anything the model can see it can quote to a shopper,
 *  so these tools' raw results are reshaped server-side into an ordered
 *  product-title list BEFORE they reach the model: a number that never
 *  enters context is a number that can't leak. Returns undefined when the
 *  result isn't a parseable analytics payload (errors pass through). */
export function internalDataResult(toolName: string, result: string): string | undefined {
  if (!result.startsWith('{')) return undefined;
  let data: Record<string, unknown> | undefined;
  try {
    data = (JSON.parse(result) as { data?: Record<string, unknown> }).data;
  } catch {
    return undefined;
  }
  if (!data) return undefined;
  if (toolName === 'shopify_analytics') {
    const q = data.shopifyqlQuery as
      | { tableData?: { rows?: unknown }; parseErrors?: unknown; parseWarnings?: unknown }
      | undefined;
    if (!q) return undefined;
    const errs = Array.isArray(q.parseErrors) && q.parseErrors.length ? q.parseErrors : undefined;
    if (errs) return JSON.stringify({ parseErrors: errs });
    let ranked: string[] = [];
    try {
      const rows =
        typeof q.tableData?.rows === 'string' ? JSON.parse(q.tableData.rows) : q.tableData?.rows;
      if (Array.isArray(rows))
        ranked = rows
          .map((r) => String((r as { product_title?: unknown }).product_title ?? ''))
          .filter(Boolean);
    } catch {
      /* unparseable rows scalar → empty ranking */
    }
    return JSON.stringify({ ranked_products: ranked });
  }
  if (toolName === 'shopify_sales_stats') {
    const orders = (data.orders as { nodes?: unknown[] } | undefined)?.nodes;
    if (!Array.isArray(orders)) return undefined;
    const tally = new Map<string, number>();
    for (const o of orders) {
      const items = (o as { lineItems?: { nodes?: unknown[] } }).lineItems?.nodes ?? [];
      for (const li of items) {
        const title = String(
          (li as { product?: { title?: unknown }; title?: unknown }).product?.title ??
            (li as { title?: unknown }).title ??
            '',
        );
        const qty = Number((li as { quantity?: unknown }).quantity) || 0;
        if (title) tally.set(title, (tally.get(title) ?? 0) + qty);
      }
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return JSON.stringify({ ranked_products: ranked });
  }
  return undefined;
}

/** Rows the in-stock filter hid — nonzero only on an explicit in-stock ask.
 *  Used to tell the model "N more matched but are unavailable" so it can
 *  offer them rather than undercounting the catalogue. */
export function availabilityDropped(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
  resultText: string,
): number {
  const rel = cfg.availability;
  if (!rel) return 0;
  const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  if (!rel.in_stock_arg || !truthy(args[rel.in_stock_arg])) return 0;
  if (rel.only_arg && truthy(args[rel.only_arg])) return 0;
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return 0;
  }
  let rows: unknown = cfg.items != null ? digPath(data, cfg.items) : undefined;
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) rows = [rows];
  if (!Array.isArray(rows)) return 0;
  const hidden = rows.filter((r) => {
    const row = cfg.pick ? applyRowPick(r, cfg.pick) : r;
    return digPath(row, rel.field) === false;
  }).length;
  // An all-OOS page renders its rows badged rather than dropping them —
  // nothing was actually hidden, so the "N more exist" note would lie.
  return hidden < rows.length ? hidden : 0;
}

// ---------------------------------------------------------------------------
// Storefront truth — Admin's availableForSale says a product is sellable even
// when the Online Store can't sell it (third-party fulfilment location stock:
// sellableOnlineQuantity counts it, /cart/add.js 422s). The storefront's own
// /products/{handle}.js answers in shopper-facing terms — fetch it server-
// side per card (60s cache, one flight per handle) and correct the widget
// BEFORE it ships, so badge and narration agree pre-hydration.

interface SfVariant {
  id: number;
  available?: boolean;
  price?: number;
  compare_at_price?: number | null;
  selling_plan_allocations?: { selling_plan_id: number; price: number }[];
}
interface SfProduct {
  available?: boolean;
  variants?: SfVariant[];
}

const SF_TTL = 60_000;
const SF_COOKIE_TTL = 3_600_000;
const sfCache = new Map<string, { ts: number; data: SfProduct | null }>();
const sfFlight = new Map<string, Promise<SfProduct | null>>();
const sfCookies = new Map<string, { ts: number; cookie: string | null }>();

export function clearStorefrontCache(): void {
  sfCache.clear();
  sfFlight.clear();
  sfCookies.clear();
}

/** Storefront requests masquerade as a real shopper — Shopify's password
 *  gate and bot throttles treat the default node-fetch UA as a crawler
 *  (products/*.js bounces to /password even with a session cookie). */
const SF_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Password-protected storefronts bounce every request to /password.
 *  When the connection carries SHOPIFY_STOREFRONT_PASSWORD, POST the
 *  standard form to trade it for the session cookies (modern themes set
 *  _shopify_essential, older ones storefront_digest) and reuse them. */
async function storefrontCookie(shopHost: string, password: string | undefined): Promise<string | null> {
  if (!password) return null;
  const hit = sfCookies.get(shopHost);
  if (hit && Date.now() - hit.ts < SF_COOKIE_TTL) return hit.cookie;
  try {
    const r = await fetch(`https://${shopHost}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': SF_UA },
      body: `form_type=storefront_password&utf8=%E2%9C%93&password=${encodeURIComponent(password)}`,
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
    });
    // Node's fetch collapses set-cookie — getSetCookie() splits them; the
    // Cookie header wants every name=value pair, joined.
    const setCookies =
      (r.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [r.headers.get('set-cookie') ?? ''].filter(Boolean);
    const cookie = setCookies
      .map((c) => /^[^;]+/.exec(c)?.[0])
      .filter((c): c is string => !!c)
      .join('; ') || null;
    sfCookies.set(shopHost, { ts: Date.now(), cookie });
    return cookie;
  } catch {
    sfCookies.set(shopHost, { ts: Date.now(), cookie: null });
    return null;
  }
}

/** The shopper's resolved market country (Shopify.country) drives
 *  availability — a market whose catalog excludes the product reports
 *  `available:false` for EVERY variant, including untracked stock. The
 *  server must probe in the shopper's market: `localization=<cc>` is the
 *  storefront cookie that pins market context (self-setting it works —
 *  verified live). Without it the answer reflects whatever market the
 *  API's IP resolves to — a wrong-market "in stock" ships a dead button. */
export async function storefrontProduct(
  shopHost: string,
  handle: string,
  password?: string,
  market?: string,
): Promise<SfProduct | null> {
  const mk = /^[A-Za-z]{2}$/.test(market ?? '') ? market!.toUpperCase() : '';
  const key = `${shopHost}/${handle}/${mk}`;
  const hit = sfCache.get(key);
  if (hit && Date.now() - hit.ts < SF_TTL) return hit.data;
  const inflight = sfFlight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const url = `https://${shopHost}/products/${encodeURIComponent(handle)}.js`;
    // Follow redirects manually — a passworded shop loops /password →
    // /password under redirect:'follow' until the hop cap kills it, and
    // redirect detection is the signal that says "log in first".
    const get = async (cookie: string | null) => {
      const jar = [cookie, mk ? `localization=${mk}` : null].filter(Boolean).join('; ');
      const headers = { accept: 'application/json', 'user-agent': SF_UA, ...(jar ? { cookie: jar } : {}) };
      let r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(4_000) });
      for (let hop = 0; hop < 3 && r.status >= 300 && r.status < 400; hop++) {
        const loc = r.headers.get('location') ?? '';
        if (/\/password/.test(loc)) return { r: null as Response | null, passworded: true };
        if (!loc) break;
        r = await fetch(new URL(loc, url).href, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(4_000),
        });
      }
      return { r, passworded: false };
    };
    try {
      let { r, passworded } = await get(null);
      if (passworded) {
        const cookie = await storefrontCookie(shopHost, password);
        if (cookie) ({ r, passworded } = await get(cookie));
      }
      if (passworded || !r?.ok) throw new Error('unreachable');
      const data = (await r.json()) as SfProduct;
      sfCache.set(key, { ts: Date.now(), data });
      return data;
    } catch {
      sfCache.set(key, { ts: Date.now(), data: null });
      return null;
    } finally {
      sfFlight.delete(key);
    }
  })();
  sfFlight.set(key, p);
  return p;
}

/** Product search's `collection_id:<n>` clause only accepts the numeric
 *  collection id — the model holds handles. Resolve via Admin GraphQL,
 *  cached per (shop, handle); a miss resolves to null so the caller can
 *  scope to an impossible id rather than silently unfiltered results. */
const collectionIdCache = new Map<string, Promise<string | null>>();
export async function shopifyCollectionId(
  secrets: Record<string, string>,
  handle: string,
): Promise<string | null> {
  if (/^\d+$/.test(handle)) return handle; // numeric id passed straight through
  const shop = secrets.SHOPIFY_SHOP;
  const token = secrets.SHOPIFY_TOKEN;
  if (!shop || !token) return null;
  const key = `${shop}:${handle}`;
  let p = collectionIdCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
          body: JSON.stringify({
            query: 'query($h:String!){collectionByHandle(handle:$h){id}}',
            variables: { h: handle },
          }),
          signal: AbortSignal.timeout(5_000),
        });
        const j = (await res.json()) as {
          data?: { collectionByHandle?: { id?: string } | null };
        };
        return /\/(\d+)$/.exec(String(j?.data?.collectionByHandle?.id ?? ''))?.[1] ?? null;
      } catch {
        return null;
      }
    })();
    collectionIdCache.set(key, p);
  }
  return p;
}

/** Correct rendered card items against the storefront's own availability.
 *  mode 'badge' (default browse): mark unsellable items Out of stock, keep
 *  them visible. mode 'drop' (explicit in-stock ask): remove them — they
 *  don't belong in an available-only carousel at all. Returns flips. */
export async function storefrontTruth(
  widget: WidgetComponent,
  secrets: Record<string, string>,
  mode: 'badge' | 'drop' = 'badge',
  market?: string,
): Promise<number> {
  if (widget.type !== 'cards') return 0;
  const shop = secrets.SHOPIFY_SHOP;
  if (!shop) return 0;
  const flip = new Set<(typeof widget.items)[number]>();
  await Promise.all(
    widget.items.map(async (it) => {
      if (it.stock) return; // already badged
      const m = /\/products\/([^/?#]+)/.exec(it.link ?? '');
      if (!m) return;
      const p = await storefrontProduct(shop, m[1], secrets.SHOPIFY_STOREFRONT_PASSWORD, market);
      if (!p || !Array.isArray(p.variants)) return;
      if (it.cart_variant_id) {
        const v = p.variants.find((x) => String(x.id) === it.cart_variant_id);
        if (v && v.available === false) flip.add(it);
      } else if (p.available === false || (p.variants.length > 0 && !p.variants.some((v) => v.available !== false))) {
        flip.add(it);
      }
    }),
  );
  if (!flip.size) return 0;
  if (mode === 'drop') {
    widget.items = widget.items.filter((i) => !flip.has(i));
  } else {
    for (const it of flip) {
      it.stock = 'Out of stock';
      delete it.cart_variant_id;
    }
  }
  return flip.size;
}

/** Build a widget from a bound tool's JSON result. Null when the result
 *  isn't usable (truncated at the 8k tool cap, non-JSON, or no mappable
 *  rows) — the model's own narration still carries the answer. */
export function widgetFromToolResult(
  cfg: ToolWidgetConfig,
  resultText: string,
  secrets: Record<string, string> = {},
  args: Record<string, unknown> = {},
): WidgetComponent | null {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return null;
  }
  let rows: unknown =
    cfg.items != null ? digPath(data, cfg.items) : Array.isArray(data) ? data : undefined;
  // items may point at a single object (data.draftOrder) — wrap it so a
  // create-one-thing result renders as a one-card widget with its pay link.
  if (cfg.items != null && rows && typeof rows === 'object' && !Array.isArray(rows)) rows = [rows];
  // Result is an object — find its first array-valued property (the common
  // { products: [...] } / { results: [...] } envelope shape).
  if (!Array.isArray(rows) && data && typeof data === 'object') {
    rows = Object.values(data as Record<string, unknown>).find(Array.isArray);
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  // Variant selection before availability — the picked node answers both
  // "is this row buyable" and "what does the Add button send".
  let list: unknown[] = cfg.pick ? rows.map((r) => applyRowPick(r, cfg.pick!)) : rows;
  // Unpurchasable rows (availableForSale === false) drop out of the cards
  // unless the call explicitly opted in — the model narrates from the full
  // result either way. `list` keeps the array narrowing `rows` can't.
  const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  const onlyOos = cfg.availability?.only_arg ? truthy(args[cfg.availability.only_arg]) : false;
  // Default catalogue view badges OOS rows rather than hiding them — the
  // filter only activates on an explicit in-stock ask (or the flipped
  // unavailable-only view).
  const inStockOnly = cfg.availability?.in_stock_arg
    ? truthy(args[cfg.availability.in_stock_arg])
    : false;
  if (cfg.availability) {
    const field = cfg.availability.field;
    if (onlyOos) {
      list = list.filter((r) => digPath(r, field) === false);
      if (!list.length) return null;
    } else if (inStockOnly) {
      list = list.filter((r) => digPath(r, field) !== false);
      // An explicit in-stock ask with zero sellable rows renders no cards —
      // the model narrates "everything is sold out" from the result.
      if (!list.length) return null;
    }
  }
  // Focused-ask cap — `limit` narrows rendered rows, never the model's data.
  const rowCap = cfg.row_limit_arg ? Number(args[cfg.row_limit_arg]) : NaN;
  if (Number.isFinite(rowCap) && rowCap > 0) list = list.slice(0, Math.min(rowCap, 12));
  // Price-window filter — a "snowboards under $800" ask must never render
  // an $973 card beside that narration. Two mechanical sources: a
  // `variants.price:<op><n>` clause inside the search query itself, and
  // dedicated price_min/price_max args. The picked variant's price is the
  // one the card shows and the cart charges, so it's the one checked.
  if (cfg.pick) {
    let lo: number | null = null;
    let hi: number | null = null;
    let loIncl = true;
    let hiIncl = true;
    const clause = /variants\.price\s*:\s*(<=?|>=?|=)\s*([\d.]+)/.exec(String(args.query ?? ''));
    if (clause) {
      const n = Number(clause[2]);
      if (clause[1] === '<' || clause[1] === '<=') {
        hi = n;
        hiIncl = clause[1] === '<=';
      } else if (clause[1] === '>' || clause[1] === '>=') {
        lo = n;
        loIncl = clause[1] === '>=';
      } else {
        lo = n;
        hi = n;
      }
    }
    const amin = Number(args.price_min);
    const amax = Number(args.price_max);
    if (Number.isFinite(amin)) lo = lo === null ? amin : Math.max(lo, amin);
    if (Number.isFinite(amax)) hi = hi === null ? amax : Math.min(hi, amax);
    if (lo !== null || hi !== null) {
      const L = lo, H = hi, loI = loIncl, hiI = hiIncl;
      list = list.filter((r) => {
        const p = Number(digPath(r, '__v.price'));
        if (!Number.isFinite(p)) return false;
        if (L !== null && (loI ? p < L : p <= L)) return false;
        if (H !== null && (hiI ? p > H : p >= H)) return false;
        return true;
      });
      if (!list.length) return null;
    }
  }
  // Display ordering — runs after filters, before the 10-card slice, so the
  // leading cards are the ones the question was about. "-path" descending.
  if (cfg.sort) {
    const desc = cfg.sort.startsWith('-');
    const path = desc ? cfg.sort.slice(1) : cfg.sort;
    const keyed = (r: unknown): { n?: number; s?: string } => {
      const v = digPath(r, path);
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? { n } : { s: String(v ?? '') };
    };
    list = [...list].sort((a, b) => {
      const A = keyed(a);
      const B = keyed(b);
      const cmp =
        A.n !== undefined && B.n !== undefined
          ? A.n - B.n
          : A.n !== undefined
            ? -1
            : B.n !== undefined
              ? 1
              : (A.s ?? '').localeCompare(B.s ?? '');
      return desc ? -cmp : cmp;
    });
  }
  const map = cfg.map ?? {};
  // Label literals stay literal; a {path} in them resolves per-row, so a
  // card's select button can send "I'd like the Blue Tee", not just
  // "Choose this" for every product.
  const label = (v: string | undefined, r: unknown): string | undefined =>
    v && v.includes('{') ? str(mapValue(r, v, secrets)) : v;

  const candidate: unknown =
    cfg.type === 'options'
      ? {
          type: 'options',
          title: cfg.title,
          items: list
            .slice(0, 12)
            .map((r) => ({
              label: str(mapValue(r, map.label ?? 'label', secrets)) ?? str(mapValue(r, map.title ?? 'title', secrets)),
              description: str(mapValue(r, map.description ?? 'description', secrets)),
            }))
            .filter((it) => it.label),
        }
      : {
          type: 'cards',
          items: list
            .slice(0, 10)
            .map((r) => {
              const opt = purchaseOptionInfo(r);
              const price = str(mapValue(r, map.price ?? 'price', secrets));
              return {
                title: str(mapValue(r, map.title ?? 'title', secrets)) ?? str(mapValue(r, map.label ?? 'label', secrets)),
                subtitle: str(mapValue(r, map.subtitle ?? 'subtitle', secrets)),
                image: str(mapValue(r, map.image ?? 'image', secrets)),
                // Multi-variant rows sell "from" the picked price — a flat
                // "$24.95" implies every variant costs that.
                price: price && opt.multi ? `from ${price}` : price,
                compare_at: map.compare_at ? str(mapValue(r, map.compare_at, secrets)) : undefined,
                stock: map.stock ? str(mapValue(r, map.stock, secrets)) : undefined,
                options: opt.text,
                // An unavailable row renders for information only — its Add to
                // cart would hit the same rejection the badge warns about.
                // Selling-plan rows drop the button too: one-tap adding a
                // subscription product silently picks one-time purchase —
                // the PDP is the only place that choice exists.
                cart_variant_id:
                  map.cart_variant_id &&
                  !opt.suppressAdd &&
                  !(cfg.availability && digPath(r, cfg.availability.field) === false)
                    ? str(mapValue(r, map.cart_variant_id, secrets))
                    : undefined,
                link: str(mapValue(r, map.link ?? 'link', secrets)),
                link_label: label(cfg.link_label, r),
                select_label: label(cfg.select_label, r),
                select_button: label(cfg.select_button, r),
              };
            })
            .filter((it) => it.title),
        };

  const parsed = WidgetComponent.safeParse(candidate);
  if (!parsed.success) return null;
  const widget = parsed.data;
  // Stamp the query total + page cursor when a real next page exists —
  // renderers get a "K of N" + load-more tile, the reply guard can catch a
  // narration claiming the partial set is everything, and next turn's run
  // can recover when the model fumbles `after`. Skipped on the last page
  // (a tile there loops forever) and for `only_arg` views (the query total
  // counts rows the filter removed, so "3 of 13" would misdescribe it).
  if (widget.type === 'cards') {
    const cur = toolResultHasNext(resultText) ? toolResultEndCursor(resultText) : null;
    if (cur) widget.end_cursor = cur;
    // Continuation pages keep their producing args even on the LAST page
    // (no cursor) — that's what marks them as members of the pagination
    // chain when a later turn walks the history.
    if (cur || args.after !== undefined) widget.page_args = { ...args };
    const availFiltered =
      !!cfg.availability &&
      !!((cfg.availability.only_arg && args[cfg.availability.only_arg]) ||
        (cfg.availability.in_stock_arg && args[cfg.availability.in_stock_arg]));
    if (cur && !availFiltered) {
      const total = toolResultCount(resultText);
      // A floor count can't render as an exact "K of N" — skip the stamp;
      // the load-more tile still appears via end_cursor.
      const floor = (JSON.parse(resultText) as { __countFloor?: unknown }).__countFloor === true;
      if (!floor && total !== null && total > widget.items.length) widget.total = total;
    }
  }
  return widget;
}

/** The result's pageInfo.endCursor when another page exists — the
 *  authoritative next-page token, carried on the widget so a later turn
 *  can recover from a model-invented cursor. */
export function toolResultEndCursor(resultText: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return undefined;
  }
  let found: string | undefined;
  const walk = (obj: unknown, depth: number) => {
    if (found || !obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (found) return;
      if (k === 'pageInfo' && v && typeof v === 'object') {
        const pi = v as { hasNextPage?: unknown; endCursor?: unknown };
        if (pi.hasNextPage === true && typeof pi.endCursor === 'string') {
          found = pi.endCursor;
          return;
        }
      }
      walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return found;
}

/** True when the result's rows array resolved to empty — the caller uses it
 *  to warn the model not to fabricate the asked-for item's existence. */
export function toolResultEmpty(cfg: ToolWidgetConfig, resultText: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return false;
  }
  let rows: unknown =
    cfg.items != null ? digPath(data, cfg.items) : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(rows) && data && typeof data === 'object' && !Array.isArray(data)) {
    rows = Object.values(data as Record<string, unknown>).find(Array.isArray);
  }
  return Array.isArray(rows) && rows.length === 0;
}

/** Result-side facts the model must not guess: an authoritative total and
 *  the exact args for the next page. Shopify cursors are bound to the query
 *  that produced them — "show me more" with a rephrased query silently
 *  resets to page one, so the note hands the model the call verbatim. */
export function toolResultNotes(
  resultText: string,
  args: Record<string, unknown> = {},
  shown?: number,
  priceMapped?: boolean,
): string {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return '';
  }
  const notes: string[] = [];
  // Cards hydrate storefront-localized prices client-side, so the figures in
  // the raw result are list prices that can differ from what this shopper
  // sees and is charged. Quoting them verbatim contradicts the card.
  if (priceMapped) {
    notes.push(
      'prices in this data are catalogue list prices — the shopper\'s market may adjust them, so the rendered card (and checkout) can differ; never quote a bare price in text — hedge it ("listed at $X", "from $X") or defer to the card ("the card shows today\'s price")',
    );
  }
  const hasNext = toolResultHasNext(resultText);
  // Product results carry productsCount; collection results carry a top
  // collectionsCount AND a per-node productsCount — only the first (top-
  // level, query-order) count is the query total, so note just that one.
  const isProductResult = !!(data as { data?: { products?: unknown } })?.data?.products;
  // The pagination reconciler rewrites the count to the filtered total once
  // the match set is exhausted; when the scan hit its page budget the count
  // is only a confirmed floor — narrate "more than N", never an exact total
  // the carousel can't deliver.
  const countFloor = (data as { __countFloor?: unknown }).__countFloor === true;
  let countNoted = false;
  const priced: { title: string; min: number; max: number }[] = [];
  const walk = (obj: unknown, depth: number) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    const rec = obj as Record<string, unknown>;
    const pr = rec.priceRangeV2 as { minVariantPrice?: { amount?: string }; maxVariantPrice?: { amount?: string } } | undefined;
    if (typeof rec.title === 'string' && pr?.minVariantPrice?.amount !== undefined) {
      priced.push({
        title: rec.title,
        min: Number(pr.minVariantPrice.amount),
        max: Number(pr.maxVariantPrice?.amount),
      });
    }
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'count' && typeof v === 'number' && !countNoted) {
        countNoted = true;
        const what = isProductResult ? 'catalogue' : 'result set';
        notes.push(
          countFloor
            ? `more than ${v} items match this query — ${v} is a confirmed lower bound (the rest weren't scanned); narrate "more than ${v}" or "the first ${shown ?? v} of at least ${v}", never quote ${v} as the exact total`
            : args.after !== undefined
            ? `this is a continuation page — the ${v}-item total covers the whole query, not this page; narrate "the remaining items" (or similar), never "the first ${shown ?? v} of ${v}"`
            : shown !== undefined && shown < v
              ? hasNext
                ? `the ${what} total for this query is ${v} but only ${shown} cards render — narrate "the first ${shown} of ${v}" (or similar) and point out the customer can ask for more; NEVER call this "all ${v}" or "every product"`
                : isProductResult
                  ? `the catalogue total for this query is ${v} but only ${shown} cards render (the rest were filtered out — unavailable items); narrate "${shown} of ${v}" and do NOT promise more pages`
                  : `the ${what} total for this query is ${v} but only ${shown} cards render — narrate "${shown} of ${v}" and do NOT promise more pages`
              : `the ${what} total for this query is ${v} — quote that number, not a count of the rows shown`,
        );
      }
      if (k === 'pageInfo' && v && typeof v === 'object') {
        const pi = v as { hasNextPage?: unknown; endCursor?: unknown };
        if (pi.hasNextPage === true && typeof pi.endCursor === 'string') {
          // Verbatim — "same arguments" leaves the model room to rephrase the
          // query, which silently resets the cursor to page one.
          const q = args.query !== undefined ? `query:"${args.query}" ` : '';
          const flags = ['include_unavailable', 'only_unavailable', 'limit']
            .filter((k) => args[k] !== undefined)
            .map((k) => `${k}:"${args[k]}" `)
            .join('');
          notes.push(
            `more rows exist beyond this page — if the customer asks for more, call this tool again with ${q}${flags}after:"${pi.endCursor}" exactly (repeat every argument — a changed or dropped one resets the cursor or reshapes the list)`,
          );
        }
      }
      walk(v, depth + 1);
    }
  };
  walk(data, 0);
  // Grounded price extremes — a "cheapest" ask answered from memory picks
  // the first row, not the cheapest one.
  if (priced.length > 1) {
    const lo = priced.reduce((a, b) => (b.min < a.min ? b : a));
    const hi = priced.reduce((a, b) => (b.min > a.min ? b : a));
    notes.push(
      `cheapest of these results: "${lo.title}" from ${lo.min} — most expensive: "${hi.title}" from ${hi.max} (list prices; use these for cheapest/most-expensive asks)`,
    );
  }
  return notes.length ? `\n[facts: ${notes.join('; ')}]` : '';
}

/** pageInfo.hasNextPage in the result — the load-more tile must only exist
 *  when a real next page does; on the last page "tap for more" loops. */
export function toolResultHasNext(resultText: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return false;
  }
  let found = false;
  const walk = (obj: unknown, depth: number) => {
    if (found || !obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (found) return;
      if (k === 'hasNextPage' && v === true) {
        found = true;
        return;
      }
      walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return found;
}

/** First `{count: N}` total in the result (productsCount and friends) — the
 *  reply guard checks the model's quoted catalogue size against it. */
export function toolResultCount(resultText: string): number | null {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return null;
  }
  let found: number | null = null;
  const walk = (obj: unknown, depth: number) => {
    if (found !== null || !obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (found !== null) return;
      if (k === 'count' && typeof v === 'number') {
        found = v;
        return;
      }
      walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return found;
}

/** Write `value` at a dot path inside an object — mirrors digPath. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Drop result rows unrelated to the search query before the model narrates
 *  them or they render as cards. A row survives on a whole-phrase match or
 *  ≥50% token overlap (word-boundary — "now" doesn't match "know"). All rows
 *  failing means no real match: the array empties so the agent reports that
 *  instead of narrating filler. */
/** The row predicate behind filterRowsByQuery — shared with the pagination
 *  reconciler so every page applies the identical relevance rule. Returns
 *  null when the query can't be evaluated (empty, or no latin tokens — CJK,
 *  Cyrillic, emoji queries pass through to the upstream search rather than
 *  emptying the carousel). */
export function relevanceRowPredicate(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
): ((r: unknown) => boolean) | null {
  const rel = cfg.relevance;
  if (!rel) return null;
  const q = String(args[rel.arg] ?? '').trim().toLowerCase();
  if (!q) return null;
  // Accent-fold so "café" and "cafe" tokenize identically.
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
  const qTokens = [...new Set(fold(q).split(/[^a-z0-9]+/).filter((t) => t.length > 1))];
  if (!qTokens.length) return null;
  const strong = rel.strong_fields;
  // Word-bounded, trailing-'s' tolerant: "snowboard" must not match
  // "snowboarder" prose, but must match a "Snowboards" productType.
  const tokRe = (t: string) =>
    new RegExp(
      `\\b${fold(t)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/s$/, '')}s?\\b`,
    );
  return (r) => {
    const hay = fold(
      rel.fields
        .map((f) => String(digPath(r, f) ?? ''))
        .join(' ')
        .toLowerCase(),
    );
    if (!hay.trim()) return false;
    // Whole-phrase match must be word-bounded too — plain `includes` lets a
    // "snowboard" query keep a row whose only hit is "snowboarder" in prose.
    if (tokRe(q).test(hay)) return true;
    if (strong) {
      // Identifying columns must carry a query token — title/type/tags are
      // what a shopper means by "snowboards"; description prose doesn't
      // count (a gift card mentioning "snowboarders" isn't a snowboard).
      const strongHay = fold(
        strong
          .map((f) => String(digPath(r, f) ?? ''))
          .join(' ')
          .toLowerCase(),
      );
      return qTokens.some((t) => tokRe(t).test(strongHay));
    }
    const hits = qTokens.filter((t) => tokRe(t).test(hay));
    return qTokens.length > 0 && hits.length / qTokens.length >= 0.5;
  };
}

export function filterRowsByQuery(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
  resultText: string,
): string {
  const pred = relevanceRowPredicate(cfg, args);
  if (!pred) return resultText;
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return resultText;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return resultText;
  const path = cfg.items;
  if (!path) return resultText;
  const rows = digPath(data, path);
  if (!Array.isArray(rows)) return resultText;
  const kept = rows.filter(pred);
  if (kept.length === rows.length) return resultText;
  const obj = data as Record<string, unknown>;
  setPath(obj, path, kept);
  if (typeof obj.resultCount === 'number') obj.resultCount = kept.length;
  return JSON.stringify(obj);
}

/** First `{count: N}` in the result rewritten in place — the relevance
 *  reconciler replaces the raw match count with the post-filter total so
 *  the stamped "K of N" and every narration guard agree with the cards. */
function setFirstResultCount(data: Record<string, unknown>, n: number): void {
  const walk = (o: unknown, depth: number): boolean => {
    if (!o || typeof o !== 'object' || depth > 4) return false;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'count' && typeof v === 'number') {
        (o as Record<string, unknown>)[k] = n;
        return true;
      }
      if (walk(v, depth + 1)) return true;
    }
    return false;
  };
  walk(data, 0);
}

/** Relevance filtering happens AFTER Shopify counts and pages its fuzzy
 *  matches, so a dropped row both shorts the carousel ("9 of 12") and
 *  inflates the stamped total. When a keyworded query dropped rows and the
 *  connection exposes per-edge cursors (pageInfo + parallel edges array),
 *  chase the next pages to refill the page to `cap`, then rewrite the
 *  result so everything downstream sees filtered truth:
 *   - nodes/edges hold only the first `cap` surviving rows, in order
 *   - pageInfo.endCursor is the LAST RENDERED row's own edge cursor — a
 *     mid-page resume point so the next `after` call picks up exactly where
 *     the shopper's carousel stopped (dropped and surplus rows re-arrive or
 *     stay filtered, no gaps, no repeats)
 *   - productsCount becomes the filtered total once the set is exhausted
 *     (priorShown makes continuation pages count the whole chain); when the
 *     scan is truncated by the page budget the count is a lower bound and
 *     `__countFloor` tells narration to say "more than N" — never an exact
 *     number the cards can't back up. */
export async function reconcilePagedResult(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
  resultText: string,
  refetch?: (after: string) => Promise<string | null>,
  opts: { cap?: number; maxPages?: number; priorShown?: number } = {},
): Promise<string> {
  const pred = relevanceRowPredicate(cfg, args);
  if (!pred) return resultText;
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return resultText;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return resultText;
  const itemsPath = cfg.items;
  if (!itemsPath) return resultText;
  const dot = itemsPath.lastIndexOf('.');
  if (dot < 0) return resultText;
  const parentPath = itemsPath.slice(0, dot);
  const itemsKey = itemsPath.slice(dot + 1);
  const parent = digPath(data, parentPath);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return resultText;
  const parentObj = parent as Record<string, unknown>;
  const rows = parentObj[itemsKey];
  if (!Array.isArray(rows)) return resultText;
  const edges = parentObj.edges;
  const pageInfo = parentObj.pageInfo;
  const obj = data as Record<string, unknown>;
  const pairs = rows
    .map((r, i) => ({
      row: r,
      cursor:
        Array.isArray(edges) && edges[i] && typeof edges[i] === 'object'
          ? (edges[i] as { cursor?: unknown }).cursor
          : undefined,
    }))
    .filter((p) => pred(p.row))
    .map((p) => ({ row: p.row, cursor: typeof p.cursor === 'string' ? p.cursor : undefined }));
  const dropped = pairs.length !== rows.length;
  const aligned = Array.isArray(edges) && edges.length === rows.length;
  const piObj =
    pageInfo && typeof pageInfo === 'object' ? (pageInfo as Record<string, unknown>) : null;
  // No pagination metadata → the plain filter is all we can do.
  if (!aligned || !piObj) {
    if (!dropped) return resultText;
    setPath(obj, itemsPath, pairs.map((p) => p.row));
    if (typeof obj.resultCount === 'number') obj.resultCount = pairs.length;
    return JSON.stringify(obj);
  }
  const prior = args.after !== undefined ? (opts.priorShown ?? 0) : 0;
  // Only skip work when the whole matching set fit in one clean page — no
  // drops AND no next page means the raw count already equals filtered.
  // Any next page can hide drops, so a paged result is always reconciled.
  if (!dropped && prior === 0 && piObj.hasNextPage !== true) return resultText;
  const rowCapArg = cfg.row_limit_arg ? Number(args[cfg.row_limit_arg]) : NaN;
  const cap = Math.max(
    1,
    Math.min(Number.isFinite(rowCapArg) && rowCapArg > 0 ? rowCapArg : 10, opts.cap ?? 10),
  );
  let hasNext = piObj.hasNextPage === true;
  let cursor = typeof piObj.endCursor === 'string' ? piObj.endCursor : undefined;
  let pages = 1;
  const maxPages = opts.maxPages ?? 5;
  let sawDrop = dropped;
  while (hasNext && pages < maxPages && cursor && refetch) {
    const next = await refetch(cursor);
    if (!next) break;
    let d2: unknown;
    try {
      d2 = JSON.parse(next);
    } catch {
      break;
    }
    if (!d2 || typeof d2 !== 'object' || Array.isArray(d2)) break;
    const errs = (d2 as { errors?: unknown }).errors;
    if (Array.isArray(errs) && errs.length) break;
    const p2 = digPath(d2, parentPath);
    if (!p2 || typeof p2 !== 'object') break;
    const rows2 = (p2 as Record<string, unknown>)[itemsKey];
    if (!Array.isArray(rows2)) break;
    const edges2 = (p2 as Record<string, unknown>).edges;
    const pi2 = (p2 as Record<string, unknown>).pageInfo;
    const before = pairs.length;
    rows2.forEach((r, i) => {
      if (pred(r)) {
        const c =
          Array.isArray(edges2) && edges2[i] && typeof edges2[i] === 'object'
            ? (edges2[i] as { cursor?: unknown }).cursor
            : undefined;
        pairs.push({ row: r, cursor: typeof c === 'string' ? c : undefined });
      }
    });
    if (pairs.length - before !== rows2.length) sawDrop = true;
    pages++;
    hasNext = !!(pi2 && typeof pi2 === 'object' && (pi2 as { hasNextPage?: unknown }).hasNextPage === true);
    const ec = pi2 && typeof pi2 === 'object' ? (pi2 as { endCursor?: unknown }).endCursor : undefined;
    cursor = typeof ec === 'string' ? ec : undefined;
  }
  const rendered = pairs.slice(0, cap);
  const moreToShow = pairs.length > rendered.length || hasNext;
  // The continuation cursor must resume after the last RENDERED row. When a
  // next page should exist but that row carries no edge cursor, trim the
  // tail back to the last cursor-bearing row — its unrendered neighbours
  // are re-fetched by the next `after` call rather than skipped forever.
  if (moreToShow) {
    while (rendered.length && !rendered[rendered.length - 1].cursor) rendered.pop();
  }
  setPath(obj, itemsPath, rendered.map((p) => p.row));
  if (aligned) setPath(obj, `${parentPath}.edges`, rendered.map((p) => ({ cursor: p.cursor })));
  const lastRendered = rendered[rendered.length - 1]?.cursor;
  if (lastRendered) piObj.endCursor = lastRendered;
  piObj.hasNextPage = moreToShow;
  // Continuation without chain context: the raw count still covers the
  // whole query better than a remaining-rows figure — leave it alone.
  // And when a chase that scanned ahead saw no drops at all, the raw count
  // was never contradicted — don't replace a real number with a floor.
  if (args.after === undefined || prior > 0) {
    if (sawDrop || prior > 0) {
      setFirstResultCount(obj, prior + pairs.length);
      if (hasNext) obj.__countFloor = true;
      else delete obj.__countFloor;
    }
  }
  if (typeof obj.resultCount === 'number') obj.resultCount = rendered.length;
  return JSON.stringify(obj);
}


/** Normalised product title — punctuation, case and the leading article
 *  stripped so narration matching isn't defeated by markdown or colons
 *  ("The Collection Snowboard: Liquid" ≡ "collection snowboard liquid"). */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Loose title equality — containment either way or ≥60% token overlap.
 *  Narration shortens ("the Liquid" for "The Collection Snowboard: Liquid")
 *  and a stored corpus row keeps its full name. */
export function titlesMatch(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const hits = [...ta].filter((t) => tb.has(t)).length;
  return hits / tb.size >= 0.6 || hits / ta.size >= 0.6;
}

/** Product names the reply text claims: titles from this run's tool corpus
 *  that appear in the reply, plus **bolded** spans (the channel's
 *  product-name convention). Bold spans that aren't products are cheap
 *  misses — a lookup finds nothing and nothing renders. */
export function namedProductsInReply(reply: string, corpusTitles: string[]): string[] {
  const named = new Set<string>();
  const hay = ` ${normTitle(reply)} `;
  for (const t of corpusTitles) {
    if (t && hay.includes(` ${t} `)) named.add(t);
  }
  for (const m of reply.matchAll(/\*\*([^*\n]{3,80})\*\*/g)) {
    const s = m[1].trim();
    if (/^[\d#.,\s$]+$/.test(s)) continue; // "**#1001**", "**$12.00**" — not products
    named.add(s);
  }
  return [...named];
}

/** A WIDGET_REF capture — the normalised name plus the model's optional
 *  inline data object (props for placeholders, args for a bound tool, or a
 *  "state" key selecting a named variant). */
export interface WidgetRef {
  name: string;
  data?: Record<string, unknown>;
}

/** True while a directive's JSON payload is still unterminated — an open
 *  string or unmatched brackets. Used to absorb pretty-printed multi-line
 *  specs: models frequently emit "WIDGET: {" then the object over the next
 *  lines, and a line-at-a-time parser would leak the rest to the customer. */
function jsonOpen(s: string): boolean {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth > 0 || inStr;
}

/** Strip "WIDGET: {json}" lines from a reply; valid components return for
 *  payload.widgets. Malformed lines are still removed — a broken widget is
 *  better than model markup leaking to the customer — but they count in
 *  `dropped` so the caller can regenerate: a vanished component line leaves
 *  the customer staring at a bare "Here are the songs:" lead-in. */
export function extractWidgets(text: string): {
  text: string;
  widgets: WidgetComponent[];
  refs: WidgetRef[];
  dropped: number;
} {
  const widgets: WidgetComponent[] = [];
  const refs: WidgetRef[] = [];
  let dropped = 0;
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The directive can start mid-line ("options: WIDGET: {…}") — the
    // model loves a colon lead-in. The prose prefix survives; the tail
    // is consumed as the directive.
    const dm = /\bWIDGET(?:_REF)?:/i.exec(line);
    if (!dm) {
      out.push(line);
      continue;
    }
    const before = line.slice(0, dm.index).trimEnd();
    let tail = line.slice(dm.index).trim();
    let ref = tail.match(WIDGET_REF_LINE);
    let m = ref ? null : tail.match(WIDGET_LINE);
    let end = i;
    // Pretty-printed directive — keep absorbing lines while the JSON
    // payload is unterminated (a blank line, a fresh directive or the cap
    // ends an abandoned block). Runs even when m matched "WIDGET: {" alone.
    while (
      !ref &&
      jsonOpen(tail) &&
      end + 1 < lines.length &&
      end - i < 50 &&
      lines[end + 1].trim() !== '' &&
      !/\bWIDGET(?:_REF)?:/i.test(lines[end + 1])
    ) {
      end++;
      tail += '\n' + lines[end];
      ref = tail.match(WIDGET_REF_LINE);
      m = ref ? null : tail.match(WIDGET_LINE);
    }
    if (!ref && !m) {
      if (end === i) {
        // WIDGET-ish word, not a directive — keep verbatim.
        out.push(line);
        continue;
      }
      // An unterminated/mangled directive block — drop it whole.
      dropped++;
      i = end;
      if (before) out.push(before);
      continue;
    }
    i = end;
    if (ref) {
      let data: Record<string, unknown> | undefined;
      if (ref[2]) {
        try {
          const parsed: unknown = JSON.parse(ref[2]);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            data = parsed as Record<string, unknown>;
        } catch {
          // malformed data object — still resolves the name with no props
        }
      }
      refs.push({ name: normWidgetRef(ref[1]), data });
      if (before) out.push(before);
      continue;
    }
    let ok = false;
    if (widgets.length < MAX_WIDGETS) {
      try {
        const parsed = WidgetComponent.safeParse(JSON.parse(m![1]));
        if (parsed.success) {
          widgets.push(parsed.data);
          ok = true;
        }
      } catch {
        // malformed JSON — drop the block
      }
    }
    if (!ok) dropped++;
    if (before) out.push(before);
  }
  return { text: out.join('\n').trim(), widgets, refs, dropped };
}

/** Per-item identity — what the component actually shows the customer. */
function widgetItemKeys(w: WidgetComponent): string[] {
  // Itemless components (cart — hydrated client-side) have nothing to key.
  if (w.type === 'cart') return [];
  const items: Record<string, unknown>[] =
    w.type === 'cards' || w.type === 'options' || w.type === 'pricing'
      ? w.items
      : w.type === 'form'
        ? w.fields
        : w.type === 'status'
          ? w.steps
          : w.rows;
  // Title-first: a model-authored card restating a tool result often omits
  // link/link_label, so "Tenth Stair|" must still match the tool's
  // "Tenth Stair" + link item. Untitled items fall back to the link.
  return items.map((i) => {
    const title = String(i.title ?? i.label ?? i.name ?? '').trim().toLowerCase();
    return title || String(i.link ?? '').trim().toLowerCase();
  });
}

/**
 * A widget-bound tool already renders its result deterministically — a
 * model that *also* emits a WIDGET: line for the same data produces a
 * second row repeating some or all of it. Dedupe per item: cards/options
 * lose just the items a tool already rendered (the model's own additions
 * still show); structured components (form/status/receipt) can't lose
 * pieces without looking broken, so they drop whole when mostly repeated.
 */
export function dedupeToolWidgets(
  toolWidgets: WidgetComponent[],
  modelWidgets: WidgetComponent[],
): WidgetComponent[] {
  if (!toolWidgets.length || !modelWidgets.length) return modelWidgets;
  const toolKeysByType = new Map<string, Set<string>>();
  for (const t of toolWidgets) {
    const keys = toolKeysByType.get(t.type) ?? new Set<string>();
    for (const k of widgetItemKeys(t)) keys.add(k);
    toolKeysByType.set(t.type, keys);
  }
  const result: WidgetComponent[] = [];
  for (const m of modelWidgets) {
    const toolKeys = toolKeysByType.get(m.type);
    if (!toolKeys) {
      result.push(m);
      continue;
    }
    const mine = widgetItemKeys(m);
    if (m.type === 'cards' || m.type === 'options') {
      const items = m.items.filter((_, i) => !toolKeys.has(mine[i]));
      if (items.length) result.push({ ...m, items } as WidgetComponent);
      continue; // fully restated — the tool row already says it
    }
    // Itemless components (cart) carry no repeatable content — never drop.
    if (mine.length === 0 || mine.filter((k) => toolKeys.has(k)).length < Math.ceil(mine.length * 0.6))
      result.push(m);
  }
  return result;
}

/**
 * Same rules as dedupeToolWidgets but pairwise across one ordered list —
 * first-seen wins. Covers dupes inside either source: a widget-bound tool
 * firing twice in the tool loop or across a regen attempt lands the same
 * component in toolWidgets twice, and nothing else catches that.
 */
export function dedupeWidgetList(list: WidgetComponent[]): WidgetComponent[] {
  const seenByType = new Map<string, Set<string>>();
  const out: WidgetComponent[] = [];
  for (const w of list) {
    const seen = seenByType.get(w.type) ?? new Set<string>();
    seenByType.set(w.type, seen);
    const mine = widgetItemKeys(w);
    if (w.type === 'cards' || w.type === 'options') {
      const items = w.items.filter((_, i) => !seen.has(mine[i]));
      mine.forEach((k) => seen.add(k));
      if (items.length) out.push({ ...w, items } as WidgetComponent);
      continue;
    }
    const dup = mine.filter((k) => seen.has(k)).length;
    mine.forEach((k) => seen.add(k));
    if (mine.length === 0 || dup < Math.ceil(mine.length * 0.6)) out.push(w);
  }
  return out;
}
