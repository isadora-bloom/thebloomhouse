# Enterprise pricing — Wedgewood-tier

**Status:** TEMPLATE.
**Anchor:** `00-positioning.md`, `02-moat-economics.md`.

When Wedgewood (or any roll-up of 20+ venues) enters serious procurement conversations, what does the contract look like?

## Anchor: list price

The Pricing v2 Multi tier is $4999/mo per venue. For a 50-venue roll-up that's $250K/mo = $3M ARR.

That's the **list price**. Real procurement always negotiates down.

## Realistic enterprise contract shapes

### Shape 1: Per-venue with volume discount

- 1-10 venues: $4999/mo each
- 11-25 venues: $3999/mo each (20% off)
- 26-50 venues: $2999/mo each (40% off)
- 51-100 venues: $2499/mo each (50% off)
- 100+ venues: custom quote, $1999-2499/mo

For Wedgewood at ~70 venues: ~$2499 × 70 × 12 = $2.1M ARR.

### Shape 2: Flat platform fee

- Negotiated based on total venue count + contract length
- 3-year term: $1.8M/year for 70 venues = $25K/venue/year
- Includes everything: unlimited users, all tiers, dedicated support
- Auto-renew with 5% annual escalator

### Shape 3: Hybrid (recommended)

- $X base platform fee
- $Y per active venue per month
- $Z per "premium feature module" (advanced AI, custom reports, etc.)

This shape has the highest expansion potential — base grows with venue count, modules grow with adoption.

## What MUST be in the contract

- **3-year term.** Anything shorter and the customer has too much negotiation power at renewal.
- **Annual upfront payment.** Quarterly is acceptable; monthly is unacceptable for this size customer.
- **Auto-renew with 90-day notice.** Default to renewal; opt-out is the customer's burden.
- **5% annual escalator.** Inflation + value-growth captured.
- **Master Services Agreement (MSA).** Standard SaaS terms. Bloom's MSA template lives at `legal/msa-enterprise-template.md` (TBD — draft when first enterprise prospect surfaces).
- **Data residency clause.** US-only customers get US-only stamp; future EU customers trigger SCC paperwork per `data-region-and-scc.md`.
- **SLA.** Uptime 99.5% per `sla.md`. Multi-venue customers get 99.9% custom commitment.
- **Termination-for-convenience** clause: 90 days notice, prorated refund of unused term. Standard.
- **Termination-for-cause** clause: standard breach + cure period.
- **IP ownership:** Bloom owns the platform; customer owns their data; Bloom retains right to anonymized aggregate data for product improvement.

## What you SHOULDN'T agree to

- **Custom features that aren't on Bloom's roadmap.** A feature only Wedgewood needs is a maintenance tax forever. Push back on roadmap; if they insist, charge ($50-200K) as professional services.
- **Per-named-user licensing.** Per-venue is the right unit. Per-user limits the brain's value (more eyes on it = more value).
- **Source code escrow** — only at Series B+ stage and only if they're paying $5M+ ARR. Below that, Bloom is too early.
- **Indemnification for "any data breach."** Bloom indemnifies for breaches caused by Bloom's negligence. Period.
- **MFN clause** ("Most Favored Nation," guaranteeing Wedgewood the best price across all customers). MFN locks future pricing forever; never agree.
- **Acquisition right of first refusal.** They want to acquire you cheap if you exit. Don't sign this away.

## Negotiation playbook

### Discovery (week 1-2)

- What's their current spend on tooling per venue? (HoneyBook + WeddingWire + ad spend) → reveals their willingness-to-pay anchor.
- Who's the decision-maker? CFO will push price; COO will push capability; VP Sales will push pipeline impact.
- What's the pain that brought them to Bloom? "We don't have visibility across 50 venues" is different from "Our coordinators waste 2 hours/day on email."

### Pricing pitch (week 3-4)

- Lead with TOTAL value: "$200K saved in coordinator time + $400K in lost-deal recovery + $300K in upsell from cohort intelligence = $900K of value at $1.8M list."
- DO NOT lead with cost: "We're $1.8M, much cheaper than HoneyBook." That frames you as cheap; you're not cheap, you're high-ROI.
- DO mention competitors only once: "HoneyBook and Tripleseat have CRM features Bloom imports from. Our value is the cross-source brain layer they can't build without 18 months of engineering."

### Closing (week 5-8)

- Always have a "we walk if pricing falls below X" anchor in writing internally.
- Offer flexibility on payment terms (net-60, net-90 if they have purchase orders) to preserve list pricing.
- Final concession should be a non-pricing item (longer term, additional venues thrown in, training package).

## What "no thanks" looks like

If they push price below $25K/venue/year (=$2099/mo), walk. Two reasons:

1. Below that, the COGS margin compresses to break-even at scale.
2. Wedgewood-tier customers anchor pricing for everyone else. If word gets out that you sold at $1500/venue, every prospect demands the same.

Walking is hard but signals confidence. They will come back if Bloom is genuinely the brain layer they need.

## What goes in the contract

Once pricing is locked, the contract includes:

1. Pricing schedule (above)
2. Service Description (the modules they're getting)
3. SLA reference
4. MSA (master terms)
5. DPA reference (per `dpa-reference.md`)
6. Acceptable Use Policy
7. Term + termination
8. IP + data ownership
9. Indemnification + limitation of liability
10. Governing law (Virginia or Delaware preferred)

Cross-references: `00-positioning.md`, `02-moat-economics.md`, `07-honeybook-acquihire-defense.md`, `15-investor-readiness.md`, `docs/compliance/sla.md`.
