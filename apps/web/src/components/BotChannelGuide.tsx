/** Full Chatfuel/ManyChat setup guides — the complete operator-doc bodies
 *  (intro, request/response contract, setup steps with screenshots, testing,
 *  advanced, takeover, troubleshooting). Single source of truth: OperatorDocs
 *  renders them under their <h2> section headers; the channel card's setup
 *  <details> renders the same component so the console guide never drifts
 *  from the docs. The {apiOrigin}/{bot_key} placeholders in the Code blocks
 *  are intentional — the channel card shows the real URL above the guide. */
import { Code, DocShot, Table } from './bits';

export function ChatfuelGuide() {
  return (
    <>
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
          <DocShot src="/img/docs/cf-step1.png" alt="Chatfuel — create a block" />
        </li>
        <li>
          Open your <strong>Default Message</strong>: replace its contents with a{' '}
          <strong>User Input</strong> card that saves the answer to{' '}
          <span className="mono">{'{{user input}}'}</span>, then a{' '}
          <strong>Go to block</strong> card pointing at <strong>Janis</strong>.
          <DocShot src="/img/docs/cf-step2.png" alt="Chatfuel — User Input card saving to {{user input}}" />
          <DocShot src="/img/docs/cf-step3.png" alt="Chatfuel — Go to block card pointing at the Janis block" />
        </li>
        <li>
          In the <strong>Janis</strong> block, add a <strong>JSON API</strong>{' '}
          card: type <strong>POST</strong>, the URL from step 1, and send user
          attributes — <span className="mono">messenger user id</span> and{' '}
          <span className="mono">user input</span> must be included (the card's
          send-all default covers them).
          <DocShot src="/img/docs/cf-step4.png" alt="Chatfuel — JSON API card set to POST with user attributes" />
        </li>
        <li>
          Leave <strong>Report errors in the bot</strong> off, then{' '}
          <strong>Test the request</strong> — expect{' '}
          <span className="mono">200 OK</span>.
          <DocShot src="/img/docs/cf-step5.png" alt="Chatfuel — Test the request returning 200 OK" />
        </li>
        <li>
          Clear keyword rules that would fire ahead of the default message, so
          every message reaches the Janis block.
          <DocShot src="/img/docs/cf-step7.png" alt="Chatfuel — clearing competing keyword rules" />
        </li>
      </ol>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        Screenshots are from the platform's classic builder — styling differs
        today but the card and field names are the same.
      </p>

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
    </>
  );
}

export function ManyChatGuide() {
  return (
    <>
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
          <DocShot src="/img/docs/mc-editdefault.png" alt="ManyChat — Settings → Default Reply → Edit" />
        </li>
        <li>
          Replace the first step with a <strong>Dynamic</strong> step and click
          the purple area to add a request.
          <DocShot src="/img/docs/mc-step3.png" alt="ManyChat — replace the step with a Dynamic step" />
          <DocShot src="/img/docs/mc-step4.png" alt="ManyChat — click the purple area to add a dynamic request" />
        </li>
        <li>
          Method <strong>POST</strong>, the URL from step 1, and under{' '}
          <strong>Body</strong> pick <strong>Full Subscriber Data</strong> —
          the subscriber's <span className="mono">id</span> and{' '}
          <span className="mono">custom_fields.user input</span> are what Janis
          reads.
          <DocShot src="/img/docs/mc-step5.png" alt="ManyChat — request body set to Full Subscriber Data" />
        </li>
        <li>
          <strong>Test this request</strong> → <span className="mono">200</span>,
          then <strong>Save</strong>. Keep the Default Reply enabled, set it to
          fire <strong>every time</strong>, and <strong>Publish</strong> the
          flow.
          <DocShot src="/img/docs/mc-everytime.png" alt="ManyChat — Default Reply set to fire every time and publish" />
        </li>
        <li>
          Paste your ManyChat API token into the channel card (ManyChat
          Settings → API) — Janis then pushes replies through ManyChat
          directly, so answers still arrive if a reply runs past the request's
          time limit, and teammate replies reach the subscriber too.
          <DocShot src="/img/docs/mc-gettoken.png" alt="ManyChat — copy the API token under Settings → API" />
        </li>
      </ol>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        Screenshots are from the platform's classic builder — styling differs
        today but the field names are the same.
      </p>

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
