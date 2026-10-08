import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, agents, memberGroups, memberships } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentRoleFor, isAdminRole } from '../lib/access.js';
import { toMemberGroup } from '../lib/serializers.js';

const groupBody = z.object({
  name: z.string().min(1).max(80),
  member_ids: z.array(z.string().uuid()).max(200),
  /** null/absent = workspace-wide; set = scoped to one agent's rules. */
  agent_id: z.string().uuid().nullable().optional(),
});

async function ownedGroup(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(memberGroups)
    .where(and(eq(memberGroups.id, id), eq(memberGroups.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

async function ownsAgent(db: Db, workspaceId: string, agentId: string) {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(row);
}

/** Workspace admins manage any group; otherwise only an agent's admins can
 *  touch rosters scoped to that agent. */
async function canManage(db: Db, c: Context<SessionEnv>, agentId: string | null) {
  if (isAdminRole(c.get('role'))) return true;
  if (!agentId) return false;
  const role = await agentRoleFor(
    db, c.get('user').id, c.get('role'), c.get('agentScope'), agentId,
    c.get('workspaceId'),
  );
  return isAdminRole(role);
}

/** Valid roster members — workspace members always; agent-scoped groups can
 *  also carry that agent's accepted agent-only members (the client-VA case).
 *  Drops ids that don't resolve so a stale roster can't carry ghosts. */
async function existingMemberIds(
  db: Db,
  workspaceId: string,
  ids: string[],
  agentId?: string | null,
) {
  if (!ids.length) return [] as string[];
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, ids)),
    );
  const valid = new Set(rows.map((r) => r.userId));
  if (agentId) {
    const extra = await db
      .select({ userId: agentMembers.userId })
      .from(agentMembers)
      .where(
        and(
          eq(agentMembers.agentId, agentId),
          isNotNull(agentMembers.acceptedAt),
          inArray(agentMembers.userId, ids),
        ),
      );
    for (const r of extra) valid.add(r.userId);
  }
  return [...new Set(ids.filter((id) => valid.has(id)))];
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
    const body = c.req.valid('json');
    const agentId = body.agent_id ?? null;
    if (agentId && !(await ownsAgent(db, c.get('workspaceId'), agentId))) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!(await canManage(db, c, agentId))) {
      return c.json({ error: 'admin required' }, 403);
    }
    const memberIds = await existingMemberIds(
      db, c.get('workspaceId'), body.member_ids, agentId,
    );
    const [row] = await db
      .insert(memberGroups)
      .values({ workspaceId: c.get('workspaceId'), agentId, name: body.name, memberIds })
      .returning();
    return c.json({ group: toMemberGroup(row) }, 201);
  });

  app.patch('/:id', zValidator('json', groupBody.partial()), async (c) => {
    const existing = await ownedGroup(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (!(await canManage(db, c, existing.agentId))) {
      return c.json({ error: 'admin required' }, 403);
    }
    const body = c.req.valid('json');
    // Scope is fixed at creation — a PATCH carrying a different agent_id is
    // an error, not a silent no-op.
    if (body.agent_id !== undefined && body.agent_id !== existing.agentId) {
      return c.json({ error: 'group scope is fixed' }, 400);
    }
    const memberIds =
      body.member_ids !== undefined
        ? await existingMemberIds(db, c.get('workspaceId'), body.member_ids, existing.agentId)
        : existing.memberIds;
    const [row] = await db
      .update(memberGroups)
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), memberIds })
      .where(eq(memberGroups.id, existing.id))
      .returning();
    return c.json({ group: toMemberGroup(row) });
  });

  app.delete('/:id', async (c) => {
    const existing = await ownedGroup(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (!(await canManage(db, c, existing.agentId))) {
      return c.json({ error: 'admin required' }, 403);
    }
    await db.delete(memberGroups).where(eq(memberGroups.id, existing.id));
    // rules referencing the group keep its id harmlessly — groupsForRules
    // resolves only live rows, so a deleted roster simply stops contributing.
    return c.json({ ok: true });
  });

  return app;
}
