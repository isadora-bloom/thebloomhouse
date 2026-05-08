# Series A org chart

**Status:** TEMPLATE.
**Anchor:** `05-fund-returner-math.md` (Series A timing).

The team Bloom needs at Series A to deploy the round well. Roles, reporting, hire sequence.

## The minimum-viable team at Series A

Round size assumption: ~$5-10M. 18-24 month runway. Must support: shipping multi-venue features, signing first roll-up customer, scaling support.

### Founder / CEO

**You.** Owns: vision, customers > $25K ACV, hiring, fundraising, strategic deals.

### CTO / Founding Engineer

**Hire #1, ideally before Series A.** Owns: engineering org, scale architecture, AI/ML platform calls.

Profile:
- 8+ years engineering experience
- Has shipped a vertical SaaS with AI before
- Comfortable owning product + engineering at small scale (will hire below themselves)
- NOT a CRM-shape engineer (won't push toward HoneyBook-clone roadmap)

Compensation: 1-3% equity, market salary for stage.

### Head of Sales / AE #1

**Hire #2, post-Series A only.** Owns: outbound + inbound conversion, demo-to-close, contract negotiation.

Profile:
- 5+ years vertical SaaS sales experience
- Has sold to event-venue or hospitality industry preferably
- Comfortable with $25K-150K ACV deal sizes
- Founder-led-style, comfortable selling without an SDR for first 6 months

Compensation: $130-180K base + equivalent OTE.

### Customer Success Manager #1

**Hire #3, post-Series A.** Owns: post-sale onboarding, expansion + retention, feedback loop to product.

Profile:
- 3+ years CSM experience in vertical SaaS
- Empathy for venue operators (talks to them like peers, not sales targets)

### Engineering hires #2-4

**Hires #4-6, post-Series A.** Roles:
- Senior backend (Postgres / Supabase / Node) - owns identity engine + data integrity
- Senior frontend (Next.js / React) - owns couple portal + coordinator UI
- ML / AI engineer - owns Voice DNA + extraction pipelines, the brain layer specifically

### Operations / People

**Hire #7-8, late post-Series A.** Bookkeeper + part-time legal/HR.

## Total at Series A close

8 people including you. Burns ~$1.4M/year all-in. 18-month runway from $5M; 30 months from $10M.

## Reporting structure

```
                 You (CEO)
                    |
        +-----------+------------+
        |           |            |
       CTO     Head of Sales    CSM
        |
   +----+----+
   |    |    |
   E2  E3   E4
```

## What this costs

| Role | Annual all-in (US) |
|---|---|
| You | $200K (founder rate, partly-deferred until cash flow allows) |
| CTO | $200K + 2% equity |
| AE #1 | $130K base + 130K OTE = $260K + 0.5% equity |
| CSM #1 | $110K + 0.25% equity |
| Eng #2-4 | 3 × $180K = $540K + 0.5% equity each |
| Ops/HR | $80K |
| **Total** | ~$1.4M |
| Plus: tools, AWS/Vercel/Supabase/Anthropic/Stripe, legal, accounting | ~$200K |
| **Annual burn** | ~$1.6M |

## Hire sequence + triggers

| Hire | Trigger |
|---|---|
| CTO | Series A close (or pre-A if right person available) |
| AE #1 | $1M ARR + Series A capital |
| CSM #1 | 2 paying customers > $50K ACV OR 10 paying customers total |
| Eng #2 | First sustained customer-driven roadmap pressure (single eng can't keep up) |
| Eng #3 (ML) | Voice DNA quality is the bottleneck |
| Eng #4 (frontend) | Couple-portal feedback bottleneck |
| Ops | $4M ARR or 8+ employees, whichever first |

## What goes wrong

- **Hiring an AE before the founder-led GTM is repeatable.** AE arrives, can't reproduce the founder pitch, churns out in 6 months. Wasted $200K + a year.
- **Hiring engineers before product-market fit.** Engineers ship more features. Features ≠ customers. Burn accelerates without ARR.
- **Hiring a CTO who's a CRM-shape engineer.** They push the roadmap toward CRM features because that's their pattern-match. Brain shape erodes.
- **Hiring a CSM too late.** First 5 customers churn because nobody owns their outcomes. Cohort math breaks for the next 5.

## Anti-pattern: hiring to accommodate weakness

If you hire a CMO because you "don't like marketing," you'll second-guess every decision they make. Same for CFO, CTO, head of sales.

Hire when the work is genuinely beyond your bandwidth, not when it's outside your comfort zone.

Cross-references: `05-fund-returner-math.md`, `11-financial-model.md`, `15-investor-readiness.md`.
