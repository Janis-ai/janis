import type { Db } from '../db/client.js';
import type { agents } from '../db/schema.js';
import { interpolateSecrets } from './secrets.js';

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
}

export function toolsFor(agent: AgentRow): ToolDef[] {
  const cfg = (agent.config ?? {}) as { tools?: ToolDef[] };
  return (cfg.tools ?? []).filter((t) => t.name && t.url);
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
