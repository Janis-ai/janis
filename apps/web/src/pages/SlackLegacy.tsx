import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

type Decision = 'keep' | 'migrate' | 'new';

/**
 * Slack install collision — the Slack team being connected still runs on
 * classic Janis (wordhop-slack). Its OAuth grant sits parked in
 * slack_pending_installs until the installer picks:
 *   keep    → stay on classic; nothing changes, manage at janis.ai
 *   migrate → assisted cutover: same Slack experience, run by the new stack
 *   new     → start fresh; the classic install stops receiving traffic
 */
export default function SlackLegacy() {
  usePageTitle('Existing Janis setup found');
  const navigate = useNavigate();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<'kept' | 'requested' | 'done' | null>(null);

  const decide = async (decision: Decision) => {
    setBusy(decision);
    setError('');
    try {
      const r = await api<{
        claimed?: boolean;
        kept?: boolean;
        migration?: string;
        legacy?: string;
      }>('/api/slack/claim', { method: 'POST', body: JSON.stringify({ decision }) });
      if (r.claimed) navigate('/settings?slack=connected');
      else if (r.kept) setOutcome('kept');
      else if (r.migration === 'done') setOutcome('done');
      else if (r.migration) setOutcome('requested');
      else setError('Nothing pending — this link may have expired. Connect Slack again.');
    } catch (e) {
      setError(e instanceof ApiError ? friendlyError(e.message).text : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand">
          <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
          <p className="muted">Slack setup</p>
        </div>

        {outcome === 'kept' && (
          <>
            <p>
              <strong>Nothing changed.</strong> Your workspace keeps running on classic Janis —
              manage it at <a href="https://www.janis.ai">janis.ai</a>.
            </p>
            <a className="btn" style={{ display: 'block', textAlign: 'center' }} href="/">
              Back to Janis
            </a>
          </>
        )}

        {outcome === 'done' && (
          <>
            <p>
              <strong>Migration complete.</strong> Your workspace now runs on the new Janis —
              same Slack experience: transcripts, alerts, and commands. Your agents came over
              on their existing Dialogflow engine and answer exactly as before. We emailed you
              the details.
            </p>
            <a
              className="btn primary"
              style={{ display: 'block', textAlign: 'center' }}
              href="/settings?slack=connected"
            >
              Open Slack settings
            </a>
          </>
        )}

        {outcome === 'requested' && (
          <>
            <p>
              <strong>Migration requested.</strong> We'll move your setup onto the new Janis —
              your Slack experience stays identical, and your workspace keeps running on classic
              Janis until the move completes. We'll email you when it's done.
            </p>
            <a className="btn" style={{ display: 'block', textAlign: 'center' }} href="/">
              Back to Janis
            </a>
          </>
        )}

        {!outcome && (
          <>
            <p>
              This Slack workspace already has an <strong>existing Janis setup</strong> — agents,
              alert routing, and channels running on classic Janis.
            </p>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              onClick={() => decide('keep')}
              disabled={!!busy}
            >
              {busy === 'keep' ? 'Saving…' : 'Keep my current setup'}
            </button>
            <p className="muted" style={{ fontSize: 13, margin: '6px 0 14px' }}>
              Nothing changes — your workspace stays on classic Janis.
            </p>
            <button
              className="btn"
              style={{ width: '100%' }}
              onClick={() => decide('migrate')}
              disabled={!!busy}
            >
              {busy === 'migrate' ? 'Migrating…' : 'Move to the new Janis'}
            </button>
            <p className="muted" style={{ fontSize: 13, margin: '6px 0 14px' }}>
              Same Slack experience — transcripts, alerts, and commands — managed from this
              console. Your agents move over on their existing Dialogflow engine and keep
              answering the same way; you can convert any of them to the hosted engine later,
              per agent.
            </p>
            <p className="muted" style={{ fontSize: 13, textAlign: 'center' }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (!busy) void decide('new');
                }}
              >
                Or start fresh — my existing setup stops working
              </a>
            </p>
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
