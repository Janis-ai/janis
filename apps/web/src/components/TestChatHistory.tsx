import { useEffect, useRef, useState } from 'react';
import { Check, History } from 'lucide-react';
import { api } from '../api/client';
import { timeAgo } from './bits';
import { consoleVisitorId } from './AskJanis';
import { rawVisitor, testConvVisitor } from '../lib/testChat';

interface TestConv {
  id: string;
  external_id: string;
  is_test?: boolean;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
}

/** Previous test conversations on this channel — picking one re-keys the
 *  chat to that visitor's thread. Test convs are externalId-keyed
 *  (…:test:<channelId>:<cust_visitor>), so the visitor is recoverable
 *  from the listing without a new endpoint. */
export function TestChatHistory({
  agentId,
  channelId,
  currentVisitor,
  onPick,
}: {
  agentId: string;
  channelId: string;
  /** Raw visitor id the chat is keyed to — undefined = the base console
   *  visitor's thread. */
  currentVisitor?: string;
  /** Called with the raw visitor id to switch to. */
  onPick: (visitor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [convs, setConvs] = useState<TestConv[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const currentExt = `cust_${currentVisitor ?? consoleVisitorId()}`;

  useEffect(() => {
    if (!open) return;
    api<{ conversations: TestConv[] }>(
      `/api/conversations?agent_id=${agentId}&limit=50`,
    )
      .then((d) =>
        setConvs(
          d.conversations.filter(
            (c) =>
              c.is_test && c.external_id.split(':')[2] === channelId,
          ),
        ),
      )
      .catch(() => setConvs([]));
  }, [open, agentId, channelId]);

  // Click-away — a dock dropdown shouldn't pin open behind navigation.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        className="link small"
        title="Load a previous test conversation"
        onClick={() => setOpen((v) => !v)}
      >
        <History size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
        History
      </button>
      {open && (
        <div className="test-chat-history">
          {convs === null && <div className="muted">Loading…</div>}
          {convs?.length === 0 && (
            <div className="muted">No test conversations yet</div>
          )}
          {convs?.map((c) => {
            const visitor = testConvVisitor(c.external_id);
            if (!visitor) return null;
            const isCurrent = visitor === currentExt;
            return (
              <button
                key={c.id}
                className="test-chat-history-row"
                disabled={isCurrent}
                onClick={() => {
                  setOpen(false);
                  onPick(rawVisitor(visitor));
                }}
              >
                <span className="grow" style={{ textAlign: 'left' }}>
                  {c.last_message_preview ?? 'empty chat'}
                </span>
                <span className="muted" style={{ flex: 'none' }}>
                  {timeAgo(c.last_message_at ?? c.created_at)}
                </span>
                {isCurrent && <Check size={12} style={{ flex: 'none' }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
