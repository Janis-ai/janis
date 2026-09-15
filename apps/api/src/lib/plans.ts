import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
import { currentPeriod } from './billing.js';

export interface Plan {
  name: string;
  // monthly sell price (USD cents) — includes `includedMessages`
  baseCents: number;
  includedMessages: number;
  // sell price per 1k messages beyond the included amount.
  // null = hard cap (free tier): agent stops answering, inbox still works
  overagePer1kCents: number | null;
}

export const PLANS: Record<string, Plan> = {
  free: { name: 'Free', baseCents: 0, includedMessages: 250, overagePer1kCents: null },
  starter: { name: 'Starter', baseCents: 2900, includedMessages: 2_000, overagePer1kCents: 800 },
  pro: { name: 'Pro', baseCents: 9900, includedMessages: 20_000, overagePer1kCents: 500 },
  scale: { name: 'Scale', baseCents: 29900, includedMessages: 100_000, overagePer1kCents: 300 },
};

export function planFor(key: string | null | undefined): Plan {
  return PLANS[key ?? ''] ?? PLANS.free;
}

/** Every stored message counts — user in, agent out, human replies. */
export async function messagesInPeriod(
  db: Db,
  workspaceId: string,
  period = currentPeriod(),
): Promise<number> {
  const start = new Date(`${period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        gte(messages.createdAt, start),
        lt(messages.createdAt, end),
      ),
    );
  return row.count;
}

export interface CapStatus {
  plan: Plan;
  used: number;
  capped: boolean; // hard-capped plan over its included amount
}

/** Hard cap check — only hard-cap plans (free) ever return capped. */
export async function messageCap(db: Db, workspaceId: string): Promise<CapStatus> {
  const [ws] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const plan = planFor(ws?.plan);
  const used = await messagesInPeriod(db, workspaceId);
  return { plan, used, capped: plan.overagePer1kCents === null && used >= plan.includedMessages };
}
