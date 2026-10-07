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
 *  note or an instruction rule. With a scenario the card leads with
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
  // The correction text Janis last diagnosed — Update re-classifies only
  // when the wording actually changed (or fills in once Continue ran).
  const [diagText, setDiagText] = useState<string | null>(null);
  const [instrEdit, setInstrEdit] = useState('');
  const [noteEdit, setNoteEdit] = useState('');
  const [expEdit, setExpEdit] = useState(scenario?.expectation ?? '');
  const [error, setError] = useState('');
  const [addedTest, setAddedTest] = useState(false);
  // Post-fix summary line — replaces the close-on-save for non-scenario
  // corrections so the owner sees what landed before leaving.
  const [savedFix, setSavedFix] = useState<string | null>(null);
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
    setDiagText(null);
    setInstrEdit('');
    setNoteEdit('');
    setExpEdit(scenario?.expectation ?? '');
    setError('');
    setAddedTest(false);
    setSavedFix(null);
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

  // A correction lands as a knowledge note — corrections are too short
  // to be articles (no title/category/long-form fields here), and notes
  // teach this agent directly.
  const saveCorrection = useMutation({
    mutationFn: (text: string) =>
      api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: { ...cfg, knowledge: [...(cfg.knowledge ?? []), text] },
        }),
      }),
    onSuccess: (_r, text) => {
      onSaved?.({ ...cfg, knowledge: [...(cfg.knowledge ?? []), text] });
      void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      if (scenario) {
        void markFixed('knowledge').catch((e) => setError(e.message));
        onClose();
      } else {
        setSavedFix('Fact saved as a note — it teaches this agent only.');
      }
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
      setDiagText(correction.trim());
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
      // Knowledge fix — Janis's drafted shape when she has one, else the
      // correction itself (it's already fact-shaped: they wrote it).
      setNoteEdit(p.knowledge_shape ?? correction.trim());
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
      if (scenario) {
        void markFixed(fixedCause ?? 'behavior').catch((e) => setError(e.message));
        onClose();
      } else {
        setSavedFix('Rule added to the instructions.');
      }
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
  // card — the correction itself still lands as a note/rule.
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
        ＋ Save as scenario
      </button>
    );

  const suggestedTools = (cfg.builder?.suggested_templates ?? []).map((t) => t.name || t.id);
  // When Janis has no drafted rule, the placeholder should still belong to
  // THIS agent's domain — a generic example teaches the wrong pattern.
  const agentTopic = cfg.builder?.summary?.split('.')[0]?.trim();
  const topic = agentTopic
    ? `${agentTopic.charAt(0).toLowerCase()}${agentTopic.slice(1)}`
    : null;
  const rulePlaceholder = topic
    ? `e.g. "Answer casual questions briefly, then steer back to ${topic}"`
    : 'e.g. "When the customer defers, choose and proceed"';
  const notePlaceholder = topic
    ? `Provide missing knowledge — e.g. the facts it needed about ${topic}: hours, prices, eligibility`
    : 'Provide missing knowledge — e.g. "Hours: Tue–Sat 9–5"';
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
                  onClick={() => saveCorrection.mutate(noteEdit.trim())}
                >
                  {saveCorrection.isPending ? 'Saving…' : 'Save as note'}
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
      ) : savedFix ? (
        <>
          {/* Post-fix summary — the owner sees what landed before leaving;
              the regression hook is offered only now that a fix exists. */}
          <div style={{ fontSize: 13, marginTop: 10 }}>✓ {savedFix}</div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            {addTestBtn}
            <button className="btn sm primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Non-scenario path — owner writes the correction, Janis classifies
              it knowledge vs behavior. The field stays editable after the
              diagnosis; Update re-reads the new wording. */}
          <textarea
            rows={3}
            style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
            placeholder="What should it have said or done?"
            value={correction}
            autoFocus
            onChange={(e) => setCorrection(e.target.value)}
          />
          {cause === null ? (
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <button
                className="btn sm primary"
                disabled={!correction.trim() || diagnose.isPending}
                onClick={() => diagnose.mutate()}
              >
                {diagnose.isPending ? 'Checking…' : 'Continue →'}
              </button>
              <button className="btn sm" onClick={onClose}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
              <button
                className="btn sm"
                disabled={
                  !correction.trim() ||
                  diagnose.isPending ||
                  correction.trim() === diagText
                }
                title="Re-diagnose with the updated correction"
                onClick={() => diagnose.mutate()}
              >
                {diagnose.isPending ? 'Checking…' : 'Update'}
              </button>
            </div>
          )}
          {cause === 'behavior' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {plan?.classified && plan.cause === 'behavior'
                  ? 'Janis reads this as a behavior fix'
                  : 'Provide a behavior fix'}{' '}
                —{' '}
                <button
                  className="link small"
                  onClick={() => {
                    setCause('knowledge');
                    // Owner overrode Janis's read — their correction is
                    // still the fact; carry it into the note field.
                    if (!noteEdit.trim()) setNoteEdit(correction.trim());
                  }}
                >
                  enter a fact instead
                </button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Rule:
              </div>
              <textarea
                rows={2}
                style={{ width: '100%', marginTop: 4, boxSizing: 'border-box' }}
                placeholder={rulePlaceholder}
                value={instrEdit}
                onChange={(e) => setInstrEdit(e.target.value)}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className="btn sm primary"
                  disabled={!instrEdit.trim() || applyInstruction.isPending}
                  onClick={() => applyInstruction.mutate({ text: instrEdit.trim() })}
                >
                  {applyInstruction.isPending ? 'Saving…' : 'Add to instructions'}
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                The rule is appended to the instructions — review it any time on
                Guide it.
              </div>
            </>
          )}
          {cause === 'knowledge' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {plan?.classified && plan.cause === 'knowledge'
                  ? 'Janis reads this as missing knowledge'
                  : 'Provide the missing knowledge'}{' '}
                —{' '}
                <button className="link small" onClick={() => setCause('behavior')}>
                  enter a behavior fix instead
                </button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Note:
              </div>
              <textarea
                rows={2}
                style={{ width: '100%', marginTop: 4, boxSizing: 'border-box' }}
                placeholder={notePlaceholder}
                value={noteEdit}
                onChange={(e) => setNoteEdit(e.target.value)}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn sm" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className="btn sm primary"
                  disabled={
                    !(noteEdit.trim() || correction.trim()) || saveCorrection.isPending
                  }
                  onClick={() =>
                    saveCorrection.mutate(noteEdit.trim() || correction.trim())
                  }
                >
                  {saveCorrection.isPending ? 'Saving…' : 'Add to notes'}
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                A note teaches this agent only — review it any time on Teach it.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
