import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';

/** The key bot-platform ingest URLs are addressed by — /bot/<key>/<flavor>
 *  matches agents.metadata.bot_key (or legacy_client_key). Minted lazily:
 *  every surface that needs the URL (the channel card's /bot GET, channel
 *  creation, concierge inspect_agent) calls this rather than reading
 *  metadata directly, so an agent whose key was never minted still yields a
 *  real URL instead of a null the model has to guess around. */
export async function ensureBotKey(
  db: Db,
  agent: { id: string; metadata: unknown },
): Promise<string> {
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  const existing = (meta.bot_key ?? meta.legacy_client_key) as string | undefined;
  if (existing) return existing;
  const key = `bk_${randomBytes(16).toString('hex')}`;
  await db
    .update(agents)
    .set({ metadata: { ...meta, bot_key: key } })
    .where(eq(agents.id, agent.id));
  return key;
}
