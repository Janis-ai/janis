import type { Db } from '../db/client.js';
import type { agents } from '../db/schema.js';
import { interpolateSecrets } from './secrets.js';
import { IDENTITY_TOOL_NAMES, TEMPLATE_WIDGETS } from './toolTemplates.js';
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
      [tool.url, ...Object.values(tool.headers ?? {})]
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
  if (tool.method !== 'GET' && tool.method !== 'DELETE' && Object.keys(rest).length) {
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
