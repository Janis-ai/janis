# Janis investor demo — script

Audience: investor. Goal: prove one claim — *Janis runs customer
conversations end-to-end, with humans natively in the loop, and every
escalation compounds into product strength.* Depth first, breadth sweep
at the end.

Runtime target: ~4:00. Reference cut: `/tmp/janis-demo/janis-demo-investor-fx.mp4`.

## Production setup

- **Light mode** for the console — set `localStorage.janis_theme='light'`
  in devtools before filming (reads better on projectors).
- Browser window ~1600×1000, zoom 100%. Clean bookmarks bar, no devtools.
- Have the SnowboardsAreUs storefront open in one tab (`snowboardsareus.myshopify.com`,
  password `newtsu`) and `app.janis.ai` console in another.
- The demo creates a real conversation — the newest inbox thread will be
  yours when you cut to the console.
- Don't rush the LLM. Pauses while it types are good footage — they read
  as real product, not a mock.

## Scene 1 — Storefront (0:00–1:50)

ON SCREEN: Shopify storefront, Janis bubble bottom-right. Click it open.

> "Live product, real storefront, real traffic — nothing staged."

TYPE: `Show me the snowboards you have for sale`

Wait for the collection/product cards to render in-chat. If it asks a
clarifying question, reply `yes` and let the cards come.

> "The agent answers from the merchant's real catalog — products, prices,
> collections — inside the chat. And commerce happens in-conversation:
> product cards, add-to-cart, checkout — no redirect."

Click a collection so individual product cards show (images, prices,
buttons). Linger 3–4s.

TYPE: `what size board should I get? I'm 5'10", 170lb`

> "Structured intake is built in — it collects what it needs without a
> forms page or email tag."

Let the sizing form/recommendation render.

TYPE: `I'll take the first one you showed me`

> "It closes the sale in the thread. Conversion, not deflection."

Pause on the checkout link.

TYPE: `Actually the board I got last month is cracked and I want a refund`

> "Here's the part competitors hand-wave. The hard part isn't AI
> answering — it's knowing when to stop. Escalation is a first-class
> primitive: sentiment flags, structured intake, clean handoff."

Let the collect-form/escalation render. Beat. Cut.

## Scene 2 — Inbox, the human side (1:50–2:20)

ON SCREEN: Janis console → Inbox. The conversation you just had is the
top row. Open it.

> "Same thread, operator side. Human takeover is native — not a bolt-on."

Point at the rail: Status, Sentiment: NEGATIVE, Intent, full transcript
with the product cards still in it. Click **Take over**.

TYPE into "Reply as a human": `Hi! Maya here from SnowboardsAreUs — so
sorry the board arrived cracked. I'm shipping a replacement today and
emailing you a prepaid return label. You don't need to do anything else.`

Send.

> "One conversation, one thread — the handoff is invisible to the
> customer. The human reply lands in the same bubble they were already
> talking to."

## Scene 3 — The moat (2:20–2:45)

Still in the thread. Click **Resume agent** (hands it back to AI), then
**Teach agent**.

> "That's the moat — every human rescue becomes a regression test the
> agent is checked against. The next customer who says 'cracked board'
> gets the answer without a human. The product compounds."

(Optional: show the Scenarios page — rescued conversations sit there as
saved test cases.)

## Scene 4 — Time to value (2:45–3:40)

ON SCREEN: Agents → New agent → "Build an agent with Janis".

> "Time-to-value is one sentence. Describe the job — the LLM drafts the
> agent."

TYPE into the description: `Answer customer questions about our hiking
gear — sizing, availability, order status and returns — and help them
check out.` Give it a name, hit Create.

Let "Building agent…" run — the drafted config, greeting, and suggested
topics appearing live IS the shot.

> "Six guided stages — Create, Teach, Guide, Abilities, Try, Deploy.
> Fully self-serve. No integration project, no professional services."

Click through a stage or two so the rail animates. Open the built-in
test chat on the right if there's time — "you test it like a customer
before it ever touches one."

## Scene 5 — Breadth sweep (3:40–4:10)

Rapid cuts, ~5s each — this is where breadth lives, not as features but
as market surface:

- **Agent Overview** — the "This week" stat cards (conversations /
  % resolved by AI / open handoffs / CSAT). Real numbers on screen.
- **Channels page** — Shopify, Meta, email, Slack, SMS, voice.
- **Campaigns** — outbound, not just inbound support.
- **Knowledge/Scenarios** — the learning surface.

> "One agent, every channel — web, Shopify, Meta, email, Slack, SMS,
> voice. One inbox. And this isn't a cold start — we have eighteen
> thousand legacy accounts in the migration pipeline, waiting to move
> onto this stack."

## Close (4:10–4:25)

ON SCREEN: janis.ai landing page.

> "AI when AI is best. Humans when humans are needed. janis.ai."

## Filming notes

- Cut on action: end a scene mid-interaction (message sent, spinner
  running) so the next scene feels continuous.
- The Details rail (sentiment, intent, status) and the "This week" stats
  are the two densest investor-relevant surfaces — linger there, they're
  the proof points.
- If a turn misfires (agent asks something unexpected), roll with it or
  retake that one beat — every scene is independent.
- The existing `/tmp/janis-demo/` take is usable as fallback B-roll or as
  timing reference for each beat.
