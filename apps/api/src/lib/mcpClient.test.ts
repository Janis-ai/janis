import { describe, it, expect, afterEach, vi } from 'vitest';
import { mcpListTools, mcpCallTool } from './mcpClient.js';
import { TOOL_TEMPLATES } from './toolTemplates.js';
import { callTool } from './toolExec.js';

interface Seen {
  url: string;
  init?: RequestInit;
}
let seen: Seen[] = [];

const stubMcp = (
  handler: (msg: { id?: number; method: string }, init: RequestInit | undefined) => {
    status?: number;
    body?: unknown;
    sse?: boolean;
    sessionId?: string;
  },
) => {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, init });
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      const r = handler(msg, init);
      const headers: Record<string, string> = {
        'content-type': r.sse ? 'text/event-stream' : 'application/json',
      };
      if (r.sessionId) headers['mcp-session-id'] = r.sessionId;
      const payload =
        r.body === undefined
          ? ''
          : r.sse
            ? `data: ${JSON.stringify(r.body)}\n\n`
            : JSON.stringify(r.body);
      return Promise.resolve(new Response(payload, { status: r.status ?? 200, headers }));
    }),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('mcp client', () => {
  it('initializes then lists tools over JSON responses', async () => {
    stubMcp((msg) => {
      if (msg.method === 'initialize') {
        return {
          sessionId: 'sess-1',
          body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Asana MCP' } } },
        };
      }
      if (msg.method === 'notifications/initialized') return { status: 202 };
      if (msg.method === 'tools/list') {
        return {
          sessionId: 'sess-1',
          body: {
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [
                {
                  name: 'asana_search_tasks',
                  description: 'find tasks',
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          },
        };
      }
      return { status: 500, body: { error: 'nope' } };
    });
    const { tools, serverInfo } = await mcpListTools('https://mcp.example.com/mcp', {
      authorization: 'Bearer tok',
    });
    expect(serverInfo.name).toBe('Asana MCP');
    expect(tools.map((t) => t.name)).toEqual(['asana_search_tasks']);
    // Bearer + session id ride subsequent calls.
    const listCall = seen.find((s) => String(s.init?.body).includes('tools/list'))!;
    const h = listCall.init?.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['mcp-session-id']).toBe('sess-1');
    // Both transports accepted on every call.
    expect(h.accept).toBe('application/json, text/event-stream');
  });

  it('unwraps SSE-framed responses', async () => {
    stubMcp((msg) => {
      if (msg.method === 'initialize') {
        return { sse: true, body: { jsonrpc: '2.0', id: 1, result: {} } };
      }
      if (msg.method === 'notifications/initialized') return { status: 202 };
      return {
        sse: true,
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: 'task AS-1 created' }],
          },
        },
      };
    });
    const out = await mcpCallTool('https://mcp.example.com/mcp', {}, 'create_task', {
      title: 'x',
    });
    expect(out).toBe('task AS-1 created');
  });

  it('surfaces JSON-RPC and isError failures as errors', async () => {
    stubMcp((msg) => {
      if (msg.method === 'initialize') return { body: { jsonrpc: '2.0', id: 1, result: {} } };
      if (msg.method === 'notifications/initialized') return { status: 202 };
      return {
        body: { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'tool not found' } },
      };
    });
    await expect(mcpCallTool('https://mcp.example.com/mcp', {}, 'nope', {})).rejects.toThrow(
      'tool not found',
    );

    stubMcp((msg) => {
      if (msg.method === 'initialize') return { body: { jsonrpc: '2.0', id: 1, result: {} } };
      if (msg.method === 'notifications/initialized') return { status: 202 };
      return {
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: { isError: true, content: [{ type: 'text', text: 'bad args' }] },
        },
      };
    });
    expect(await mcpCallTool('https://mcp.example.com/mcp', {}, 'x', {})).toBe('error: bad args');
  });
});

describe('mcp-server template discovery', () => {
  const tpl = TOOL_TEMPLATES.find((t) => t.id === 'mcp-server')!;
  const fields = { name: 'Asana', server_url: 'https://mcp.example.com/mcp', auth_token: 'tok' };

  it('namespaces tools, carries the input schema, and gates mutations', async () => {
    stubMcp((msg) => {
      if (msg.method === 'initialize') return { body: { jsonrpc: '2.0', id: 1, result: {} } };
      if (msg.method === 'notifications/initialized') return { status: 202 };
      return {
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'search_tasks',
                description: 'find tasks',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                annotations: { readOnlyHint: true },
              },
              { name: 'create task!', annotations: { destructiveHint: true } },
              { name: 'move_card' }, // no annotations → mutation default
            ],
          },
        },
      };
    });
    const tools = await tpl.discoverTools!(fields);
    expect(tools.map((t) => t.name)).toEqual([
      'mcp_asana_search_tasks',
      'mcp_asana_create_task_',
      'mcp_asana_move_card',
    ]);
    const [ro, del, mut] = tools;
    // readOnlyHint → autonomous; anything else → approval-gated.
    expect(ro.approval).toBeUndefined();
    expect(del.approval).toBe(true);
    expect(mut.approval).toBe(true);
    // The server's schema + remote name ride the def; identity never binds.
    expect(ro.inputSchema?.type).toBe('object');
    expect(ro.mcpTool).toBe('search_tasks');
    expect(ro.transport).toBe('mcp');
    expect(tools.every((t) => !t.identity)).toBe(true);
    // Secret placeholders — never the literal URL/token.
    expect(ro.url).toBe('{{secrets.MCP_ASANA_URL}}');
    expect(ro.headers?.authorization).toBe('Bearer {{secrets.MCP_ASANA_TOKEN}}');
  });

  it('rejects a bad server URL before any fetch', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      tpl.discoverTools!({ ...fields, server_url: 'notaurl' }),
    ).rejects.toThrow('http');
  });
});

describe('mcp tool execution', () => {
  it('callTool dispatches transport=mcp to JSON-RPC with secrets interpolated', async () => {
    stubMcp((msg) => {
      if (msg.method === 'initialize') return { body: { jsonrpc: '2.0', id: 1, result: {} } };
      if (msg.method === 'notifications/initialized') return { status: 202 };
      return {
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        },
      };
    });
    const out = await callTool(
      {
        name: 'mcp_asana_search_tasks',
        description: 'find tasks',
        method: 'POST',
        url: '{{secrets.MCP_ASANA_URL}}',
        headers: { authorization: 'Bearer {{secrets.MCP_ASANA_TOKEN}}' },
        transport: 'mcp',
        mcpTool: 'search_tasks',
      },
      { q: 'billing', limit: '5' },
      { MCP_ASANA_URL: 'https://mcp.example.com/mcp', MCP_ASANA_TOKEN: 'tok' },
    );
    expect(out).toBe('{"ok":true}');
    const call = seen.find((s) => String(s.init?.body).includes('tools/call'))!;
    const body = JSON.parse(String(call.init?.body));
    expect(body.params.name).toBe('search_tasks');
    expect(body.params.arguments).toEqual({ q: 'billing', limit: '5' });
    const h = call.init?.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(call.url).toBe('https://mcp.example.com/mcp');
  });
});
