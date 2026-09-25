import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { typingBus } from './typingBus';

export interface StreamAlert {
  id: string;
  conversation_id: string;
  type: string;
  detail: string | null;
  status: string;
  created_at: string;
  /** Alert went out before its notification payload was ready (handoff
   * brief still generating) — the enriched republish carries the toast. */
  pending?: boolean;
  /** The same payload push/email send — the toast renders it verbatim. */
  notification?: { title: string; body: string; url?: string };
}

/**
 * Subscribe to the workspace SSE stream; invalidate queries on each event.
 * EventSource is same-origin (Vite proxy in dev), so the session cookie flows.
 * `onAlert` fires for every alert event (used by the in-app toast).
 */
export function useStream(enabled: boolean, onAlert?: (alert: StreamAlert) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/stream');
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['attention-count'] });
    };
    source.addEventListener('message', refresh);
    source.addEventListener('conversation', refresh);
    source.addEventListener('suggestion', refresh);
    // Visitor typing — ephemeral; routed to the open chat, never a refetch.
    source.addEventListener('typing', (e) => {
      try {
        typingBus.publish(JSON.parse((e as MessageEvent).data));
      } catch {
        // malformed payload — ignore
      }
    });
    source.addEventListener('alert', (e) => {
      refresh();
      if (onAlert) {
        try {
          onAlert(JSON.parse((e as MessageEvent).data) as StreamAlert);
        } catch {
          // malformed payload — skip the toast, refresh already ran
        }
      }
    });
    return () => source.close();
  }, [enabled, qc, onAlert]);
}
