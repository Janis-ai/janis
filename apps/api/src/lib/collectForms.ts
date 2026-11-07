import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { AgentConfig } from '@janis/shared';
import { agents, contacts, conversations, formSubmissions } from '../db/schema.js';
import { enrichContactClaimed } from './contacts.js';
import { sendEmail } from './notify.js';
import { env } from '../env.js';

type CollectForm = NonNullable<AgentConfig['collect_forms']>[number];

/** Build a submit-side tool call: static args where a `{field}`
 *  placeholder interpolates the posted value of that form field — inside
 *  a JSON-structured arg (`[[{f}]]`) the value substitutes JSON-encoded so
 *  `[[{"answer"}]]` stays parseable. A tool param literally named `values`
 *  (sheets-style append APIs) left unset defaults to one row of the form's
 *  fields in order — "put the answers in columns" needs no mapping. */
export function submitToolArgs(
  sub: { name: string; args?: Record<string, string> },
  spec: unknown,
  values: Record<string, string>,
  toolParams: Record<string, string> | undefined,
): Record<string, unknown> {
  const fields = (((spec as { fields?: { name?: string }[] } | undefined)?.fields) ?? [])
    .map((f) => f.name)
    .filter((n): n is string => !!n);
  const args: Record<string, unknown> = {};
  // `{f}` and `{{f}}` both interpolate — the concierge writes the moustache
  // form by habit. Dotted names (`{{secrets.X}}`) never match the class.
  const FIELD = /\{\{?([a-z0-9_]+)\}?\}/gi;
  const fill = (v: string, jsonish: boolean) =>
    v.replace(FIELD, (_m, f: string) => {
      const val = values[f.toLowerCase()] ?? values[f] ?? '';
      return jsonish ? JSON.stringify(val) : val;
    });
  for (const [k, v] of Object.entries(sub.args ?? {})) {
    // JSON-structured args (`[[{f}]]`) substitute encoded — a bare `{f}`
    // arg is just a string fill, quoting it would double-wrap.
    const jsonish =
      /^[\[{]/.test(v.trim()) && !/^\{\{?[a-z0-9_]+\}?\}$/i.test(v.trim());
    args[k] = fill(v, jsonish);
  }
  if (toolParams && 'values' in toolParams) {
    if (args.values == null) {
      args.values = JSON.stringify([fields.map((n) => values[n] ?? '')]);
    } else {
      // Sheets-style append bodies splice `values` in as a JSON array of
      // row arrays. A comma-list template ("{a},{b}") interpolates to
      // "Pizza,x" — invalid JSON there, so every submit failed. Rebuild
      // the template as one row of plain cell values.
      let isArray = false;
      try {
        isArray = Array.isArray(JSON.parse(String(args.values)));
      } catch {
        /* not JSON */
      }
      if (!isArray) {
        const template = String(sub.args!.values);
        const cells = template.split(',').map((cell) => fill(cell.trim(), false).trim());
        args.values = JSON.stringify([cells]);
      }
    }
  }
  return args;
}
type ConvRow = typeof conversations.$inferSelect;

/** Read the agent's configured collect forms (lenient — config is jsonb). */
export function collectFormsFor(agent: { config: unknown }): CollectForm[] {
  const forms = (agent.config as { collect_forms?: CollectForm[] } | undefined)?.collect_forms;
  return Array.isArray(forms) ? forms : [];
}

export function collectFormNamed(
  agent: { config: unknown },
  name: string,
): CollectForm | undefined {
  const norm = name.trim().toLowerCase();
  return collectFormsFor(agent).find((f) => f.name?.trim().toLowerCase() === norm);
}

/** Split submitted values into contact identifiers vs. everything else.
 *  Field *type* decides: email → email, tel → phone, a field named `name`
 *  → name; the rest are claimed facts keyed by their label. */
function splitValues(
  form: CollectForm,
  values: Record<string, string>,
): { name?: string; email?: string; phone?: string; facts: Record<string, string> } {
  const out: { name?: string; email?: string; phone?: string; facts: Record<string, string> } = {
    facts: {},
  };
  for (const f of form.fields ?? []) {
    const v = values[f.name]?.trim();
    if (!v) continue;
    if (f.type === 'email' && !out.email) out.email = v.toLowerCase();
    else if (f.type === 'tel' && !out.phone) out.phone = v;
    else if (f.name.toLowerCase() === 'name' && !out.name) out.name = v;
    else out.facts[f.label.trim().slice(0, 40)] = v.slice(0, 200);
  }
  return out;
}

/**
 * Record a collect-form submission: form_submissions row, contact
 * enrichment (same claimed-claims path save_user_profile uses), contact
 * tags, then the destinations — webhook POST and/or notify email. Never
 * throws into the caller; a dead webhook can't lose the visitor's message.
 */
export async function recordFormSubmission(
  db: Db,
  input: {
    agent: typeof agents.$inferSelect;
    conv: ConvRow | undefined;
    form: CollectForm;
    values: Record<string, string>;
  },
): Promise<void> {
  const { agent, conv, form } = input;
  const contactId = conv?.contactId ?? null;
  await db.insert(formSubmissions).values({
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    conversationId: conv?.id ?? null,
    contactId,
    form: form.name,
    values: input.values,
  });

  const { name, email, phone, facts } = splitValues(form, input.values);

  // Conversation profile — same fields save_user_profile writes so the
  // agent recalls them next turn even before the contact merges.
  if (conv) {
    const base = (conv.userProfile ?? {}) as Record<string, unknown>;
    const metadata = Object.keys(facts).length
      ? {
          ...((base.metadata as Record<string, unknown>) ?? {}),
          ...facts,
        }
      : base.metadata;
    await db
      .update(conversations)
      .set({
        userProfile: {
          ...base,
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(metadata ? { metadata } : {}),
        },
      })
      .where(eq(conversations.id, conv.id));
  }

  // Contact enrichment + tags — claimed provenance, identical to
  // save_user_profile (fills empty fields, folds alts, 'self-reported' tag).
  if (contactId && form.contact !== false) {
    try {
      await enrichContactClaimed(db, contactId, { name, email, phone, facts });
      if (form.tags?.length) {
        await db
          .update(contacts)
          .set({
            tags: sql`array(select distinct unnest(${contacts.tags} || array[${sql.join(
              form.tags.map((t) => sql`${t}`),
              sql`, `,
            )}]))`,
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, contactId));
      }
    } catch (err) {
      console.error('collect form contact enrich failed:', err);
    }
  }

  // Destinations — fire-and-forget; failures log, never block the turn.
  const payload = {
    event: 'form_submission',
    form: form.name,
    title: form.title ?? form.name,
    values: input.values,
    agent: { id: agent.id, name: agent.name },
    conversation_id: conv?.id ?? null,
    contact_id: contactId,
    submitted_at: new Date().toISOString(),
  };
  if (form.webhook_url) {
    fetch(form.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    }).catch((err) => console.error(`collect form webhook ${form.name}:`, err));
  }
  if (form.email) {
    const lines = Object.entries(input.values).map(([k, v]) => `${k}: ${v}`);
    sendEmail(
      [form.email],
      `Form submission: ${form.title ?? form.name}`,
      `${agent.name} collected a "${form.title ?? form.name}" submission:\n\n${lines.join('\n')}`,
      conv ? `/conversations/${conv.id}` : undefined,
    ).catch((err) => console.error(`collect form email ${form.name}:`, err));
  }
}
