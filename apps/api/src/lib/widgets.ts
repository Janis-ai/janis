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
function formatMoney(amount: unknown, code: unknown): string | undefined {
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
        return formatMoney(v, digPath(row, parent ? `${parent}.currencyCode` : 'currencyCode')) ?? '';
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
  // Unpurchasable rows (availableForSale === false) drop out of the cards
  // unless the call explicitly opted in — the model narrates from the full
  // result either way.
  const optedIn =
    cfg.availability &&
    ['1', 'true', 'yes'].includes(String(args[cfg.availability.unless_arg] ?? '').toLowerCase());
  if (cfg.availability && !optedIn) {
    const field = cfg.availability.field;
    rows = rows.filter((r) => digPath(r, field) !== false);
    if (!rows.length) return null;
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
          items: rows
            .slice(0, 12)
            .map((r) => ({
              label: str(mapValue(r, map.label ?? 'label', secrets)) ?? str(mapValue(r, map.title ?? 'title', secrets)),
              description: str(mapValue(r, map.description ?? 'description', secrets)),
            }))
            .filter((it) => it.label),
        }
      : {
          type: 'cards',
          items: rows
            .slice(0, 10)
            .map((r) => ({
              title: str(mapValue(r, map.title ?? 'title', secrets)) ?? str(mapValue(r, map.label ?? 'label', secrets)),
              subtitle: str(mapValue(r, map.subtitle ?? 'subtitle', secrets)),
              image: str(mapValue(r, map.image ?? 'image', secrets)),
              price: str(mapValue(r, map.price ?? 'price', secrets)),
              stock: map.stock ? str(mapValue(r, map.stock, secrets)) : undefined,
              cart_variant_id: map.cart_variant_id
                ? str(mapValue(r, map.cart_variant_id, secrets))
                : undefined,
              link: str(mapValue(r, map.link ?? 'link', secrets)),
              link_label: label(cfg.link_label, r),
              select_label: label(cfg.select_label, r),
            }))
            .filter((it) => it.title),
        };

  const parsed = WidgetComponent.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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
