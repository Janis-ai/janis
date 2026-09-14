import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pushSubscriptions, users } from '../db/schema.js';
import { env } from '../env.js';

let configured = false;

function ensureVapid(): boolean {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    configured = true;
  }
  return true;
}

/** Push a notification to every subscribed device in the workspace. No-op without VAPID keys. */
export async function notifyWorkspace(
  db: Db,
  workspaceId: string,
  notification: { title: string; body: string; url?: string },
): Promise<void> {
  if (!ensureVapid()) return;

  const memberIds = (
    await db.select({ id: users.id }).from(users).where(eq(users.workspaceId, workspaceId))
  ).map((u) => u.id);
  if (memberIds.length === 0) return;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, memberIds));

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          JSON.stringify(notification),
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        }
      }
    }),
  );
}
