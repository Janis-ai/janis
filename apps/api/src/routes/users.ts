import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, memberships, users } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { toWorkspaceUser } from '../lib/serializers.js';
import { removeMemberFromAlertChannels } from '../lib/slack.js';

const createUser = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'member']).default('member'),
});

export function userRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // Members (accepted) + pending invites for this workspace. ?agent_id=
  // returns that agent's eligible set instead: workspace members ∪ accepted
  // agent_members, with the effective role per user (agent role wins).
  app.get('/', async (c) => {
    const workspaceId = c.get('workspaceId');
    const agentId = c.req.query('agent_id');
    const rows = await db
      .select({ user: users, membership: memberships })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.workspaceId, workspaceId));
    if (!agentId) {
      return c.json({
        users: rows.map((r) => ({
          ...toWorkspaceUser(r.user, r.membership.role),
          status: r.membership.acceptedAt ? 'active' : 'invited',
        })),
      });
    }
    const scoped = await db
      .select({ user: users, member: agentMembers })
      .from(agentMembers)
      .innerJoin(users, eq(agentMembers.userId, users.id))
      .where(and(eq(agentMembers.agentId, agentId), isNotNull(agentMembers.acceptedAt)));
    const scopedById = new Map(scoped.map((s) => [s.user.id, s.member]));
    const memberIds = new Set(rows.map((r) => r.user.id));
    return c.json({
      users: [
        ...rows.map((r) => ({
          ...toWorkspaceUser(r.user, scopedById.get(r.user.id)?.role ?? r.membership.role),
          status: r.membership.acceptedAt ? 'active' : 'invited',
        })),
        ...scoped
          .filter((s) => !memberIds.has(s.user.id))
          .map((s) => ({
            ...toWorkspaceUser(s.user, s.member.role ?? 'member'),
            status: 'active',
          })),
      ],
    });
  });

  // admin-only: invite a teammate by email. Existing Janis accounts get a
  // pending invite they accept on login; new emails get a passwordless account
  // with a pending membership — their first OAuth sign-in lands on the invite.
  app.post('/', adminOnly, zValidator('json', createUser), async (c) => {
    const me = c.get('user');
    const workspaceId = c.get('workspaceId');
    const body = c.req.valid('json');

    const [existing] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) {
      const [mem] = await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, existing.id), eq(memberships.workspaceId, workspaceId)),
        )
        .limit(1);
      if (mem?.acceptedAt) return c.json({ error: 'already a member of this workspace' }, 409);
      if (mem) return c.json({ error: 'invite already pending for this workspace' }, 409);
      await db.insert(memberships).values({
        userId: existing.id,
        workspaceId,
        role: body.role,
        invitedBy: me.id,
      });
      return c.json(
        { user: { ...toWorkspaceUser(existing, body.role), status: 'invited' } },
        201,
      );
    }

    const [row] = await db
      .insert(users)
      .values({ email: body.email, name: body.name ?? body.email.split('@')[0] })
      .returning();
    await db.insert(memberships).values({
      userId: row.id,
      workspaceId,
      role: body.role,
      invitedBy: me.id,
    });
    return c.json({ user: { ...toWorkspaceUser(row, body.role), status: 'invited' } }, 201);
  });

  // update your own preferences (notification channels) or password. The
  // current password is required when the account already has one — OAuth-only
  // accounts can set their first password without it.
  app.patch(
    '/me',
    zValidator(
      'json',
      z.object({
        notify: z
          .object({
            push: z.boolean().optional(),
            email: z.boolean().optional(),
            sound: z.boolean().optional(),
          })
          .optional(),
        password: z
          .object({ current: z.string().optional(), new: z.string().min(8) })
          .optional(),
        // customer-facing operator identity — shown on channels that enable
        // "show operator name"; empty string clears back to first name
        display_name: z.string().max(80).nullable().optional(),
        avatar_url: z.string().regex(/^\/uploads\//).nullable().optional(),
        // per-operator opt-out of customer-facing identity on human replies
        show_identity: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const me = c.get('user');
      const body = c.req.valid('json');
      const updates: {
        notifyPrefs?: object;
        passwordHash?: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        showIdentity?: boolean;
      } = {};
      if (body.notify) {
        const current = (me.notifyPrefs ?? {}) as {
          push?: boolean;
          email?: boolean;
          sound?: boolean;
        };
        updates.notifyPrefs = {
          push: body.notify.push ?? current.push ?? true,
          email: body.notify.email ?? current.email ?? true,
          sound: body.notify.sound ?? current.sound ?? true,
        };
      }
      if (body.password) {
        if (
          me.passwordHash &&
          (!body.password.current || !(await verifyPassword(body.password.current, me.passwordHash)))
        ) {
          return c.json({ error: 'current password is wrong' }, 403);
        }
        updates.passwordHash = await hashPassword(body.password.new);
      }
      if (body.display_name !== undefined) {
        updates.displayName = body.display_name?.trim() || null;
      }
      if (body.avatar_url !== undefined) updates.avatarUrl = body.avatar_url;
      if (body.show_identity !== undefined) updates.showIdentity = body.show_identity;
      const [row] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, me.id))
        .returning();
      return c.json({ user: toWorkspaceUser(row, c.get('role')) });
    },
  );

  // admin-only: change a teammate's role in this workspace
  app.patch(
    '/:id',
    adminOnly,
    zValidator('json', z.object({ role: z.enum(['admin', 'member']) })),
    async (c) => {
      const [row] = await db
        .update(memberships)
        .set({ role: c.req.valid('json').role })
        .where(
          and(
            eq(memberships.userId, c.req.param('id')),
            eq(memberships.workspaceId, c.get('workspaceId')),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
      return c.json({ user: toWorkspaceUser(u, row.role) });
    },
  );

  // admin-only: remove a teammate from this workspace (can't remove yourself).
  // The account survives — their other memberships are unaffected.
  app.delete('/:id', adminOnly, async (c) => {
    const me = c.get('user');
    if (me.id === c.req.param('id')) return c.json({ error: 'cannot remove yourself' }, 409);
    const [row] = await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, c.req.param('id')),
          eq(memberships.workspaceId, c.get('workspaceId')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    // Slack connected → kick the removed member out of the alert channels.
    void removeMemberFromAlertChannels(db, c.get('workspaceId'), c.req.param('id')).catch((e) =>
      console.error('slack member unsync failed:', e),
    );
    return c.json({ ok: true });
  });

  return app;
}
