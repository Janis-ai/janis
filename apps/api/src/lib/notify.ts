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

interface NotifyPrefs {
  push?: boolean;
  email?: boolean;
}

/** Transactional email via Resend — no-op until RESEND_API_KEY is configured. */
async function sendEmail(to: string[], title: string, body: string, url?: string) {
  if (!env.resendApiKey || to.length === 0) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.resendApiKey}`,
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to,
      subject: title,
      text: url ? `${body}\n\n${env.webOrigin}${url}` : body,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error('email send failed:', res.status, await res.text().catch(() => ''));
}

/**
 * Alert workspace members when an agent needs a human — each user's
 * notify_prefs decide web push and/or email. No-op without VAPID/Resend keys.
 */
export async function notifyWorkspace(
  db: Db,
  workspaceId: string,
  notification: { title: string; body: string; url?: string },
): Promise<void> {
  const members = await db
    .select({ id: users.id, email: users.email, notifyPrefs: users.notifyPrefs })
    .from(users)
    .where(eq(users.workspaceId, workspaceId));
  if (members.length === 0) return;

  const pushUserIds = members
    .filter((m) => (m.notifyPrefs as NotifyPrefs).push !== false)
    .map((m) => m.id);
  const emailAddrs = members
    .filter((m) => (m.notifyPrefs as NotifyPrefs).email !== false)
    .map((m) => m.email);

  const jobs: Promise<unknown>[] = [];

  if (ensureVapid() && pushUserIds.length) {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, pushUserIds));
    jobs.push(
      ...subs.map(async (sub) => {
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

  jobs.push(
    sendEmail(emailAddrs, notification.title, notification.body, notification.url).catch((err) =>
      console.error('email send failed:', err),
    ),
  );

  await Promise.allSettled(jobs);
}
