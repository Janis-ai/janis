import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface StreamAlert {
  id: string;
  conversation_id: string;
  type: string;
  detail: string | null;
  status: string;
  created_at: string;
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
