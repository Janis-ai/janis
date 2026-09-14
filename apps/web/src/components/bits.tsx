import type { ConversationState } from '@janis/shared';

export function StateBadge({ state }: { state: ConversationState }) {
  const label = { active: 'Agent', needs_human: 'Needs human', human: 'Human', archived: 'Archived' }[state];
  return <span className={`badge ${state}`}>{label}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>{children}</div>;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
