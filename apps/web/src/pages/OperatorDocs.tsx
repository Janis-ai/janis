import { usePageTitle } from '../lib/title';

const STATES = [
  ['Needs human', 'The agent escalated (handoff, failure, or a routing rule). This is your work queue — claim it, reply, release.'],
  ['Human', 'You own it. The agent stays silent until you release it back.'],
  ['Agent', 'The agent is handling it. Jump in any time — replying as a human pauses the agent automatically.'],
  ['Snoozed', 'Hidden until the timer expires or the customer messages again — then it comes back on its own.'],
  ['Archived', 'Done. CSAT is collected on archive; it stays searchable.'],
];

const SHORTCUTS = [
  ['⌘K / Ctrl+K', 'Command palette — jump to any page, agent, or conversation'],
  ['j / k', 'Move focus down / up the conversation list'],
  ['Enter', 'Open the focused conversation'],
  ['e', 'Archive the focused conversation'],
  ['s', 'Snooze the focused conversation'],
  ['x', 'Toggle-select the focused conversation for bulk actions'],
];

const SEND_STATUSES = [
  ['sent / delivered', 'Provider accepted (or confirmed) the message'],
  ['held — campaign is paused', 'Waiting for the campaign to resume — nothing is lost'],
  ['held for quiet hours — retrying <time>', 'Deferred by your quiet-hours window; sends when the window opens'],
  ['skipped — suppressed (bounce/complaint)', 'This recipient bounced or complained before — suppressed automatically'],
  ['skipped — opted out', 'The recipient texted STOP or used an unsubscribe — do not re-add them'],
  ['skipped — 24h frequency cap', 'Already received a campaign message in the last 24h'],
  ['failed — <reason>', 'Provider rejected it; the send row keeps the raw error'],
];

const STEP_CONDITIONS = [
  ['if_not_replied', 'Only people who did NOT reply to the prior step (classic drip — default)'],
  ['if_replied', 'Only repliers — route them down a different path'],
  ['if_converted', 'Only contacts who hit the campaign goal event'],
  ['if_not_converted', 'Everyone else — the classic "saw it but didn\'t buy" nudge'],
  ['always', 'Every recipient of the prior send, regardless'],
];

const CRM_EVENTS = [
  ['campaign_sent / campaign_failed', 'Each campaign send (or failure) for a synced contact'],
  ['campaign_reply', 'The contact replied to a campaign message'],
  ['conversion', 'The contact hit a campaign goal event'],
  ['human_reply', 'An operator replied in the inbox'],
  ['opt_out', 'The contact opted out of messaging'],
];

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="docs-table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i} className={i === 0 ? 'mono' : 'muted'}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OperatorDocs() {
  usePageTitle('Operator guide');
  return (
    <>
      <h1>Operator guide</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Everything a human teammate needs to run the console day to day: the inbox,
        handoffs, campaigns, CRM sync, and the policy knobs that explain <em>why</em> a
        send did (or didn't) happen.
      </p>

      <h2>The inbox — states and takeover</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Every conversation is in exactly one state. The agent escalates to humans;
        humans release back to the agent. A customer message on a snoozed
        conversation wakes it automatically.
      </p>
      <Table head={['State', 'What it means']} rows={STATES} />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Internal notes</strong> (the 🔒 toggle in the composer) are visible to
        your team only — never delivered to the customer, and mirrored into the Slack
        thread. <strong>Saved views</strong> remember a filter combination per user;
        share them by copying the URL — every list filter is in the querystring.
      </p>

      <h3>Keyboard triage</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Volume triage is keyboard-first. Shortcuts are inert while you're typing in
        an input.
      </p>
      <Table head={['Key', 'Action']} rows={SHORTCUTS} />

      <h2>Handoffs and approvals</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        An agent escalates three ways: it explicitly requests a human
        (<span className="mono">[HANDOFF]</span>), it offers one and the customer
        accepts, or a routing/SLA rule fires. All of them land in <em>Needs
        human</em> with an alert. Approval-gated tools pause mid-action: the
        agent's intent appears as a pending action on the conversation —
        approve or reject, and the agent continues with your decision.
      </p>

      <h2>Slack</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Connect Slack under Settings → Integrations, then route agents to
        channels on each agent's page. Alerts post as messages; replying in
        the thread <strong>takes over the conversation</strong> and delivers
        your reply to the customer. Release back to the agent from the thread
        or the console — state stays in sync both ways. Internal notes in the
        console appear in the thread; thread replies marked as notes stay
        internal.
      </p>
      <Table
        head={['In an alert thread', 'Does']}
        rows={[
          ['plain text', 'Sent to the customer as a human reply (auto takes over)'],
          ['note: <text>', 'Internal note — never reaches the customer'],
          ['agent: <text>', 'Delivered as the agent — no takeover'],
          ['teach: <text>', 'Adds a knowledge entry — admins only'],
          ['pause: [minutes|forever]', 'Takes over or extends the human window'],
          ['resume:', 'Hands the conversation back to the agent'],
          ['Take over / Resume buttons', 'Same as the above — on the alert message'],
        ]}
      />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Slack blocks slash commands inside threads entirely — they never reach
        Janis — so in threads use the colon forms or the buttons. /pause and
        /resume do work as real Slack commands at channel level, acting on the
        channel's most recent conversation.
      </p>

      <h2>Campaigns</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        A campaign sends over one or more steps to a resolved audience of
        contacts. <strong>Ongoing</strong> campaigns keep enrolling new
        matching contacts and accept webhook enrollments at{' '}
        <span className="mono">POST /enroll/:token</span> (the token is on the
        campaign card) — that's how a signup form or Shopify flow starts a
        drip. <strong>send_cap</strong> stops the campaign after N sends;
        pause/resume/cancel are always available.
      </p>

      <h3>Step conditions</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Every follow-up step evaluates a condition against how the recipient
        responded to the <em>prior</em> step:
      </p>
      <Table head={['Condition', 'Audience']} rows={STEP_CONDITIONS} />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Branches are just multiple steps with complementary conditions —{' '}
        <span className="mono">if_replied</span> +{' '}
        <span className="mono">if_not_replied</span> at the same delay sends two
        different follow-ups down two paths.
      </p>

      <h3>Sending rules — why a send says what it says</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Every send decision is recorded on the send row — click into a
        campaign to see per-recipient status. Held sends <em>retry</em>;
        skipped sends are final.
      </p>
      <Table head={['Status', 'Meaning']} rows={SEND_STATUSES} />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Quiet hours are set per workspace in Settings → Sending rules — they
        <em>defer</em>, never drop. The frequency cap is global across all
        campaigns so a contact in two drips doesn't get double-mailed.
      </p>

      <h3>Suppressions and deliverability</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Bounces and spam complaints suppress the address automatically (via
        the provider webhook); STOP/unsubscribe keywords suppress the phone
        or address on inbound. Suppressed recipients are skipped with a
        recorded reason on every future send — import nothing, maintain
        nothing, and don't re-add them through a new list: the suppression is
        keyed on the address/number, not the list.
      </p>

      <h2>CRM sync</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Connect HubSpot or Salesforce under Settings → CRM. Sync is
        <strong> read-only inbound</strong>: contacts come in, keyed by the
        CRM id in <span className="mono">external_ids</span>, and CRM-side
        opt-outs suppress in Janis (one-way — Janis never writes opt-outs
        back).
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Enable <strong>write activity back to CRM</strong> on the connection to
        append Janis activity to the contact's timeline (HubSpot notes,
        Salesforce Tasks). It is append-only and only fires for contacts that
        already exist in your CRM — Janis never creates CRM contacts. Every
        note carries a deep link back to the Janis conversation.
      </p>
      <Table head={['Activity', 'Written to CRM as']} rows={CRM_EVENTS} />

      <h2>Reports</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        The Reports page answers the three questions an admin screenshots for
        a slide: <strong>containment</strong> (what the AI handled vs what
        reached humans), <strong>volume</strong> (daily conversations and
        in/out/human message counts), and <strong>usage</strong> (this billing
        period's messages, LLM tokens + cost, and voice minutes against your
        plan). Both report kinds export to CSV from the page header —
        conversations and campaign sends, up to 5,000 rows.
      </p>

      <h2>Widget channels and guests</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        The web widget identifies visitors by a channel-scoped guest token, so
        conversations reattach across visits and devices only within the same
        browser profile — that is the channel's continuity boundary. Agent,
        human, and Slack activity on the conversation all live in the same
        thread regardless of which channel the customer wrote from.
      </p>

      <h2>In-conversation widgets</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Agents can answer with interactive components — product/plan{' '}
        <em>cards</em>, tap-to-pick <em>options</em>, <em>forms</em>, order{' '}
        <em>status</em> trackers and <em>receipts</em> — rendered inside the
        chat. Taps and submissions arrive as ordinary customer messages, so the
        agent can reason over them like typed replies. On webchat they render
        as rich components; on WhatsApp they become native interactive
        lists/buttons, on Messenger card carousels, and SMS flattens them to
        text. The transcript shows the same component so you can see exactly
        what the customer was offered.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Two ways they get emitted: the agent writes a{' '}
        <span className="mono">WIDGET:</span> directive itself when a visual
        answer beats prose, or a custom action declares{' '}
        <strong>Show the result as</strong> cards/options and its JSON result
        renders automatically — live catalogue data without the model copying
        it. The Shopify "Search products" template ships bound to cards out of
        the box.
      </p>
    </>
  );
}
