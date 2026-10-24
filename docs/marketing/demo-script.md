# Janis product demo — scripts (customer cut ~3:30 / investor cut ~4:00)

Two cuts, same footage pipeline:

| cut | file | audience | spine |
|---|---|---|---|
| Customer | `docs/marketing/janis-demo.mp4` | founders + support leads evaluating AI support | "AI when AI is best. Humans when humans are needed." |
| **Investor** | `docs/marketing/janis-demo-investor.mp4` | investors evaluating the company | product reality → the rescue→test moat → distribution as a rail |

The investor cut reframes the same story: the storefront isn't a
support demo, it's proof of a revenue surface on a real catalog; the
rescue loop isn't a feature, it's the compounding moat; and the close
isn't a tagline, it's the migration rail — 17k legacy installs that
convert in one click.

Tone: calm, no hype. Let the product do the flexing. Every claim is
shown, not said.

**Filmed brand:** SnowboardsAreUs — dedicated demo workspace
(`d4f3f73b`, plan pro, agent `51a81b16`, live Bubble channel on
snowboardsareus.myshopify.com). One brand, one conversation,
start to finish: storefront chat → inbox rescue → regression test.
That continuity IS the pitch — the same thread the customer started
is the one the human saves and the agent learns from.

---

## Shot list

### S0 — Cold open on the problem (0:00–0:08)
- **Screen:** snowboardsareus.myshopify.com, browsing. Chat bubble
  sits bottom-right.
- **VO:** "Your customers are already talking to you. The question is
  who's answering."

### S1 — AI does what AI is best at (0:08–0:35)
- **Action:** visitor opens the widget →
  *"Show me the snowboards you have for sale"* → product cards render
  in-chat (live catalog — real prices, sale badges, stock) →
  *"what size board should I get? I'm 5'10", 170lb"* → sizing answer →
  *"I want to buy the first board you showed me"* → checkout/cart link
  in the thread.
- **VO:** "Janis answers from your actual catalog and docs — product
  questions, sizing, order status — and closes the loop: a checkout
  link right in the conversation. No forms, no dead ends."
- **Note:** real LLM latency, keep the typing indicator on screen —
  it reads as the product thinking, not the video stalling.

### S2 — The moment AI should stop (0:35–0:50)
- **Action:** same visitor: *"Actually the board I got last month is
  cracked. I want a refund."* The agent doesn't freestyle — sentiment
  classifies negative, the collect form gathers order details, and the
  thread is flagged for a human.
- **VO:** "Until something needs judgment. A refund, a promise, an
  angry customer — that's not a job for a confidence score."

### S3 — The human end of the same thread (0:50–1:25)
- **Screen:** console → Inbox. The SAME conversation, live — product
  cards, collect form, the refund request, negative-sentiment badge,
  all visible in one thread.
- **Action:** operator opens it → **Take over** → types a human reply
  ("So sorry about the cracked board — prepaid label on its way…") →
  internal note for a teammate → resume the agent.
- **VO:** "Same conversation, other side. A human sees it the moment
  it matters — with everything the AI already learned — and just
  types. The customer never leaves the bubble, never repeats
  themselves."

### S4 — The loop that makes it learn (1:25–1:50)
- **Screen:** agent → Test. "N rescued conversations — not yet
  covered by a scenario." The conversation we just saved is the top
  row.
- **Action:** expand → **Save as tests** → scenario appears with an
  AI-drafted expectation ("acknowledges the cracked board, initiates
  the return…"). Run it → next time the AI handles it.
- **VO:** "And here's the part nobody else does: every human rescue
  becomes a lesson. The gap is flagged, the fix is tested, and the
  next customer never waits on a human for that question."

### S5 — How you'd run it (1:50–2:10)
- **Screen:** fast montage across the agent rail:
  **Knowledge** (catalog + docs it answers from) → **Behavior**
  (instructions, tone, greeting) → **Actions** (tools it can use) →
  **Test** (scenarios) → **Channels** (where it answers).
- **VO:** "Setup isn't a config file. Point it at what you know, tell
  it how to behave, test it like a customer, deploy it where your
  customers are."
- **Pacing:** ~4s per surface, montage not tutorial.

### S6 — Where it lives (2:10–2:25)
- **Screen:** Channels card — Bubble on Shopify connected; the breadth
  line reads: webchat, Meta (Messenger/IG/WhatsApp), email, phone/SMS,
  voice, Slack.
- **VO:** "Web chat, social, email, voice — one agent, one inbox, one
  set of rules."

### S7 — Close (2:25–2:35)
- **Screen:** Landing hero.
- **VO:** "AI when AI is best. Humans when humans are needed.
  Janis — janis.ai."

---

## Investor cut — shot list + burned-in captions (filmed 2026-10-24)

Same rig, same store, investor spine. Captions are rendered as a DOM
overlay at film time (this ffmpeg build lacks libass) — they're timed
to beat marks, so sync is exact by construction. Light-mode console
(`janis_theme=light`), widget panel expanded via `#janis-expand`.

| # | seg | duration | what's on screen | caption |
|---|---|---|---|---|
| 1 | `seg1-storefront` | ~2:36 | password gate → browse → bubble → **expanded panel** → catalog ask → **product carousel** (sale badges, stock, add-to-cart, "Showing 10 of 11") → sizing form → buy → **checkout card** (Order #D31, $2,629.95, "Complete your purchase") → email collect → return ask → **send-to-team form** | "Customer support is the last workflow still priced per human hour." → "This is Janis running a real storefront — live catalog, live pricing, in the chat bubble." → "Not an FAQ — a revenue surface. Real products, real prices, in-chat." → "The loop closes in-chat — a checkout link, not a ticket." → "Until it needs judgment. Then it stops — by design." |
| 2 | `seg2-inbox` | ~0:29 | `/conversations` → newest thread (carousel preview, intent: sales, BUBBLE/Shopify channel) → **Take over** → typed human reply | "Same conversation, other side — full context, instant human takeover." → "Every rescue is captured — not just answered." |
| 3 | `seg3-learn` | ~0:15 | agent → Test → expand "N rescued conversations" → the seg2 reply as top row → **Save as tests** → scenario with AI-drafted expectation | "The moat: rescued threads surface here —" → "…and one click turns a save into a regression test. The product compounds with use." |
| 4 | `seg4-build` | ~0:22 | rail montage: Knowledge → Behavior → Actions → Test | "Knowledge, behavior, actions, tests, channels — a platform, not a feature." |
| 5 | `seg5-migration` | ~0:20 | **Michael's workspace** → Settings → Escalation → janistest3 card → "Migrated from the classic setup — 5 agents" (HOSTED/MONITOR/DIALOGFLOW badges, channel bindings, Manage links) → landing hero | "17,000 legacy installs migrate in one click — distribution is a rail, not an ad spend." → "AI when AI is best. Humans when humans are needed. Janis — janis.ai" |

```bash
SNOW_TOKEN=<demo-ws session> SNOW_TOKEN2=<main-ws session> \
  SHOP_PASS=<storefront pw> node scripts/ui/demo-film.mjs
# concat (captions already in-frame — plain concat, no ass filter):
ffmpeg -f concat -safe 0 -i concat.txt -c:v libx264 -pix_fmt yuv420p \
  -crf 20 -movflags +faststart docs/marketing/janis-demo-investor.mp4
```

seg5 needs `SNOW_TOKEN2` — the migrated-agents panel lives in the main
workspace, not the demo one. `beats.json` records the mark for every
caption (only segments filmed in that run appear — merge when a cut is
assembled from multiple runs).

---

## Filming — `scripts/ui/demo-film.mjs` (built + proven)

Extends `demo-video.mjs` (which recorded the Shopify review video).
Adds the two things that keep headless footage from looking robotic:
a **fake on-screen cursor** (animated dot, distance-scaled glide,
click pulse — Playwright records no OS cursor) and **char-by-char
typing with jitter** (never `fill()` on camera).

```bash
SNOW_TOKEN=<minted session> SHOP_PASS=<storefront pw> \
  node scripts/ui/demo-film.mjs          # all segments → /tmp/janis-film/
ONLY=seg2 node scripts/ui/demo-film.mjs  # one segment
```

Mint the console session (SnowboardsAreUs workspace, lands in the
right brand automatically):
`cd apps/api && DATABASE_URL=… npx tsx scripts/tmp/mint-snow.ts`

| Seg | Script | Surface | Auth | Status |
|---|---|---|---|---|
| `seg1` | S0–S2 visitor chat | storefront widget | `SHOP_PASS` | **filmed 2026-10-23** — cards, sizing form, buy→checkout, return→"Send to the team" |
| `seg2` | S3 inbox + takeover | `/conversations` | session | **filmed** — picked up seg1's conv (mike@example.com) |
| `seg3` | S4 rescue→learn | agent Test | session | **filmed** — seg2's reply (11s old) was the top suggestion |
| `seg4` | S5 montage | agent rail | session | **filmed** |
| `seg5` | S6+S7 | channels + landing | session | **filmed** |

**Delivered:** `docs/marketing/janis-demo.mp4` — 3:13, 1600×1000, H.264.
The whole arc is one continuous story: the seg1 refund chat is the conv
seg2 takes over, whose rescue is the scenario seg3 saves.

**Verdict: it does not look bad.** The cursor reads as intentional,
typing reads human, LLM latency is a feature not a bug. Review-grade
footage — Shopify accepted the predecessor's output. For a hero
marketing cut, this is solid B-roll/a first cut; a hand-recorded
Screen Studio take will still beat it on polish.

### Post (ffmpeg)
```bash
cd /tmp/janis-film
ffmpeg -f concat -safe 0 -i <(printf "file '%s'\n" seg1-storefront.webm seg2-inbox.webm seg3-learn.webm seg4-build.webm seg5-close.webm) \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart janis-demo.mp4
# speed-ramp thinking pauses: select slow ranges → setpts=0.5*PTS
# VO + light grade in post (iMovie/Resolve) — footage is clean source
```

### Watch-fors
- **Push banner** — `tidy()` dismisses `.push-banner-dismiss`; new
  console chrome (cookie bars, banners) needs adding there.
- **Inbox row selector** is `a.conv-row` — agent-scoped inboxes link
  `/agents/:id/inbox/:id`, not `/conversations/…`.
- **Rescue suggestions** live in a collapsed `<details>` — seg3 clicks
  the summary first (the expand IS part of the story).
- Film order matters: seg1's chat must run before seg2 so the newest
  inbox row is the filmed conversation. seg3's suggestion list needs a
  rescue to exist — seg2's takeover creates one.
- The minted session shows operator "Maya Chen" — on-screen takeover
  markers read as the shop's teammate. Keep reply text name-free.
- **Collections-picker tap is a dead loop** (product bug, found on
  camera 2026-10-24): tapping a collection row posts its name as a
  visitor message and the agent answers with the SAME picker again
  instead of listing products. The rig no longer taps it — if the
  browse ask draws the picker, it waits 15s then sends the sharper
  "just show me all the boards you carry", which reliably pulls the
  carousel. Don't film the tap until the bug is fixed.
- `ONLY=segN` runs rewrite `beats.json` — restore marks for segments
  not re-filmed before referencing timings.
