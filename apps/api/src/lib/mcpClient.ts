// Minimal MCP client — streamable-HTTP transport only (POST JSON-RPC,
// JSON or SSE-framed responses). No stdio, no GET event stream: v1
// targets hosted remote servers (Asana/Sentry/GitHub-style endpoints).
// Every call re-initializes so nothing session-shaped needs storing —
// stateless servers ignore the handshake, stateful ones mint a fresh
// mcp-session-id we carry for the rest of that call.

export interface McpServerInfo {
  name?: string;
  version?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const PROTOCOL_VERSION = '2025-06-18';

/** A response can be plain JSON or text/event-stream — unwrap either. */
async function readMessage(res: Response): Promise<JsonRpcMessage | null> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    // SSE frames: `data: <json>` lines; the last data line carries the
    // response for single-shot POSTs.
    let msg: JsonRpcMessage | null = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(t.slice(5).trim()) as JsonRpcMessage;
        if (parsed.id !== undefined || parsed.method) msg = parsed;
      } catch {
        /* partial/keepalive lines */
      }
    }
    return msg;
  }
  try {
    return (await res.json()) as JsonRpcMessage;
  } catch {
    return null;
  }
}

/** One JSON-RPC round trip; returns { result, sessionId } or throws. */
async function rpc(
  url: string,
  headers: Record<string, string>,
  msg: { id?: number; method: string; params?: unknown },
  sessionId?: string,
): Promise<{ result?: unknown; sessionId?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
    signal: AbortSignal.timeout(15_000),
  });
  const sid = res.headers.get('mcp-session-id') ?? sessionId;
  if (res.status === 202) return { sessionId: sid }; // notification ack
  const parsed = await readMessage(res);
  if (!res.ok) {
    throw new Error(
      parsed?.error?.message ?? `MCP server answered ${res.status}`,
    );
  }
  if (parsed?.error) {
    throw new Error(parsed.error.message ?? `MCP error ${parsed.error.code ?? ''}`.trim());
  }
  return { result: parsed?.result, sessionId: sid };
}

async function handshake(
  url: string,
  headers: Record<string, string>,
): Promise<{ sessionId?: string; serverInfo: McpServerInfo }> {
  const { result, sessionId } = await rpc(
    url,
    headers,
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'janis', version: '1.0' },
      },
    },
  );
  const info = (result as { serverInfo?: McpServerInfo } | undefined)?.serverInfo ?? {};
  // Spec-required notification — fire-and-forget (202/no-body).
  await rpc(url, headers, { method: 'notifications/initialized' }, sessionId).catch(() => {});
  return { sessionId, serverInfo: info };
}

/** initialize → tools/list — used at install to materialize ToolDefs. */
export async function mcpListTools(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ tools: McpToolDef[]; serverInfo: McpServerInfo }> {
  const { sessionId, serverInfo } = await handshake(url, headers);
  const { result } = await rpc(url, headers, { id: 2, method: 'tools/list' }, sessionId);
  const tools = ((result as { tools?: McpToolDef[] } | undefined)?.tools ?? []).filter(
    (t) => typeof t?.name === 'string' && t.name,
  );
  return { tools, serverInfo };
}

/**
 * initialize → tools/call — the runtime path. Re-handshakes each call so
 * expired sessions self-heal; args pass through verbatim (the model built
 * them against the server's own inputSchema — no template substitution).
 */
export async function mcpCallTool(
  url: string,
  headers: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { sessionId } = await handshake(url, headers);
  const { result } = await rpc(
    url,
    headers,
    { id: 2, method: 'tools/call', params: { name: toolName, arguments: args } },
    sessionId,
  );
  const r = result as
    | { content?: { type?: string; text?: string }[]; isError?: boolean }
    | undefined;
  const text = (r?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n');
  const out = text || JSON.stringify(r ?? {});
  return r?.isError ? `error: ${out}` : out;
}
