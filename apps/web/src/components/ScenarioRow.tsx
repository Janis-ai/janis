import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, Trash2 } from 'lucide-react';

/** One scenario, one card — shared by the builder's Try-it checklist and
 *  the deployed agent's regression suite. Same data (agent_tests), same
 *  anatomy and reading order: prompt → expectation → why it failed →
 *  agent reply → cause → actions. What differs by surface is which
 *  actions appear, not the shape. */

export interface ScenarioRun {
  at?: string;
  passed: boolean | null;
  reason?: string;
  reply?: string | null;
  control?: 'handoff' | 'offer' | 'cancel';
  tools?: { name: string; gated?: boolean; outcome: string }[];
  model?: string;
  context?: { prompt: 'custom' | 'default'; kb: string[]; knowledge: string[] };
}

export interface ScenarioTest {
  id: string;
  name: string;
  turns: { role: 'customer' | 'agent'; text: string; mid?: string }[];
  expectation: string;
  /** Expectation was AI-drafted at save time and not yet reviewed. */
  expectation_draft?: boolean;
  original_reply?: string | null;
  source_conversation_id?: string | null;
  source_message_id?: string | null;
  last_run?: ScenarioRun | null;
  human_result?: 'pass' | 'fail' | 'unreviewed' | 'fixed_recheck' | null;
  fail_cause?: string | null;
  category?: string | null;
  source?: string;
  stale?: boolean;
}

/** The customer message a scenario replays — last inbound turn for
 *  multi-turn transcript cases, the single turn for scenarios. */
export const scenarioPrompt = (t: ScenarioTest) =>
  [...(t.turns ?? [])].reverse().find((x) => x.role === 'customer')?.text ?? t.name;

/** fail_cause → the suggested fix path, shown in the card footer. */
const CAUSE_HINT: Record<string, string> = {
  knowledge: 'Janis suggests teaching the fact (Teach it)',
  behavior: 'Janis suggests adding an instruction rule (Guide it)',
  ability: 'Janis suggests connecting a tool (Abilities)',
  expectation: 'Janis suggests editing the expectation',
};

export function ScenarioRow({
  test,
  running,
  disabled,
  onRun,
  onDelete,
  replyOverride,
  onSaveExpectation,
  expectationSaving,
  verdict,
  onFix,
}: {
  test: ScenarioTest;
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
  onDelete?: () => void;
  /** A reply produced this session that isn't persisted in last_run yet —
   *  labeled "Janis answered" so it reads as fresh, not recorded. */
  replyOverride?: string | null;
  /** Saves the expectation AND re-judges the stored reply against it —
   *  no new run, so no new random reply sneaks in to move the verdict. */
  onSaveExpectation?: (text: string) => void;
  expectationSaving?: boolean;
  /** Human-verdict controls (builder pre-launch judging). Shown when the
   *  row is unreviewed and a real reply exists to judge. */
  verdict?: { pending: boolean; onPass: () => void; onFail: () => void };
  /** Diagnose path — Fix it opens the same card on both surfaces. */
  onFix?: (reply: string, prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);      // replay transcript
  const [replyOpen, setReplyOpen] = useState(false); // full reply
  const [editing, setEditing] = useState(false);
  const [expText, setExpText] = useState('');
  const [menu, setMenu] = useState(false);
  // Passed rows collapse to one line — the failures stand out and the
  // list stays scannable. Expansion state lives per mounted row.
  const [collapsed, setCollapsed] = useState(true);

  const run = test.last_run;
  const prompt = scenarioPrompt(test);
  const reply = replyOverride ?? run?.reply ?? null;
  const replyLabel = replyOverride
    ? 'Janis answered'
    : run?.reply
      ? 'Last replay'
      : null;
  // Fix it only diagnoses — any known reply (this run, the last replay,
  // the original transcript) works, so the button survives a reload.
  const fixReply = reply ?? test.original_reply ?? null;
  const hr = test.human_result;

  /** One status, one badge — the machine judge and the human verdict are
   *  the same outcome at two confidences; the human's say wins. */
  const failed = hr === 'fail' || run?.passed === false;
  const passed = !failed && (hr === 'pass' || run?.passed === true);
  const recheck = !failed && !passed && hr === 'fixed_recheck';
  const canVerdict = verdict && reply && hr === 'unreviewed';
  const isCollapsed =
    collapsed && !editing && !test.stale && (hr === 'pass' || (hr == null && run?.passed === true));

  if (isCollapsed) {
    return (
      <div className="scenario-row scenario-collapsed" id={`sc-${test.id}`}>
        <span className="scenario-check" style={{ color: 'var(--accent)' }}>✓</span>
        <span className="grow" style={{ fontSize: 13, minWidth: 0 }}>
          “{test.name}”
        </span>
        <span className="scenario-badge pass">passed</span>
        <button
          className="btn ghost sm"
          aria-label="Expand"
          onClick={() => setCollapsed(false)}
        >
          ▾
        </button>
      </div>
    );
  }

  return (
    <div className="scenario-row scenario-card" id={`sc-${test.id}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow" style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
          “{test.name}”
        </div>
        {/* One badge, one verdict. */}
        {editing ? (
          <span className="scenario-badge">editing</span>
        ) : test.stale ? (
          <span className="scenario-badge stale" title="Config changed since this ran">
            stale
          </span>
        ) : failed ? (
          <span className="scenario-badge fail">failed</span>
        ) : passed ? (
          <span className="scenario-badge pass">passed</span>
        ) : recheck ? (
          <span className="scenario-badge fixed">fix applied — re-run to confirm</span>
        ) : reply ? (
          <span className="scenario-badge">unreviewed</span>
        ) : null}
        {onDelete && (
          <span style={{ position: 'relative' }}>
            <button
              className="btn ghost sm"
              title="More actions"
              aria-label="More actions"
              onClick={() => setMenu(!menu)}
              onBlur={() => setTimeout(() => setMenu(false), 150)}
            >
              <MoreHorizontal size={13} />
            </button>
            {menu && (
              <div className="scenario-menu">
                <button
                  className="scenario-menu-item danger"
                  onClick={() => {
                    setMenu(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={12} /> Delete test
                </button>
              </div>
            )}
          </span>
        )}
      </div>

      {/* Expected — the bar. Edit keeps 'expects' inline beside the field. */}
      {editing ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span className="muted" style={{ fontSize: 12, paddingTop: 7 }}>
              expects:
            </span>
            <textarea
              rows={2}
              autoFocus
              style={{ flex: 1, fontSize: 12 }}
              value={expText}
              onChange={(e) => setExpText(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn primary sm"
              disabled={expectationSaving}
              onClick={() => {
                onSaveExpectation?.(expText.trim());
                setEditing(false);
              }}
            >
              {expectationSaving
                ? 'Saving…'
                : reply
                  ? 'Save and re-check'
                  : 'Save expectation'}
            </button>
          </div>
          {reply && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Last result is from the old expectation — saving re-checks the
              same reply without a new run.
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>
            Expected
          </div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
            <div className="grow" style={{ fontSize: 13, marginTop: 2 }}>
              {test.expectation ? (
                <>
                  {test.expectation}
                  {test.expectation_draft && (
                    <span
                      className="badge warn"
                      style={{ marginLeft: 6 }}
                      title="Written by AI at save time — review it"
                    >
                      AI draft
                    </span>
                  )}
                </>
              ) : test.category === 'safety' ? (
                <span style={{ color: 'var(--warn)' }}>
                  no expectation written — verdicts judge this by eye
                </span>
              ) : (
                <span className="muted">no expectation — runs aren't judged</span>
              )}
            </div>
            {onSaveExpectation && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setExpText(test.expectation);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
        </div>
      )}

      {/* The judge's reason is an evaluation, not part of the reply —
          labeled and ruled so it reads as the judge's voice. */}
      {failed && run?.reason && !editing && (
        <div className="scenario-judge">
          <div className="scenario-section-label">Why it failed</div>
          {run.reason}
        </div>
      )}

      {/* What the agent said — clamped, expandable. */}
      {reply && !editing && (
        <div style={{ marginTop: 8 }}>
          <div className="scenario-section-label">Agent replied</div>
          <div
            className={replyOpen ? '' : 'scenario-reply-clamp'}
            style={{ fontSize: 13, marginTop: 2, whiteSpace: 'pre-wrap' }}
            title={reply}
          >
            {replyLabel === 'Janis answered' ? null : null}
            {reply}
          </div>
          <button
            className="inspector-toggle"
            style={{ marginTop: 4 }}
            onClick={() => setReplyOpen(!replyOpen)}
          >
            {replyOpen ? '▾ show less' : '▸ show full reply'}
          </button>
        </div>
      )}
      {/* No fresh reply but an original transcript exists — show it under
          its own label so it never reads as a run result. */}
      {!reply && test.original_reply && !editing && (
        <div style={{ marginTop: 8 }}>
          <div className="scenario-section-label">
            Original reply — what the agent did then
          </div>
          <div
            className={replyOpen ? '' : 'scenario-reply-clamp'}
            style={{ fontSize: 13, marginTop: 2, whiteSpace: 'pre-wrap' }}
          >
            {test.original_reply}
          </div>
          <button
            className="inspector-toggle"
            style={{ marginTop: 4 }}
            onClick={() => setReplyOpen(!replyOpen)}
          >
            {replyOpen ? '▾ show less' : '▸ show full reply'}
          </button>
        </div>
      )}

      {test.category === 'actions' && !editing && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          runs the live pipeline — gated actions pause on an approval card,
          nothing executes silently
        </div>
      )}
      {test.source === 'correction' && !editing && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          saved from a Correct this fix
        </div>
      )}

      {/* Full replay transcript — the turns + provenance footer. */}
      {run && !editing && (test.turns.length > 1 || run.control || run.tools?.length || run.model || run.context) && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          <button
            className="inspector-toggle"
            onClick={() => setOpen(!open)}
          >
            {open ? '▾ hide replay transcript' : '▸ show replay transcript'}
          </button>
          {open && (
            <div className="inspector-panel" style={{ maxWidth: '100%', marginTop: 6 }}>
              {(() => {
                const shown = test.turns.slice(-4);
                const omitted = test.turns.length - shown.length;
                return (
                  <>
                    {omitted > 0 && (
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                        …{omitted} earlier turn{omitted === 1 ? '' : 's'} in the
                        replayed transcript
                      </div>
                    )}
                    {shown.map((turn, i) => {
                      const trigger = i === shown.length - 1 && turn.role === 'customer';
                      const linked = turn.mid && test.source_conversation_id;
                      return (
                        <div
                          key={i}
                          style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 12 }}
                        >
                          <span
                            className="mono muted"
                            style={{ minWidth: 58, flexShrink: 0, fontSize: 11 }}
                          >
                            {turn.role}
                          </span>
                          {linked ? (
                            <Link
                              to={`/conversations/${test.source_conversation_id}?msg=${turn.mid}`}
                              className={trigger ? '' : 'muted'}
                              style={{
                                ...(trigger ? { fontWeight: 600 } : {}),
                                textDecoration: 'underline',
                                textDecorationStyle: 'dotted',
                                textUnderlineOffset: 3,
                                whiteSpace: 'pre-wrap',
                              }}
                              title="Open this message in the conversation"
                            >
                              {turn.text}
                            </Link>
                          ) : (
                            <span
                              className={trigger ? '' : 'muted'}
                              style={{
                                whiteSpace: 'pre-wrap',
                                ...(trigger ? { fontWeight: 600 } : {}),
                              }}
                            >
                              {turn.text}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {test.original_reply && (
                      <>
                        <div className="muted" style={{ fontSize: 11, margin: '6px 0 3px' }}>
                          ↳ original reply — what the agent actually did then:
                        </div>
                        <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                          {test.original_reply}
                        </div>
                      </>
                    )}
                  </>
                );
              })()}
              {run.control && (
                <div className="muted" style={{ marginTop: 6 }}>
                  ended with [
                  {run.control === 'handoff'
                    ? 'HANDOFF'
                    : run.control === 'offer'
                      ? 'OFFER_HUMAN'
                      : 'CANCEL_HANDOFF'}
                  ]
                </div>
              )}
              {run.tools?.length ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  tools: {run.tools.map((x) => `${x.name} (${x.outcome})`).join(', ')}
                </div>
              ) : null}
              {run.model && (
                <div className="muted" style={{ marginTop: 6 }}>model: {run.model}</div>
              )}
              {run.context && (
                <div className="muted" style={{ marginTop: 6 }}>
                  grounded on: {run.context.prompt} prompt
                  {run.context.knowledge.length > 0 &&
                    ` · ${run.context.knowledge.length} knowledge snippet${run.context.knowledge.length === 1 ? '' : 's'}`}
                  {run.context.kb.length > 0 && ` · ${run.context.kb.join(', ')}`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {test.source_conversation_id && !editing && (
        <div style={{ marginTop: 6 }}>
          <Link
            to={`/conversations/${test.source_conversation_id}${test.source_message_id ? `?msg=${test.source_message_id}` : ''}`}
            className="muted"
            style={{ fontSize: 12 }}
          >
            view source conversation →
          </Link>
        </div>
      )}

      {/* Footer — the cause hint and the one action row. Fix it is the
          primary on a failure: fixing is the next step, not re-running. */}
      {!editing && (
        <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8 }}>
          <span className="grow muted" style={{ fontSize: 12 }}>
            {failed && test.fail_cause && CAUSE_HINT[test.fail_cause]
              ? `Likely cause: ${test.fail_cause}. ${CAUSE_HINT[test.fail_cause]}.`
              : ''}
          </span>
          {canVerdict && (
            <>
              {/* Equal weight — a filled Looks right nudges rubber-stamping;
                  the verdict is earned by judgment, not button color. */}
              <button
                className="btn sm"
                disabled={verdict.pending}
                onClick={verdict.onPass}
              >
                Looks right
              </button>
              <button
                className="btn sm"
                disabled={verdict.pending}
                onClick={verdict.onFail}
              >
                Needs work
              </button>
            </>
          )}
          <button
            className="btn sm"
            disabled={running || disabled}
            onClick={onRun}
          >
            {running ? 'Running…' : run || hr ? 'Run again' : '▶ Run'}
          </button>
          {onFix && fixReply && failed && (
            <button
              className="btn primary sm"
              title="Diagnose the miss — knowledge, behavior, ability, or a wrong expectation"
              onClick={() => onFix(fixReply, prompt)}
            >
              Fix it
            </button>
          )}
        </div>
      )}
    </div>
  );
}
