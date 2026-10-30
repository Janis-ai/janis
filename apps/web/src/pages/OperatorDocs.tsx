import { usePageTitle } from '../lib/title';
import { Code } from '../components/bits';

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
        Quiet hours are set per workspace in Campaigns → settings (the gear)
        — they <em>defer</em>, never drop. The frequency cap is global across
        all campaigns so a contact in two drips doesn't get double-mailed.
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

      <h2>Bubble channels and guests</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        The chat bubble identifies visitors by a channel-scoped guest token, so
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
      <h3>Saved components — Behavior → Chat components</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Reusable, named versions of every widget type. The agent calls one by
        writing <span className="mono">WIDGET_REF: name</span> — you control the
        content, it chooses the moment. The <strong>when to use</strong> line is
        the agent's cue for picking it over prose or another component, so write
        the trigger, not the content ("customer asks where their order is").{' '}
        <strong>Show on open</strong> pins a component under the chat greeting.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Any field can hold a <span className="mono">{'{prop}'}</span>{' '}
        placeholder the agent fills with ref data
        (<span className="mono">{'WIDGET_REF: plans {"plan":"pro"}'}</span>).
        Bind a <strong>tool</strong> and the ref becomes that tool's call: the
        agent supplies the args in the ref data, the JSON result fills{' '}
        <span className="mono">{'{props}'}</span> and the list rows
        (<span className="mono">items</span> for cards/options,{' '}
        <span className="mono">steps</span> for status,{' '}
        <span className="mono">rows</span> for receipts) through the mapping —{' '}
        <span className="mono">{'{"items":"path.to.rows","item_map":{"title":"name"}}'}</span>{' '}
        plus format modifiers like <span className="mono">{'{ts:date}'}</span>,{' '}
        <span className="mono">{':money'}</span>,{' '}
        <span className="mono">{':pretty'}</span> and{' '}
        <span className="mono">{':stepstate'}</span>. Facts always come from the
        tool — the model selects, it never invents prices or statuses. Named{' '}
        <strong>states</strong> add variant layouts picked by{' '}
        <span className="mono">{'{"state":"name"}'}</span>. Use{' '}
        <strong>Run with real data</strong> in the editor to preview the exact
        render with a live tool call before saving.
      </p>

      <h2 id="chatfuel">Chatfuel channel</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Chatfuel fronts your Facebook Page's bot; Janis sits behind it. A{' '}
        <strong>JSON API</strong> card in the bot POSTs each visitor message to
        the agent's ingest URL synchronously, and the reply comes back in the
        HTTP response — the same hosted pipeline (knowledge, tools, persona)
        that answers every other channel. Attributes the card sends are stored
        on the contact; while a teammate owns the thread the endpoint answers
        empty and the bot stays silent. The URL lives on the channel card
        (agent → Channels → Chatfuel → Chatfuel setup) — the bot key mints on
        first view. A migrated agent's legacy client key works too: repointing
        an old bot's card at <span className="mono">/bot/&lt;key&gt;/chatfuel</span>{' '}
        <em>is</em> the migration off the legacy{' '}
        <span className="mono">/messenger/client/…/chatfuel/fallback</span>{' '}
        endpoint, which still serves bots that haven't moved.
      </p>
      <Code>{`POST {apiOrigin}/bot/{bot_key}/chatfuel      ← the card's URL
content-type: application/json

{ "messenger user id": "2423…", "user input": "where is my order?",
  "first_name": "Jane", "event": "order_lookup" }       ← attributes the card sends

→ 200 OK
{
  "messages": [
    { "text": "Your order #1042 shipped Tuesday —" },
    { "text": "want the tracking link?",
      "quick_replies": [
        { "title": "Track it", "block_names": ["Janis"],
          "set_attributes": { "user input": "Track it" } } ] }
  ],
  "set_attributes": { "order_id": "1042" },
  "redirect_to_blocks": ["Post-Purchase"] }`}</Code>

      <h3>Setup</h3>
      <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: 20 }}>
        <li>
          In Janis, add a <strong>Chatfuel</strong> channel on the agent — the setup
          card shows the POST URL.
        </li>
        <li>
          In Chatfuel, create a block named <strong>Janis</strong> — the name
          matters: quick-reply taps and card buttons route back through this
          block.
        </li>
        <li>
          Open your <strong>Default Message</strong>: replace its contents with a{' '}
          <strong>User Input</strong> card that saves the answer to{' '}
          <span className="mono">{'{{user input}}'}</span>, then a{' '}
          <strong>Go to block</strong> card pointing at <strong>Janis</strong>.
        </li>
        <li>
          In the <strong>Janis</strong> block, add a <strong>JSON API</strong>{' '}
          card: type <strong>POST</strong>, the URL from step 1, and send user
          attributes — <span className="mono">messenger user id</span> and{' '}
          <span className="mono">user input</span> must be included (the card's
          send-all default covers them).
        </li>
        <li>
          Leave <strong>Report errors in the bot</strong> off, then{' '}
          <strong>Test the request</strong> — expect{' '}
          <span className="mono">200 OK</span>.
        </li>
        <li>
          Clear keyword rules that would fire ahead of the default message, so
          every message reaches the Janis block.
        </li>
      </ol>

      <h3>Testing</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        The card's <strong>Test the request</strong> — or a real Messenger
        message — must return <span className="mono">200 OK</span>. The reply
        renders in Messenger as ordinary bot messages and the transcript lands
        in the console inbox under{' '}
        <span className="mono">chatfuel:&lt;messenger user id&gt;</span>. Note
        that an empty <span className="mono">{'{messages:[]}'}</span> body is
        still a healthy 200 — the meanings are under Troubleshooting below.
      </p>

      <h3>Advanced</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Events.</strong> Post an <span className="mono">event</span>{' '}
        (or <span className="mono">dfEvent</span>) attribute with no typed text
        — a button or flow can fire it — and the agent receives{' '}
        <span className="mono">[event] NAME</span> as the turn; on a new
        conversation the run opens with your greeting. This is how a structured
        flow hands its outcome to the agent.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Attributes → contact.</strong> Every non-reserved attribute the
        card sends is stored on the contact's profile and shown to the agent —
        names, emails, anything the flow collected. Reserved keys (
        <span className="mono">messenger user id</span>,{' '}
        <span className="mono">user input</span>,{' '}
        <span className="mono">event</span>, <span className="mono">df*</span>,{' '}
        <span className="mono">lang/locale</span>,{' '}
        <span className="mono">latitude/longitude</span>) are consumed by the
        endpoint itself: coordinates land as the contact's location, lang as
        its language.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Reply contract.</strong>{' '}
        <span className="mono">{'{messages:[…]}'}</span> — long answers split
        into multiple <span className="mono">{'{text}'}</span> messages at
        ~640 characters. <strong>Quick replies</strong> ride the last text
        message: a tap sets <span className="mono">user input</span> to the
        label and routes back through the Janis block (why the block name
        matters). <strong>Rich replies</strong> — the agent's card widgets —
        render as Messenger generic-template carousels (image, title, subtitle,
        link/select buttons; a select tap re-fires the Janis block with the
        label), and images/video/audio/file attachments send as native
        Messenger attachments.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Directives.</strong> The agent can write invisible{' '}
        <span className="mono">{'{{…}}'}</span> commands in its reply —
        stripped from the visible text and logged on the transcript as channel
        effects: <span className="mono">{'{{set field=value}}'}</span> →{' '}
        <span className="mono">set_attributes</span>,{' '}
        <span className="mono">{'{{goto "Flow Name"}}'}</span> →{' '}
        <span className="mono">redirect_to_blocks</span>.{' '}
        <span className="mono">{'{{tag}}'}</span>/
        <span className="mono">{'{{untag}}'}</span> exist too but are
        ManyChat-only — Chatfuel has no primitive, so they're dropped.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Connect to Meta.</strong> Linking the Facebook Page on the
        channel card folds the Chatfuel thread into the Page's Messenger
        conversation — the agent sees <em>every</em> message, not just the ones
        the card forwards; a human replying in Meta's Page Inbox takes over
        automatically; and replies push to the subscriber through Meta
        directly, so the card's time limit stops mattering (the card responds
        empty on purpose — push owns delivery).
      </p>

      <h3>Human takeover</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        While a teammate owns the conversation the endpoint answers{' '}
        <span className="mono">{'{messages:[]}'}</span> — the bot stays silent
        until the thread is released back to the agent. Operator replies from
        the console (or Slack) still reach the subscriber when the Page is
        connected. With the Page connected, a reply typed in Meta's own Page
        Inbox takes over too; release in the console hands it back either way.
      </p>

      <h3>Troubleshooting</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        An empty <span className="mono">{'{messages:[]}'}</span> on a 200 means
        one of four things — check in this order:
      </p>
      <Table
        head={['Empty response', 'Meaning']}
        rows={[
          ['teammate owns the thread', 'Human takeover — intentional silence until release (check the inbox state)'],
          ['Page is connected', 'Meta push owns delivery — the reply already arrived via Graph; the card stays empty to avoid doubles'],
          ['same message twice inside ~90s', 'Duplicate guard — the Page webhook AND the card both forwarded it; the stored reply is re-served rather than answered twice'],
          ['none of the above', 'The reply landed past the card\'s ~10–14s window — it\'s in the transcript but too late for the response. Connect the Page so pushes land regardless of timing'],
        ]}
      />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        An empty response on the <em>first</em> test usually means the card sent
        no <span className="mono">messenger user id</span> — check the
        attributes the JSON API card posts. The endpoint rate-limits at 120
        calls per minute per bot key; cards firing faster than that get 429s,
        not silence.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Migrating from the old stack? The legacy{' '}
        <strong>🙊 No Response</strong> alert — "the bot had nothing to say" —
        has no direct equivalent because the hosted agent never stays silent on
        failure: a failed run fires a <strong>failure alert</strong> and
        escalates to <em>Needs human</em> (or apologizes in-line when handoffs
        are off), and the unanswered question itself lands in the agent's{' '}
        <strong>Knowledge gaps</strong> — clustered there so you can teach the
        answer once instead of rescuing the same question forever.
      </p>

      <h2 id="manychat">ManyChat channel</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        ManyChat fronts your Page's bot; Janis sits behind it. A{' '}
        <strong>Dynamic step</strong> (External Request) POSTs the subscriber's
        data to the agent's ingest URL synchronously, and the reply comes back
        in the HTTP response — the same hosted pipeline that answers every
        other channel. The URL lives on the channel card (agent → Channels →
        ManyChat → ManyChat setup). A migrated agent's legacy client key works
        too — repointing the request at{' '}
        <span className="mono">/bot/&lt;key&gt;/manychat</span> is the
        migration off the legacy{' '}
        <span className="mono">/messenger/client/…/manychat/fallback</span>{' '}
        endpoint.
      </p>
      <Code>{`POST {apiOrigin}/bot/{bot_key}/manychat      ← the request URL
content-type: application/json

{ "id": "8823…", "first_name": "Jane",                    ← Full Subscriber Data
  "custom_fields": { "user input": "where is my order?" } }

→ 200 OK
{
  "version": "v2",
  "content": {
    "messages": [{ "type": "text", "text": "Order #1042 shipped Tuesday." }],
    "actions": [
      { "action": "set_field_value", "field_name": "order_id", "value": "1042" },
      { "action": "add_tag", "tag_name": "order-lookup" } ],
    "quick_replies": [{ "type": "node", "caption": "Track it", "target": "Track it" }] } }`}</Code>

      <h3>Setup</h3>
      <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: 20 }}>
        <li>
          In Janis, add a <strong>ManyChat</strong> channel on the agent — the
          setup card shows the POST URL.
        </li>
        <li>
          In ManyChat, open <strong>Settings → Messenger → Default Reply →
          Edit</strong>.
        </li>
        <li>
          Replace the first step with a <strong>Dynamic</strong> step and click
          the purple area to add a request.
        </li>
        <li>
          Method <strong>POST</strong>, the URL from step 1, and under{' '}
          <strong>Body</strong> pick <strong>Full Subscriber Data</strong> —
          the subscriber's <span className="mono">id</span> and{' '}
          <span className="mono">custom_fields.user input</span> are what Janis
          reads.
        </li>
        <li>
          <strong>Test this request</strong> → <span className="mono">200</span>,
          then <strong>Save</strong>. Keep the Default Reply enabled, set it to
          fire <strong>every time</strong>, and <strong>Publish</strong> the
          flow.
        </li>
        <li>
          Paste your ManyChat API token into the channel card (ManyChat
          Settings → API) — Janis then pushes replies through ManyChat
          directly, so answers still arrive if a reply runs past the request's
          time limit, and teammate replies reach the subscriber too.
        </li>
      </ol>

      <h3>Testing</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Test this request</strong> must return{' '}
        <span className="mono">200</span>; the reply renders in the subscriber's
        thread and the transcript lands in the console inbox under{' '}
        <span className="mono">manychat:&lt;subscriber id&gt;</span>. An empty{' '}
        <span className="mono">{'{messages:[], actions:[]}'}</span> body is
        still a healthy 200 — the meanings are under Troubleshooting below.
      </p>

      <h3>Advanced</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Events.</strong> A custom field named{' '}
        <span className="mono">event</span> reaches the agent as{' '}
        <span className="mono">[event] NAME</span> with no visible text — on a
        new conversation the run opens with your greeting.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Custom fields → contact.</strong> Subscriber fields and custom
        fields in the posted body are stored on the contact's profile and shown
        to the agent — the flow's collected data rides every turn without the
        agent asking twice.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Reply contract.</strong>{' '}
        <span className="mono">
          {'{version:"v2", content:{messages, actions, quick_replies?}}'}
        </span>{' '}
        — long answers split into ~640-character text messages;{' '}
        <strong>quick replies</strong> post as{' '}
        <span className="mono">node</span> targets named after the label, so a
        same-named flow/node picks the tap up. <strong>Rich replies</strong> —
        card widgets — render as <span className="mono">type:"cards"</span>{' '}
        elements, option lists become quick replies, and media attachments send
        as image/video/audio/file messages.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Directives.</strong> All four{' '}
        <span className="mono">{'{{…}}'}</span> commands work — stripped from
        the visible text and logged on the transcript as channel effects:{' '}
        <span className="mono">{'{{set field=value}}'}</span> →{' '}
        <span className="mono">set_field_value</span>,{' '}
        <span className="mono">{'{{tag name}}'}</span>/
        <span className="mono">{'{{untag name}}'}</span> →{' '}
        <span className="mono">add_tag</span>/<span className="mono">remove_tag</span>,{' '}
        <span className="mono">{'{{goto "Flow Name"}}'}</span> →{' '}
        <span className="mono">send_flow</span>. On the push path a goto rides
        ManyChat's dedicated sendFlow endpoint, same as the card.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>API token pushes.</strong> A token saved on the channel card
        lets Janis call <span className="mono">sendContent</span> itself —
        replies that miss the card's window still arrive, operator sends reach
        the subscriber (prefixed with the sender's name), and goto effects push
        via <span className="mono">sendFlow</span>. With a token saved, push
        owns delivery and the card's response stays empty — by design, not a
        bug.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <strong>Connect to Meta.</strong> Linking the Facebook Page folds the
        ManyChat thread into the Page's Messenger conversation — the agent sees
        every message (not just what the card forwards), Page Inbox replies
        take over automatically, and Meta push can own delivery too.
      </p>

      <h3>Human takeover</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        While a teammate owns the conversation the endpoint answers an empty
        v2 response — the bot stays silent until the thread is released back.
        With a token saved, operator replies still push to the subscriber; with
        the Page connected, replies typed in Meta's Page Inbox take over as
        well.
      </p>

      <h3>Troubleshooting</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        An empty <span className="mono">{'{messages:[], actions:[]}'}</span> on
        a 200 means one of four things — check in this order:
      </p>
      <Table
        head={['Empty response', 'Meaning']}
        rows={[
          ['teammate owns the thread', 'Human takeover — intentional silence until release (check the inbox state)'],
          ['API token saved', 'Push owns delivery — the reply already went out via sendContent; the card stays empty to avoid doubles'],
          ['same message twice inside ~90s', 'Duplicate guard — the Page webhook AND the card both forwarded it; the stored reply is re-served rather than answered twice'],
          ['none of the above', 'The reply landed past the request\'s ~10–14s window — it\'s in the transcript but too late for the response. Save the API token so late replies push through'],
        ]}
      />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        An empty response on the <em>first</em> test usually means the body
        wasn't <strong>Full Subscriber Data</strong> — Janis keys the
        conversation on the subscriber <span className="mono">id</span> and
        answers empty when it's absent. The endpoint rate-limits at 120 calls
        per minute per bot key.
      </p>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Migrating from the old stack? The legacy{' '}
        <strong>🙊 No Response</strong> alert has no direct equivalent — the
        hosted agent never stays silent on failure: a failed run fires a{' '}
        <strong>failure alert</strong> and escalates to <em>Needs human</em>{' '}
        (or apologizes in-line when handoffs are off), and the unanswered
        question lands in the agent's <strong>Knowledge gaps</strong> for
        one-time teaching.
      </p>
    </>
  );
}
