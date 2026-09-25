import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAgents, useMe } from '../api/hooks';
import type { Channel } from '@janis/shared';
import { ChannelCard } from './Integrations';

/** Standalone editor for one channel — loads just that channel plus the agent
 *  list, skipping the Meta session/status queries that make the full
 *  Channels page shuffle while editing. */
export default function ChannelEdit() {
  const { channelId } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => api<{ channel: Channel }>(`/api/channels/${channelId}`),
  });
  const { data: agents } = useAgents();
  const { data: me } = useMe();
  // Entry points pass { from, label } so the back link returns where the
  // operator came from (agent Channels tab vs. the full list).
  const back = (useLocation().state as { from?: string; label?: string } | null) ?? {};
  const backTo = back.from ?? '/integrations';
  const backLabel = back.label ?? 'All channels';

  if (isLoading || !agents || !me) return <div className="muted">Loading…</div>;
  if (me.user.role !== 'admin') {
    return (
      <>
        <Link to={backTo} className="muted">← {backLabel}</Link>
        <div className="muted" style={{ marginTop: 12 }}>
          Channels are managed by workspace admins.
        </div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <Link to={backTo} className="muted">← {backLabel}</Link>
        <div className="error" style={{ marginTop: 12 }}>Channel not found.</div>
      </>
    );
  }
  return (
    <>
      <Link to={backTo} className="muted">← {backLabel}</Link>
      <div style={{ marginTop: 12, maxWidth: 640 }}>
        <ChannelCard ch={data.channel} agents={agents.agents} deletedTo={backTo} standalone />
      </div>
    </>
  );
}
