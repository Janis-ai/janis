import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Subscribe to the workspace SSE stream; invalidate queries on each event.
 * EventSource is same-origin (Vite proxy in dev), so the session cookie flows.
 */
export function useStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/stream');
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    };
    source.addEventListener('message', refresh);
    source.addEventListener('conversation', refresh);
    source.addEventListener('alert', refresh);
    source.addEventListener('suggestion', refresh);
    return () => source.close();
  }, [enabled, qc]);
}
