# Intel Canonical API — Doctrine

**Date:** 2026-05-21 · **Plan day:** Day 3 of `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md`
**Status:** doctrine. No code changes here — it is the contract Days 4-5 stub and Days 14-18 implement against.
**Anchors:** `ENGINEERING-BUILD-PLAN.md` §6 · `CONSOLIDATION-AUDIT.md` (Day 1, Agent C + D + E) · `CASCADE-CANONICAL-WRITER.md` (Day 2) · plan § N

The reader counterpart to the writer doctrine. Where the writer doctrine constrained how spine rows are *created*, this constrains how they are *read*.

---

## 1. The rule

**Every Intel surface calls one of exactly six functions. Surfaces are dumb renderers.**

This is Build Plan R3: read paths are dumb and stateless. A surface (`page.tsx`) takes the return of one canonical function and renders it. It contains **no data derivation** — no ratio math, no filtering, no joining. If a surface needs a computed value, that computation moves into the canonical function.

Day 1 found 65 `/intel` page.tsx files (Agent D) and 80 `src/lib/services/intel/*` files (Agent E), each with its own opinion of what's true. That is why two pages show different numbers for the same fact. Six functions, one implementation each, is the fix.

**The number six does not grow.** If a future surface needs something the six can't return, the move is to add a parameter to one of the six — never a seventh function.

---

## 2. The six functions

All live at `src/lib/intel/canonical.ts` (the Day 4-5 stub target). Full TypeScript, no `any`.

### 2.1 `getVenueOverview`

```ts
getVenueOverview(venueId: string): Promise<VenueOverview>

interface VenueOverview {
  couples: { total: number; byLifecycle: Record<LifecycleState, number> }
  recentActivity: ActivityItem[]          // last N spine writes, newest first
  dataMaturity: { backfillStatus: string; oldestTouchpoint: string | null; n: number }
  generatedAt: string
}
```

Top-line counts + lifecycle distribution + recent activity + a data-maturity honesty block. Partially exists today as `buildSourceQualityReport` (D8, shipped 2026-05-20) — Day 14 folds the venue-level rollup of that into this.

### 2.2 `getSourceAttribution`

```ts
getSourceAttribution(venueId: string, opts?: {
  model?: 'first_touch' | 'last_touch' | 'linear' | 'time_decay'   // default 'first_touch'
  period?: DateRange
}): Promise<SourceAttribution>

interface SourceAttribution {
  model: AttributionModel
  channels: ChannelStat[]                 // each: { channel, n, conversion, cac, revenuePerDollar, enoughData }
  topByVolume: string | null
  topByConversion: string | null          // deliberately separate — volume ≠ conversion
  generatedAt: string
}
```

**Already exists under a different name.** Day 1 Agent C: `buildCoupleAttribution` (D3, shipped 2026-05-19) is couple-keyed first-touch attribution. Day 14 is **rename + add the opts**, not greenfield.

**Reads the DERIVED first-touch, not stamped `weddings.source`** (§ N.12 + Day-2 doctrine §6). First-touch = the earliest credible touchpoint per couple, computed here. The couple's self-reported `discoverySource` is one touchpoint among them; a Knot relay email predating a "Google" self-report outranks it.

**All four models kept, UI defaults to first-touch** (Bucket C, plan § N). The other three models are opt-driven — the math already exists in `buildCoupleAttribution`; surfacing only first-touch by default is a UI choice, costs nothing to keep the rest.

### 2.3 `getCohortFunnel`

```ts
getCohortFunnel(venueId: string, opts?: {
  period?: DateRange
  segment?: SegmentKey                    // 'channel:knot' | 'season:spring_2026' | 'cohort:cultural_diverse' | ...
  operatorAxis?: boolean                  // § M — segment by responded_by for Tier 5
}): Promise<CohortFunnel>

interface CohortFunnel {
  funnel: FunnelStage[]                   // inquiry → tour → booked → completed, each with n
  responseTime: Distribution              // median + delta-over-12mo, carries enoughData
  leadTime: Distribution                  // inquiry-to-event-date
  conversionCurve: CurvePoint[]
  knee: { responseHours: number; dropoffAfter: number } | null   // § M — detectKnee()
  textPatterns: ThemePattern[]            // emerging themes (Wave 5B cohort-rollup)
  operatorBreakdown?: OperatorStat[]      // present only when operatorAxis: true
  generatedAt: string
}
```

Wraps the existing `loadCohortData` touchpoints-keyed loader (Day 1 Agent C — `/intel/cohort` + `/intel/heat` + `/intel/source-quality` already use it; it is already off the legacy attribution tables).

**Two § M additions:**
- `operatorAxis: true` → returns `operatorBreakdown` segmented by `responded_by`: per-coordinator response-time, reply-to-arrival alignment, stalled-engagement detection. Answers battery Tier 5 (Q22-25) without a seventh function.
- `knee` → a `detectKnee()` helper (~30 lines) scans the conversion curve for an inflection point. Answers Q3 (non-linear response-time threshold). `null` when no knee is detectable.

### 2.4 `getCoupleJourney`

```ts
getCoupleJourney(venueId: string, coupleId: string): Promise<CoupleJourney>

interface CoupleJourney {
  couple: CoupleIdentity                  // names, lifecycle, heat
  ribbon: TouchpointRibbon[]              // every touchpoint, ordered, each with cascade_stage + cascade_reason
  progression: ProgressionEvent[]
  identityProfile: CoupleIdentityProfile  // Wave 4 reconstruction
  lookAlikeCohort: CoupleRef[]
  generatedAt: string
}
```

`ribbon` carries `cascade_stage` + `cascade_reason` per touchpoint — Day 1 Agent C found those columns populated but with zero readers. Surfacing them here is what answers battery Q5 (model transparency); the Day 17-18 UI piece renders it.

### 2.5 `getDailyList`

```ts
getDailyList(venueId: string): Promise<DailyList>

interface DailyList {
  needsReply: CoupleRef[]
  goingCold: CoupleRef[]
  toursThisWeek: TourRef[]
  highIntent: CoupleRef[]                 // Wave 5A close-probability + key_signals
  generatedAt: string
}
```

New function — the substrate for the Day 20-22 landing page. Each block is a canonical-function read; the landing page renders five blocks and nothing else.

### 2.6 `askIntel`

```ts
askIntel(venueId: string, question: string): Promise<IntelAnswer>

interface IntelAnswer {
  answer: string
  evidence: EvidenceRef[]                 // verbatim quotes / row refs — never an unsourced number
  confidence: 'high' | 'hedged' | 'refused'
  generatedAt: string
}
```

Wraps the existing NLQ brain. The honesty rails are runtime, not just prompt: a forecast question returns `confidence: 'hedged'`; a question whose data doesn't exist returns `confidence: 'refused'` with an explanation; a false premise gets challenged. Battery Tier 4 (Q17-21, Q31-32) tests exactly this.

---

## 3. Honest no-data semantics (R5)

Every metric the API returns carries its own honesty. This is not optional decoration — it is the contract.

```ts
interface Distribution {
  value: number | null                   // null when no data, never 0-as-fake-answer
  n: number                              // sample size, always present
  enoughData: boolean                    // false below the per-metric threshold
  reason?: 'insufficient_sample' | 'no_data' | 'zero_denominator'
}
```

Rules:
- **Every ratio uses `null` on a zero denominator.** Conversion of a channel with zero inquiries is `null`, not `0`.
- **Every aggregation carries `n`.** A surface can show "median response 4h" only alongside "(n=312)".
- **Below-threshold samples set `enoughData: false`.** The surface renders an honest "not enough data yet" state, not a number.
- **Sage (`askIntel`) and Intel surfaces refuse the same way for the same reason.** Prompt-level rails for Sage, data-level rails for surfaces — one honesty doctrine, two enforcement points.

This is what makes battery Q32 (false-premise: "why did volume spike in March 2024?") answerable: `getCohortFunnel` returns the real March-2024 `n`, `askIntel` sees it didn't spike, and challenges the premise instead of fabricating a cause.

---

## 4. The cache contract

Build Plan §6 specs a two-tier compute (real-time derivation + `intel_rollups` batch cache). Plan § B Bucket B **defers `intel_rollups`** — no surface measured >500ms, premature for the 25-day window.

So the Day-3 cache contract is minimal:
- Every canonical function derives live from the spine on each call. No cache.
- If, during Days 14-16, any single function exceeds ~500ms for Rixey-scale data, that one function gets a content-hash cache — not a blanket `intel_rollups` layer.
- A cache, if added, exists for **cost, not correctness**, and is invalidated by spine writes. The spine is always the truth.

---

## 5. What already exists — Day 14-16 is mostly renaming

| Canonical function | Today | Day 14-16 work |
|---|---|---|
| `getSourceAttribution` | `buildCoupleAttribution` (D3) | rename + add `model`/`period` opts + read derived first-touch |
| `getVenueOverview` | `buildSourceQualityReport` (D8) — partial | fold venue rollup in |
| `getCohortFunnel` | `loadCohortData` loader | wrap + add `operatorAxis` + `detectKnee` |
| `getCoupleJourney` | journey-ribbon component logic | consolidate into one function |
| `getDailyList` | — | new (Day 20-22 landing substrate) |
| `askIntel` | NLQ brain (`intel-brain.ts`) | wrap + enforce honesty rails |

Two of six are renames, one is a wrap, one is a consolidation, one is new, one is a wrapper. Less greenfield than the plan first assumed (plan § N correction).

---

## 6. Battery coverage

| Function | Battery questions it answers |
|---|---|
| `getCohortFunnel` | Q1, Q2 (response-time distributions), Q3 (knee), Q4 (channel×time), Q11, Q14, Q22-25 (operatorAxis), Q13/15/16/27 (textPatterns) |
| `getSourceAttribution` | Q5, Q26 (volume≠conversion), Q28, Q33 (consistency — same function, same data, same answer across reframings) |
| `getCoupleJourney` | Q5 (cascade_stage transparency), Q6, Q29, Q36 |
| `getVenueOverview` | Q30 (data completeness self-report) |
| `getDailyList` | Q19, Q34 (the workflow chain) |
| `askIntel` | Q17-21, Q31-32 (honesty + refusal), catch-all for the rest |

Q33 (adversarial consistency) is structurally guaranteed: "what's my best channel" / "which channel should I cut" / "where to invest" all call `getSourceAttribution` with the same data — they cannot contradict.

---

## 7. What this document commits

- Six read functions. The number does not grow; new needs become parameters.
- Surfaces are dumb renderers — zero derivation logic in `page.tsx`.
- Every metric carries `n` + `enoughData`; every ratio is `null` on a zero denominator.
- `getSourceAttribution` reads the derived first-touch, all four models as opts, UI defaults first-touch.
- `getCohortFunnel` carries `operatorAxis` (Tier 5) and `knee` (Q3) — § M additions, not new functions.
- No blanket `intel_rollups` cache; per-function content-hash cache only if a function proves slow.
- Day 14-16 is mostly renaming existing D3/D8 work, not greenfield.

Days 4-5 stub this contract + the writer contract, with shape-only integration tests. Day 6 produces the signed kill list. Days 14-18 implement these six and migrate the 8 KEEP surfaces onto them.
