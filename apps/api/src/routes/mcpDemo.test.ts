import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mcpDemoRoutes, MCP_DEMO_TOKEN } from './mcpDemo.js';
import { mcpListTools, mcpCallTool } from '../lib/mcpClient.js';

const app = new Hono().route('/mcp-demo', mcpDemoRoutes());

afterEach(() => vi.unstubAllGlobals());
const AUTH = { authorization: `Bearer ${MCP_DEMO_TOKEN}` };

const post = (body: unknown) =>
  app.request('/mcp-demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });

describe('mcp demo server', () => {
  it('rejects calls without the demo token', async () => {
    const res = await app.request('/mcp-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('handshakes, lists tools, and serves calls', async () => {
    const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
    expect(init.result.serverInfo.name).toBe('Janis Demo MCP');

    const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['lookup_order', 'search_faq', 'create_ticket']);
    // read-only hints on the lookups, none on the mutation — that split is
    // what the connector turns into approval defaults.
    const byName = Object.fromEntries(
      list.result.tools.map((t: { name: string; annotations?: { readOnlyHint?: boolean } }) => [
        t.name,
        t.annotations?.readOnlyHint,
      ]),
    );
    expect(byName.lookup_order).toBe(true);
    expect(byName.create_ticket).toBeUndefined();

    const call = await (
      await post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_ticket', arguments: { summary: 'broken checkout' } },
      })
    ).json();
    const ticket = JSON.parse(call.result.content[0].text);
    expect(ticket.ticket_id).toMatch(/^DEMO-\d{4}$/);
    expect(ticket.summary).toBe('broken checkout');
  });

  it('round-trips through the real client — the exact path the card uses', async () => {
    // Point the client at the in-process app via a fetch shim.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: RequestInfo | URL, init?: RequestInit) =>
        app.request('/mcp-demo', init),
      ),
    );

    const { tools, serverInfo } = await mcpListTools('https://x/mcp-demo', AUTH);
    expect(serverInfo.name).toBe('Janis Demo MCP');
    expect(tools).toHaveLength(3);

    const out = await mcpCallTool(
      'https://x/mcp-demo',
      AUTH,
      'lookup_order',
      { order_number: '#1042' },
    );
    expect(JSON.parse(out).status).toBe('shipped');
  });
});
