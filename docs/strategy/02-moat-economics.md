# Moat economics

**Status:** TEMPLATE.
**Anchor:** `00-positioning.md` (the moat is the brain, not the UI).

The four standard moat tests, applied to Bloom's brain shape.

## 1. Network effects

**Direct (do users benefit when more users join?):** weak. A new venue customer doesn't make existing venue customers' Bloom better in an obvious way.

**Indirect / data network effect:** **strong**. Every wedding processed makes the cross-venue cohort matching, source-quality benchmarking, and cultural-moments correlation engine smarter. A multi-venue customer's brain reads on the whole portfolio's data.

**Scoring:** [pick: strong / medium / weak] — recommend medium-to-strong as Bloom scales.

**Test for the test:** at 100 venues, can Bloom answer questions a 10-venue Bloom can't? If yes, the data network effect is real.

## 2. Switching costs

Once a venue is in Bloom for 12 months, what does it cost to leave?

**Hard costs:**
- Voice DNA training data: 12 months of mined phrases. Re-creating elsewhere requires another 12 months.
- Identity graph: tangential signals + candidate identities + cross-source matches. Lost on departure.
- Custom AI rules + prompt versions: the operator's specific tuning is gone.
- Historical correlations: 12 months of FRED / Trends / weather × wedding correlations.

**Soft costs:**
- Coordinator habit. Sage drafts → coordinator review → inbox is muscle memory after a quarter.
- Reporting coordinators have come to rely on (cohort match, source quality scorecard).

**Estimated re-creation effort:** 6-9 months of operator time + cost of the new tool + accepted gap of "we're flying blind" during the transition.

**Pricing power implication:** Bloom can raise prices 10-15% annually without meaningful churn IF voice training is meaningfully accumulated. This is the core LTV argument.

## 3. Counter-positioning (does the incumbent face a strategic conflict copying us?)

**HoneyBook copying Bloom's brain shape:**
- Their pricing model assumes single-source data. Charging $799/mo for "brain on top of HoneyBook only" looks like a 10x price hike for marginal value.
- Their feature roadmap is CRM breadth. Adding deep brain features means hiring AI engineers in a market where their DNA is full-stack.
- Their cross-source story is weak. They can't credibly say "we'll learn your voice from your Knot exports too" without becoming a layer that competes with their own integration partners.

**Aisle Planner copying:** weaker counter-position. They have less to lose and more incentive.

**Verdict:** moderate counter-positioning vs HoneyBook (default incumbent). Weaker vs new entrants.

## 4. Cornered resource (is there a thing competitors can't access?)

**Voice DNA per venue.** Each venue's email history is the venue's data, not industry-shared. Bloom imports it once with permission and learns from it. A competitor would need the same permission + 12 months. Not literally cornered but practically expensive to replicate.

**Cross-venue signals from the multi-venue customer.** Wedgewood-tier signals are NOT in any single competitor's data. First Bloom multi-venue customer is the moat that the second multi-venue customer joins.

**Verdict:** weak corner alone, but combined with switching costs the data is hard to dislodge.

## LTV / CAC math (placeholder — fill from real Rixey numbers)

- ACV at Growth tier: $[____]/mo × 12 = $[____]
- Gross margin at scale: [___]% (mostly Anthropic + Supabase costs)
- Annual churn: [___]% (target < 10% gross at 24-month mark)
- LTV = ACV × margin / churn = $[____]
- CAC: assume [_____] (founder-led, near-zero ad spend → low CAC, ceiling ~5-10K per logo)
- LTV/CAC ratio: [____x]

**Healthy benchmark for SaaS:** 3-5x LTV/CAC.

## Net moat-economics call

[After filling above, the recommendation is one of:]
- **Strong moat, defensible business.** Pricing power exists; LTV/CAC supports a Series A pitch.
- **Moderate moat, founder-defensible only.** Non-founder operator might struggle to retain; price aggressively while founder is in the seat.
- **Weak moat, race to escape velocity.** Need to ship enterprise features (multi-venue) and lock in a roll-up customer before HoneyBook copies.

## What changes the call

- Series A prospect demands defensibility narrative → upgrade to "strong" requires the multi-venue customer first
- A competitor announces an AI brain layer → re-validate the data network effect math
- Voice DNA proves to be re-creatable in < 3 months → switching costs collapse → moat downgrades

Cross-references: `01-tam-sam-som.md`, `08-competitive-landscape.md`, `13-enterprise-pricing-wedgewood.md`.
