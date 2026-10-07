import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ReplyBlock } from './ScenarioRow';
import type { AgentConfig } from '@janis/shared';

type FailCause = 'knowledge' | 'behavior' | 'ability' | 'expectation';

export interface CorrectTarget {
  agentText: string;
  customerText?: string;
  /** Scenario context — set when the card opens from a failed Try-it run.
   *  The card leads with "What went wrong?" (no correction text needed),
   *  and the ability + expectation branches become available. */
  scenario?: { id: string; expectation: string };
}

const CAUSE_LABELS: Record<FailCause, { title: string; hint: string }> = {
  knowledge: {
    title: 'Missing or wrong fact',
    hint: 'it needed a fact it doesn’t know',
  },
  behavior: {
    title: 'Wrong tone, promise, or approach',
    hint: 'how it answered, not what it knew',
  },
  ability: {
    title: 'It can’t do the action',
    hint: 'it promised something no tool can do',
  },
  expectation: {
    title: 'The expectation is wrong',
    hint: 'the reply was fine — the test is off',
  },
};

/** The one wrong-reply path — inbox "Correct this" and scenario "Needs work"
 *  both land here. Without a scenario the operator writes what it should
 *  have said, Janis diagnoses the cause, and the fix lands as a knowledge
 *  note/article or an instruction rule. With a scenario the card leads with
 *  the cause picker (Janis's guess preselected), the fix is applied, and the
 *  builder marks the scenario fixed_recheck and re-runs it in a fresh chat —
 *  diagnose → fix → re-run → confirm, never a dead end. */
export function CorrectThisCard({
  agentId,
  cfg,
  target,
  onClose,
  onSaved,
  onFixed,
  onSendToCopilot,
  onGoStep,
}: {
  agentId: string;
  cfg: AgentConfig;
  target: CorrectTarget;
  onClose: () => void;
  /** Called with the new config after a save — the builder keeps a local
   *  draft copy to sync; other callers just get the server truth back via
   *  the agents-query invalidation. */
  onSaved?: (config: AgentConfig) => void;
  /** A fix was applied and the scenario row was marked fixed_recheck —
   *  the builder re-runs the scenario in a fresh conversation. */
  onFixed?: (scenarioId: string) => void;
  /** Behavior branch — "Send to Copilot" drops the correction into the
   *  concierge tab as a draft the owner reviews, where the concierge turns
   *  it into an instructions edit they approve (the draft→approve path). */
  onSendToCopilot?: (draft: string) => void;
  /** Navigate to a builder step (Teach it / Abilities) — the fix card for
   *  ability suggests connecting a tool rather than fixing in place. */
  onGoStep?: (step: 'teach' | 'abilities') => void;
}) {
  const qc = useQueryClient();
  const scenario = target.scenario;
  const [correction, setCorrection] = useState('');
  const [plan, setPlan] = useState<{
    cause: FailCause;
    instruction?: string;
    knowledge_shape?: string;
    classified: boolean;
  } | null>(null);
  const [cause, setCause] = useState<FailCause | null>(null);
  const [instrEdit, setInstrEdit] = useState('');
  const [noteEdit, setNoteEdit] = useState('');
  const [expEdit, setExpEdit] = useState(scenario?.expectation ?? '');
  const [error, setError] = useState('');
  const [addedTest, setAddedTest] = useState(false);
  // Diagnose fires once per scenario target — a re-render must not spam it.
  const diagTried = useRef(false);

  // A fresh target means a fresh draft — reset during render (the
  // React-blessed pattern; an effect would flash the previous reply's
  // correction for one frame).
  const targetKey = `${target.agentText}${target.customerText ?? ''}${scenario?.id ?? ''}`;
  const [forTarget, setForTarget] = useState(targetKey);
  if (forTarget !== targetKey) {
    setForTarget(targetKey);
    setCorrection('');
    setPlan(null);
    setCause(null);
    setInstrEdit('');
    setNoteEdit('');
    setExpEdit(scenario?.expectation ?? '');
    setError('');
    setAddedTest(false);
    diagTried.current = false;
  }

  const markFixed = async (c: FailCause) => {
    if (!scenario) return;
    await api(`/api/agents/${agentId}/tests/${scenario.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ human_result: 'fixed_recheck', fail_cause: c }),
    });
    void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
    void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
    onFixed?.(scenario.id);
  };

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
      if (scenario) void markFixed('knowledge').catch((e) => setError(e.message));
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const diagnose = useMutation({
    mutationFn: () =>
      api<{
        cause: FailCause;
        instruction?: string;
        knowledge_shape?: string;
        classified: boolean;
      }>(`/api/agents/${agentId}/correction-plan`, {
        method: 'POST',
        body: JSON.stringify({
          customerText: target.customerText,
          agentText: target.agentText,
          ...(correction.trim() ? { correction: correction.trim() } : {}),
          ...(scenario?.expectation ? { expected: scenario.expectation } : {}),
        }),
      }),
    onSuccess: (p) => {
      setPlan(p);
      // The guess preselects — the owner confirms or overrides below.
      // Outside scenario mode, ability/expectation have no fix surface:
      // ability folds into the drafted handoff instruction, expectation
      // into a knowledge note.
      setCause(
        !scenario && p.cause === 'ability'
          ? 'behavior'
          : !scenario && p.cause === 'expectation'
            ? 'knowledge'
            : p.cause,
      );
      setInstrEdit(p.instruction ?? '');
      if (p.knowledge_shape) setNoteEdit(p.knowledge_shape);
    },
    onError: (e) => setError(e.message),
  });

  // Scenario mode diagnoses immediately — the (prompt, reply, expectation)
  // triple is enough; no correction text needed.
  useEffect(() => {
    if (scenario && !diagTried.current && !diagnose.isPending) {
      diagTried.current = true;
      diagnose.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, targetKey]);

  // Behavior branch — the drafted rule lands appended to the agent's
  // instructions and is logged so Guide it can credit testing/inbox
  // corrections as the source.
  const applyInstruction = useMutation({
    mutationFn: ({ text, fixedCause }: { text: string; fixedCause?: FailCause }) => {
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
      }).then(() => ({ config: config as AgentConfig, fixedCause }));
    },
    onSuccess: ({ config, fixedCause }) => {
      onSaved?.(config);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      if (scenario) void markFixed(fixedCause ?? 'behavior').catch((e) => setError(e.message));
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  // Expectation branch — the test itself is wrong: fix the bar or delete it.
  // No re-run on save: the reply was fine, the bar moved. The existing reply
  // stays on the row and the owner verdicts it against the new expectation
  // directly — re-running would produce a *different* reply to judge.
  const saveExpectation = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests/${scenario!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectation: expEdit.trim(),
          human_result: 'unreviewed',
          fail_cause: 'expectation',
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const deleteScenario = useMutation({
    mutationFn: () => api(`/api/agents/${agentId}/tests/${scenario!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  // "Connect the tool" isn't a config fix — record the cause, keep the row
  // failing, and send the owner to Abilities.
  const markAbility = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests/${scenario!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fail_cause: 'ability' }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      onGoStep?.('abilities');
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  // "Add to tests" — the correction becomes a regression scenario (the
  // customer's prompt is the trigger, the fix is the expectation) so a
  // later config change can't silently regress it. Doesn't close the
  // card — the correction itself still lands as a note/article/rule.
  // Pointless on an existing scenario — non-scenario callers only.
  const addTest = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: target.customerText ?? target.agentText.slice(0, 200),
          expectation:
            correction.trim() || instrEdit.trim() || 'the reply should answer this correctly',
          category: 'general',
          source: 'correction',
        }),
      }),
    onSuccess: () => {
      setAddedTest(true);
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
    },
    onError: (e) => setError(e.message),
  });

  // Needs the customer's prompt — a scenario without a trigger can't re-run.
  const addTestBtn =
    scenario || !target.customerText ? null : addedTest ? (
      <span className="muted" style={{ fontSize: 12 }}>
        ✓ in tests
      </span>
    ) : (
      <button
        className="link small"
        disabled={addTest.isPending}
        title="Save the customer's prompt + this fix as a re-runnable scenario on Try it"
        onClick={() => addTest.mutate()}
      >
        ＋ Add to tests
      </button>
    );

  const suggestedTools = (cfg.builder?.suggested_templates ?? []).map((t) => t.name || t.id);
  const HANDOFF_RULE =
    'When asked to take an action the agent cannot perform, collect the relevant details and say a teammate will follow up — never promise the action itself.';
  const busy =
    saveCorrection.isPending ||
    applyInstruction.isPending ||
    saveExpectation.isPending ||
    deleteScenario.isPending ||
    markAbility.isPending;

  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <strong style={{ fontSize: 13 }}>
        {scenario ? 'What went wrong?' : 'Correct this reply'}
      </strong>
      {/* Who said what, in order — the agent's words clamp to two lines
          with the same measured show-full toggle the scenario row uses. */}
      {target.customerText && (
        <ReplyBlock label="User" text={target.customerText} inline />
      )}
      <ReplyBlock label="Agent" text={target.agentText} inline />
      {scenario?.expectation && (
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          Expected: {scenario.expectation}
        </div>
      )}
      {error && (
        <div className="error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      {scenario ? (
        <>
          {/* Diagnose — Janis's guess preselects, owner picks or overrides. */}
          {diagnose.isPending && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Janis is diagnosing the miss…
            </div>
          )}
          <div className="cause-picker">
            {(Object.keys(CAUSE_LABELS) as FailCause[]).map((c) => (
              <button
                key={c}
                className={`cause-row${cause === c ? ' on' : ''}`}
                onClick={() => setCause(c)}
              >
                <span className="cause-title">
                  {CAUSE_LABELS[c].title}
                  {plan?.classified && plan.cause === c && (
                    <span className="cause-guess">Janis’s guess</span>
                  )}
                </span>
                <span className="cause-hint">{CAUSE_LABELS[c].hint}</span>
              </button>
            ))}
          </div>

          {cause === 'knowledge' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Janis drafted the note’s shape — fill in the real facts. Model
                memory isn’t evidence; the values must be yours.
              </div>
              <textarea
                rows={3}
                style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
                placeholder="e.g. Junior certification: ages 10–14; Open Water: 15+"
                value={noteEdit}
                autoFocus
                onChange={(e) => setNoteEdit(e.target.value)}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button
                  className="btn sm primary"
                  disabled={!noteEdit.trim() || busy}
                  onClick={() => saveCorrection.mutate({ mode: 'note', text: noteEdit.trim() })}
                >
                  {saveCorrection.isPending ? 'Saving…' : 'Save as note'}
                </button>
                <button
                  className="btn sm"
                  disabled={!noteEdit.trim() || busy}
                  title="Creates an unpublished draft — review it under Teach it → Articles"
                  onClick={() => saveCorrection.mutate({ mode: 'article', text: noteEdit.trim() })}
                >
                  Draft article
                </button>
                {onGoStep && (
                  <button className="link small" onClick={() => onGoStep('teach')}>
                    or find a source →
                  </button>
                )}
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {cause === 'behavior' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                A behavior fix becomes a rule in the instructions:
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
                  disabled={!instrEdit.trim() || busy}
                  onClick={() => applyInstruction.mutate({ text: instrEdit.trim() })}
                >
                  {applyInstruction.isPending ? 'Saving…' : 'Add to instructions'}
                </button>
                {onSendToCopilot && (
                  <button
                    className="btn sm"
                    disabled={!instrEdit.trim() || busy}
                    title="Opens Copilot with this fix drafted — the concierge turns it into an instruction you approve"
                    onClick={() =>
                      onSendToCopilot(
                        [
                          'A correction from testing my agent:',
                          target.customerText ? `The customer said: "${target.customerText.slice(0, 200)}"` : '',
                          `It replied: "${target.agentText.slice(0, 200)}"`,
                          `The fix: ${instrEdit.trim()}`,
                          'Please draft this as an instruction update for my approval.',
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      )
                    }
                  >
                    Send to Copilot
                  </button>
                )}
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {cause === 'ability' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                This test expects an action
                {suggestedTools.length
                  ? ` — suggested at Create: ${suggestedTools.slice(0, 3).join(', ')}`
                  : ''}
                .{' '}
                {(cfg.tools?.length ?? 0) + (cfg.builtin_tools?.length ?? 0) === 0
                  ? 'No tools are connected.'
                  : 'No connected tool matches it.'}
              </div>
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                {onGoStep && (
                  <button
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() => markAbility.mutate()}
                  >
                    Set up abilities →
                  </button>
                )}
                <button
                  className="btn sm"
                  disabled={busy}
                  title="Adds an instruction: collect the details and hand off to a human instead of promising the action"
                  onClick={() =>
                    applyInstruction.mutate({
                      text: instrEdit.trim() || HANDOFF_RULE,
                      fixedCause: 'ability',
                    })
                  }
                >
                  Collect details + hand off instead
                </button>
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Connect the tool and the scenario can re-run for real; the
                hand-off rule is the honest fallback when there is no tool.
              </div>
            </>
          )}

          {cause === 'expectation' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                The reply may be fine — fix what the test expects, or drop it.
              </div>
              <textarea
                rows={2}
                style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
                placeholder="What a good reply must do…"
                value={expEdit}
                onChange={(e) => setExpEdit(e.target.value)}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button
                  className="btn sm primary"
                  disabled={!expEdit.trim() || busy}
                  onClick={() => saveExpectation.mutate()}
                >
                  {saveExpectation.isPending ? 'Saving…' : 'Save expectation'}
                </button>
                <button
                  className="link small"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Delete this scenario?')) deleteScenario.mutate();
                  }}
                >
                  delete scenario
                </button>
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {/* Non-scenario path — owner writes the correction, Janis classifies
              it knowledge vs behavior, same as before. */}
          <textarea
            rows={3}
            style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
            placeholder="What should it have said or done?"
            value={correction}
            autoFocus
            onChange={(e) => setCorrection(e.target.value)}
          />
          {cause === 'behavior' ? (
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
                  onClick={() => applyInstruction.mutate({ text: instrEdit.trim() })}
                >
                  {applyInstruction.isPending ? 'Saving…' : 'Add to instructions'}
                </button>
                {onSendToCopilot && (
                  <button
                    className="btn sm"
                    disabled={!instrEdit.trim()}
                    title="Opens Copilot with this fix drafted — the concierge turns it into an instruction you approve"
                    onClick={() =>
                      onSendToCopilot(
                        [
                          'A correction from a live conversation:',
                          target.customerText ? `The customer said: "${target.customerText.slice(0, 200)}"` : '',
                          `It replied: "${target.agentText.slice(0, 200)}"`,
                          `The fix: ${instrEdit.trim()}`,
                          'Please draft this as an instruction update for my approval.',
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      )
                    }
                  >
                    Send to Copilot
                  </button>
                )}
                <button className="link small" onClick={() => setCause('knowledge')}>
                  it’s a fact instead
                </button>
                {addTestBtn}
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                The rule is appended to the instructions — review it any time on
                Guide it.
              </div>
            </>
          ) : cause === 'knowledge' ? (
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
                <button className="link small" onClick={() => setCause('behavior')}>
                  it’s about behavior
                </button>
                {addTestBtn}
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
                disabled={!correction.trim() || diagnose.isPending}
                onClick={() => diagnose.mutate()}
              >
                {diagnose.isPending ? 'Checking…' : 'Continue →'}
              </button>
              {addTestBtn}
              <button className="btn sm" onClick={onClose}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
