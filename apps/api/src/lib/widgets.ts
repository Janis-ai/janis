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
          link: url.optional(),
          link_label: s(30).optional(),
          // Interpolated labels carry a full title ("I'm interested in the
          // {title}") — the cap must clear a 120-char product name.
          select_label: s(160).optional(), // tapping sends this as a message
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
    fields: z
      .array(
        z.object({
          name: s(40).regex(/^[a-z][a-z0-9_]*$/i),
          label: s(60),
          type: z.enum(['text', 'email', 'tel', 'textarea', 'select']).default('text'),
          options: z.array(s(60)).max(10).optional(),
          required: z.boolean().optional(),
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
          state: z.enum(['done', 'current', 'todo']).default('todo'),
          note: s(160).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  // Receipt/summary — label/value rows with an optional bold total.
  z.object({
    type: z.literal('receipt'),
    title: s(120).optional(),
    rows: z.array(z.object({ label: s(80), value: s(160) })).min(1).max(15),
    total: z.object({ label: s(80), value: s(60) }).optional(),
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
const WIDGET_LINE = /^WIDGET:\s*(.*)$/i;
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
  /** Dot path to the rows array inside the result. Default: the result is
   *  an array, or its first array-valued property. */
  items?: string;
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
  };
  /** Rows whose `field` resolves to === false are unpurchasable — drop them
   *  from the rendered cards unless the model opted in via `unless_arg`
   *  (e.g. the customer asked for that specific product). The model still
   *  sees every row in the result text and can narrate OOS truthfully;
   *  this only shapes the cards the customer sees. Browsing stays clean by
   *  default — a widget can't hide stock a prompt instruction hoped for. */
  availability?: {
    /** Row dot path holding the purchasable flag (=== false ⇒ hide). */
    field: string;
    /** Tool arg that disables the drop when set to a truthy string. */
    unless_arg: string;
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
    const out = t.replace(/\{([A-Za-z0-9_.]+)(?::([a-z]+))?\}/g, (_, p: string, mod?: string) => {
      const v = digPath(row, p);
      if (mod === 'money') {
        const parent = p.slice(0, Math.max(0, p.lastIndexOf('.')));
        // Sibling currencyCode first (MoneyV2), then the row's own, then any
        // currencyCode in the row — a scalar Money field (ProductVariant.price)
        // has no sibling, but the row's priceRange still carries the code.
        const code =
          digPath(row, parent ? `${parent}.currencyCode` : 'currencyCode') ??
          digPath(row, 'currencyCode') ??
          firstCurrencyCode(row);
        return formatMoney(v, code) ?? '';
      }
      // {flag:stock} — 'Out of stock' only when the source flag is a real
      // false; true/absent (untracked inventory, gift cards) stays silent.
      if (mod === 'stock') return v === false ? 'Out of stock' : '';
      // {path:gidnum} — the numeric tail of a Shopify gid
      // (gid://shopify/ProductVariant/123 → '123') for the Ajax cart API.
      if (mod === 'gidnum') {
        const m = String(v ?? '').match(/\/(\d+)$/);
        return m ? m[1] : '';
      }
      return v == null ? '' : String(v);
    });
    return out.trim() ? out : undefined;
  }
  return digPath(row, expr);
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : v == null ? undefined : String(v).slice(0, 500);

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

/** Rows the availability filter hides — OOS products on a call that didn't
 *  opt into showing them. Used to tell the model "N more matched but are
 *  unavailable" so a 'show me everything' can surface them badged. */
export function availabilityDropped(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
  resultText: string,
): number {
  const rel = cfg.availability;
  if (!rel) return 0;
  const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  if (truthy(args[rel.unless_arg]) || (rel.only_arg && truthy(args[rel.only_arg]))) return 0;
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
  const optedIn = cfg.availability && truthy(args[cfg.availability.unless_arg]);
  const onlyOos = cfg.availability?.only_arg ? truthy(args[cfg.availability.only_arg]) : false;
  if (cfg.availability) {
    const field = cfg.availability.field;
    if (onlyOos) {
      list = list.filter((r) => digPath(r, field) === false);
      if (!list.length) return null;
    } else if (!optedIn) {
      const kept = list.filter((r) => digPath(r, field) !== false);
      // Every matched row is unpurchasable — that IS what the customer asked
      // about ("do you have the gift card?"), so render the rows badged rather
      // than a blank answer that invites a model-authored card without one.
      list = kept.length ? kept : list;
    }
  }
  // Focused-ask cap — `limit` narrows rendered rows, never the model's data.
  const rowCap = cfg.row_limit_arg ? Number(args[cfg.row_limit_arg]) : NaN;
  if (Number.isFinite(rowCap) && rowCap > 0) list = list.slice(0, Math.min(rowCap, 12));
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
            .map((r) => ({
              title: str(mapValue(r, map.title ?? 'title', secrets)) ?? str(mapValue(r, map.label ?? 'label', secrets)),
              subtitle: str(mapValue(r, map.subtitle ?? 'subtitle', secrets)),
              image: str(mapValue(r, map.image ?? 'image', secrets)),
              price: str(mapValue(r, map.price ?? 'price', secrets)),
              stock: map.stock ? str(mapValue(r, map.stock, secrets)) : undefined,
              // An unavailable row renders for information only — its Add to
              // cart would hit the same rejection the badge warns about.
              cart_variant_id:
                map.cart_variant_id &&
                !(cfg.availability && digPath(r, cfg.availability.field) === false)
                  ? str(mapValue(r, map.cart_variant_id, secrets))
                  : undefined,
              link: str(mapValue(r, map.link ?? 'link', secrets)),
              link_label: label(cfg.link_label, r),
              select_label: label(cfg.select_label, r),
            }))
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
  if (widget.type === 'cards' && toolResultHasNext(resultText)) {
    const cur = toolResultEndCursor(resultText);
    if (cur) widget.end_cursor = cur;
    if (!(cfg.availability?.only_arg && args[cfg.availability.only_arg])) {
      const total = toolResultCount(resultText);
      if (total !== null && total > widget.items.length) widget.total = total;
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
  const walk = (obj: unknown, depth: number) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'count' && typeof v === 'number') {
        notes.push(
          args.after !== undefined
            ? `this is a continuation page — the ${v}-item total covers the whole query, not this page; narrate "the remaining items" (or similar), never "the first ${shown ?? v} of ${v}"`
            : shown !== undefined && shown < v
              ? hasNext
                ? `the catalogue total for this query is ${v} but only ${shown} cards render — narrate "the first ${shown} of ${v}" (or similar) and point out the customer can ask for more; NEVER call this "all ${v}" or "every product"`
                : `the catalogue total for this query is ${v} but only ${shown} cards render (the rest were filtered out — unavailable items); narrate "${shown} of ${v}" and do NOT promise more pages`
              : `the catalogue total for this query is ${v} — quote that number, not a count of the rows shown`,
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
export function filterRowsByQuery(
  cfg: ToolWidgetConfig,
  args: Record<string, unknown>,
  resultText: string,
): string {
  const rel = cfg.relevance;
  if (!rel) return resultText;
  const q = String(args[rel.arg] ?? '').trim().toLowerCase();
  if (!q) return resultText;
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
  const obj = data as Record<string, unknown>;
  const qTokens = [...new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length > 1))];
  const kept = rows.filter((r) => {
    const hay = rel.fields
      .map((f) => String(digPath(r, f) ?? ''))
      .join(' ')
      .toLowerCase();
    if (!hay.trim()) return false;
    if (hay.includes(q)) return true;
    const hits = qTokens.filter((t) =>
      new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay),
    );
    return qTokens.length > 0 && hits.length / qTokens.length >= 0.5;
  });
  if (kept.length === rows.length) return resultText;
  setPath(obj, path, kept);
  if (typeof obj.resultCount === 'number') obj.resultCount = kept.length;
  return JSON.stringify(obj);
}


/** A WIDGET_REF capture — the normalised name plus the model's optional
 *  inline data object (props for placeholders, args for a bound tool, or a
 *  "state" key selecting a named variant). */
export interface WidgetRef {
  name: string;
  data?: Record<string, unknown>;
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
  const out = text
    .split('\n')
    .map((line) => {
      // The directive can start mid-line ("options: WIDGET: {…}") — the
      // model loves a colon lead-in. The prose prefix survives; the tail
      // is consumed as the directive.
      const dm = /\bWIDGET(?:_REF)?:/i.exec(line);
      if (!dm) return line;
      const before = line.slice(0, dm.index).trimEnd();
      const t = line.slice(dm.index).trim();
      const ref = t.match(WIDGET_REF_LINE);
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
        return before;
      }
      const m = t.match(WIDGET_LINE);
      if (!m) return line; // WIDGET-ish word, not a directive — keep verbatim
      let ok = false;
      if (widgets.length < MAX_WIDGETS) {
        try {
          const parsed = WidgetComponent.safeParse(JSON.parse(m[1]));
          if (parsed.success) {
            widgets.push(parsed.data);
            ok = true;
          }
        } catch {
          // malformed JSON — drop the line
        }
      }
      if (!ok) dropped++;
      return before;
    })
    .filter((line) => line !== '')
    .join('\n');
  return { text: out.trim(), widgets, refs, dropped };
}

/** Per-item identity — what the component actually shows the customer. */
function widgetItemKeys(w: WidgetComponent): string[] {
  // Itemless components (cart — hydrated client-side) have nothing to key.
  if (w.type === 'cart') return [];
  const items: Record<string, unknown>[] =
    w.type === 'cards' || w.type === 'options'
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
