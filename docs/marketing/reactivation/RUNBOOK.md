# Reactivation campaign runbook

## Prerequisites (all external)

- [ ] `www.janis.ai` cutover complete — campaign traffic must NOT land on the
      legacy site. Verify: curl -I https://www.janis.ai → serves the new app,
      OAuth redirects (Google/Slack/Meta) re-registered, Stripe webhook
      re-pointed, old app still up for legacy clients.
- [ ] Legacy list exported — `scripts/export-legacy-bots.mjs` → ~17k contacts
      (email, name, last-seen). Verify the export actually produces the file
      before scheduling anything.
- [ ] Suppression list applied — merge any prior unsubscribes/bounces into
      the contacts suppression table before the first send.
- [ ] Resend events webhook live — `email.delivered/bounced/complained` →
      `/channels/email/events` (already configured 2026-09). Bounces feed
      suppression automatically; complaints must kill the sequence for that
      contact.
- [ ] Sending domain verified — custom Resend domain with SPF/DKIM green on
      the email channel's page (Channels → the channel → sending domain).
- [ ] GA4 funnel live — signup/first_agent/first_conversation events fire.

## Send plan

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
