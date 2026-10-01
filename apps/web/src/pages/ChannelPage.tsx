import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAgents, useChannel } from '../api/hooks';
import { ChannelCard, KIND_LABEL } from '../components/Channels';
import { usePageTitle } from '../lib/title';
import { friendlyError } from '../lib/friendlyError';

/** One connected channel's settings page — the full editor (embed, appearance,
 *  credentials, per-kind config) lives here instead of inline on the Channels
 *  index, so OAuth callbacks and deep links land on a stable URL. */
export default function ChannelPage() {
  const { id: agentId, channelId } = useParams<{ id: string; channelId: string }>();
  const { data, isLoading } = useChannel(channelId);
  const { data: agentsData } = useAgents();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  // Cloudflare OAuth lands back here with ?cf_connect= / ?cf_error= —
  // refetch the channel so new creds (e.g. pushed DNS records) render.
  const cfConnected = params.get('cf_connect') ?? '';
  const cfError = params.get('cf_error') ?? '';
  useEffect(() => {
    if (!cfConnected && !cfError) return;
    void qc.invalidateQueries({ queryKey: ['channel', channelId] });
    void qc.invalidateQueries({ queryKey: ['channels'] });
  }, [cfConnected, cfError]); // eslint-disable-line react-hooks/exhaustive-deps
  const dropCfParams = () => {
    const next = new URLSearchParams(params);
    next.delete('cf_connect');
    next.delete('cf_error');
    setParams(next, { replace: true });
  };
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
      {cfConnected && (
        <div className="muted" style={{ margin: '8px 0', fontSize: 13 }}>
          Connected <strong>{cfConnected}</strong>{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); dropCfParams(); }}>dismiss</a>
        </div>
      )}
      {cfError && (
        <div className="error" style={{ margin: '8px 0' }}>
          Cloudflare setup failed: {friendlyError(cfError).text}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); dropCfParams(); }} className="muted">dismiss</a>
        </div>
      )}
      <ChannelCard key={ch.id} ch={ch} agents={agents} />
    </>
  );
}
