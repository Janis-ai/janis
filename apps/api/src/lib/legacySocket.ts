import { env } from '../env.js';
import type { agents } from '../db/schema.js';

type AgentRow = typeof agents.$inferSelect;

/**
 * Relay for legacy npm-SDK bots. The old `wordhop-socket-server` is a dumb
 * socket.io fan-out: SDK bots hold a persistent connection, register their
 * socket via /api/v1/update_bot_socket_id, and janis-api emitted events
 * (chat response / channel update) that the server addressed by socket_id.
 * The server also accepts POST /send — `{socket_id, message_type, ...}` —
 * which emits the matching event to that socket, so we can push over plain
 * HTTP without holding a socket.io client.
 *
 * Delivery precedence mirrors legacy (webhook OR socket): when an agent has
 * a registered socket it IS the bot's delivery path — the conversation's
 * channel row is transcript bookkeeping, not a place we can send.
 */

export function legacySocketId(agent: AgentRow): string | null {
  const meta = agent.metadata as { legacy_socket_id?: unknown } | null;
  return typeof meta?.legacy_socket_id === 'string' && meta.legacy_socket_id
    ? meta.legacy_socket_id
    : null;
}

async function send(socketId: string, payload: Record<string, unknown>): Promise<void> {
  if (!env.legacySocketUrl) return;
  try {
    await fetch(`${env.legacySocketUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ socket_id: socketId, ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

/** Operator reply → bot's socket ('chat response' → SDK 'sendMessage' path). */
export async function emitChatResponse(
  agent: AgentRow,
  platformUserId: string,
  text: string,
  operatorName?: string,
): Promise<boolean> {
  const socketId = legacySocketId(agent);
  if (!socketId) return false;
  const clientKey =
    (agent.metadata as { legacy_client_key?: string } | null)?.legacy_client_key ?? undefined;
  await send(socketId, {
    message_type: 'chat response',
    message: {
      text,
      metadata: { slack_user: operatorName ?? null, ts: new Date().toISOString() },
    },
    recipient: { id: platformUserId },
    client_key: clientKey,
  });
  return true;
}

/** Takeover/resume → 'channel update' so the bot stops/starts auto-replying. */
export async function emitChannelUpdate(
  agent: AgentRow,
  platformUserId: string,
  paused: boolean,
): Promise<void> {
  const socketId = legacySocketId(agent);
  if (!socketId) return;
  const clientKey =
    (agent.metadata as { legacy_client_key?: string } | null)?.legacy_client_key ?? undefined;
  await send(socketId, {
    message_type: 'channel update',
    type: 'channel_update',
    paused,
    channel: platformUserId,
    client_key: clientKey,
    text: paused ? 'A human has taken over this conversation.' : 'A human has resumed the bot.',
  });
}
