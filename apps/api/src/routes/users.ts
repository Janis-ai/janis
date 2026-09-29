import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, agents, memberships, users, workspaces } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { toWorkspaceUser } from '../lib/serializers.js';
import { removeMemberFromAlertChannels } from '../lib/slack.js';
import { audit } from '../lib/audit.js';

const createUser = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

export function userRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  const workspaceOwner = async (workspaceId: string) => {
    const [ws] = await db
      .select({ ownerId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return ws?.ownerId ?? null;
  };

  // Members (accepted) + pending invites for this workspace. ?agent_id=
  // returns that agent's eligible set instead: workspace members ∪ accepted
  // agent_members, with the effective role per user (agent role wins).
  // 'hidden' rows are denied access — they're never eligible assignees.
  app.get('/', async (c) => {
    const workspaceId = c.get('workspaceId');
    const agentId = c.req.query('agent_id');
    const ownerId = await workspaceOwner(workspaceId);
    const rows = await db
      .select({ user: users, membership: memberships })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.workspaceId, workspaceId));
    const wsRole = (u: (typeof rows)[number]) =>
      u.user.id === ownerId ? ('owner' as const) : u.membership.role;
    if (!agentId) {
      return c.json({
        users: rows.map((r) => ({
          ...toWorkspaceUser(r.user, wsRole(r)),
          status: r.membership.acceptedAt ? 'active' : 'invited',
        })),
      });
    }
    const [agent] = await db
      .select({ ownerId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    const scoped = await db
      .select({ user: users, member: agentMembers })
      .from(agentMembers)
      .innerJoin(users, eq(agentMembers.userId, users.id))
      .where(and(eq(agentMembers.agentId, agentId), isNotNull(agentMembers.acceptedAt)));
    const scopedById = new Map(scoped.map((s) => [s.user.id, s.member]));
    const hidden = new Set(
      scoped.filter((s) => s.member.role === 'hidden').map((s) => s.user.id),
    );
    const memberIds = new Set(rows.map((r) => r.user.id));
    // hidden rows were filtered above — a residual 'hidden' can't surface
    const effRole = (userId: string, fallback: 'owner' | 'admin' | 'member' | 'viewer') => {
      if (userId === agent?.ownerId) return 'owner' as const;
      const r = scopedById.get(userId)?.role;
      return r && r !== 'hidden' ? r : fallback;
    };
    return c.json({
      users: [
        ...rows
          .filter((r) => !hidden.has(r.user.id))
          .map((r) => ({
            ...toWorkspaceUser(r.user, effRole(r.user.id, wsRole(r))),
            status: r.membership.acceptedAt ? 'active' : 'invited',
          })),
        ...scoped
          .filter((s) => !memberIds.has(s.user.id) && s.member.role !== 'hidden')
          .map((s) => ({
            ...toWorkspaceUser(s.user, effRole(s.user.id, 'member')),
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
      await audit(db, {
        workspaceId, userId: me.id, userName: me.name,
        action: 'member.invite', targetType: 'user', targetId: existing.id,
        meta: { email: body.email, role: body.role },
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
    await audit(db, {
      workspaceId, userId: me.id, userName: me.name,
      action: 'member.invite', targetType: 'user', targetId: row.id,
      meta: { email: body.email, role: body.role },
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

  // admin-only: change a teammate's role in this workspace. role 'owner'
  // TRANSFERS ownership — only the current owner can do it (an admin may
  // claim it when no owner is recorded, e.g. a pre-migration workspace).
  // The owner can't be demoted except by handing ownership over.
  app.patch(
    '/:id',
    adminOnly,
    zValidator('json', z.object({ role: z.enum(['admin', 'member', 'viewer', 'owner']) })),
    async (c) => {
      const me = c.get('user');
      const workspaceId = c.get('workspaceId');
      const role = c.req.valid('json').role;
      const [mem] = await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, c.req.param('id')), eq(memberships.workspaceId, workspaceId)),
        )
        .limit(1);
      if (!mem) return c.json({ error: 'not found' }, 404);
      const ownerId = await workspaceOwner(workspaceId);

      if (role === 'owner') {
        if (ownerId === c.req.param('id')) {
          const [u] = await db.select().from(users).where(eq(users.id, mem.userId)).limit(1);
          return c.json({ user: toWorkspaceUser(u, 'owner') });
        }
        if (ownerId !== me.id && ownerId !== null) {
          return c.json({ error: 'only the workspace owner can transfer ownership' }, 403);
        }
        if (!mem.acceptedAt) {
          return c.json({ error: 'ownership can only go to an accepted member' }, 409);
        }
        // Owners are always admins — promote the membership, then move the
        // owner pointer. The previous owner stays an admin.
        await db
          .update(memberships)
          .set({ role: 'admin' })
          .where(eq(memberships.id, mem.id));
        await db
          .update(workspaces)
          .set({ ownerUserId: mem.userId })
          .where(eq(workspaces.id, workspaceId));
        const [u] = await db.select().from(users).where(eq(users.id, mem.userId)).limit(1);
        return c.json({ user: toWorkspaceUser(u, 'owner') });
      }

      if (c.req.param('id') === ownerId) {
        return c.json({ error: 'the workspace owner stays admin — transfer ownership first' }, 409);
      }
      const [row] = await db
        .update(memberships)
        .set({ role })
        .where(eq(memberships.id, mem.id))
        .returning();
      const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
      return c.json({ user: toWorkspaceUser(u, row.role) });
    },
  );

  // admin-only: remove a teammate from this workspace (can't remove yourself
  // or the owner — ownership must be transferred first). The account
  // survives — their other memberships are unaffected.
  app.delete('/:id', adminOnly, async (c) => {
    const me = c.get('user');
    if (me.id === c.req.param('id')) return c.json({ error: 'cannot remove yourself' }, 409);
    if ((await workspaceOwner(c.get('workspaceId'))) === c.req.param('id')) {
      return c.json({ error: 'the workspace owner cannot be removed — transfer ownership first' }, 409);
    }
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
