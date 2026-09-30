import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaignSends, suppressions } from '../db/schema.js';

/** Workspace send policy — lives in workspaces.config.send_policy.
 *  Applies to marketing-class sends (campaigns, broadcasts); conversational
 *  replies only ever get opt-out checks, never caps/quiet hours. */
export interface SendPolicy {
  quiet_enabled?: boolean;
  /** 'HH:MM' 24h wall clock in quiet_tz — window may wrap midnight. */
  quiet_from?: string;
  quiet_to?: string;
  /** IANA zone for the quiet-hours window (workspace-level for now —
 *  per-recipient timezone lands with contact TZ capture). */
  quiet_tz?: string;
  /** Max marketing sends to one address in a rolling 24h. 0/undef = no cap. */
  max_per_recipient_per_day?: number;
}

export function policyFor(config: unknown): SendPolicy {
  const p = (config as { send_policy?: SendPolicy } | null)?.send_policy;
  return p && typeof p === 'object' ? p : {};
}

export function normalizeAddress(addr: string): string {
  const a = addr.trim().toLowerCase();
  // Email stays verbatim; phone-ish addresses normalize to +digits so
  // '(415) 555-0100' and '+14155550100' hit the same suppression row.
  return a.includes('@') ? a : a.replace(/[^\d+]/g, '');
}

function minutesOfDay(now: Date, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null; // bad tz — fail open rather than block all sends
  }
}

function toMinutes(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < 24 * 60 ? v : null;
}

/** When quiet hours are active, the wall-clock time the window ends —
 *  sends defer to then rather than dropping. Null when not quiet. */
export function quietHoursDeferUntil(policy: SendPolicy, now = new Date()): Date | null {
  if (!policy.quiet_enabled) return null;
  const from = toMinutes(policy.quiet_from);
  const to = toMinutes(policy.quiet_to);
  if (from === null || to === null || from === to) return null;
  const nowMin = minutesOfDay(now, policy.quiet_tz || 'UTC');
  if (nowMin === null) return null;
  const inWindow = from < to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to;
  if (!inWindow) return null;
  // DST drift within a window shifts this by ≤1h — acceptable, documented.
  const untilEnd = (to - nowMin + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + untilEnd * 60_000);
}

export type PolicyDecision =
  | { ok: true }
  | { ok: false; skip: 'suppressed' | 'frequency_cap' }
  | { ok: false; deferUntil: Date };

/** Central gate for bulk outbound — called inside the send job immediately
 *  before dispatch, so late-arriving suppressions and cancellations still
 *  catch queued sends. Order: suppression (never) → frequency cap (never
 *  today) → quiet hours (defer). */
export async function checkSendPolicy(
  db: Db,
  args: { workspaceId: string; channelKind: string; recipient: string; policy: SendPolicy },
): Promise<PolicyDecision> {
  const { workspaceId, channelKind, recipient, policy } = args;
  const address = normalizeAddress(recipient);
  const addrClass = address.includes('@') ? 'email' : 'phone';
  const channelClass = channelKind === 'sms' || channelKind === 'whatsapp' ? 'phone' : 'email';

  const sup = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.workspaceId, workspaceId),
        eq(suppressions.address, address),
        sql`${suppressions.kind} in ('all', ${addrClass}, ${channelClass})`,
      ),
    )
    .limit(1);
  if (sup.length) return { ok: false, skip: 'suppressed' };

  const cap = policy.max_per_recipient_per_day ?? 0;
  if (cap > 0) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(
        and(
          eq(campaignSends.workspaceId, workspaceId),
          eq(campaignSends.recipient, recipient),
          eq(campaignSends.status, 'sent'),
          gt(campaignSends.sentAt, since),
        ),
      );
    if ((row?.n ?? 0) >= cap) return { ok: false, skip: 'frequency_cap' };
  }

  const defer = quietHoursDeferUntil(policy);
  if (defer) return { ok: false, deferUntil: defer };
  return { ok: true };
}
