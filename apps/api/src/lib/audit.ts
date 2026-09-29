import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  workspaceId: string;
  userId?: string | null;
  userName?: string | null;
  /** Dotted verb: 'agent.create', 'channel.delete', 'billing.connect', … */
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

/** Write an audit row. Never throws — auditing must not break the mutation
 *  it records; a failed audit insert logs to stderr instead. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      workspaceId: entry.workspaceId,
      userId: entry.userId ?? null,
      userName: entry.userName ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      meta: entry.meta ?? {},
    });
  } catch (err) {
    console.error('audit write failed:', entry.action, err);
  }
}

/** Newest-first page of a workspace's audit trail. */
export async function auditLogFor(db: Db, workspaceId: string, limit = 100) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, workspaceId))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, 500));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    user_name: r.userName,
    target_type: r.targetType,
    target_id: r.targetId,
    meta: r.meta,
    created_at: r.createdAt,
  }));
}
