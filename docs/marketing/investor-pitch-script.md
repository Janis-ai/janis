# Investor pitch — product demo script (~3:30, record live)

For Mike to record himself. Structure inverts the filmed cut: instead of
one narrow thread end-to-end, we **open on breadth**, go deep on a single
thread to prove it's real, sweep the platform, land on distribution.

The three claims an investor should walk away with:

1. **It's a platform, not a widget** — every channel into one inbox, one
   agent definition, one set of rules.
2. **It compounds** — every human rescue becomes a regression test, every
   gap becomes a knowledge draft. The product gets better because it was
   used.
3. **Distribution is built in** — 17k+ legacy installs migrate in one
   click; Shopify app is listed; the surface is already out there.

Recording notes: light or dark console both work — pick one and stay in
it. 1600×1000 or larger. SnowboardsAreUs workspace has ~85 real-looking
conversations; use `mike@example.com` threads for the deep dive. Speak
under the footage — every line below maps to what's on screen.

---

## Act 0 — The queue (0:00–0:15)

**Screen:** `/conversations` — wide inbox shot. Channel badges visible:
BUBBLE, EMAIL, WHATSAPP, SMS, SLACK. Hover nothing; let the list read.

> "This is every customer conversation a business has — web chat,
> WhatsApp, email, SMS, voice, Slack — landing in one queue. Most lines
> are the AI doing the work. The flagged ones are asking for a human."

## Act 1 — One thread, end to end (0:15–1:00)

**Screen:** open a SnowboardsAreUs storefront conv (any with cards +
escalation). Scroll the transcript at reading pace — product cards,
checkout link, the return ask, "Send to the team" form, takeover markers.

> "Here's one, end to end — a real Shopify store, not a mock. A product
> question answered from the live catalog — real prices, real stock —
> a checkout link in the thread, then a return that needs judgment."

**Screen:** click **Take over**, type one short human line, send.

> "The agent stops — by design. A human steps in, same thread, full
> context, and hands it back. The customer never repeats themselves."

## Act 2 — The flywheel (1:00–1:35)

**Screen:** agent → **Tests** → expand "N rescued conversations" → the
thread you just saved is the top row → **Save as tests** → the scenario
appears with its AI-drafted expectation.

> "And every save becomes a regression test — the gap is flagged, the
> fix is drafted, the next customer never waits on a human for that
> question. That's the flywheel: the product gets better because it was
> used. Nobody reselling a thin GPT wrapper has this loop."

## Act 3 — The platform sweep (1:35–2:30)

~8s per surface, montage pace, one VO line each:

| surface | screen | line |
|---|---|---|
| Knowledge | `/agents/:id/knowledge` | "It answers from what it knows — catalog, docs, policies." |
| Behavior | `/agents/:id/behavior` | "It acts how you tell it — tone, procedures, when to stop." |
| Actions | `/agents/:id/integrations` | "Tools it can run — orders, refunds, CRM — with approval gates on anything that spends money." |
| Ask Janis | `/ask` — type "which conversations need a human right now?" | "And the operators get a copilot that knows the whole workspace." |
| Campaigns | campaigns surface | "It doesn't just answer — abandoned carts, win-backs, proactive outreach." |
| Channels | `/agents/:id/channels` | "One agent definition, deployed everywhere a customer already is." |

## Act 4 — Distribution (2:30–3:00)

**Screen:** Michael's workspace → Settings → Escalation → janistest3
card → "Migrated from the classic setup — 5 agents" panel with engine
badges + Manage links.

> "And here's the part you can't buy: seventeen thousand businesses run
> the classic Janis inside Slack today. Migrating is one click — agents,
> channels, credentials come with them. Distribution is a rail, not an
> ad spend."

## Act 5 — Close (3:00–3:15)

**Screen:** back to the inbox, or the landing hero.

> "AI when AI is best. Humans when humans are needed. One seamless
> conversation — and a system that learns every time it was wrong.
> That's Janis."

---

## If a section can't be filmed live

- **Voice channel**: don't call it live — a Channels card showing the
  connected Twilio number is enough; VO: "…even the phone line."
- **Ask Janis**: ask something it can actually answer — "which agents
  have the most unresolved alerts?" is safer than open-ended analysis.
- **Campaigns**: if the workspace has none, show the settings surface
  and let the line carry it.
- The filmed Playwright cut (`janis-demo-investor.mp4`) covers Acts 0–2
  verbatim — splice it in for the storefront/inbox/flywheel acts if a
  live take goes sideways; it's already synced and captioned.
