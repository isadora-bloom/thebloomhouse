# Financial model — runway scenarios

**Status:** TEMPLATE.
**Anchor:** `05-fund-returner-math.md`, `10-series-a-org-chart.md`.

Three runway scenarios. Each has assumptions, monthly burn, ARR ramp, cash-out date, and triggers to revisit.

## Assumptions (shared across scenarios)

- ACV blended: $799/mo Solo tier × 70% + $1799/mo Growth tier × 25% + $4999/mo Multi tier × 5% = ~$1100/mo blended.
- Annual ACV: $13.2K.
- Gross margin at scale: 70% (Anthropic + Supabase + Vercel + Stripe + Resend cost stack).
- Sales cycle: 30-60 days to first paying customer outside friend-of-Isadora.
- Churn: 8-15% annual at Y1-Y2; targeting < 8% by Y3.

## Scenario 1: Bootstrap to break-even (no Series A)

**Capital:** existing personal capital + Rixey cash flow + small angel ($250-500K).

**Monthly burn:** ~$15-25K (you + part-time contractor + tools).

**ARR ramp:**
- Y1 end: $300K (Rixey + 5-10 paying friends-of-Isadora)
- Y2 end: $1M (founder-led GTM saturating)
- Y3 end: $3M (slow-growth without sales hire)
- Y4 end: $7M (with one sales hire post-break-even)

**Cash-out date:** never if execution holds. Break-even ~Y2 mid.

**What this looks like:** lifestyle business that scales to $10-20M ARR over 5-7 years. Founder gets a great outcome. No fund-returner outcome.

**Triggers to revisit:**
- A real prospect demands enterprise multi-venue features that require capital
- A competitor enters that's well-funded; bootstrap can't keep pace
- Personal life changes that require liquidity sooner

## Scenario 2: Series A on traction (waiting until $1M+ ARR)

**Capital:** Series A at $25-40M post, $5-7M raised.

**Trigger:** $1M ARR + first multi-venue customer in conversation OR signed.

**Monthly burn at close:** ~$60-80K (existing) → $130-150K (post-hires from `10-series-a-org-chart.md`).

**ARR ramp post-A:**
- A close to A+12 months: $1M → $4M
- A+12 to A+24 months: $4M → $12M
- A+24 to A+36 months: $12M → $25M

**Cash-out date:** ~30 months post-A close at current burn-vs-revenue gap. Next round (B) by month 18-24.

**What this looks like:** standard venture path. Series B at $20-30M ARR; Series C at $50M ARR; exit or IPO at $100M+ ARR.

**Triggers to revisit:**
- ARR growth lags 18-month-out plan: burn-rate cut + extension round before B
- Competitor announces brain layer + raises big: accelerate B raise

## Scenario 3: Capital-constrained Series A (now)

**Capital:** $2-3M seed/seed-extension at $12-18M post.

**Trigger:** before $1M ARR but with momentum.

**Monthly burn:** ~$50-70K (you + 1-2 hires).

**Why you'd do this:** if a competitor raises $20M+ and you need defensive capital before traction-based pricing.

**Why you wouldn't:** dilution at low valuation hurts at exit. Cash before product-market fit pulls roadmap toward investor priorities, not customer priorities.

**Triggers to revisit:**
- Competitor raises big AND has overlap product → defensive capital needed
- Founder personal-runway is < 6 months → forces capital regardless of optimal timing

## Burn drivers (ranked by leverage)

1. **Headcount.** ~75% of burn. Each $200K hire is $17K/mo + benefits.
2. **AI inference (Anthropic + OpenAI).** Per-customer cost. Currently capped at $5/venue/day = $150/mo per active venue.
3. **Supabase.** Pro plan + storage + bandwidth. Currently small fraction; grows linearly with active venues.
4. **Vercel.** Pro plan currently; Enterprise needed at ~50K MAU couples, far away.
5. **Marketing / content / paid acquisition.** Low today (founder-led); ramps post-Series A.

## Margin model

At maturity:
- Revenue: $1100/mo per customer blended
- COGS:
  - Anthropic + OpenAI: $30-60/mo
  - Supabase: $15-30/mo
  - Vercel: $5-10/mo
  - Stripe: 2.9% + $0.30 → ~$32/mo on $1100
  - Resend: $1-3/mo
  - Total: ~$95-135/mo
- Gross margin: ~85% at top tier; ~70% average due to lower-tier customers having proportionally higher fixed costs

## Sensitivity analysis

What if Anthropic prices double?

- Direct hit: AI cost line ~doubles → $60-120/mo per customer
- Margin compression: 85% → 73-78% at Multi tier
- Mitigation: more aggressive Haiku-vs-Sonnet routing, prompt-cache aggressive, model-fallback to OpenAI

What if customer count doubles ahead of plan?

- Burn doesn't double; mostly fixed-cost.
- Margin improves.
- Need to hire CSM + AE earlier than `10-series-a-org-chart.md` plan.

What if churn doubles?

- 8% → 16% means net new ARR drops by ~half.
- Triggers a hard look at why churning: fit problem? pricing? competition?
- Mitigation: pause new hires until cohort retention is fixed.

## Quarterly review

Every quarter:
- Compare actual MRR + burn vs plan
- Flag any line item > 20% off
- Re-validate runway months remaining
- Decide: any change to hire sequence?

Cross-references: `01-tam-sam-som.md`, `04-b2b2c-distribution.md`, `05-fund-returner-math.md`, `10-series-a-org-chart.md`, `15-investor-readiness.md`.
