# HoneyBook acqui-hire vs build defense

**Status:** TEMPLATE.
**Anchor:** `00-positioning.md`, `02-moat-economics.md`.

If HoneyBook (or another well-capitalised CRM) decides Bloom is a threat or an opportunity, what's the defense? Three scenarios.

## Scenario A: HoneyBook builds a competing brain layer

**Likelihood:** medium-high within 24 months.

**What it looks like:** HoneyBook ships "HoneyBook Insights" — an AI layer on top of their CRM data. Marketed as "everything Bloom does, free with your HoneyBook subscription."

**Why it's weaker than Bloom:**
- Single-source. Only learns from HoneyBook data; can't ingest Knot, WeddingWire, Instagram, Pinterest signals.
- Cross-tenant constraint. Their AI training is scoped per-customer because their multi-tenant architecture forbids cross-pollination.
- DNA mismatch. HoneyBook's engineering is full-stack CRM, not data + ML.

**Bloom's defense:**
1. **Cross-source narrative.** "We learn from your HoneyBook export PLUS your Knot, WeddingWire, Instagram, Pinterest, Facebook, and Google Business signals. They learn from your HoneyBook only."
2. **Voice DNA pre-training.** Customers who have a 6-month head start on Bloom voice training cannot get equivalent quality from HoneyBook in less than 6 months even if they switch.
3. **Multi-venue play.** Roll-ups CANNOT use HoneyBook Insights because each venue is its own HoneyBook account. Bloom is the only way to get cross-venue intelligence.

**Decision:** if HoneyBook ships an Insights layer, double down on cross-source + multi-venue messaging. Don't compete on price.

## Scenario B: HoneyBook acquires Bloom

**Likelihood:** low-to-medium, depends on Bloom's traction.

**Why they'd do it:** buying out the brain shape rather than building. Saves them 12-18 months. Talent acquisition (you + your hires).

**Likely terms range:**
- At $1M ARR: $5-10M acquihire (mostly equity rolling, small founder cash)
- At $5M ARR: $25-50M (cash + earnout)
- At $15M ARR: $75-150M (real exit, accelerator stock)
- At $50M+ ARR: probably not them — too expensive, their valuation can't support

**Defense framework:**

1. **Don't position to be acquired by HoneyBook specifically.** That's a 1-buyer market and they'll lowball.
2. **Position to be acquired by 3+ potential buyers.** HoneyBook, Aisle Planner, Tripleseat, Wedgewood, a private-equity-backed roll-up of any of those. Multiple bidders = real pricing.
3. **Build features that are valuable to multi-vertical events not just weddings.** Expands the buyer set to include corporate-event SaaS (Cvent, Tripleseat) and B&B-software roll-ups.
4. **Maintain optionality with cash.** Burn rate has to leave at least 18 months of runway at any negotiation moment. Desperate sellers get bad prices.

**Decision:** never sell to a single bidder without a competing offer. Build the cross-vertical story to broaden the buyer set.

## Scenario C: HoneyBook ignores Bloom

**Likelihood:** medium. They're 100x bigger; we may not blip on their radar until Bloom hits ~$10M ARR.

**Why this is good:** more time to build the moat. More venues onboarded with voice DNA before they notice.

**Why this is a trap:** false sense of security. The week after they notice, the threat materialises. We need to be defensible BEFORE we're noticed, not after.

**Defense:**
- Ship the cross-source story now (already shipped: brain-dump scraper contract + 11 platform detectors)
- Lock in voice DNA training (Gmail backfill shipped)
- Sign a multi-venue customer (the actual irreversible defense)
- Quietly hold pricing power; don't telegraph the moat to competitors via blog posts

**Decision:** assume Scenario C is the current state. Don't change anything based on hope.

## Triggering events that flip scenarios

- HoneyBook announces an "Insights" / "AI" / "Intelligence" product → Scenario A active. Within 30 days: blog post + sales script + pricing review.
- HoneyBook reaches out for "a chat" → Scenario B prep. Get legal counsel + a competing buyer in conversation immediately.
- Bloom hits $5M ARR and HoneyBook still hasn't reacted → Scenario C reading is correct. Continue.

## What we WON'T do

- Negotiate exit terms with HoneyBook before $5M ARR. Their best offer pre-traction is a lowball acquihire.
- Adjust roadmap to mirror HoneyBook's CRM-shape "to compete." That sacrifices the brain moat to fight on their turf.
- Hire ex-HoneyBook employees who might leak our roadmap during their notice period.

Cross-references: `02-moat-economics.md`, `08-competitive-landscape.md`.
