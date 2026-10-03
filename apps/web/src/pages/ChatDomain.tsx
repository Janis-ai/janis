import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { HelpDomain } from './HelpCenter';
import { usePageTitle } from '../lib/title';

/** Custom Bubble domain — a webchat channel that claimed chat.acme.com gets
 *  the hosted chat surface for that channel: the same full-page messenger
 *  /chat/:token/page?mode=full serves. A host with no claim falls through
 *  to the help-centre domain resolution. */
export function ChatDomain() {
  const [data, setData] = useState<{ token: string; agent_name: string } | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    api<{ token: string; agent_name: string }>(
      `/chat/by-domain?host=${encodeURIComponent(window.location.hostname)}`,
    )
      .then(setData)
      .catch(() => setMiss(true));
  }, []);

  usePageTitle(data ? `${data.agent_name} — Chat` : null);

  if (miss) return <HelpDomain />;
  if (!data) return <div className="login-wrap muted">Loading…</div>;
  return (
    <iframe
      src={`/chat/${data.token}/page?mode=full`}
      title="Chat"
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0, background: '#fff' }}
    />
  );
}
