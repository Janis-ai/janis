import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { typingBus, presenceBus } from './typingBus';

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
    // Eval suite runs (scheduled/manual) — refresh the tests tab's data.
    source.addEventListener('eval', () => {
      void qc.invalidateQueries({ queryKey: ['agent-tests'] });
      void qc.invalidateQueries({ queryKey: ['agent-test-runs'] });
    });
    // Agent config changed out-of-band (concierge teach_agent/create_agent/
    // apply_routing_rule) — refresh open agent pages so the KB, gap and
    // Escalation-rule views aren't stale.
    source.addEventListener('agent', () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      // channel rows embed agent_name — renames must reach them too
      // (the list key AND the single-channel ['channel', id] key)
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel'] });
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      void qc.invalidateQueries({ queryKey: ['knowledge-gaps'] });
      void qc.invalidateQueries({ queryKey: ['rules'] });
      // bootstrap config embeds agent_name/greeting/quick_replies — stale
      // in an open Ask Janis rail after update_agent
      void qc.invalidateQueries({ queryKey: ['ask-janis-config'] });
    });
    // Workspace plan changed (checkout, webhook sync, concierge change_plan)
    // — plan-gated UI (Settings, custom help domain, usage page) refreshes.
    source.addEventListener('workspace', () => {
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['billing-status'] });
    });
    // Visitor typing — ephemeral; routed to the open chat, never a refetch.
    source.addEventListener('typing', (e) => {
      try {
        typingBus.publish(JSON.parse((e as MessageEvent).data));
      } catch {
        // malformed payload — ignore
      }
    });
    // Co-presence — who's viewing each conversation right now.
    source.addEventListener('presence', (e) => {
      try {
        presenceBus.publish(JSON.parse((e as MessageEvent).data));
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
