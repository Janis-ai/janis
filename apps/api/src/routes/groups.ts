import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberGroups, memberships } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { isAdminRole } from '../lib/access.js';
import { toMemberGroup } from '../lib/serializers.js';

const groupBody = z.object({
  name: z.string().min(1).max(80),
  member_ids: z.array(z.string().uuid()).max(200),
});

async function ownedGroup(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(memberGroups)
    .where(and(eq(memberGroups.id, id), eq(memberGroups.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Workspace member ids — drops ids that aren't real members so a stale
 *  roster can't carry ghosts. */
async function existingMemberIds(db: Db, workspaceId: string, ids: string[]) {
  if (!ids.length) return [] as string[];
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, ids)),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

export function groupRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(memberGroups)
      .where(eq(memberGroups.workspaceId, c.get('workspaceId')));
    return c.json({ groups: rows.map(toMemberGroup) });
  });

  app.post('/', zValidator('json', groupBody), async (c) => {
    if (!isAdminRole(c.get('role'))) return c.json({ error: 'admin required' }, 403);
    const body = c.req.valid('json');
    const memberIds = await existingMemberIds(db, c.get('workspaceId'), body.member_ids);
    const [row] = await db
      .insert(memberGroups)
      .values({ workspaceId: c.get('workspaceId'), name: body.name, memberIds })
      .returning();
    return c.json({ group: toMemberGroup(row) }, 201);
  });

  app.patch('/:id', zValidator('json', groupBody.partial()), async (c) => {
    if (!isAdminRole(c.get('role'))) return c.json({ error: 'admin required' }, 403);
    const existing = await ownedGroup(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    const body = c.req.valid('json');
    const memberIds =
      body.member_ids !== undefined
        ? await existingMemberIds(db, c.get('workspaceId'), body.member_ids)
        : existing.memberIds;
    const [row] = await db
      .update(memberGroups)
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), memberIds })
      .where(eq(memberGroups.id, existing.id))
      .returning();
    return c.json({ group: toMemberGroup(row) });
  });

  app.delete('/:id', async (c) => {
    if (!isAdminRole(c.get('role'))) return c.json({ error: 'admin required' }, 403);
    const existing = await ownedGroup(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    await db.delete(memberGroups).where(eq(memberGroups.id, existing.id));
    // rules referencing the group keep its id harmlessly — groupsForRules
    // resolves only live rows, so a deleted roster simply stops contributing.
    return c.json({ ok: true });
  });

  return app;
}
