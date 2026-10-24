# Janis product demo — script (~2:30)

Audience: founders + support leads evaluating AI customer service.
Differentiator the whole script is built around:
**"AI when AI is best. Humans when humans are needed. One seamless
customer conversation."**

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
| `seg1` | S0–S2 visitor chat | storefront widget | `SHOP_PASS` | **needs password** |
| `seg2` | S3 inbox + takeover | `/conversations` | session | filmed, verified |
| `seg3` | S4 rescue→learn | agent Test | session | filmed — the seg2 conv appeared as the top suggestion |
| `seg4` | S5 montage | agent rail | session | filmed, verified |
| `seg5` | S6+S7 | channels + landing | session | filmed, verified |

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
