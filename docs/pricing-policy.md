# Pricing + GTM policy

**Date locked:** 2026-05-08 · **Decided by:** Isadora Martin-Dye

The policy answers to Group D. This doc is the canonical source for every pricing/GTM question. When the marketing site, the Stripe config, or a sales call disagrees with this doc, the doc wins.

---

## Founding Member terms (D1)

**50% off list price for 24 months from signup.** After month 24, the customer transitions to standard list pricing (whatever tier they're on at that point).

Why 24 months not "forever":
- Forever-discount creates a permanent two-class customer base; Founding Members eventually become a margin drag.
- 24 months is long enough to feel like meaningful loyalty recognition.
- Customers who renew at full price post-24 are demonstrating real value capture.

Mechanics:
- Stripe coupon code applied at signup; code expires automatically at 24 months from invoice 1.
- No transferability. If a Founding Member sells the venue, the new owner pays full price.
- Customer-visible transparency: "50% off your first 24 months as a Founding Member" everywhere it's mentioned.

Cap: first 25 customers globally only. After that, no more Founding Member status; Bloom returns to standard pricing.

---

## Annual prepay discount (D2)

**15% off the monthly rate for an annual prepay.**

Industry standard ranges 15-20%; we land at 15% because:
- Bloom's monthly cash flow is healthy at small scale; we don't need to incentivise prepay heavily.
- 15% protects gross margin against the higher-tier (Multi/Enterprise) where lower discount preserves more revenue.
- Easy to remember + communicate.

Mechanics:
- Stripe annual product per tier with the 15% discount baked into list price.
- Customer can switch monthly→annual at next renewal; can't switch annual→monthly mid-term.
- Refund-on-cancel is pro-rated to the day, less a 5% admin fee (per D4 cancellation policy).

---

## Dunning escalation ladder (D3)

When a Stripe payment fails (subscription enters `past_due` status), this is what happens:

| Day | Action | Implementation status |
|---|---|---|
| 0-7 | Stripe auto-retries on its standard schedule | ✓ shipped |
| 8 | First reminder email to billing contact | TODO (cron) |
| 14 | Second reminder email + in-app red banner on every coordinator page | TODO (cron + UI) |
| 21 | Sage drafts paused (autonomous-sender stops; coordinator can still manually send via Gmail) | TODO (enforcement) |
| 30 | Read-only mode (mutating endpoints return 402; couples can still read; coordinator can resolve billing) | TODO (enforcement) |

After day 30, the customer either resolves billing (returns to active) or churns. No further escalation past 30 days.

Couple-portal access stays read-only throughout — couples never see "your venue's billing is past due." The dispute is between Bloom and the venue.

Coordinator override: if the venue's billing contact is unreachable for legitimate reasons (medical leave, etc.), super_admin can extend by 30 days via a manual override stored on `venues.dunning_extension_until`.

**Implementation:** mig pending + cron `dunning_escalate` daily at 09:00 UTC. Builds on existing `past_due_since` column from mig 209.

---

## Cancellation policy (D4)

**Cancel anytime; access continues to the end of the current billing period.**

Mechanics:
- Self-serve cancel button in `/settings/billing`.
- For monthly subscriptions: cancellation is effective at the end of the current month. No refund.
- For annual subscriptions: cancellation is effective at the end of the current annual term BY DEFAULT. Customer can request a pro-rated refund of unused months minus a 5% admin fee.
- After cancellation, the venue's data is retained for 30 days (per `vendor-security-review.md`); customer can export anytime in that window.
- After 30 days post-cancellation, data is hard-deleted. Re-signup creates a fresh account.

No "30-day written notice required" or other friction. Industry-standard friendly cancellation.

---

## Per-seat pricing (D5)

**Not in initial pricing. Single flat rate per venue covers all coordinator users.**

Rationale: per-seat pricing limits the brain's value (more eyes = more learning). Bloom benefits when an entire team uses it.

Re-evaluation trigger: if a single venue ever exceeds 10 active coordinator users on the platform AND those users are clearly distinct people (not shared logins), revisit.

---

## Per-email pricing (D6)

**No per-email line item. All-you-can-eat under the existing $5/venue/day cost ceiling.**

Rationale: email send cost is ~$0.001 per Resend send. Anthropic inference is the real cost driver, capped at $5/venue/day already. The cost ceiling IS the abuse guard. If a venue's auto-send pattern is genuinely unhealthy (script-driven, off-pattern), the ceiling auto-pauses and we have a human conversation.

What we'd never do:
- "Email volume packs" sold as add-ons. Creates account-management drag for marginal margin.
- Hard cap on emails. Coordinators legitimately scale; throttling them is bad UX.

What we WOULD do (only if needed):
- A higher daily ceiling on Multi/Enterprise tiers (currently $5/venue/day across all tiers). E.g., Multi could get $15/venue/day if usage data shows ceiling-hit becomes routine for them.

---

## Tier names (D7)

**Keep as-is:** `pre_opening / solo / growth / multi / enterprise`.

Audit had flagged "reconsider" but on review the names map to clear customer profiles:
- pre_opening: not yet booking weddings
- solo: 1-2 events/year, side-business shape
- growth: 10-25 events/year, primary business
- multi: 30+ events OR multi-venue operator
- enterprise: roll-up customer (Wedgewood-tier)

The names are technical (small caps, no marketing fluff) which suits the marketing-site copy that explains each.

---

## Sales-assisted vs self-serve (D9)

**Self-serve up through Multi tier. Enterprise is "Talk to us."**

Self-serve means: signup, payment, onboarding all automated. Coordinator clicks signup → enters card → onboarding wizard → starts using.

Enterprise tier requires sales because:
- Custom MSA per `13-enterprise-pricing-wedgewood.md`.
- Volume discounting beyond the standard list price.
- Dedicated AM onboarding flow.
- 99.9% SLA (vs 99.5% standard) negotiation.

Mechanics:
- Pricing page: Multi tier has a "Start trial" CTA → standard signup. Enterprise tier has a "Contact us" CTA → opens an email/Calendly link.
- Sales engagement starts before contract signature; closes through DocuSign + Stripe invoice (not card).

---

## Founder-led GTM ceiling (D10)

**Open. Track and revisit at $500K ARR.**

How to find the ceiling:
1. Track hours-per-deal from first non-Rixey demo onward (log in a spreadsheet: prospect / first touch / hours invested / status / outcome).
2. Track hours-per-week available for selling (vs Rixey ops + Bloom product work).
3. Compute: (selling hours / week × 4 weeks) ÷ avg hours per deal = deals/month.
4. Multiply by ACV blend ($1100/mo) = monthly ARR additions.
5. Annualise = founder-led ceiling.

Industry rough range: $500K-1.5M ARR for a strong founder-led seller in vertical SaaS. Bloom's specific number depends on:
- ACV mix (more Multi-tier customers = higher ARR per deal but longer sales cycle).
- Inbound vs outbound mix (inbound is much faster; outbound takes 5-10x more hours per close).
- Founder split (Isadora running Rixey + Bloom + 4 other projects → effective selling hours is much lower than 100% would be).

When to hire AE #1: when founder-led ceiling has been hit AND product-market fit is repeatable AND there's $5M+ ARR runway in the funnel that the founder can't service.

---

## Demo→signup conversion measurement (D8)

**PostHog.** See `docs/posthog-setup.md` for installation.

What to track from Day 1:
- Page views (autocapture)
- Signup completion (event: `signup_complete`)
- First brain-dump / first email pipeline run / first Sage draft viewed (events: `first_brain_dump`, `first_email_processed`, `first_draft_viewed`)
- Cancel events (event: `subscription_canceled`)

Funnel reports to monitor weekly:
- Pricing page → signup
- Signup → first session
- First session → first AI interaction
- First AI interaction → continued usage (day 7 / day 30 retention)

---

## Re-validation cadence

This doc is reviewed:
- **Annually** for the policy decisions (D1, D2, D4, D5, D6, D7).
- **Quarterly** for the dunning ladder (D3) and operational rules.
- **At every fundraise** for D9 + D10 (revenue model + founder ceiling).

Last reviewed: 2026-05-08.
