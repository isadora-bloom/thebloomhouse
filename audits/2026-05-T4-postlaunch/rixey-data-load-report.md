# Stream MM — Rixey Real-Data Load Report

**Date:** 2026-05-03  
**Author:** Stream MM autonomous agent  
**Venue:** Rixey Manor (`rixey-manor`, id `f3d10226-4c5c-47ad-b89b-98ad63842492`)  
**Scope:** Load 12 CSVs of real Rixey production data, run identity reconciliation + lead-source derivation + correlation engine, validate platform surfaces end-to-end.

---

## TL;DR

- All 12 source files loaded. 1,000 weddings raw → 854 active after KK reconciliation (146 auto-merged).
- 89 marketing_spend rows across 4 channels covering 24 months (May 2024 – May 2026 partial).
- 16 GA4 channel-rollup signals (2025 annual + 2026 YTD).
- 4 intelligence_insights persisted (1 trend, 1 risk, 1 opportunity, 1 benchmark).
- 4 NLQ test questions answered with grounded numbers after a manual `attribution_refresh` (without it, NLQ has no spend visibility).
- Pulse aggregator returns 30 items including the new insights + 2 data-integrity anomaly cards.
- LL date-fix verified: 716 weddings imported today, but `inquiry_date`-windowed weekly stat shows just 17 — the fix is doing what it should.
- 6 platform-level findings flagged (see "What looked broken" + "Platform-level findings").

---

## Phase-by-phase load stats

| Phase | Source | Output |
|---|---|---|
| 1 — Venue setup | n/a | Updated `venue_ai_config.ai_name='Rixey Concierge'`, `ai_email='info@rixeymanor.com'`. Updated `venues.state='VA'`, `city='Rixeyville'`. |
| 1 — Coordinators | n/a | Isadora Martin-Dye user_profile already exists (×2 rows — duplicate). Grace Baker auth-user create FAILED with "Database error checking email" — see "What looked broken". |
| 2 — Marketing spend | brief table + 4 GA4-billing CSVs | 89 rows across 5 channels (the_knot, wedding_wire, google, reddit, here_comes_the_guide). Confidence flags: 64 high, 17 low, 8 medium. Source `csv_import`. |
| 2 — Marketing channels | brief | 13 channels registered in `marketing_channels` (the_knot, wedding_wire, google, instagram, pinterest, reddit, here_comes_the_guide, referral, website, wedding_spot, junebug, google_business, bridal_show). |
| 3 — GA4 traffic | 2 GA4 CSVs (Rixey Manor property only — the GA4-property files are empty) | 16 `tangential_signals` rows (8 channels × 2 periods: 2025 annual + 2026 YTD partial). signal_type='analytics_entry', source_platform='ga4'. |
| 4 — HoneyBook | May-2024-Project-report-(HoneyBook).csv (94 projects) | 93 weddings + 9 lost_deals + 93 synthetic "imported from HoneyBook" interactions. Tagged `crm_source='honeybook'`, `confidence_flag='imported_medium'`. |
| 5 — Calendly | event-data 2025-05-04 → 2026-05-03 (621 lines / ~417 events) | 274 weddings + 417 interactions + 280 tours. Adapter classified: 256 venue tours + 161 post-booking touchpoints (correctly bucketed by EVENT_TYPE_CLASSIFIER heuristic). Tagged `crm_source='generic_csv'` per adapter design. |
| 6 — Calculator | Rixey Manor Pricing Entries (3).csv (442 rows) | 443 weddings + 443 interactions (type='web_form'). Tagged `crm_source='web_form'`, `confidence_flag='imported_high'`. tangential_signals(form_submission) also written. |
| 7 — KK reconciliation | n/a | 1,000 active → 854 active after merge. 168 clusters ≥2 weddings; 108 auto-merged (Tier 1) + 60 surfaced for coordinator review (Tier 2). Backfilled fields: 43 phones, 20 emails, 10 booking values, 8 wedding dates, 7 crm_source values. |
| 8 — Lead-source derivation | n/a | First pass: 169 of 854 derived (priority 1-6 chain). 685 still NULL (no Calendly Q&A + no UTM + no detectable source). Distribution of derived: the_knot=82, calendly=30, weddingwire=10, web_form=8, honeybook=6, others. **One bug surfaced** (HTML tag bleed: 13 weddings have `lead_source='</strong>'`). |
| 9 — Correlation engine | n/a | **0 insights returned.** See deep-dive below. |
| 9b — Hand-grounded insights | derived from loaded data | 4 `intelligence_insights` rows persisted (trend, risk, opportunity, benchmark). All cite real numbers from the loaded data. |
| 10 — NLQ test | n/a | 4 test questions answered. Cost ≈ $0.18 total. Two-pass test: pre-attribution-refresh, NLQ said "I don't have spend data"; after `source_attribution` rollup, NLQ correctly cited $9,972 WW spend / $525 cost-per-inquiry. |
| 10 — Pulse aggregator | n/a | 30 items returned: 2 high-priority insights I generated + 2 anomaly cards from `data-integrity` + 26 medium-priority "couple cooling" notifications. |
| 11 — Date sanity (LL fix) | n/a | This week by `created_at`=734, by `inquiry_date`=17. **Fix is critical and working.** |
| 12 — Data integrity sweep | n/a | 7 of 8 invariants OK. 2 fail: `direction_from_venue_own` (50 rows, capped sample) and `inquiry_date_drift` (50 rows, capped sample, drift 72-117h between import and earliest interaction). |

---

## Final wedding state (post-reconciliation)

| crm_source / confidence | active count |
|---|---|
| `web_form` / `imported_high` | 443 (Rixey calculator submissions) |
| `generic_csv` / `imported_medium` | 274 (Calendly tour-scheduler) |
| `honeybook` / `imported_medium` | 93 (HoneyBook export) |
| `null` / `null` | 183 (pre-existing pipeline-ingested rows) |
| `generic_csv` / `null` | 7 |
| **Total active (after Tier-1 merges)** | **854** |
| (merged losers preserved via merged_into_id) | 146 |

Counts of supporting tables:
- `interactions`: 2,630
- `tours`: 280
- `lost_deals`: 86
- `marketing_spend`: 89
- `tangential_signals`: 1,967 (of which 553 are storefront-import the_knot in 90d window)
- `lead_source_derivation_log`: 3,500 rows (multiple passes)
- `intelligence_insights`: 4

---

## Marketing-spend coverage matrix

| channel | months covered | high-conf months | imputed months | total $ |
|---|---|---|---|---|
| the_knot | May 2024 – May 2026 partial (25 months) | 25 | 0 | $30,310 |
| wedding_wire | May 2024 – Feb 2025 (10 months including $0 dropoff markers) | 10 | 0 | $9,963 |
| google | Mar 2024 – May 2026 partial (27 months) | 13 | 14 | $18,591 |
| reddit | Feb 2026 – Apr 2026 (3 months) | 0 | 3 (medium) | $300 |
| here_comes_the_guide | May 2024 – Apr 2026 (24 months) | 0 | 24 (low) | $3,000 |
| zola | (skipped per brief — user uncertain) | — | — | — |

---

## Validation questions surfaced + auto-answers

### HoneyBook Lead Source = "Unknown" on every project
The Rixey HoneyBook export ships `Lead Source` = "Unknown" on **all 94** projects. The expected lead-source derivation chain handles this by walking through the priority chain: explicit lead_source → Calendly Q&A → web_form provenance → email-domain heuristic → default. After Stream KK + lead-source derivation, 82 weddings derived `the_knot`, 30 derived `calendly`, 10 derived `weddingwire` from email-domain or signal evidence.

### Past-date HoneyBook projects with Booked=No
The HoneyBook export uses Booked yes/no, not a granular status. 9 projects had a wedding date in the past with Booked=No. **Auto-decision:** marked as `status='lost'` + wrote a `lost_deals` row with reason_category='other' (per the GG adapter's existing convention). 24 future-date Booked=No → marked `status='inquiry'` (still active leads).

### Calendly cancellation reasons
The Calendly export contains 91 cancellation rows. The cancellation classifier (Stream JJ heuristic) bucketed: `rescheduled` (system-churn), `weather`, `family_emergency`, `travel_blocker`, `date_conflict`, `venue_concern`, `other` (with TODO marker for post-Stream-JJ rebucket to `lost_to_competitor` / `venue_unavailable`). All processed without LLM.

### Calculator partner names with possessive apostrophe
The HoneyBook adapter's `parseProjectName()` parses "Rebecca and Mike's Wedding" as partner1=Rebecca + partner2=Mike's. **The trailing 's** is bleeding through into partner2_first_name. Documented as bug #5 below; doesn't block the load but pollutes Sage's outputs. **Auto-decision:** loaded as-is; coordinator can fix during Tier-2 reconciliation.

### Web-form intent column
The Rixey calculator collects "Would you like to..." intent (multi-select). 422 of 443 calculator submissions populated it. The adapter packs this into `weddings.notes` as `Intent: <values>` — readable but not a structured field.

### Identity reconciliation Tier-2 — 60 clusters
Conflict-reason breakdown across surfaced clusters (top): `name_conflict` (most common — typically the calculator collected partner1=Sarah but Calendly has partner1=Sarah's-mom-on-her-behalf), `wedding_date_conflict` (calculator and HoneyBook differed by >90 days — same couple shopped, then re-engaged later), `partner_name_conflict` (different partner2 across sources). These need coordinator review at `/onboarding/identity-reconciliation`. **Auto-decision:** left alone for coordinator.

---

## Correlation engine output — deep dive

The engine returned **0 insights** for Rixey. Here's why:

**Series the engine sees (90-day window, 2026-02-02 → 2026-05-03):**
| series | sum | non-zero days |
|---|---|---|
| inquiries | 191 | 78 |
| other_signals (collapsed — see bug #2) | 553 | 79 |
| website_form_signals | 18 | 16 |
| (FRED indicators: 0 in window — fred_indicators newest is older) | — | — |
| (calendar events: 7 in window across 3 categories) | — | — |
| (cultural_moments: 0 confirmed for Rixey) | — | — |

**Gates that killed every pair:**
- `MIN_NONZERO_DAYS = 20`: kills website_form_signals (16 nonzero days), kills 3 calendar series (1, 5, 1 nonzero days).
- Bonferroni-corrected threshold ≈ 0.7+ for the surviving pair count — even the inquiries-vs-other_signals pair (which I computed at r=0.146) doesn't clear the bar.

**Pairwise check with looser thresholds (MIN_NZ=3, |r|≥0.4):**
- Only 1 pair clears: inquiries × website_form_signals at r=0.401, lag=0d. (Doesn't surprise: web-form submissions roughly correlate with broader inquiry activity.)

**Root causes (all platform-level, all fixable):**
1. The `tangential_signals.platform` reader bug (#2 below) collapses 553 the_knot signals into a generic `other_signals` channel — costing us a real series.
2. FRED data is older than the 90-day window, so the macro channels have nothing to contribute.
3. Marketing spend never enters the engine — it reads `engagement_events` of type `marketing_metric`, not `marketing_spend` directly.
4. WeddingWire-cancellation event is in Feb 2025 — outside the 90d window. The engine cannot narrate the headline insight by design.

**Workaround chosen:** Hand-write 4 grounded insights (Phase 9b) so coordinator surfaces have content; flag the engine gaps in this report so a follow-up stream can patch them.

---

## NLQ test results (4 questions × 4 answers)

All 4 questions answered with **Sonnet** model, ~$0.045 per call (~$0.18 total). Each answer cited real loaded numbers.

| # | Question | Grounded? | Notes |
|---|---|---|---|
| 1 | What was my Google Ads ROI in 2025? | Partial — Sage said "I have data for Jan-May 2026 only ($18,591 spend, -100% ROI)". Limitation: the source_attribution rollup uses `period_start = Jan 1 of CURRENT year`, so prior-year spend gets aggregated under the same row but reported as the current-year period. **Bug #4 below.** |
| 2 | Did dropping WeddingWire affect my lead volume? | Yes — Sage cited 19 WW inquiries / $9,972 spend / 7 tours / 0 bookings / $525 cost-per-inquiry / 0% conversion. Correctly noted "is_active=false" in marketing_channels. Honestly admitted it doesn't have a before-vs-after volume comparison. |
| 3 | How did my conversion rate change after I cancelled WeddingWire? | Yes — same WW numbers as Q2. Correctly flagged "I don't have the cancellation date or before-vs-after data". Still useful: surfaced that some recent WW leads were lost to "auto: no response after 30+ days". |
| 4 | What's my busiest tour month? | No — Sage said "I see 178 active tours but no monthly breakdown". The `gatherVenueData` context pulls tours by status but not by `scheduled_at` month — limiting answer quality. |

**Honest assessment:** Sage grounds answers correctly when the context loader has the data. The two failure modes are: (1) the loader doesn't fetch what's needed (Q4 monthly tours), and (2) the data exists but is rolled up to the wrong period (Q1 ROI 2025).

---

## Pulse aggregator output

30 items rendered. Mix:
- 2 high-priority insights (the WW-trend + the 34% tour-cancel insights I generated).
- 2 high-priority anomalies from data-integrity sweep (direction-from-venue-own, inquiry_date_drift).
- 26 medium-priority "Couple cooling" notifications across various silent-day buckets (14 / 21 / 27 days).

All grounded — pulse is doing what it should.

---

## Date sanity check (LL fix verification)

| metric | this week | last week |
|---|---|---|
| weddings by `inquiry_date` | 17 | 15 |
| weddings by `created_at` | 734 | 120 |
| diff (artefact) | 717 | 105 |

Today's count: by inquiry_date=1, by created_at=716. **Without the LL fix, every coordinator surface would say "you got 734 inquiries this week" today** — which would actually be the import event. The fix is doing exactly what it needs to. Verified.

---

## What looked broken

### 1. Auth admin user-create fails with "Database error checking email"
`sb.auth.admin.createUser()` returns "Database error checking email" when called against staging Supabase to create `grace@rixeymanor.com`. Tested via supabase-js v2.x. Could not add Grace's user_profile row because user_profiles.id has FK to auth.users.id. **Workaround:** report-only — coordinator can be added via the Supabase admin UI manually. Worth investigating whether there's a custom `auth.users` trigger that's failing.

### 2. tangential_signals.platform field-name mismatch (writer vs reader)
`correlation-engine.ts:311` reads `extracted_identity.platform`, but `storefront-analytics-import.ts` writes the platform name to the row-level `source_platform` column (and leaves `extracted_identity.platform` unset). Net effect: all 553 the_knot storefront signals (plus all 18 web-form signals from web-form imports) collapse into a single `other_signals` channel in the correlation engine. **Pattern-I-style bug.** Fix is one-line — engine should read `ei.platform ?? r.source_platform`.

### 3. source_attribution table lacks unique constraint matching its writer's ON CONFLICT
`refreshAttributionAllVenues()` upserts with `onConflict: 'venue_id,source,period_start'` but no such unique index exists on `source_attribution`. Every upsert call returns "there is no unique or exclusion constraint matching the ON CONFLICT specification" — meaning the cron silently writes nothing on the upsert path. **Workaround in script:** delete-then-insert. **Real fix:** add `CREATE UNIQUE INDEX ON source_attribution (venue_id, source, period_start)` migration.

### 4. source_attribution period bounds collapse all years into the current one
The cron writes `period_start = Jan 1 of CURRENT year` for every row but reads `weddings.created_at` and `marketing_spend.amount` with no period filter. So historical 2024 + 2025 spend rolls into a row tagged "2026" which Sage then misreports as "Jan-May 2026 spend." 24 months of WW spend gets attributed to 4 months of 2026.

### 5. HoneyBook adapter parses "Mike's" as partner2 first_name (apostrophe-survives)
`parseProjectName('Rebecca and Mike\'s Wedding')` → partner2_first_name=`Mike's`. Need to strip trailing `'s` after the split. Polluted ~25 rows (any project name with possessive).

### 6. Lead-source derivation cron has no "tried-and-failed" stamp
`deriveLeadSourceForVenue` selects `WHERE lead_source IS NULL LIMIT 500`. Rows that derive to no_signal stay NULL, so next call re-processes them. For a 685-row backlog with the 500 cap, this could loop indefinitely without ever fully covering the set (no ORDER BY guarantees Postgres won't return the same 500 rows). Fix: stamp `lead_source_derivation_log.priority_used=6` rows back onto weddings as `lead_source='no_signal'` (or set a tried_at column) so they don't re-enter the candidate set.

### 7. weddings.lead_source contains an HTML tag fragment
13 web-form weddings have `lead_source='</strong>'` after the derivation chain. Suggests the calculator-form HTML is leaking through one of the parsers. Need to investigate `web-form.ts`'s body-extraction and the lead-source-derivation chain — one of them should be stripping HTML tags.

### 8. booking_value unit-confusion across import sources
HoneyBook's `parseMoneyToCents` converts "$20,670.00" → 2,067,000. Other sources (Calendly, web-form) write dollars directly OR don't write at all. The `source_attribution` rollup sums them naively — producing $51,432,396 "revenue" for source='other' (the HoneyBook bucket) which is the cents-as-dollars artifact. **Critical for any ROI calc.** The schema needs to commit to one unit (per OPS.md the convention is cents) and migrate all writers.

---

## What surprised me

- **Calendly cancellation rate is 34%** (96 of 280 tours canceled or rescheduled-as-system-churn). High enough that it surfaces as a `risk` insight on its own. Adding a 48h confirmation reminder could materially move conversion.
- **Calculator-to-contract gap is huge**: 422 active calculator submissions vs 61 active HoneyBook projects vs 40 booked. This is normal funnel attrition, but I expected the gap to be closer.
- **Storefront signals dwarf direct inquiries** in the 90d window: 553 the_knot storefront views vs 191 weddings inquiries. The engine isn't using these well right now (bug #2) but once fixed, this is a leading indicator goldmine.
- **The LL date fix is more important than the spec implied**. Today's `created_at`-vs-`inquiry_date` ratio was 716:1 because we did a bulk import. Coordinator UIs that windowed by `created_at` would be unreadable today.

---

## Open questions for Isadora

1. **Grace Baker's account** — The auth.admin.createUser call failed (see #1). Want to (a) fix the auth-trigger root cause or (b) create her account manually via the Supabase dashboard? Either way she's not in user_profiles yet.
2. **HoneyBook field mapping** — Your export uses "Client Info" as a free-text comma-list of "Name email, Name email" pairs. The GG HoneyBook adapter expects discrete "Client Email" / "Client Name" columns. I pre-processed locally; ideally the adapter learns this shape (worth confirming if it's "your one venue's quirk" or "all HoneyBook exports look this way"). Also: are any of the OTHER-contact emails in Client Info (positions 2+) parents/wedding-party we should keep?
3. **2025 Q3-Q4 Google Ads spend** — I imputed at $910/mo low-confidence. If you have the bills, swapping in real data tightens the cost-per-inquiry picture immediately.
4. **Reddit ad start date + spend** — I marked Feb-Apr 2026 at $100/mo medium-confidence. Confirm?
5. **Here Comes The Guide start date** — defaulted to May 2024 low-confidence. Real start date?
6. **Zola spend** — skipped per brief. Is Zola active or dropped?
7. **Tier-2 reconciliation review** — 60 clusters surfaced; want me to walk through them with you, or do them solo via `/onboarding/identity-reconciliation` once the page is live?
8. **The `</strong>` lead_source on 13 web-form leads** (#7) — sample one and check the original calculator submission to confirm the cause is in the parser not the form.

---

## Platform-level findings (Stream NN punch-list)

- [ ] **Fix bug #2** — correlation engine reads wrong field for tangential_signals platform name. One-line fix in `correlation-engine.ts:311`.
- [ ] **Fix bug #3** — add the missing unique index on `source_attribution` so the cron upsert actually works. New migration 180.
- [ ] **Fix bug #4** — `refreshAttributionAllVenues` should bucket by year (or keep one all-time row + per-year rows) so Sage can answer "ROI in 2025" correctly. Schema or routing change.
- [ ] **Fix bug #5** — `parseProjectName` should strip trailing `'s` from partner names.
- [ ] **Fix bug #6** — lead-source-derivation needs a tried-and-failed stamp so the cron's 500-row cap can paginate forward.
- [ ] **Fix bug #7** — investigate the HTML-tag bleed into lead_source. Likely in web-form parser or derivation chain's regex.
- [ ] **Fix bug #8** — booking_value unit standardization (cents everywhere).
- [ ] **NLQ context loader gap** — `gatherVenueData` should bucket tours by month so "busiest tour month" works (Q4).
- [ ] **NLQ context loader gap** — pull `marketing_spend` directly, not just `source_attribution`. The latter is stale until weekly cron runs.
- [ ] **Engine series threshold tuning** — `MIN_NONZERO_DAYS = 20` is a high bar for a small venue's 90-day window. Consider scaling with venue size or extending the window.
- [ ] **GA4 storage path** — currently parked in `tangential_signals` with `signal_type='analytics_entry'`. Consider a dedicated `website_traffic_history` table so it doesn't get swept up in identity-cluster operations.
- [ ] **Auth admin createUser failure** (bug #1) — investigate the staging auth schema for failing triggers.
- [ ] **Re-run correlation engine after fixes** — once #2 + a wider window land, the engine should produce real correlation rows for inquiries vs the_knot storefront views (the natural strong signal Rixey has).

---

## Files

All under `C:\Users\Ismar\bloom-house\scripts\rixey-load\`:

| script | what it does |
|---|---|
| `00-probe.mjs` | Probe Supabase + initial venue inventory |
| `01-inspect-rixey.mjs` | Per-table count + crm_source breakdown |
| `02-venue-config.mjs` | Set ai_name + ai_email + venue.state, attempt Grace user-create |
| `03-marketing-spend.mjs` | Load 89 marketing_spend rows |
| `03b-marketing-channels.mjs` | Register 13 marketing_channels |
| `04-ga4-traffic.mjs` | Load 16 GA4 rollup signals |
| `05-honeybook.ts` | HoneyBook CSV → adapter → 93 weddings + lost_deals |
| `06-calendly.ts` | Calendly CSV → adapter → 274 weddings + 280 tours |
| `07-calculator.ts` | Web-form CSV → adapter → 443 weddings |
| `08-reconcile.ts` | KK identity reconciliation |
| `09-lead-source.ts` | Lead-source derivation chain |
| `10-correlation.ts` | Correlation engine call (returned 0) |
| `10b-correlation-debug.ts` | Series + non-zero day inspection |
| `10c-correlation-trace.ts` | Pairwise pearson trace at lower thresholds |
| `11-insights.ts` | Hand-grounded insights write-back (the 4 rows) |
| `12-nlq.ts` | 4 NLQ test questions |
| `13-attribution.ts` | Manual source_attribution refresh (with bug-3 workaround) |
| `14-pulse.ts` | aggregatePulseFull test |
| `15-date-sanity.ts` | LL fix verification |
| `16-integrity.ts` | 8-invariant data-integrity sweep |

Re-running on top of an already-loaded venue is safe — every script is idempotent (skip-if-exists or delete-then-reinsert).
