import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';

/** One scenario, one row — shared by the builder's Try-it checklist and
 *  the deployed agent's regression suite. Same data (agent_tests), same
 *  anatomy: prompt → expectation → reply → verdict. What differs by
 *  surface is the action column, not the shape. */

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
  /** Enables the inline expectation editor — same PATCH both pages make. */
  onSaveExpectation?: (text: string) => void;
  expectationSaving?: boolean;
  /** Human-verdict controls (builder pre-launch judging). Shown when the
   *  row is unreviewed and a real reply exists to judge. */
  verdict?: { pending: boolean; onPass: () => void; onFail: () => void };
  /** Diagnose path — Fix it opens the same card on both surfaces. */
  onFix?: (reply: string, prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expText, setExpText] = useState('');

  const run = test.last_run;
  const prompt = scenarioPrompt(test);
  // A name that restates the prompt doesn't earn a second line.
  const sameLine =
    prompt.trim().toLowerCase().replace(/["'“”]/g, '') ===
    test.name.trim().toLowerCase().replace(/["'“”]/g, '');
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
  const canVerdict = verdict && reply && hr === 'unreviewed';

  return (
    <div className="scenario-row" id={`sc-${test.id}`}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>“{test.name}”</div>
        {!sameLine && (
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            responds to: "{prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt}"
          </div>
        )}

        {editing ? (
          <div style={{ marginTop: 6 }}>
            {/* 'expects:' keeps its seat while the text edits — the row's
                shape doesn't change under you. */}
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
            <div className="row" style={{ marginTop: 4 }}>
              <button
                className="btn primary sm"
                disabled={expectationSaving}
                onClick={() => {
                  onSaveExpectation?.(expText.trim());
                  setEditing(false);
                }}
              >
                {expectationSaving ? 'Saving…' : 'Save expectation'}
              </button>
              <button className="btn sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {test.expectation ? (
                <>
                  expects: {test.expectation}
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
                "no expectation — runs aren't judged"
              )}
            </div>
            {onSaveExpectation && (
              <button
                className="btn ghost sm"
                style={{ marginTop: 4 }}
                onClick={() => {
                  setExpText(test.expectation);
                  setEditing(true);
                }}
              >
                {test.expectation ? 'Edit expectation' : 'Add an expectation'}
              </button>
            )}
          </>
        )}

        {/* The run's reply quoted on the row — provenance labels keep a
            recorded/original reply from reading as a fresh run. */}
        {reply && (
          <div className="scenario-reply" title={reply}>
            <span className="scenario-reply-label">{replyLabel}</span>
            {reply}
          </div>
        )}

        {test.category === 'actions' && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            runs the live pipeline — gated actions pause on an approval card,
            nothing executes silently
          </div>
        )}
        {test.source === 'correction' && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            saved from a Correct this fix
          </div>
        )}

        {run && (
          <div style={{ fontSize: 12, marginTop: 6 }}>
            {run.reason && <div className="muted">{run.reason}</div>}
            {(run.reply || test.original_reply || (run.tools?.length ?? 0) > 0 || test.turns.length > 1) && (
              <>
                <button
                  className="inspector-toggle"
                  style={{ marginTop: 4 }}
                  onClick={() => setOpen(!open)}
                >
                  {open ? '▾ hide replay' : '▸ show replay'}
                </button>
                {open && (
                  <div
                    className="inspector-panel"
                    style={{ maxWidth: '100%', marginTop: 6 }}
                  >
                    {/* The replay answers the last customer turn — show the
                        transcript tail so the reply has visible context. */}
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
                            const trigger =
                              i === shown.length - 1 && turn.role === 'customer';
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
                          <div className="muted" style={{ fontSize: 11, margin: '6px 0 3px' }}>
                            ↳ replayed now — current setup (never sent, tools stubbed):
                          </div>
                          {run.reply ? (
                            <div style={{ whiteSpace: 'pre-wrap' }}>{run.reply}</div>
                          ) : (
                            <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                              (no text reply — the replay ended on tool calls, above)
                            </div>
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
              </>
            )}
          </div>
        )}
        {/* No persisted run but a session reply exists — the preview above
            carries it; nothing else to expand. */}
        {!run && test.original_reply && (
          <div style={{ fontSize: 12, marginTop: 6 }}>
            <button
              className="inspector-toggle"
              style={{ marginTop: 4 }}
              onClick={() => setOpen(!open)}
            >
              {open ? '▾ hide original reply' : '▸ show original reply'}
            </button>
            {open && (
              <div className="inspector-panel" style={{ maxWidth: '100%', marginTop: 6 }}>
                <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                  {test.original_reply}
                </div>
              </div>
            )}
          </div>
        )}
        {test.source_conversation_id && (
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
      </div>

      {/* Right column — status labels on top, action buttons below.
          Badges report state, they never do work. */}
      <div className="scenario-verdict">
        {(test.stale || run || (hr && hr !== 'unreviewed' && !test.stale)) && (
          <div className="scenario-badges">
            {test.stale && (
              <span
                className="scenario-badge stale"
                title="Config changed since this ran"
              >
                stale
              </span>
            )}
            {run?.passed === true && (
              <span className="scenario-badge pass">✓ pass</span>
            )}
            {run?.passed === false && (
              <span className="scenario-badge fail" title={run.reason}>
                ✗ fail
              </span>
            )}
            {hr === 'pass' && !test.stale && (
              <span className="scenario-badge pass">looks right</span>
            )}
            {hr === 'fail' && !test.stale && (
              <span className="scenario-badge fail">
                needs work{test.fail_cause ? ` · ${test.fail_cause}` : ''}
              </span>
            )}
            {hr === 'fixed_recheck' && !test.stale && (
              <span className="scenario-badge fixed">
                fix applied — re-run to confirm
              </span>
            )}
          </div>
        )}
        <div className="scenario-actions">
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
          {/* One repair verb — "needs work"/"fail" are statuses, Fix it is
              the only button that opens the diagnose card. */}
          {onFix && fixReply && (hr === 'fail' || run?.passed === false) && (
            <button
              className="btn sm"
              title="Diagnose the miss — knowledge, behavior, ability, or a wrong expectation"
              onClick={() => onFix(fixReply, prompt)}
            >
              Fix it
            </button>
          )}
          <button className="btn sm" disabled={running || disabled} onClick={onRun}>
            {running
              ? 'Running…'
              : run || hr
                ? 'Run again'
                : '▶ Run'}
          </button>
          {onDelete && (
            <button
              className="btn sm"
              title="Delete test"
              aria-label="Delete test"
              onClick={onDelete}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
