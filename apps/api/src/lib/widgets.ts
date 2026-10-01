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
