import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentConfig } from '@janis/shared';

export interface CorrectTarget {
  agentText: string;
  customerText?: string;
}

/** "Correct this" — the operator writes what the agent should have said or
 *  done, then the fix routes: missing knowledge lands as a note or a draft
 *  article; a behavior fix becomes an instruction rule (draft→approve, same
 *  pattern as Gaps). Janis suggests the branch via POST /correction-plan;
 *  the operator can override. Used by the test surfaces (builder dock,
 *  Try it) and the inbox transcript — a bad reply anywhere is learnable. */
export function CorrectThisCard({
  agentId,
  cfg,
  target,
  onClose,
  onSaved,
}: {
  agentId: string;
  cfg: AgentConfig;
  target: CorrectTarget;
  onClose: () => void;
  /** Called with the new config after a save — the builder keeps a local
   *  draft copy to sync; other callers just get the server truth back via
   *  the agents-query invalidation. */
  onSaved?: (config: AgentConfig) => void;
}) {
  const qc = useQueryClient();
  const [correction, setCorrection] = useState('');
  const [plan, setPlan] = useState<{
    kind: 'knowledge' | 'behavior';
    instruction?: string;
    classified: boolean;
  } | null>(null);
  const [branch, setBranch] = useState<'knowledge' | 'behavior' | null>(null);
  const [instrEdit, setInstrEdit] = useState('');
  const [error, setError] = useState('');

  // A fresh target means a fresh draft — reset during render (the
  // React-blessed pattern; an effect would flash the previous reply's
  // correction for one frame).
  const targetKey = `${target.agentText}${target.customerText ?? ''}`;
  const [forTarget, setForTarget] = useState(targetKey);
  if (forTarget !== targetKey) {
    setForTarget(targetKey);
    setCorrection('');
    setPlan(null);
    setBranch(null);
    setInstrEdit('');
    setError('');
  }

  const saveCorrection = useMutation({
    mutationFn: ({ mode, text }: { mode: 'note' | 'article'; text: string }) =>
      mode === 'note'
        ? api(`/api/agents/${agentId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              config: { ...cfg, knowledge: [...(cfg.knowledge ?? []), text] },
            }),
          })
        : api('/api/articles', {
            method: 'POST',
            body: JSON.stringify({
              agent_id: agentId,
              // The customer's question is the article title — help pages
              // answer questions.
              title: (target.customerText ?? text).slice(0, 80),
              body: text,
              category: 'General',
              status: 'draft',
            }),
          }),
    onSuccess: (_r, v) => {
      const next =
        v.mode === 'note'
          ? { ...cfg, knowledge: [...(cfg.knowledge ?? []), v.text] }
          : cfg;
      onSaved?.(next);
      void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
      void qc.invalidateQueries({ queryKey: ['articles', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const correctionPlan = useMutation({
    mutationFn: () =>
      api<{ kind: 'knowledge' | 'behavior'; instruction?: string; classified: boolean }>(
        `/api/agents/${agentId}/correction-plan`,
        {
          method: 'POST',
          body: JSON.stringify({
            customerText: target.customerText,
            agentText: target.agentText,
            correction: correction.trim(),
          }),
        },
      ),
    onSuccess: (p) => {
      setPlan(p);
      setBranch(p.kind);
      setInstrEdit(p.instruction ?? '');
    },
    onError: (e) => setError(e.message),
  });

  // Behavior branch — the drafted rule lands appended to the agent's
  // instructions and is logged so Guide it can credit testing/inbox
  // corrections as the source.
  const applyInstruction = useMutation({
    mutationFn: (text: string) => {
      const config: AgentConfig = {
        ...cfg,
        system_prompt: `${(cfg.system_prompt ?? '').trim()}\n\n${text}`.trim(),
        builder: {
          ...cfg.builder,
          instruction_edits: [...(cfg.builder?.instruction_edits ?? []), text].slice(-20),
        },
      };
      return api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => config as AgentConfig);
    },
    onSuccess: (config) => {
      onSaved?.(config);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <strong style={{ fontSize: 13 }}>Correct this answer</strong>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        It said: “
        {target.agentText.length > 140
          ? `${target.agentText.slice(0, 140)}…`
          : target.agentText}
        ”
        {target.customerText
          ? ` — the customer asked “${target.customerText.slice(0, 80)}”`
          : ''}
      </div>
      {error && (
        <div className="error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <textarea
        rows={3}
        style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
        placeholder="What should it have said or done?"
        value={correction}
        autoFocus
        onChange={(e) => setCorrection(e.target.value)}
      />
      {branch === 'behavior' ? (
        <>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {plan?.classified
              ? 'Janis reads this as a behavior fix — it becomes a rule in the instructions:'
              : 'A behavior fix becomes a rule in the instructions:'}
          </div>
          <textarea
            rows={2}
            style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
            placeholder={'e.g. "When the customer defers, choose and proceed"'}
            value={instrEdit}
            onChange={(e) => setInstrEdit(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button
              className="btn sm primary"
              disabled={!instrEdit.trim() || applyInstruction.isPending}
              onClick={() => applyInstruction.mutate(instrEdit.trim())}
            >
              {applyInstruction.isPending ? 'Saving…' : 'Add to instructions'}
            </button>
            <button className="link small" onClick={() => setBranch('knowledge')}>
              it's a fact instead
            </button>
            <button className="btn sm" onClick={onClose}>
              Cancel
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            The rule is appended to the instructions — review it any time on
            Guide it.
          </div>
        </>
      ) : branch === 'knowledge' ? (
        <>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {plan?.classified
              ? 'Janis reads this as missing knowledge — where should it live?'
              : 'Where should this fix live?'}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button
              className="btn sm primary"
              disabled={saveCorrection.isPending}
              onClick={() => saveCorrection.mutate({ mode: 'note', text: correction.trim() })}
            >
              {saveCorrection.isPending ? 'Saving…' : 'Save as note'}
            </button>
            <button
              className="btn sm"
              disabled={saveCorrection.isPending}
              title="Creates an unpublished draft — review it under Teach it → Articles"
              onClick={() => saveCorrection.mutate({ mode: 'article', text: correction.trim() })}
            >
              Draft article
            </button>
            <button className="link small" onClick={() => setBranch('behavior')}>
              it's about behavior
            </button>
            <button className="btn sm" onClick={onClose}>
              Cancel
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            A note teaches this agent only. An article also becomes a public
            help page — saved as a draft until you publish it.
          </div>
        </>
      ) : (
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button
            className="btn sm primary"
            disabled={!correction.trim() || correctionPlan.isPending}
            onClick={() => correctionPlan.mutate()}
          >
            {correctionPlan.isPending ? 'Checking…' : 'Continue →'}
          </button>
          <button className="btn sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
