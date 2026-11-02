import { Hono } from 'hono';

// Demo MCP server — a canned-data JSON-RPC endpoint for exercising the
// mcp-server connector card end-to-end (discovery → install → calls →
// approval gating) without standing up a real third-party server. Also a
// permanent eval fixture for customers who want to feel the flow before
// pointing the card at their own endpoint. Returns JSON only (our client
// accepts JSON or SSE); stateless — no session ids.
//
// Gate: a public, documented demo token — not a real secret, it just
// keeps drive-by scanners from rattling the endpoint.

export const MCP_DEMO_TOKEN = 'janis-demo-2026';

interface RpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const TOOLS = [
  {
    name: 'lookup_order',
    description: 'Look up a demo order by number — returns canned status.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'e.g. #1042' },
      },
      required: ['order_number'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_faq',
    description: 'Search the demo knowledge base — returns canned articles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search text' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_ticket',
    description: 'File a demo support ticket — mutating, so it installs approval-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'one-line summary' },
        customer_email: { type: 'string', description: 'optional reporter email' },
      },
      required: ['summary'],
    },
    // No readOnlyHint → the connector installs this approval-gated.
  },
];

const CANNED = {
  lookup_order: (a: Record<string, unknown>) => ({
    order_number: a.order_number ?? '#1042',
    status: 'shipped',
    carrier: 'UPS',
    tracking: '1Z999AA10123456784',
    eta: '2026-11-04',
    items: ['Demo Widget ×2'],
  }),
  search_faq: (a: Record<string, unknown>) => ({
    query: a.query ?? '',
    results: [
      { title: 'Returns & exchanges', score: 0.94, snippet: '30-day returns, prepaid label…' },
      { title: 'Shipping times', score: 0.81, snippet: '2–5 business days domestic…' },
    ],
  }),
  create_ticket: (a: Record<string, unknown>) => ({
    ticket_id: `DEMO-${Math.floor(1000 + Math.random() * 9000)}`,
    summary: a.summary ?? '',
    customer_email: a.customer_email ?? null,
    status: 'open',
    note: 'demo ticket — nothing was actually filed',
  }),
};

const ok = (id: number | string | null | undefined, result: unknown) => ({
  jsonrpc: '2.0',
  id,
  result,
});
const err = (id: number | string | null | undefined, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

export function mcpDemoRoutes() {
  const app = new Hono();

  app.post('/', async (c) => {
    if (c.req.header('authorization') !== `Bearer ${MCP_DEMO_TOKEN}`) {
      return c.json(
        err(null, -32001, `unauthorized — send Authorization: Bearer ${MCP_DEMO_TOKEN} (this is the public demo token)`),
        401,
      );
    }
    const msg = (await c.req.json().catch(() => null)) as RpcMsg | null;
    if (!msg?.method) return c.json(err(msg?.id ?? null, -32600, 'invalid request'), 400);

    switch (msg.method) {
      case 'initialize':
        return c.json(
          ok(msg.id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'Janis Demo MCP', version: '1.0.0' },
          }),
        );
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return c.body(null, 202);
      case 'ping':
        return c.json(ok(msg.id, {}));
      case 'tools/list':
        return c.json(ok(msg.id, { tools: TOOLS }));
      case 'tools/call': {
        const name = msg.params?.name ?? '';
        const fn = (CANNED as Record<string, (a: Record<string, unknown>) => unknown>)[name];
        if (!fn) return c.json(ok(msg.id, { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] }));
        const result = fn(msg.params?.arguments ?? {});
        return c.json(
          ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }),
        );
      }
      default:
        return c.json(err(msg.id, -32601, `method not supported: ${msg.method}`), 400);
    }
  });

  return app;
}
