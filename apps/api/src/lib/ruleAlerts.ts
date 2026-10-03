import { and, eq, inArray } from 'drizzle-orm';
import type { AlertType } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, alertRules, conversations, memberGroups } from '../db/schema.js';
import { bus } from './bus.js';
import { openAlertOnce } from './alerts.js';
import { alertNotification, eventForAlertType, notifyWorkspace } from './notify.js';
import { postSlackAlert } from './slack.js';
import { toAlert } from './serializers.js';
import { pickRuleAssignee, type GroupRef, type RuleConfig, type RuleRow } from './rules.js';

type AgentRow = typeof agents.$inferSelect;
type ConvRow = typeof conversations.$inferSelect;

/** Fetch the member_groups rows a rule set references — one query for the
 *  union of group_ids, scoped to the agent's workspace. */
export async function groupsForRules(
  db: Db,
  workspaceId: string,
  rules: RuleRow[],
): Promise<GroupRef[]> {
  const ids = [
    ...new Set(rules.flatMap((r) => (r.config as RuleConfig).group_ids ?? [])),
  ];
  if (!ids.length) return [];
  return db
    .select()
    .from(memberGroups)
    .where(and(eq(memberGroups.workspaceId, workspaceId), inArray(memberGroups.id, ids)));
}

/**
 * Resolve the routing a fired rule set carries — first rule with an
 * assignable target wins (fixed owner beats pool rotation), every rule's
 * tag merges. Rotation cursors persist back onto their rule configs so
 * the next fire picks the following member.
 */
export async function resolveRuleRouting(
  db: Db,
  workspaceId: string,
  rules: RuleRow[],
): Promise<{ assigneeId?: string; tags: string[] }> {
  const groups = await groupsForRules(db, workspaceId, rules);
  let assigneeId: string | undefined;
  const tags: string[] = [];
  for (const rule of rules) {
    const cfg = rule.config as RuleConfig;
    if (cfg.tag) tags.push(cfg.tag);
    if (assigneeId) continue;
    const pick = pickRuleAssignee(rule, groups);
    if (!pick) continue;
    assigneeId = pick.userId;
    if (pick.next !== undefined) {
      const cfg = { ...(rule.config as RuleConfig), next: pick.next };
      rule.config = cfg; // in-memory advance — repeat fires rotate forward
      await db.update(alertRules).set({ config: cfg }).where(eq(alertRules.id, rule.id));
    }
  }
  return { assigneeId, tags };
}

/**
 * Fire an alert for a triggered rule set — deduped open (one per
 * conversation/type), then the rules' routing applies to the thread
 * (non-stealing assign + tag merge) and the alert fans out to the bus,
 * Slack, and push/email. Pages the resolved assignee when there is one,
 * the whole workspace otherwise.
 */
export async function fireRuleAlert(
  db: Db,
  agent: AgentRow,
  conv: ConvRow,
  opts: { type: AlertType; detail?: string | null; rules?: RuleRow[] },
): Promise<void> {
  // Routing applies on every fire — the alert row dedupes, the rule's
  // assign/tag doesn't (a repeat fire still rotates the pool).
  const fired = opts.rules ?? [];
  const { assigneeId, tags } = fired.length
    ? await resolveRuleRouting(db, agent.workspaceId, fired)
    : { assigneeId: undefined, tags: [] as string[] };

  let updated = conv;
  const mergedTags = tags.length ? [...new Set([...conv.tags, ...tags])] : conv.tags;
  const changed = (assigneeId && !conv.assigneeId) || mergedTags.length !== conv.tags.length;
  if (changed) {
    const [row] = await db
      .update(conversations)
      .set({
        ...(assigneeId && !conv.assigneeId ? { assigneeId } : {}),
        ...(mergedTags.length !== conv.tags.length ? { tags: mergedTags } : {}),
      })
      .where(eq(conversations.id, conv.id))
      .returning();
    updated = row ?? conv;
    bus.publish(agent.workspaceId, {
      type: 'conversation',
      data: { id: conv.id, state: updated.state },
    });
  }

  const { alert, created } = await openAlertOnce(db, {
    conversationId: conv.id,
    type: opts.type,
    detail: opts.detail ?? undefined,
  });
  if (!created) return;

  const n = await alertNotification(db, alert, updated, agent);
  bus.publish(agent.workspaceId, {
    type: 'alert',
    data: { ...toAlert(alert), notification: n },
  });
  void postSlackAlert(db, agent.workspaceId, updated, agent, alert);
  void notifyWorkspace(db, agent.workspaceId, n, {
    agentId: agent.id,
    userIds: assigneeId ? [assigneeId] : undefined,
    event: eventForAlertType(alert.type),
  });
}

/**
 * The agent run itself degraded — tool failures, dropped component lines,
 * guard strips. Opt-in: only fires when the agent has enabled 'error'
 * rules; nothing pages on errors the workspace didn't ask about.
 */
export async function fireErrorAlert(
  db: Db,
  agent: AgentRow,
  convId: string,
  detail: string,
): Promise<void> {
  const rules = (
    await db.select().from(alertRules).where(eq(alertRules.agentId, agent.id))
  ).filter((r) => r.kind === 'error' && (r.config as RuleConfig).enabled !== false);
  if (!rules.length) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv) return;
  await fireRuleAlert(db, agent, conv, { type: 'error', detail, rules });
}
