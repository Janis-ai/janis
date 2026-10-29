# Reactivation campaign runbook

## Prerequisites (all external)

- [x] `www.janis.ai` cutover complete — DONE 2026-10-23 via CF worker
      (AGENTS.md launch item A1). Campaign traffic lands on the new app.
- [x] Legacy list exported — done a different way (2026-10-20): archived
      in-place on the wordhopapi cluster
      (scripts/archive-legacy-collections.mjs) then segmented into
      ~/Documents/janis-campaign/ — 18,819 contacts in 5 segments;
      *_verified.csv = 18,130 after email verification.
- [ ] Suppression list applied — merge any prior unsubscribes/bounces into
      the contacts suppression table before the first send. (23 prior
      unsubscribes already excluded from the campaign CSVs at build time —
      still load them into the suppressions table.)
- [x] Resend events webhook live — `email.delivered/bounced/complained` →
      `/channels/email/events` (configured 2026-09). Bounces feed
      suppression automatically; complaints must kill the sequence for that
      contact.
- [x] Sending domain verified — `mail.janis.ai` is the verified campaign
      domain on Resend (janis.ai = send-only transactional, apex MX stays
      Google). Send campaigns from mail.janis.ai, NOT the primary domain.
- [x] GA4 funnel live — signup/first_agent/first_conversation/
      channel_connected/first_takeover fire server-side on transition
      (lib/analytics.ts, localStorage-deduped).

## Send plan

> **Superseded on strategy (2026-10-20):** the real send plan lives in
> `~/Documents/janis-campaign/campaign.md`. Key changes from what follows:
> the first send IS the re-permission ask — do NOT drip into a cold list;
> send in segment waves (A1 → A2 → B in ~1k batches → C → D) not a full-
> list blast; A1/A2 are small enough to hand-send from Mike's real
> address. The prerequisites + kill conditions below still stand;
> the 3-email README sequence is the *post-opt-in* sequence, not the
> opener. Verification already ran — `*_verified.csv` (18,130 contacts).

Three emails (`README.md`), one week apart:

| Wave | When | To |
|---|---|---|
| E1 | T+0 | full list minus suppression |
| E2 | T+7d | opens + non-openers alike (different subject angle) |
| E3 | T+14d | everyone who hasn't unsubscribed or replied |

Send through the campaigns feature (not a one-off tool): campaign with 3
steps, `if_not_replied` branch conditions on steps 2–3 so anyone who replies
drops out automatically. Rate: keep under ~2k/day to protect the sending
domain's reputation; the queue spaces sends.

## Metrics to watch (daily during the run)

- Bounce rate < 4% per wave — higher means the list needs cleaning; pause.
- Complaint rate — any spike, pause immediately (Resend events → suppress).
- Replies → founder inbox; every reply is a sales conversation.
- Conversions: `conversion_events` + GA4 funnel (signup → first_agent →
  first_conversation → channel_connected). Campaign attribution lives in
  Reports → campaigns.
- CRM write-back: activity lands on HubSpot contact records (notes) for
  contacts with an external_ids anchor.

## Kill conditions

- Bounce >4% on wave 1 → clean list (verify emails) before wave 2.
- Complaint spike → pause the campaign, review copy.
- Deliverability collapse → switch sending subdomain, rewarm.

## Post-run

- Non-responders: one-time passive state — do not re-mail inside 90 days.
- Repliers who don't convert: personal follow-up, not automated.
- Feed learnings into `/for/:slug` landing variants only if a channel skew
  shows up in the data (e.g. agency-heavy responders → agency page).
