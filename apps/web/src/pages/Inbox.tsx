import { Link } from 'react-router-dom';
import { useConversations } from '../api/hooks';
import { Empty, StateBadge, timeAgo } from '../components/bits';

/** Live inbox: conversations needing a human or currently human-handled. */
export default function Inbox() {
  const { data, isLoading } = useConversations({ attention: true });

  return (
    <>
      <h1 className="page-title">Inbox</h1>
      {isLoading && <div className="muted">Loading…</div>}
      {data && data.conversations.length === 0 && (
        <Empty>No conversations need attention. When an agent fails or asks for help, it lands here.</Empty>
      )}
      {data?.conversations.map((c) => (
        <Link key={c.id} to={`/conversations/${c.id}`} className="conv-row">
          {c.open_alert_count > 0 && <span className="alert-dot" />}
          {c.is_unread && <span className="unread-dot" title="Unread" />}
          <div className="who">
            <div className={`name ${c.is_unread ? 'unread' : ''}`}>
              {c.is_starred && '⭐ '}
              {(c.user_profile.name as string) ?? c.external_id}
            </div>
            <div className="preview">{c.last_message_preview}</div>
          </div>
          <StateBadge state={c.state} />
          <div className="meta">{timeAgo(c.last_message_at)}</div>
        </Link>
      ))}
    </>
  );
}
