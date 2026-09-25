import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { alerts } from '../db/schema.js';

type AlertRow = typeof alerts.$inferSelect;

/**
 * Insert an open alert unless one already exists for this conversation+type.
 * The partial unique index `alerts_one_open_per_type` makes this safe under
 * concurrent event processing — the loser gets the winner's row back with
 * `created: false` and should skip publish/notify (already handled there).
 */
export async function openAlertOnce(
  db: Db,
  values: { conversationId: string; type: AlertRow['type']; detail?: string },
): Promise<{ alert: AlertRow; created: true } | { alert: AlertRow | undefined; created: false }> {
  const [inserted] = await db
    .insert(alerts)
    .values(values)
    .onConflictDoNothing({
      target: [alerts.conversationId, alerts.type],
      where: eq(alerts.status, 'open'),
    })
    .returning();
  if (inserted) return { alert: inserted, created: true };
  const [existing] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.conversationId, values.conversationId),
        eq(alerts.type, values.type),
        eq(alerts.status, 'open'),
      ),
    )
    .limit(1);
  // Conflict happened but the winner's row is gone — the conversation was
  // deleted (or the alert resolved) between the two statements. Treat as a
  // no-op rather than resurrect it.
  if (!existing) return { alert: undefined, created: false };
  return { alert: existing, created: false };
}
