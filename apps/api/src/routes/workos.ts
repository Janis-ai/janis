import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberships, users, workspaces } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';

/**
 * WorkOS Directory Sync (SCIM) — POST /workos/directory-events.
 * Customer IT points a WorkOS directory webhook here; user lifecycle events
 * provision/deprovision memberships automatically. A workspace links to a
 * directory via workspaces.config.workos_directory_id (set over the API).
 *
 * Signature: WorkOS-Signature: t=<ms>,v1=<hmac-sha256 hex of `${t}.${body}`>.
 * User rows key on email — a directory rename that changes the email simply
 * provisions under the new address; the old membership deprovisions on the
 * next deleted/deactivated event for its directory id.
 */
export function workosRoutes(db: Db) {
  const app = new Hono();

  app.post('/directory-events', async (c) => {
    if (!env.workosDirectorySecret) return c.json({ error: 'not configured' }, 404);
    const raw = await c.req.text();
    const sig = c.req.header('workos-signature') ?? '';
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(sig)?.[1];
    if (!t || !v1) return c.json({ error: 'bad signature' }, 401);
    // 5-minute replay window — same rule Stripe uses.
    if (Math.abs(Date.now() - Number(t)) > 5 * 60_000) {
      return c.json({ error: 'stale signature' }, 401);
    }
    const expected = createHmac('sha256', env.workosDirectorySecret)
      .update(`${t}.${raw}`)
      .digest('hex');
    const a = Buffer.from(v1, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'bad signature' }, 401);
    }

    const evt = JSON.parse(raw) as {
      event?: string;
      directory_id?: string;
      data?: {
        directory_id?: string;
        id?: string;
        state?: string;
        first_name?: string;
        last_name?: string;
        emails?: { value?: string; primary?: boolean }[];
      };
    };
    const directoryId = evt.directory_id ?? evt.data?.directory_id;
    if (!directoryId) return c.json({ ok: true }); // unrelated event type
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(sql`${workspaces.config}->>'workos_directory_id' = ${directoryId}`)
      .limit(1);
    if (!ws) return c.json({ ok: true }); // directory not linked to a workspace

    const du = evt.data ?? {};
    const email = (
      du.emails?.find((e) => e.primary)?.value ??
      du.emails?.[0]?.value ??
      ''
    ).toLowerCase();
    const name = [du.first_name, du.last_name].filter(Boolean).join(' ') || email;
    const deactivate =
      evt.event === 'dsync.user.deleted' ||
      (evt.event === 'dsync.user.updated' && du.state && du.state !== 'active');

    if (evt.event === 'dsync.user.created' || evt.event === 'dsync.user.updated') {
      if (!email) return c.json({ ok: true });
      if (deactivate) {
        const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (u) {
          await db
            .delete(memberships)
            .where(and(eq(memberships.userId, u.id), eq(memberships.workspaceId, ws.id)));
        }
      } else {
        let [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!u) {
          [u] = await db.insert(users).values({ email, name }).returning();
        } else if (name && u.name !== name) {
          await db.update(users).set({ name }).where(eq(users.id, u.id));
        }
        // Provisioned users are active immediately — they authenticate via
        // SSO, no invite-accept step.
        await db
          .insert(memberships)
          .values({ userId: u.id, workspaceId: ws.id, role: 'member', acceptedAt: new Date() })
          .onConflictDoNothing();
      }
    } else if (evt.event === 'dsync.user.deleted' && email) {
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (u) {
        await db
          .delete(memberships)
          .where(and(eq(memberships.userId, u.id), eq(memberships.workspaceId, ws.id)));
      }
    }
    await audit(db, {
      workspaceId: ws.id,
      action: 'scim.sync',
      targetType: 'user',
      targetId: email || du.id || 'unknown',
      meta: { event: evt.event, directory_id: directoryId },
    });
    return c.json({ ok: true });
  });

  return app;
}
