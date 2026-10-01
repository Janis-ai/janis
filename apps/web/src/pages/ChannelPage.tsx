import { Link, useParams } from 'react-router-dom';
import { useAgents, useChannel } from '../api/hooks';
import { ChannelCard, KIND_LABEL } from '../components/Channels';
import { usePageTitle } from '../lib/title';

/** One connected channel's settings page — the full editor (embed, appearance,
 *  credentials, per-kind config) lives here instead of inline on the Channels
 *  index, so OAuth callbacks and deep links land on a stable URL. */
export default function ChannelPage() {
  const { id: agentId, channelId } = useParams<{ id: string; channelId: string }>();
  const { data, isLoading } = useChannel(channelId);
  const { data: agentsData } = useAgents();
  const agents = agentsData?.agents ?? [];
  const ch = data?.channel;
  const agent = agents.find((a) => a.id === ch?.agent_id) ?? agents.find((a) => a.id === agentId);
  usePageTitle(ch ? ch.name : 'Channel');

  if (isLoading) return <div className="muted" style={{ marginTop: 12 }}>Loading…</div>;
  if (!ch) {
    return (
      <>
        <h1 className="page-title">Channel not found</h1>
        <Link to={agent ? `/agents/${agent.id}?tab=channels` : '/agents'} className="muted">
          ← Back to channels
        </Link>
      </>
    );
  }
  return (
    <>
      <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
        <Link to={agent ? `/agents/${agent.id}?tab=channels` : '/agents'}>
          ← {agent?.name ?? 'Agent'} · Channels
        </Link>
      </div>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 className="page-title grow" style={{ margin: 0 }}>{ch.name}</h1>
        <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
      </div>
      <ChannelCard ch={ch} agents={agents} />
    </>
  );
}
