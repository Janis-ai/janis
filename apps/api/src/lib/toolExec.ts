import type { Db } from '../db/client.js';
import type { agents } from '../db/schema.js';
import { interpolateSecrets } from './secrets.js';
import { CATALOG_TOOL_NAMES, IDENTITY_TOOL_NAMES, TEMPLATE_WIDGETS } from './toolTemplates.js';
import type { ToolWidgetConfig } from './widgets.js';

type AgentRow = typeof agents.$inferSelect;

export interface ToolDef {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** POST/PUT/PATCH body encoding — 'json' (default) or 'form'
   *  (application/x-www-form-urlencoded, e.g. Stripe). */
  bodyFormat?: 'json' | 'form';
  /** Operator-authored JSON body template — {param} placeholders substitute
   *  the arg as a JSON value (strings quoted, objects/arrays nested),
   *  {param:text} substitutes raw text JSON-escaped for embedding inside a
   *  quoted string (e.g. a GraphQL search clause), and {{secrets.*}} expand
   *  exactly like url/headers. Needed when the provider wants a shaped body
   *  (nested objects, secret-derived fields like Cal.com's eventTypeId)
   *  rather than flat args. Takes precedence over the flat-args body.
   *  Bodies with literal braces (a GraphQL document's selection sets) use
   *  ${param} / ${param:text} instead — a template containing any ${…}
   *  treats {…} as data, not placeholders. */
  bodyTemplate?: string;
  /** Mutating tools: the model proposes the call, a teammate approves or
   *  denies it in the console or Slack, and only then it executes. */
  approval?: boolean;
  /** Customer-record tool — reads or writes rows keyed to a specific
   *  customer (email lookups, charge/order history, free-text CRM search).
   *  Args must anchor to the conversation's VERIFIED identity: every email
   *  arg must be one of the customer's verified addresses, and provider ids
   *  (cus_…, sub_…) must have come from an earlier tool result in this run.
   *  Operator contexts (signed-in teammate on the agent's workspace) are
   *  exempt. See identityBlockReason. */
  identity?: boolean;
  /** Live data binding — the tool's JSON result renders as an in-conversation
   *  component (cards carousel / options picker) instead of the model
   *  retelling it as text. `map` selects fields off each result row. */
  widget?: ToolWidgetConfig;
}

export function toolsFor(agent: AgentRow): ToolDef[] {
  const cfg = (agent.config ?? {}) as { tools?: ToolDef[] };
  return (cfg.tools ?? [])
    .filter((t) => t.name && t.url)
    // Retroactive catalog fields — tools installed before a flag/binding
    // existed serialize without it; the catalog is the source of truth.
    .map((t) => {
      const out = { ...t };
      if (IDENTITY_TOOL_NAMES.has(t.name)) out.identity = true;
      // The catalog is authoritative both ways — a catalog tool whose def
      // dropped identity (e.g. order_number+email became pair-verified)
      // clears a stale stored flag on load. Custom tools keep theirs.
      else if (out.identity && CATALOG_TOOL_NAMES.has(t.name)) delete out.identity;
      if (!out.widget) {
        const w = TEMPLATE_WIDGETS.get(t.name);
        if (w) out.widget = w;
      }
      return out;
    });
}

/**
 * SSRF guard: https to anywhere; http only to localhost (dev stubs).
 * Client-supplied URLs are called server-side, so this matters.
 */
function toolUrlAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return (
      u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

const MAX_TOOL_RESPONSE = 8_000;

const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/** Provider ids a tool result can "produce" — an identity-scoped arg is
 *  anchored only if it appeared in an earlier result this run (never typed
 *  or claimed by the customer). Prefixed ids hard-block when unproduced;
 *  bare numerics (HubSpot vids, Shopify order ids) only anchor when
 *  produced — a ticket/phone number in a free-text query must not fail. */
const PROVIDER_ID = /\b(?:cus|sub|si|ch|in|pi|pm|prod|price|acct|re)_[A-Za-z0-9]{5,}\b/g;
const NUMERIC_ID = /\b\d{8,}\b/g;

/**
 * Hard boundary for customer-record tools. Returns a block reason when the
 * call isn't anchored to the verified identity, else null. Rules:
 *  - any email appearing in args must be one of the customer's VERIFIED
 *    addresses (a typed address is a claim, never proof);
 *  - any provider-id arg must have been produced by a tool result earlier
 *    in this run (so stripe_customer_charges only chains off a verified
 *    stripe_find_customer);
 *  - at least one arg must anchor (verified email or produced id) —
 *    unanchored calls would return someone else's records.
 */
export function identityBlockReason(
  args: Record<string, unknown>,
  verifiedEmails: ReadonlySet<string>,
  producedIds: ReadonlySet<string>,
): string | null {
  const vals = Object.values(args).filter((v): v is string => typeof v === 'string');
  let anchored = false;
  for (const v of vals) {
    for (const m of v.matchAll(EMAIL_IN_TEXT)) {
      const email = m[0].toLowerCase();
      if (!verifiedEmails.has(email)) {
        return `identity check: "${email}" is not the verified customer's address — ` +
          'customer-record tools only act on the verified identity, never an email the customer merely types';
      }
      anchored = true;
    }
  }
  for (const v of vals) {
    for (const m of v.matchAll(PROVIDER_ID)) {
      if (!producedIds.has(m[0])) {
        return `identity check: "${m[0]}" was not produced by a verified lookup in this conversation — ` +
          'look the customer up by their verified email first';
      }
      anchored = true;
    }
    for (const m of v.matchAll(NUMERIC_ID)) {
      if (producedIds.has(m[0])) anchored = true;
    }
  }
  if (!anchored) {
    return 'identity check: no verified customer identity to bind this lookup to — ' +
      'customer-record tools need a verified sign-in or an email-channel conversation';
  }
  return null;
}

/** Ids a tool result makes available for later identity-scoped calls —
 *  feeds the producedIds set. */
export function harvestProducedIds(result: string, into: Set<string>): void {
  for (const m of result.matchAll(PROVIDER_ID)) into.add(m[0]);
  for (const m of result.matchAll(NUMERIC_ID)) into.add(m[0]);
}

function jsonArg(v: string): unknown {
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  secrets: Record<string, string> = {},
): Promise<string> {
  // Secrets expand first — LLM-supplied args can never inject {{secrets.*}}
  // placeholders, and arg values never get a second expansion pass.
  const missing = [
    ...new Set(
      [tool.url, tool.bodyTemplate ?? '', ...Object.values(tool.headers ?? {})]
        .flatMap((s) => [...s.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]))
        .filter((n) => !(n in secrets)),
    ),
  ];
  if (missing.length) {
    return `error: tool needs secrets not configured on this agent: ${missing.join(', ')}`;
  }
  let url = interpolateSecrets(tool.url, secrets);
  const headers = tool.headers
    ? Object.fromEntries(
        Object.entries(tool.headers).map(([k, v]) => [k, interpolateSecrets(v, secrets)]),
      )
    : undefined;
  const used = new Set<string>();
  for (const key of Object.keys(args)) {
    if (url.includes(`{${key}}`)) {
      url = url.replaceAll(`{${key}}`, encodeURIComponent(String(args[key])));
      used.add(key);
    }
  }
  if (!toolUrlAllowed(url)) return 'error: tool URL not allowed';

  // Body templates: every {key} placeholder must be supplied as an arg;
  // values substitute as JSON (strings quoted, objects nested). Secrets in
  // the template expand server-side exactly like url/headers — arg values
  // are never re-scanned, so model input can't trigger secret expansion.
  const canBody = tool.method !== 'GET' && tool.method !== 'DELETE';
  let templateBody: string | undefined;
  if (canBody && tool.bodyTemplate) {
    // Two placeholder spellings: legacy {key} for braces-free bodies, and
    // ${key} for bodies that carry literal braces (GraphQL selection sets).
    // A template using any ${…} disables the legacy form so `{nodes{id}}`
    // reads as data, not a placeholder.
    const dollar = tool.bodyTemplate.includes('${');
    const PLACEHOLDER = dollar
      ? /\$\{([A-Za-z_][A-Za-z0-9_]*)(:(text))?\}/g
      : /\{([A-Za-z_][A-Za-z0-9_]*)(:(text))?\}/g;
    const placeholders = [
      ...new Set([...tool.bodyTemplate.matchAll(PLACEHOLDER)].map((m) => m[1])),
    ];
    const missingArgs = placeholders.filter((k) => args[k] === undefined || args[k] === null);
    if (missingArgs.length) {
      return `error: missing required args: ${missingArgs.join(', ')}`;
    }
    // {key} → arg as a JSON value (object/array strings parse first, same
    // as flat bodies). {key:text} → raw text escaped for a JSON string
    // context — builds compound values like GraphQL search clauses.
    const tpl = interpolateSecrets(tool.bodyTemplate, secrets).replace(
      PLACEHOLDER,
      (_match, key: string, _colon?: string, mode?: string) => {
        const v = args[key];
        used.add(key);
        if (mode === 'text') return JSON.stringify(String(v)).slice(1, -1);
        return JSON.stringify(typeof v === 'string' ? jsonArg(v) : v);
      },
    );
    try {
      JSON.parse(tpl);
    } catch {
      return 'error: tool body template is not valid JSON';
    }
    templateBody = tpl;
  }

  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));

  if (tool.method === 'GET' || tool.method === 'DELETE') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    );
    if ([...qs].length) url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  // Bodies: params are declared type:string, so the model supplies nested
  // structures as JSON text — parse object/array-looking values so APIs get
  // real objects (HubSpot properties, Zendesk ticket), not strings. Form
  // bodies (Stripe) stay flat strings.
  let body: string | undefined;
  let contentType: string | undefined;
  if (templateBody) {
    body = templateBody;
    contentType = 'application/json';
  } else if (canBody && Object.keys(rest).length) {
    if (tool.bodyFormat === 'form') {
      body = new URLSearchParams(
        Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
      ).toString();
      contentType = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(
        Object.fromEntries(
          Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? jsonArg(v) : v]),
        ),
      );
      contentType = 'application/json';
    }
  }
  const res = await fetch(url, {
    method: tool.method,
    headers: {
      accept: 'application/json',
      ...(contentType ? { 'content-type': contentType } : {}),
      ...headers,
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = (await res.text()).slice(0, MAX_TOOL_RESPONSE);
  return res.ok ? text : `error: HTTP ${res.status} ${text.slice(0, 300)}`;
}

export type { Db };
