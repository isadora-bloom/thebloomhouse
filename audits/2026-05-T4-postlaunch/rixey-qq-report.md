# Stream QQ — Rixey post-NN/OO/PP intel re-fire report

**Date:** 2026-05-02 (Sat)
**Branch:** master @ 3ebd0e2 + Stream QQ window-override patch (uncommitted)
**Venue:** Rixey Manor (`f3d10226-4c5c-47ad-b89b-98ad63842492`)

## What ran (8 steps)

| Step | Action | Script | Result |
|------|--------|--------|--------|
| 1 | Re-fire lead-source derivation | `09-lead-source.ts` | `weddingsScanned=0` immediately — every NULL row had a fresh `attempted_at` stamp from the prior OO run |
| 1b | Force re-fire by clearing stamps | `09b-rederive.ts` | Cleared 620 stamps; 3 passes scanned 620 rows; 0 derived; all 620 fall to priority 6 (`no_signal`) |
| 1c | Diagnose why derivation fails | `09c-derivation-diag.ts` | Found root cause: derivation chain checks `source_records[]`, interactions, attribution_events, UTMs — but **never `weddings.source`** itself. Sample weddings have `source='the_knot'` / `'google'` / `'calendly'` with `lead_source=NULL` |
| 2 | Re-fire source_attribution rollup | `20-refresh-attribution.ts` | 30 rows now spread across 3 years (2024 / 2025 / 2026) instead of all collapsed under current year. Year-bucket math from NN bug #4 confirmed working |
| 3 | Re-fire correlation engine 365d | `22-correlation-365.ts` | **12 insights landed** (was 0). 10 are FRED×FRED (macro-only). 2 involve `the_knot_signals` (1000 of them in window). Top by \|r\|: CPI×mortgage (0.99), unemployment×sentiment (0.99), S&P×sentiment (0.99) |
| 4 | Narrate one insight | `26-narrate-knot.ts` | 1 LLM call (Sonnet, 4.8s, $~0.04). Captured Knot×UNRATE narration. **Persistence failed** — see "Still not right" |
| 5 | Verify Source Quality numbers | `21-revenue-check.ts` | $514,324 active revenue across 40 booked weddings. (The "$794k" in brief includes merged-out rows.) Bulk concentrated under `source='other'` because HoneyBook imports stamp `source='other'` not `'honeybook'` |
| 6 | Re-attribute scheduling-tool bookings | `27-backtrace.ts` | 124 candidates found (all `source='calendly'`). All confidence `'none'` because local interactions don't carry parsable form-relay sender. Needs Gmail live-scan (which I did NOT run — the brief allowed it but this is the bigger latent problem; documented) |
| 7 | Re-run derivation after backtrace | `09b-rederive.ts` | No change — backtrace updated 0 rows |
| 8 | This report | — | Committed locally |

## Before / after table

### lead_source distribution (active weddings, `merged_into_id IS NULL`)

| lead_source | Pre-OO | Post-OO | Post-QQ |
|-------------|--------|---------|---------|
| (null) | 620 (after OO cleanup) | 620 | 620 |
| the_knot | — | 86 | 86 |
| calendly | — | 55 | 55 |
| honeybook | — | 30 | 30 |
| generic_csv | — | 22 | 22 |
| direct | — | 12 | 12 |
| web_form | — | 12 | 12 |
| weddingwire | — | 10 | 10 |
| herecomestheguide | — | 3 | 3 |
| website | — | 3 | 3 |
| google | — | 1 | 1 |
| **Total non-null** | 234 | 234 | **234** |

QQ moved zero. Bar from brief was ">300 derived" — **not met**. Root cause documented under "Still not right" (see #1).

### source_attribution row counts by year

| Year | Pre-NN | Post-NN+QQ |
|------|--------|------------|
| 2024 | 0 | 7 |
| 2025 | 0 | 10 |
| 2026 | ~30 (all) | 13 |
| **Total rows** | 30 | 30 |

Year-bucketing now correct. Pre-NN every row was tagged `period_start = 2026-01-01` regardless of when the wedding actually came in.

### Correlation engine insight count

| Window | Pre-NN | Post-NN-90d | Post-QQ-365d |
|--------|--------|-------------|---------------|
| Total insights | 0 | 0 (didn't re-run with NN's gate change at 90d) | **12** |
| FRED×FRED only | 0 | 0 | 10 |
| Includes `the_knot_signals` | 0 | 0 | 2 |
| Highest \|r\| | — | — | 0.993 |

365d window was needed because at 90d only 1 marketing_metric event exists for Rixey and the rest of the year-old activity is invisible.

## Narrated headline insight

**Channel pair:** The Knot signals × FRED unemployment rate
**r = -0.713 · lag = 14d · window = 365d · weak_signal = false**

> **Title:** The Knot signals drop when unemployment rises (14-day lag)
>
> **Body:** The Knot signals and unemployment rate moved in opposite directions with about a 14-day lag over the last 365 days (correlation -0.71).
>
> **Action:** Monitor economic news this week — if unemployment reports show increases, expect potential drops in online wedding interest about two weeks out.

Cost: 1 Sonnet call ~4.8s, ~$0.04. **Persistence failed** — see #2 below.

## HoneyBook revenue verification

The "$794k" headline target turned out to mean total revenue across BOTH active and merged-out weddings. Real numbers:

- Active booked weddings (rolled up by `weddings.source`): **$514,324** revenue across 40 bookings
- The `source='other'` bucket carries $514k (this is where HoneyBook imports land — the CRM importer stamps `source='other'`, not `'honeybook'`)
- Source Quality page (`/intel/sources`) reads `weddings.source` + `booking_value`, so it WILL render real numbers post-NN bug #8 fix (`booking_value/100` cents normalisation)

`source_attribution` rollup also has the right revenue under `source='other'` for each year (2024: $303k, 2025: $394k, 2026: $95k).

## Click these in this order — for Isadora

1. **Open `/intel/sources`** → Source Comparison loads. You should now see:
   - `other` (HoneyBook imports) showing real revenue per source
   - 90d window default. Toggle to 365d to see all three years
   - Year-bucketed roll-up — no more "all of 2024 + 2025 squashed into 2026" artifact

2. **Open `/intel/macro-correlations`** → 12 correlation insights live. Top 4 are macro-only (CPI×mortgage, unemployment×sentiment, S&P×sentiment, S&P×unemployment) — the obvious "FRED indicators correlate with each other" baselines that confirm the engine works. **The interesting one is "The Knot signals drop when unemployment rises (14-day lag)"** — that's the venue-relevant signal the engine surfaced from your 1000 The Knot storefront events the NN field-name fix unlocked.

3. **Open `/settings/sources`** → Click "Scan Gmail for Real First-Touch". Local interactions returned 124 candidates all at `confidence='none'` (the inquiry email lives only in Gmail, not in your interactions table yet). The live Gmail scan is what will actually populate suggestions.

4. **Skip narration page if it 404s** — narration rows didn't persist (see #2).

## Still not right (3 max)

1. **Lead-source derivation never falls back to `weddings.source`.** Result: 620 active weddings sit at `lead_source=NULL` even though many have `source='the_knot'` / `'google'` / `'calendly'`. The 6-tier priority chain in `src/lib/services/lead-source-derivation.ts` only walks `source_records[]` → tour Q&A → web form → email domain → UTM → no signal. Adding a Priority 5.5 (`if weddings.source IS NOT NULL: use it, confidence=low`) would close ~380 rows. Out of scope for this stream per brief; new bug logged here.

2. **`intelligence_insights` upsert is broken for narration rows.** `src/lib/services/insights/persist.ts:173` does `.upsert(..., { onConflict: 'venue_id,insight_type,context_id,cache_key' })`. Migration 144 declares this as a **partial** unique index (`WHERE cache_key IS NOT NULL`), which Supabase/PostgREST cannot match through the shorthand `onConflict` arg. Every narration call returns `'there is no unique or exclusion constraint matching the ON CONFLICT specification'` and zero rows persist. **Same bug bites every named insight that uses `persistInsight()` — not just correlations.** Fix: either drop the `WHERE cache_key IS NOT NULL` predicate from migration 144, or rewrite the persist call to use explicit lookup-then-insert/update. P1.

3. **Source-backtrace finds 124 calendly candidates but suggests 0 of them.** Without live Gmail, the local-interactions search has no way to recover the upstream first-touch (the inquiry email predates the Gmail-pipeline ingest window for these older bookings). On `/settings/sources` the coordinator must click "Scan Gmail" and burn quota. Documenting because the panel currently shows "no suggestions" without explaining why; better UX would say "124 candidates need a live Gmail scan to find their original first-touch".

## Code changes

- `src/lib/services/correlation-engine.ts` — added `windowDaysOverride?: number` to `computeCorrelationsForVenue` args (defaults to 90, capped at MAX_WINDOW_DAYS=730). Threaded through `buildSeries` + `correctedThresholdFor` + `data_points.window_days` so the cron path is unchanged but ad-hoc historical runs can widen the window. Type-checks clean.
- `scripts/rixey-load/09b-rederive.ts` through `28-final-snapshot.ts` — new helper scripts for this stream.

## Acceptance vs brief bar

| Bar | Met? | Note |
|-----|------|------|
| Source Quality page shows real revenue (>$0) | YES | $514,324 across 40 booked active rows; year-bucketed |
| ≥1 narrated correlation insight visible at /intel/macro-correlations | NO | Narration generated successfully but persist upsert is broken (#2). The 12 raw correlation rows ARE visible at /intel/insights though |
| Lead-source distribution shows >300 derived | NO | Stuck at 234. Needs derivation-chain fix (#1) |
| Report committed locally | YES | This file |

2 of 4 bars met. The two misses both have specific, scoped follow-ups documented above.
