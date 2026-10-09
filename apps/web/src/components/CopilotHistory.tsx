import { useEffect, useRef, useState } from 'react';
import { Check, History } from 'lucide-react';
import { api } from '../api/client';
import { timeAgo } from './bits';

interface CopilotThreadRow {
  /** Thread key for ?thread= — null marks the default shared thread. */
  thread: string | null;
  conversation_id: string;
  state: string;
  preview: string | null;
  at: string | null;
}

/** Previous copilot chats on the support channel — picking one re-keys the
 *  Ask Janis rail to that thread. Mirrors TestChatHistory's dropdown; the
 *  listing comes from /chat/:token/threads (session-bound, own threads only). */
export function CopilotHistory({
  channelId,
  currentThread,
  onPick,
}: {
  channelId: string;
  /** Active thread key — undefined = the default shared thread. */
  currentThread?: string;
  onPick: (thread: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<CopilotThreadRow[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api<{ threads: CopilotThreadRow[] }>(`/chat/${channelId}/threads`)
      .then((d) => setThreads(d.threads))
      .catch(() => setThreads([]));
  }, [open, channelId]);

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
        title="Load a previous copilot chat"
        onClick={() => setOpen((v) => !v)}
      >
        <History size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
        History
      </button>
      {open && (
        <div className="test-chat-history">
          {threads === null && <div className="muted">Loading…</div>}
          {threads?.length === 0 && <div className="muted">No chats yet</div>}
          {threads?.map((t) => {
            const isCurrent = t.thread === (currentThread ?? null);
            return (
              <button
                key={t.conversation_id}
                className="test-chat-history-row"
                disabled={isCurrent}
                onClick={() => {
                  setOpen(false);
                  onPick(t.thread);
                }}
              >
                <span className="grow" style={{ textAlign: 'left' }}>
                  {t.preview ?? 'empty chat'}
                </span>
                <span className="muted" style={{ flex: 'none' }}>
                  {t.at ? timeAgo(t.at) : ''}
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
