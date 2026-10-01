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
  .refine((u) => /^https?:\/\//.test(u) || u.startsWith('/'), 'not a url');

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

const MAX_WIDGETS = 3;
const WIDGET_LINE = /^WIDGET:\s*(.*)$/i;

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


/** Strip "WIDGET: {json}" lines from a reply; valid components return for
 *  payload.widgets. Malformed lines are still removed — a broken widget is
 *  better than model markup leaking to the customer. */
export function extractWidgets(text: string): { text: string; widgets: WidgetComponent[] } {
  const widgets: WidgetComponent[] = [];
  const out = text
    .split('\n')
    .filter((line) => {
      const m = line.trim().match(WIDGET_LINE);
      if (!m) return true;
      if (widgets.length < MAX_WIDGETS) {
        try {
          const parsed = WidgetComponent.safeParse(JSON.parse(m[1]));
          if (parsed.success) widgets.push(parsed.data);
        } catch {
          // malformed JSON — drop the line
        }
      }
      return false;
    })
    .join('\n');
  return { text: out.trim(), widgets };
}
