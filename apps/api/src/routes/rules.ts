import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentRoleFor, agentScopeCond } from '../lib/access.js';
import { toAlertRule } from '../lib/serializers.js';

const ruleConfig = z.object({
  keywords: z.array(z.string()).optional(),
  inactivity_minutes: z.number().min(1).max(1440).optional(),
  enabled: z.boolean().default(true),
});

const createRule = z.object({
  agent_id: z.string().uuid(),
  kind: z.enum(['keyword', 'failure', 'handoff_request', 'inactivity', 'custom_alert']),
  config: ruleConfig,
});

const updateRule = z.object({ config: ruleConfig });

async function ownsAgent(db: Db, workspaceId: string, agentId: string) {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(row);
}

async function ruleAgentId(db: Db, workspaceId: string, ruleId: string) {
  const [row] = await db
    .select({ agentId: alertRules.agentId })
    .from(alertRules)
    .innerJoin(agents, eq(alertRules.agentId, agents.id))
    .where(and(eq(alertRules.id, ruleId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return row?.agentId ?? null;
}

export function ruleRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const scope = agentScopeCond(c.get('agentScope'));
    const rows = await db
      .select({ rule: alertRules })
      .from(alertRules)
      .innerJoin(agents, eq(alertRules.agentId, agents.id))
      .where(and(eq(agents.workspaceId, c.get('workspaceId')), ...(scope ? [scope] : [])));
    return c.json({ rules: rows.map((r) => toAlertRule(r.rule)) });
  });

  // Rule creation is gated on the TARGET agent's role, which lives in the
  // body — read it raw so the 403 lands before validation's 400.
  const createGate = createMiddleware<SessionEnv>(async (c, next) => {
    const agentId = (
      (await c.req.json().catch(() => ({}))) as { agent_id?: string }
    ).agent_id;
    const role = agentId
      ? await agentRoleFor(
          db, c.get('user').id, c.get('role'), c.get('agentScope'), agentId,
          c.get('workspaceId'),
        )
      : c.get('role'); // no target agent: only workspace admins get to the 400
    if (role !== 'admin') return c.json({ error: 'admin required' }, 403);
    await next();
  });

  app.post('/', createGate, zValidator('json', createRule), async (c) => {
    const body = c.req.valid('json');
    if (!(await ownsAgent(db, c.get('workspaceId'), body.agent_id))) {
      return c.json({ error: 'agent not found' }, 404);
    }
    const [row] = await db
      .insert(alertRules)
      .values({ agentId: body.agent_id, kind: body.kind, config: body.config })
      .returning();
    return c.json({ rule: toAlertRule(row) }, 201);
  });

  app.patch('/:id', zValidator('json', updateRule), async (c) => {
    const agentId = await ruleAgentId(db, c.get('workspaceId'), c.req.param('id'));
    if (!agentId) return c.json({ error: 'not found' }, 404);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), agentId, c.get('workspaceId'),
    );
    if (role !== 'admin') return c.json({ error: 'admin required' }, 403);
    const [row] = await db
      .update(alertRules)
      .set({ config: c.req.valid('json').config })
      .where(eq(alertRules.id, c.req.param('id')))
      .returning();
    return c.json({ rule: toAlertRule(row) });
  });

  app.delete('/:id', async (c) => {
    const agentId = await ruleAgentId(db, c.get('workspaceId'), c.req.param('id'));
    if (!agentId) return c.json({ error: 'not found' }, 404);
    const role = await agentRoleFor(
      db, c.get('user').id, c.get('role'), c.get('agentScope'), agentId, c.get('workspaceId'),
    );
    if (role !== 'admin') return c.json({ error: 'admin required' }, 403);
    await db.delete(alertRules).where(eq(alertRules.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  return app;
}
