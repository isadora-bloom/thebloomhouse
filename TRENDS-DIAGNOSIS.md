# Trends / Macro / Cultural Events — Diagnosis

Date: 2026-05-09 · Scope: why /intel/cultural-moments, /intel/trends, /intel/macro-correlations produce nothing interesting (or nothing).

## 1. TL;DR

The feature is **alive but starved on three sides at once**:

1. **Cultural moments queue is empty** unless SerpAPI + a metro is set per venue AND the spike detector has a 14-week-deep series with z>=2.5 sustained. The cron does run nightly (`vercel.json:48-49`), but the proposer is purely a search-spike z-score algorithm — there's **no LLM proposer that suggests "Royal Wedding 2026" or "cottagecore peak"**. Anything with a bulky baseline gets thrown out by the volatility guard at `cultural-moments-auto-propose.ts:132`.
2. **Calendar channel is geographically blind.** `getVenueGeoScope` (`correlation-engine.ts:430-443`) only ever resolves to `'us'` or `'us_<state>'`. Metro-level events (`us_va_culpeper`) **cannot be activated by code path** — there's no writer that constructs them and the schema's hierarchical model documented in CLAUDE.md is unreachable.
3. **Bonferroni floor is fine, but FRED + cultural channels add empty/flat columns** that count toward the test denominator. With ~10-15 active channels at n=90, the corrected critical |r| math gives ~0.40-0.45, which is below the 0.6 effect-size floor — so the floor binds. But pure macro × macro pairs (FRED × FRED) trivially score r ≈ 0.95 (CPI vs S&P forward-filled monthlies are almost monotonic) and dominate the surface UNLESS the user clicks the "Venue-relevant" filter chip, which IS the default — so what they see is "0 of N narrations match this filter."

The macro-correlations surface very plausibly renders **"No correlations match this filter — N hidden by 'Venue-relevant'"** because every clearing pair is `macro_x_macro` (forward-filled FRED series correlate with each other near-perfectly).

## 2. Surfaces audited

| Surface | File | Current state |
|---|---|---|
| `/intel/cultural-moments` | `src/app/(platform)/intel/cultural-moments/page.tsx` | Renders empty awaiting-queue if proposer hasn't fired or all proposals deduped. UI is correct. |
| `/intel/trends` | `src/app/(platform)/intel/trends/page.tsx` | Renders Google-Trends sparklines + 4w-vs-4w deviations. Independent of correlation engine — works if `SERPAPI_API_KEY` set + `venues.google_trends_metro` populated. **Different lifecycle from macro-correlations.** |
| `/intel/macro-correlations` | `src/app/(platform)/intel/macro-correlations/page.tsx` | Default filter is `venue_relevant`. If only `macro_x_macro` correlations cleared, displays "No correlations match this filter" with hidden count. |
| `/intel/insights` | `src/app/(platform)/intel/insights/page.tsx` | Reads `intelligence_insights` rows directly; correlation rows surface here too. |
| `/intel/briefings` | `src/app/(platform)/intel/briefings/page.tsx` | Briefings via `generateWeekly/MonthlyBriefing` — `intel-brain.ts` does NOT pull cultural_moments, fred_indicators, external_calendar (per yc-partner.md HIGH 12). Briefings cannot tell macro stories. |

## 3. Engine flow trace

### Inputs (channel writers)

| Channel | Writer | Status |
|---|---|---|
| `inquiries` | `weddings.inquiry_date` | ✅ working |
| `<source>_<metric>` (marketing_metric) | `engagement_events` (storefront-analytics-import) | ⚠️ needs storefront imports per venue |
| `<platform>_signals` (tangential) | `tangential_signals` (T5-Rixey-NN reader fix landed 2026-05-02) | ✅ working when platform sigs exist |
| `fred_<id>` | `fred-fetch.ts` via cron `fred_daily_refresh @ 0 3 * * *` | ✅ wired (was the YC-partner CRITICAL 1; fixed by `vercel.json:43-46`). **Requires `FRED_API_KEY` env var** |
| `calendar_<category>` | `calendar-writer.ts` via cron `external_calendar_refresh @ 0 4 * * *` | ✅ writer ships nationwide + VA rows |
| `cultural_moments` | `cultural-moments-auto-propose.ts` via cron `cultural_moments_auto_propose @ 15 8 * * *` | ⚠️ proposer is statistical only; relies on coordinator confirming |
| `government_events` | `loadGovernmentSeries` | unclear (didn't audit deeply; not relevant to user complaint) |

### Engine

`buildSeries` → `correlation-engine.ts:290-419`. Reads all of the above, runs lagged Pearson, writes top-5 to `intelligence_insights` upsert by stable v5 UUID. ✅ working.

### Storage

`intelligence_insights` rows of `insight_type='correlation'` (engine output) and `insight_type='correlation_narration'` (LLM-narrated cards).

### Renderers

- `/intel/macro-correlations` reads `correlation_narration` rows via `listExistingNarrations` (`correlation-narration.ts:852-923`).
- `/intel/insights` reads raw `correlation` rows via `/api/intel/insights`.
- Briefings do **not** read either (HIGH 12 finding).

## 4. Specific findings

### A. Cultural moments proposer is a single algorithm with very strict gates

`cultural-moments-auto-propose.ts:113-167`. To propose:
- Need `>= 14` weeks of search_trends data for the metro (`line 118`).
- Need EITHER persistence (z≥2.5 in BOTH trailing weeks, same direction) OR magnitude (|z|≥3.5 in one week) — `lines 141-146`.
- Volatile baselines (std > mean × 1.5) are discarded silently (`line 132`).

**There is no "AI proposer" that actually proposes named cultural moments.** The CLAUDE.md description "AI proposer that suggests new moments" maps to `proposed_by='ai'` on insert, but the AI here is a statistical detector — it titles spikes generically: "Wedding-search demand spike", "Engagement-intent spike (3-12mo pipeline)", "Sentiment headwind: divorce-search uptick" (`titleForSpike` at `cultural-moments-auto-propose.ts:182-198`).

A coordinator looking at this queue **never sees "Royal Wedding 2026" or "Cottagecore peak"** unless they manually propose those themselves.

### B. Cultural moments proposer requires `venues.google_trends_metro` AND >= 14 weeks of `search_trends` rows

`cron route.ts:1207-1213` — only loops venues with non-null `google_trends_metro`. `cultural-moments-auto-propose.ts:309-330` — needs `search_trends` rows; needs >=14 weeks for spike math. New venues stay empty for the first quarter.

### C. Calendar geo_scope hierarchical model is unreachable from code

`getVenueGeoScope` (`correlation-engine.ts:430-443`) returns one of:
- `'us'` (no state) — picks up only nationwide rows (`us`).
- `'us_<state>'` (state set, 2 chars lowercase) — picks up `us` + `us_<state>` (via `expandGeoScopes`, `calendar.ts:27-35`).

There is **no path** to `us_<state>_<metro>`. The `us_va_culpeper`-shaped scope is documented in CLAUDE.md and the `calendar.ts` comments but **cannot exist** unless a coordinator manually inserts rows with that scope. Metro events from `external-calendar-events` have ZERO writers at metro level — only `populateUSCalendarEvents` (writes `us`) and `populateVirginiaCalendarEvents` (writes `us_va`) exist.

### D. Empty channels still inflate the Bonferroni denominator (or do they?)

`correlation-engine.ts:540` calls `correctedThresholdFor(numChannels, windowDays)`. The numChannels count is **only channels actually pushed onto `series`** (`correlation-engine.ts:409`). Empty `m.size === 0` skipped. Cultural moments empty `cultural.points.length > 0` checked (`line 404`). So **empty channels don't inflate**. ✅ working as designed.

But: with `MORTGAGE30US`, `CPIAUCSL`, `SP500`, `UNRATE`, `UMCSENT`, `PSAVERT`, `CONCCONF`, `HOUST`, `DSPIC96` (9 FRED) + ~5-10 calendar categories + 1 cultural + 5-10 internal → ~25 channels. `bonferroniCriticalR(25 × 24 × 7, 90, 0.05)` ≈ 0.43; engine then takes `max(0.6, 0.43) = 0.6` (`correlation-engine.ts:474`). The 0.6 effect-size floor binds, **not** Bonferroni. ✅ math is sound.

### E. Forward-filled monthly FRED series correlate with each other at r ≈ 0.95+

CPI, mortgage rate, S&P 500 are all monotonic-ish over a 90-day window. Forward-filled, `pearson(daily_grid_CPI, daily_grid_SP500)` over 90 days will commonly clear 0.6. So the engine **emits a stack of `macro_x_macro` correlations** that are statistically real but coordinator-irrelevant.

The UI defaults to `venue_relevant` filter (`macro-correlations/page.tsx:316`). When all top-5 correlations are macro × macro, the user sees: **"No correlations match this filter"** with hidden count `(N)` shown on the disabled "Macro only" / "All" chips.

This is plausibly the user's literal complaint: macro-correlations page shows nothing interesting.

### F. Briefings + Sage NLQ are blind to cultural / FRED / calendar

`yc-partner.md` HIGH 12 — `intel-brain.ts:130-181` system prompt does not enumerate CULTURAL MOMENTS, EXTERNAL CALENDAR, FRED, or CORRELATION INSIGHTS. So even when correlations DO exist, asking Sage "what's macro-correlated this month" returns a hedge.

### G. Trends recommendations require deviations > 20% absolute

`trends.ts:396` — `if (Math.abs(changePercent) > 20)`. Quiet markets produce zero deviations → AI recommendation generator returns 0 rows (`line 424-425`). The /intel/trends page then shows charts but no "Trend Deviations" or "Recommendations" sections.

### H. `MIN_NONZERO_DAYS = 12` (lowered from 20)

`correlation-engine.ts:115`. Marketing-metric series with sparse imports (e.g., monthly Knot views with 3 data points labeled '2026-03', '2026-04', '2026-05') get **3 nonzero days** in a 90-day window → the engine drops the channel before testing. So sparse storefront imports never participate.

### I. Cultural moments confirmation flow assumes coordinator action

Migration 167 made confirmation per-venue. New venues have **zero** rows in `venue_cultural_moment_state`, so `loadCulturalMomentsSeries(supabase, ..., venueId)` short-circuits to empty (`cultural-moments.ts:88-90`). The engine sees the cultural_moments channel as missing → no cultural correlations.

This is doctrinally correct (don't poison the engine with un-vetted moments), but **net effect for an unstaffed venue is: cultural channel never participates**.

### J. No seed data for fred_indicators in demo, calendar runs on startup, cultural empty

`supabase/seed.sql` has 60 `INSERT INTO fred_indicators` rows but **no** `INSERT INTO cultural_moments` and **no** `INSERT INTO external_calendar_events`. Demo venues see whatever the cron has populated since the last reset.

## 5. Recommended fix order

### Top 1 — Default the macro-correlations filter to `all` (or auto-detect "no venue-relevant correlations exist")

**File:** `src/app/(platform)/intel/macro-correlations/page.tsx:316`
**Change:** Either default `useState<FilterMode>('all')`, or compute counts before mount and default to whichever bucket has rows. Alternatively, render the empty-filter state with a clear "switch to All to see N hidden" CTA.
**Expected outcome:** User sees correlations on first load instead of an empty page.
**Effort:** 15 min.

### Top 2 — Seed `cultural_moments` with 5-10 confirmed moments per venue at onboarding

**File:** `src/lib/services/onboarding/backfill.ts` (add a `populateInitialCulturalMoments` step) + new seed list.
**Change:** Insert known 2024-2026 cultural moments (Royal-adjacent celebrity weddings, viral aesthetic peaks, Ozempic mainstreaming, ChatGPT release wave, Kate Middleton 2024, Taylor Swift / Travis Kelce engagement Aug 2024, etc.) as `proposed_by='system', status='proposed'` and let coordinator confirm during onboarding. OR write `venue_cultural_moment_state` confirmations for a small canonical set automatically per geo.
**Expected outcome:** Every venue immediately has cultural channel data and can produce macro × cultural correlations.
**Effort:** 4-6 hours (curating the list + writing).

### Top 3 — Add a real LLM proposer for cultural moments that runs nightly

**File:** new `src/lib/services/insights/cultural-moments-llm-propose.ts` + cron entry.
**Change:** Daily Claude call: "Given the wedding-industry context, propose 0-3 cultural moments active in the last 30 days. Title, category, date range, evidence URL." Insert as `proposed_by='ai'`, status='proposed'. Coordinator confirms.
**Expected outcome:** Queue has actual named events ("Royal Wedding 2026", "Pinterest cottagecore peak") instead of generic "Wedding-search demand spike" headlines.
**Effort:** 1 day. Cost: ~$0.01/venue/day.

### Top 4 — Sage NLQ + briefings: pull cultural / FRED / calendar / correlation_narration

**File:** `src/lib/services/brain/intel-brain.ts:130-181` (system prompt + data block).
**Change:** Add SQL pulls for `cultural_moments` (confirmed), recent `correlation_narration` rows, and the FRED indicator latest values. Expand system prompt to enumerate them.
**Expected outcome:** Asking Sage "what's the macro story for May" or "did Memorial Day weekend hurt our tour conversion" actually answers.
**Effort:** 4-6 hours. Closes yc-partner.md CRITICAL 4 + HIGH 12.

### Top 5 — Detrend or differencing for FRED series before pairing

**File:** `src/lib/services/intel/correlation-engine.ts` `buildSeries` macro section.
**Change:** For `fred_*` channels, compute first-difference (or rolling-7d delta) instead of feeding the raw forward-filled monolith. This kills the `macro_x_macro` r ≈ 0.95 false positives and makes macro × venue correlations more discoverable.
**Expected outcome:** Top-5 correlation list stops being dominated by CPI×SP500-style trivialities. Real macro × venue patterns surface.
**Effort:** 2-3 hours. Requires re-running the engine + invalidating narration cache.

## 6. Open questions for Isadora

1. **Is `FRED_API_KEY` actually populated in Vercel?** Code path checks `process.env.FRED_API_KEY` (`fred-fetch.ts:110`) and silently returns "not configured" — no env audit doc confirms this. If unset, FRED has been silently empty since onboarding day.
2. **Did Rixey's onboarding backfill ever complete?** Onboarding writes 13 months of FRED + 12 months of search_trends; the daily cron sustains it. If backfill was skipped, the engine has never had a 90-day window of clean macro data.
3. **For Rixey specifically, is `venues.state = 'va'` lowercase?** `getVenueGeoScope` (`correlation-engine.ts:441`) requires lowercase 2-char match. If state is `'VA'` it works (the `.toLowerCase()` runs first); if `'Virginia'` it falls back to `'us'`. Worth confirming.
4. **Has any coordinator confirmed any cultural moments at any venue?** Migration 167 made confirmation per-venue; if Rixey has zero confirmations, the cultural channel has never entered the engine. Quick check: `select count(*) from venue_cultural_moment_state where venue_id = '<rixey_id>' and state='confirmed'`.
5. **Did the Stream YY filter-chip change ever land at the user-visible level?** The `venue_relevant` default is documented as the right call (filter pure macro × macro out), but if no venue × macro correlations exist, the user gets a dead page. Was the empty-state-redirect ever tested with a real venue?
