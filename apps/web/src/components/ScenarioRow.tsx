import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Play, RotateCcw, ThumbsDown, ThumbsUp, Trash2, Wrench } from 'lucide-react';

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

/** One turn of a saved exchange — inline scenario saves capture the
 *  chat's recent turns with this shape (no mid — that's transcript-only). */
export type ScenarioTurn = { role: 'customer' | 'agent'; text: string };

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
  knowledge: 'Try teaching the fact (Teach it)',
  behavior: 'Try adding an instruction rule (Guide it)',
  ability: 'Try connecting a tool (Abilities)',
  expectation: 'Try editing the expectation',
};

/** A reply clamped to two lines; the "show full reply" toggle only
 *  renders when the text actually overflows the clamp — measured on the
 *  element, not guessed from length. Exported for CorrectThis, which
 *  quotes the same reply the row shows. */
export function ReplyBlock({
  label,
  text,
  inline,
}: {
  label: string;
  text: string;
  /** Label sits on the text's first line ('Agent: …') instead of a
   *  small-caps header above it — the CorrectThis quote style. */
  inline?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const check = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(node);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div style={{ marginTop: 8 }}>
      {!inline && <div className="scenario-section-label">{label}</div>}
      <div
        ref={el}
        className={expanded ? '' : 'scenario-reply-clamp'}
        style={{ fontSize: 13, marginTop: inline ? 0 : 2, whiteSpace: 'pre-wrap' }}
      >
        {inline && <span className="muted">{label}:</span>}
        {inline ? ' ' : ''}
        {text}
      </div>
      {(overflows || expanded) && (
        <button
          className="inspector-toggle"
          style={{ marginTop: 4 }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '▾ show less' : '▸ show full reply'}
        </button>
      )}
    </div>
  );
}

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
  onTryInChat,
}: {
  test: ScenarioTest;
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
  onDelete?: () => void;
  /** A reply produced this session that isn't persisted in last_run yet. */
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
  /** Sends the prompt into the real test chat — builder-only bridge from
   *  the checklist to a live visitor conversation. */
  onTryInChat?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expText, setExpText] = useState('');
  // Two ways a row folds: machine 'passed' auto-collapses on load, and
  // ANY status can be folded manually via the chevron — including
  // failed/rejected rows the owner wants out of the way.
  const [collapsed, setCollapsed] = useState(true);
  const [folded, setFolded] = useState(false);

  const run = test.last_run;
  const prompt = scenarioPrompt(test);
  // Setup turns — everything before the trigger. Saved inline or from a
  // transcript, a multi-turn scenario replays this exchange, so the card
  // shows it; the trigger itself is the last customer turn.
  const triggerIdx = [...(test.turns ?? [])]
    .map((t, i) => (t.role === 'customer' ? i : -1))
    .reduce((a, b) => Math.max(a, b), -1);
  const setupTurns = (test.turns ?? []).slice(0, Math.max(0, triggerIdx));
  const reply = replyOverride ?? run?.reply ?? null;
  // Fix it only diagnoses — any known reply (this run, the last replay,
  // the original transcript) works, so the button survives a reload.
  const fixReply = reply ?? test.original_reply ?? null;
  const hr = test.human_result;

  /** One status, one badge. 'approved'/'rejected' are the HUMAN verdict —
   *  distinct words from the machine's 'passed'/'failed' so a row the
   *  owner judged doesn't masquerade as a judge result. The judge's
   *  explanation and cause hint only apply to a machine fail. */
  const status = editing
    ? 'editing'
    : test.stale
      ? 'stale'
      : hr === 'fail'
        ? 'rejected'
        : hr === 'pass'
          ? 'approved'
          : run?.passed === false
            ? 'failed'
            : run?.passed === true
              ? 'passed'
              : hr === 'fixed_recheck'
                ? 'recheck'
                : reply
                  ? 'unreviewed'
                  : 'none';
  // Auto-fold is for rows that ARRIVE already passed — a pass landing on
  // an open row (you had it open when the run began) must not fold it out
  // from under you. Layout effect so the reopen lands before paint — no
  // one-frame collapse flash.
  const prevStatus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (was !== null && was !== 'passed' && status === 'passed' && !folded) {
      setCollapsed(false);
    }
  });
  // Verdict buttons are the flip, not the echo — 'Needs work' only on a
  // passing (or unjudged) reply, 'Looks right' only on a failing one.
  const showNeedsWork =
    verdict &&
    reply &&
    (status === 'passed' || status === 'approved' || status === 'unreviewed');
  const showLooksRight =
    verdict &&
    reply &&
    (status === 'failed' || status === 'rejected' || status === 'unreviewed');
  // Machine-passes fold away on their own; everything else folds only
  // when the owner asks. 'editing' can never fold — you can't hide the
  // thing you're changing.
  const isCollapsed =
    status !== 'editing' && (folded || (collapsed && status === 'passed'));

  if (isCollapsed) {
    const ok = status === 'passed' || status === 'approved';
    const bad = status === 'failed' || status === 'rejected';
    const badgeClass =
      status === 'approved' || status === 'passed'
        ? 'pass'
        : status === 'failed'
          ? 'fail'
          : status === 'rejected'
            ? 'rejected'
            : status === 'stale'
              ? 'stale'
              : status === 'recheck'
                ? 'fixed'
                : '';
    return (
      <div className="scenario-row scenario-collapsed" id={`sc-${test.id}`}>
        {ok && (
          <span className="scenario-check" style={{ color: 'var(--accent)' }}>✓</span>
        )}
        {bad && (
          <span className="scenario-check" style={{ color: 'var(--danger)' }}>✗</span>
        )}
        <span className="grow" style={{ fontSize: 13, minWidth: 0 }}>
          “{test.name}”
          {prompt !== test.name && (
            <span className="muted" style={{ fontSize: 11 }}>
              {' '}— {prompt}
            </span>
          )}
          {setupTurns.length > 0 && (
            <span className="muted" style={{ fontSize: 11 }}>
              {' '}· {setupTurns.length + 1} turns
            </span>
          )}
        </span>
        {status !== 'none' && (
          <span className={`scenario-badge ${badgeClass}`}>
            {status === 'recheck' ? 'fix applied — re-run to confirm' : status}
          </span>
        )}
        <button
          className="btn ghost sm"
          aria-label="Expand"
          onClick={() => {
            setFolded(false);
            setCollapsed(false);
          }}
        >
          ▸
        </button>
      </div>
    );
  }

  return (
    <div className="scenario-row scenario-card" id={`sc-${test.id}`}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="grow" style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
          “{test.name}”
        </div>
        {/* One badge, one verdict. */}
        {status === 'editing' ? (
          <span className="scenario-badge">editing</span>
        ) : status === 'stale' ? (
          <span className="scenario-badge stale" title="Config changed since this ran">
            stale
          </span>
        ) : status === 'rejected' ? (
          <span className="scenario-badge rejected">rejected</span>
        ) : status === 'failed' ? (
          <span className="scenario-badge fail">failed</span>
        ) : status === 'approved' ? (
          <span className="scenario-badge pass">approved</span>
        ) : status === 'passed' ? (
          <span className="scenario-badge pass">passed</span>
        ) : status === 'recheck' ? (
          <span className="scenario-badge fixed">fix applied — re-run to confirm</span>
        ) : status === 'unreviewed' ? (
          <span className="scenario-badge">unreviewed</span>
        ) : null}
        {!editing && (
          <button
            className="btn ghost sm"
            aria-label="Collapse"
            onClick={() => setFolded(true)}
          >
            ▾
          </button>
        )}
      </div>

      {/* The exchange that set up the trigger — inline saves carry it,
          so the row shows it rather than asking you to guess what "it"
          referred to. */}
      {setupTurns.length > 0 && !editing && (
        <details className="scenario-context">
          <summary>
            Exchange context — {setupTurns.length} turn{setupTurns.length > 1 ? 's' : ''}
          </summary>
          {setupTurns.map((t, i) => (
            <div key={i} className="scenario-turn">
              <span className="scenario-turn-who">
                {t.role === 'customer' ? 'customer' : 'agent'}
              </span>
              <span>{t.text}</span>
            </div>
          ))}
          <div className="scenario-turn">
            <span className="scenario-turn-who">customer</span>
            <span>
              {prompt} <em className="muted">— the trigger</em>
            </span>
          </div>
        </details>
      )}

      {/* The trigger — only rendered when the name is a separate label
          (manual/CSV scenarios); chat-saved rows already title themselves
          with it, and the exchange-context disclosure repeats it. */}
      {prompt !== test.name && setupTurns.length === 0 && !editing && (
        <ReplyBlock label="Customer" text={prompt} />
      )}

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

      {/* What the agent said — clamped, expandable only when it overflows. */}
      {reply && !editing && (
        <ReplyBlock label="Agent replied" text={reply} />
      )}
      {/* No fresh reply but an original transcript exists — show it under
          its own label so it never reads as a run result. */}
      {!reply && test.original_reply && !editing && (
        <ReplyBlock
          label="Original reply — what the agent did then"
          text={test.original_reply}
        />
      )}

      {/* The judge's reason follows the reply it evaluated — machine
          failures only; a human 'rejected' verdict has no judge behind it. */}
      {status === 'failed' && run?.reason && !editing && (
        <div className="scenario-judge">
          <div className="scenario-section-label">Why it failed</div>
          {run.reason}
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

      {/* No replay transcript — a test is a prompt, a bar, a reply, a
          verdict. Turns/provenance still exist on the row's data for the
          run itself; the card just doesn't render a fake chat. */}
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
            {status === 'failed' && test.fail_cause && CAUSE_HINT[test.fail_cause]
              ? `Likely cause: ${test.fail_cause}. ${CAUSE_HINT[test.fail_cause]}.`
              : ''}
          </span>
          {showLooksRight && (
            <button
              className="btn sm"
              title="Looks right — this reply passes"
              disabled={verdict.pending}
              onClick={verdict.onPass}
            >
              <ThumbsUp size={12} /> <span className="scenario-btn-text">Looks right</span>
            </button>
          )}
          {showNeedsWork && (
            <button
              className="btn sm"
              title="Needs work — flag this reply"
              disabled={verdict.pending}
              onClick={verdict.onFail}
            >
              <ThumbsDown size={12} /> <span className="scenario-btn-text">Needs work</span>
            </button>
          )}
          {onFix && fixReply && (status === 'failed' || status === 'rejected') && (
            <button
              className="btn primary sm"
              title="Fix it — diagnose the miss: knowledge, behavior, ability, or a wrong expectation"
              onClick={() => onFix(fixReply, prompt)}
            >
              <Wrench size={12} /> <span className="scenario-btn-text">Fix it</span>
            </button>
          )}
          <button
            className="btn sm"
            title={run || hr ? 'Run again' : 'Run'}
            disabled={running || disabled}
            style={running || disabled ? { fontStyle: 'italic' } : undefined}
            onClick={onRun}
          >
            {run || hr ? <RotateCcw size={12} /> : <Play size={12} />}
            <span className="scenario-btn-text">
              {' '}
              {running ? 'Running' : run || hr ? 'Run again' : 'Run'}
            </span>
          </button>
          {onTryInChat && (
            <button
              className="btn sm"
              title="Try in chat — send this prompt as a real test message"
              onClick={onTryInChat}
            >
              <MessageSquare size={12} />{' '}
              <span className="scenario-btn-text">Try in chat</span>
            </button>
          )}
          {onDelete && (
            <button
              className="btn sm"
              title="Delete scenario"
              onClick={onDelete}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
