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
          link: url.optional(),
          link_label: s(30).optional(),
          select_label: s(40).optional(), // tapping sends this as a message
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

/** Map values may be a plain dot path ("variants.0.price") or a template
 *  with {path} placeholders ("https://shop/products/{handle}") — needed when
 *  the API returns handles, not URLs. {{secrets.X}} resolves too so store
 *  domains don't get hard-coded into mappings. */
function mapValue(row: unknown, expr: string, secrets: Record<string, string>): unknown {
  if (expr.includes('{')) {
    const t = expr.replace(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g, (_, k: string) => secrets[k] ?? '');
    const out = t.replace(/\{([A-Za-z0-9_.]+)\}/g, (_, p: string) => {
      const v = digPath(row, p);
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
): WidgetComponent | null {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return null;
  }
  let rows: unknown =
    cfg.items != null ? digPath(data, cfg.items) : Array.isArray(data) ? data : undefined;
  // Result is an object — find its first array-valued property (the common
  // { products: [...] } / { results: [...] } envelope shape).
  if (!Array.isArray(rows) && data && typeof data === 'object') {
    rows = Object.values(data as Record<string, unknown>).find(Array.isArray);
  }
  if (!Array.isArray(rows) || !rows.length) return null;
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
              link: str(mapValue(r, map.link ?? 'link', secrets)),
              link_label: label(cfg.link_label, r),
              select_label: label(cfg.select_label, r),
            }))
            .filter((it) => it.title),
        };

  const parsed = WidgetComponent.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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
    .filter((line) => {
      const t = line.trim();
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
        return false;
      }
      const m = t.match(WIDGET_LINE);
      if (!m) return true;
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
      return false;
    })
    .join('\n');
  return { text: out.trim(), widgets, refs, dropped };
}

/** Per-item identity — what the component actually shows the customer. */
function widgetItemKeys(w: WidgetComponent): string[] {
  const items: Record<string, unknown>[] =
    w.type === 'cards' || w.type === 'options'
      ? w.items
      : w.type === 'form'
        ? w.fields
        : w.type === 'status'
          ? w.steps
          : w.rows;
  return items.map((i) => `${i.title ?? i.label ?? i.name ?? ''}|${i.link ?? ''}`);
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
    if (mine.filter((k) => toolKeys.has(k)).length < Math.ceil(mine.length * 0.6))
      result.push(m);
  }
  return result;
}
