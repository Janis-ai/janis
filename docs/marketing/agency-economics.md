# Agency economics — what does client #12 cost?

The question this answers: an agency resells Janis to N client workspaces —
what's the unit economics, and when does it beat a direct plan?

## The mechanism (already built)

Stripe Connect Express. The agency connects an account, sets per-tier retail
prices (floored at wholesale = the Janis plan's `baseCents`), and each client
workspace checks out as a **direct charge on the agency's account** with
`application_fee_percent` = wholesale ÷ retail — Janis takes its wholesale
cut of every invoice, the agency keeps the spread. Metered usage (messages,
LLM, voice) reports to Janis's platform customer — the agency pays wholesale
usage while invoicing the client retail.

So the agency's margin per client is: `retail − wholesale − usage spread`.

## The math (plan prices)

| Tier | Janis wholesale (baseCents) | Suggested retail | Agency gross margin |
|---|---|---|---|
| Starter | $29/mo | $79–99/mo | $50–70/mo |
| Pro | $99/mo | $249–299/mo | $150–200/mo |
| Scale | $299/mo | $599–899/mo | $300–600/mo |

Usage: agency marks up the metered rates the same way (LLM tokens, messages
beyond included, voice minutes). The `agencyPricing` map already enforces
`retail ≥ wholesale` server-side.

## The 12th-client answer

Marginal cost of client #12 for the agency ≈ zero beyond the wholesale fee —
no per-seat charge, no extra infra. An agency charging $249 retail on Pro
wholesale ($99) nets ~$150/mo/client; 12 clients ≈ $1.8k/mo recurring
margin on top of whatever service retainer they charge for managing the bots.

**For Janis**: an agency client pays full wholesale — identical revenue to a
direct customer, but the agency does the sales + onboarding. CAC ≈ 0. The
trade-off: support load lands on Janis only for platform issues (the agency
owns tier-1 for their clients), and the Connect payout flow is already
built + tested (billing.test.ts stubs Stripe end-to-end).

## Decision (needs founder sign-off)

- **Recommended posture**: keep Connect as the agency path — don't build a
  separate "agency plan." The wholesale/retail split is honest, self-serve,
  and requires zero per-client provisioning.
- **Minimum retail**: already enforced (retail ≥ wholesale).
- **Missing piece before selling this**: per-agent member scoping (so the
  agency's staff see only their clients' workspaces) — gated until the first
  real agency asks; the enforcement surface is large enough that building
  it speculatively isn't worth the audit cost.
- **When to revisit**: if an agency asks for a volume discount, answer with
  usage margin — never discount wholesale below the metered-cost floor.
