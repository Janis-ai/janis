import { useState } from 'react';
import type { Conversation, ConversationState, UserProfile } from '@janis/shared';
import { friendlyName } from '@janis/shared';

export function StateBadge({ state }: { state: ConversationState }) {
  const label = { active: 'Agent', needs_human: 'Needs human', human: 'Human', archived: 'Archived' }[state];
  return <span className={`badge ${state}`}>{label}</span>;
}

/** Display name for a conversation: real name → @handle → email → external id. */
export function displayName(c: Pick<Conversation, 'external_id' | 'user_profile'>): string {
  const p = (c.user_profile ?? {}) as UserProfile;
  if (p.name) return p.name;
  if (p.username) return `@${p.username}`;
  if (p.email) return p.email;
  // anonymous visitors have no profile — show a short stable handle
  // ("Calm Otter a48f") instead of the raw `webchat:<uuid>` external id
  return friendlyName(c.external_id);
}

const CHANNEL_LABELS: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
};

export function channelLabel(kind?: string): string {
  if (!kind) return '';
  return CHANNEL_LABELS[kind] ?? kind;
}

/** Profile picture via the API proxy, falling back to an initial. */
export function Avatar({
  c,
  size = 32,
}: {
  c: Pick<Conversation, 'id' | 'has_avatar' | 'external_id' | 'user_profile'>;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (c.has_avatar && !failed) {
    return (
      <img
        className="avatar"
        style={{ width: size, height: size }}
        src={`/api/conversations/${c.id}/avatar`}
        onError={() => setFailed(true)}
        alt=""
      />
    );
  }
  return (
    <span
      className="avatar fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {displayName(c)[0]?.toUpperCase() ?? '?'}
    </span>
  );
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
