import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workspaces } from '../db/schema.js';

/**
 * Outbound event export — "Zapier trigger" side of the marketplace story.
 * When the workspace sets config.event_webhook_url, every event POSTs a JSON
 * envelope there so Zapier/Make/n8n can fan it out to anything (Sheets,
 * Slack, HubSpot, …). Fire-and-forget: a slow hook never delays a reply.
 */
export function fireEventWebhook(
  db: Db,
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  void (async () => {
    const [ws] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const url = (ws?.config as { event_webhook_url?: string } | undefined)?.event_webhook_url;
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, at: new Date().toISOString(), ...data }),
      signal: AbortSignal.timeout(8_000),
    });
  })().catch(() => {});
}
