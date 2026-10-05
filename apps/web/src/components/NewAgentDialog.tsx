import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

/** Shared "new agent" dialog — the Agents-page button and the workspace
 *  switcher's "+ Add agent" both use it. Returns [element, open]: open()
 *  shows the dialog; on confirm it POSTs /api/agents, refreshes the agents
 *  list, and lands on the new agent's Channels setup. */
export function useNewAgentDialog(): [ReactNode, () => void] {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [hosted, setHosted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (open) inputRef.current?.select();
  }, [open]);

  const show = useCallback(() => {
    setName('');
    setHosted(true);
    setError('');
    setBusy(false);
    setOpen(true);
  }, []);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const r = await api<{ agent: { id: string } }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: n, hosted }),
      });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setOpen(false);
      navigate(`/agents/${r.agent.id}/channels`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
      setBusy(false);
    }
  };

  const el = open ? (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-agent-msg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <div className="modal-msg" id="new-agent-msg">Name the new agent:</div>
        <input
          ref={inputRef}
          className="input"
          style={{ width: '100%', marginTop: 10 }}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <label className="check-label" style={{ marginTop: 10, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={hosted}
            onChange={(e) => setHosted(e.target.checked)}
          />
          <span>Hosted by Janis</span>
        </label>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {hosted
            ? 'Janis writes the replies — knowledge, tests, and tools included.'
            : 'External webhook — your own backend answers inbound events.'}
        </div>
        {error && (
          <div className="error" style={{ marginTop: 8 }}>{error}</div>
        )}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button
            className="btn primary"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [el, show];
}
