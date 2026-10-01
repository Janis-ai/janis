// Poll-reconcile + render-order logic for the chat rail, lifted out of
// AskJanis so the ordering invariants are unit-testable.

export interface Attachment {
  name: string;
  url: string;
  type: string;
  size: number;
}

import type { ChatWidget } from '../components/ChatWidgets';

export interface ChatMsg {
  id: string;
  direction: string;
  text: string;
  created_at: string;
  /** Agent-emitted interactive components (cards, pickers, forms…) —
   *  rendered by <Widgets> in the rail, mirroring widget.js. */
  widgets?: ChatWidget[];
  /** Sender's own idempotency key, echoed back on inbound rows — exact
   *  outbox reconciliation even when identical text was sent twice. */
  client_id?: string;
  attachments?: Attachment[];
  quick_replies?: (string | { type: 'email' | 'phone' })[];
  author?: { name: string; avatar: string | null };
  action?: {
    id: string;
    tool: string;
    /** Card title — concierge actions set a friendly label ("Teach X");
     *  webhook approvals fall back to the tool name. */
    label?: string;
    args: Record<string, unknown>;
    /** Human-readable args for the card body — exec args may carry ids. */
    display?: Record<string, unknown>;
    status: string;
    decided_by?: string;
    result?: string;
  };
}

export interface OutEntry {
  localId: string;
  text: string;
  attachments: Attachment[];
  status: 'pending' | 'failed' | 'delivered' | 'sent';
  ts: string;
}

export interface ReconcileResult {
  outbox: OutEntry[];
  fresh: ChatMsg[];
  maxTs: string | null;
  minTs: string | null;
}

/**
 * Merge one polled batch into the outbox + transcript window.
 *
 * An inbound echo that matches a pending outbox entry promotes it to
 * 'delivered' and adopts the row's server timestamp — the optimistic entry's
 * client send-time precedes rows the server inserts first (like the
 * conversation greeting), and sorting by it would render the visitor's
 * message above the greeting.
 */
export function reconcilePoll(
  outbox: OutEntry[],
  batch: ChatMsg[],
  seen: Set<string>,
): ReconcileResult {
  const next = [...outbox];
  const fresh: ChatMsg[] = [];
  let maxTs: string | null = null;
  let minTs: string | null = null;
  for (const m of batch) {
    if (m.direction === 'in') {
      // Exact match on the sender's idempotency key first — text matching
      // misfires when the same text is sent twice in a row. A 'failed'
      // entry still matches: the write may have landed even though the
      // response was lost, and the echo promotes it back to delivered.
      const matchable = (o: OutEntry) => o.status === 'pending' || o.status === 'failed';
      const byKey = m.client_id
        ? next.findIndex((o) => matchable(o) && o.localId === m.client_id)
        : -1;
      const i =
        byKey >= 0
          ? byKey
          : next.findIndex(
              (o) =>
                matchable(o) &&
                (o.text === m.text ||
                  (o.attachments.length > 0 && (m.attachments ?? []).length > 0)),
            );
      if (i >= 0) {
        // one receipt at a time — demote any prior 'delivered' to 'sent'
        for (let j = 0; j < next.length; j++) {
          if (next[j].status === 'delivered') next[j] = { ...next[j], status: 'sent' };
        }
        next[i] = { ...next[i], status: 'delivered', ts: m.created_at };
        if (m.id) seen.add(m.id);
        if (!maxTs || m.created_at > maxTs) maxTs = m.created_at;
        continue;
      }
    }
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    fresh.push(m);
    if (!maxTs || m.created_at > maxTs) maxTs = m.created_at;
    if (!minTs || m.created_at < minTs) minTs = m.created_at;
  }
  return { outbox: next, fresh, maxTs, minTs };
}

export type TimelineItem =
  | { key: string; ts: string; kind: 'msg'; m: ChatMsg }
  | { key: string; ts: string; kind: 'out'; o: OutEntry };

export function timelineItems(msgs: ChatMsg[], outbox: OutEntry[]): TimelineItem[] {
  return [
    ...msgs.map((m) => ({ key: m.id, ts: m.created_at, kind: 'msg' as const, m })),
    ...outbox.map((o) => ({ key: o.localId, ts: o.ts, kind: 'out' as const, o })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
