# Scenario audit and wave 6/7 plan

Date: 2026-09-14. Method: two hypothetical Mondays were role-played against the
live code (a venue coordinator's admin catch-up plus a final walkthrough; a CEO's
team meeting) and every claim checked against the actual repo, file and line, not
the feature's name or its doc comment. This document is the write-up, the
cross-cutting patterns both scenarios surfaced, a full data-ingestion inventory,
and the wave 6/7 plan to close what's open.

**Framing, per Isadora 2026-09-14:** where data ingestion already exists for
something (an import guide, a capture path, a stub connector), assume it was
built for a reason and a plan existed. The job below is almost never "build new
ingestion" — it's "finish wiring what's already flowing in to the surface that
would make it useful." That framing holds for nearly every finding here; it is
called out per-item below.

---

## Report 1: the coordinator's Monday

**Scenario:** log in, catch up on Instagram followers and a Knot CSV, confirm
inquiries got auto-replied, clear the portal question queue, then in the evening
run a final walkthrough needing full client context, contract search, a day-of
timeline, and a table layout she can assign guests to.

| # | Task | State | Root cause |
|---|---|---|---|
| 1 | `/today` morning overview | **Works** | Real canonical-reader landing page. |
| 2 | Instagram follower screenshots | **Partial, but better than first reported** — see correction below | The dedicated per-handle follower-list screenshot uploader in `/intel/social-integration` is disabled (`CaptureNowModal.tsx`, "coming in V1.1"); text-paste works. But the general brain-dump path (`/api/brain-dump/route.ts:373`, real `callAIVision` call) already accepts an Instagram Insights screenshot for reach/profile-visit numbers — different data (aggregate metrics, not a named-follower list) via a different, working door. |
| 3 | Knot CSV | **Works, wrong door for the leads file** | The Knot Pro *leads* adapter (`crm-import/knot.ts`) only has an upload UI at `/onboarding/crm-import`, not on daily nav. The Knot *performance* numbers (views/inquiries/spend) have a real, daily-reachable door: drop the CSV or a screenshot into brain-dump (`Agent → Brain-dump`), registered in `source-registry.ts` with a 30-day cadence and a freshness nudge on `/intel/sources/track`. |
| 4 | Auto-reply check | **Partial** | `/agent/drafts` shows today's approved/rejected/auto-sent counts and an auto-sent chip, but nothing reconciles "N inquiries in, N replied" and the stat window is midnight-to-now, not "since Friday." The good news: the old silent-failure bug is fixed, sent now means sent (`inbox/page.tsx:1702-1747`). |
| 5 | Portal question queue | **Works** | Sage Queue is real, real data, real respond-and-file action. |
| 6 | Walkthrough: logistics + personal info in one place | **Partial** | `/portal/weddings/[id]` is a genuinely good single hub for guests/vendors/budget/notes. The "personal" side (the identity-reconstruction profile: how they met, family dynamics) is real and detailed but only renders inside `/intel/clients/[id]`, a sales-intelligence tool, never on the page open during the actual meeting. |
| 7 | Search contracts | **Partial** | Contract storage, OCR, AI summary and a working search box all exist — for the couple, at `/couple/[slug]/contracts`. The coordinator's own wedding page shows only a yes/no "uploaded" badge. |
| 8 | Build a timeline | **Partial** | The day-of timeline builder is real and full-featured — on the couple's side only (`_couple-pages/timeline`). The coordinator's tab is read-only. |
| 9 | Table layout + guest assignment | **Not built as one feature** | The visual floor-plan editor (konva) has table shapes and capacities, no guest names. Guest-to-table assignment is a separate, text-based, couple-facing list. The two never reference each other. |

### Tangential patterns in this report

- **Coordinator/couple split.** Three separate findings (6, 7, 8) are the same
  shape: a real feature was built, and it landed on the couple's side of the
  portal instead of the coordinator's, even though the coordinator's daily job
  (the walkthrough) is where it's needed live. Worth checking for more instances
  of this split beyond the three found here.
- **The "recurring re-upload" gap is a known, named doctrine item.** Isadora's
  own memory already flags a "Recurring-CSV import doctrine (NOT BUILT)" —
  this scenario is the concrete case: a coordinator re-uploading a Knot leads
  CSV mid-season, not at onboarding. Confirms this should be prioritised now
  rather than treated as a new finding.
- **"Today" framing everywhere.** The drafts-page stat window (finding 4) is
  one instance; nothing in the product currently answers "since I last looked,"
  only "since midnight." Worth checking `/pulse`, `/today` and the inbox tabs
  for the same assumption before fixing just one of them.

---

## Report 2: the CEO's Monday

**Scenario:** a team meeting where the CEO wants to raise a drop in review
"buzz" (not stars), decide whether to hire for social, ask whether posting more
leads to more tours, check midweek vs weekend tour conversion, decide whether to
move Knot ad spend to Google, and understand why a groom's-cake promise was
missed and never flagged.

| # | Question | State | Root cause |
|---|---|---|---|
| 1 | Review buzz dropping (language, not stars) | **Built but dead** | `reviews.sentiment_score`/`themes` and a real trend calculator (`reviews-analytics.ts`) exist, but no ingestion path (Google Places poll, CSV/paste, or the brain-dump `reviews_from_screenshot` case) ever writes those fields. The trend always renders blank. A separate LLM phrase-extractor (`review-language.ts`) exists but is built and approval-gated for marketing copy, not reputation monitoring. |
| 2 | Hire for social? | **No data support today** | Downstream of findings 1 and 3 below — there is no reputation-trend and no social-to-tours signal to base the decision on. |
| 3 | Does posting more lead to more tours? | **Data reaches the door, then has nowhere to go** — see correction below | Instagram/TikTok organic screenshots dropped into brain-dump *do* land in `engagement_events` as `marketing_metric`, which the correlation engine (`buildSeries`) *does* read. What's missing is a **tours** series in that engine at all — it currently only pairs channels against inquiries. This is a smaller, more precise gap than first reported: the ingestion and the engine both exist, one series is missing. |
| 4 | Midweek vs weekend tour conversion | **Works, and it's good** | `/intel/cohort` → funnel-timing tab → "By tour weekday" shows real tour→booked % for every weekday, not just a binary split. Screenshot-ready today. |
| 5 | Move Knot budget to Google? | **The compute is real; the page is one of the nine I gated in W39; both channels rely on the same manual capture, not a Google disadvantage** | `MarketingRecommendationsDashboard` (Sonnet-driven reallocation analysis) is real and reads real Apparent-vs-Real CAC per channel. Its page, `/intel/marketing-roi/recommendations`, has zero nav entry and zero inbound link, so it was correctly gated behind `SCAFFOLD_PAGES` in W39 — until this scenario, nothing asked for it. Both Knot and Google Ads spend are captured the same way today (brain-dump CSV/screenshot, `source-registry.ts` entries for both, 30-day cadence, freshness-tracked) — there is no automated connector for either, so the comparison is apples-to-apples, not tilted against Google as first reported. |
| 6 | The groom's cake | **Structural, four compounding gaps** | (a) The one piece of code that could catch a freeform mention like this (`extractSignals`'s `specialRequests` catch-all) is never called in the live email pipeline — it was deliberately left out to avoid a model call on every inbound email. (b) The classifier that does run on every message has a closed schema (name/date/guest count/budget/questions) with no slot for arbitrary detail. (c) Planning Notes, which could hold it, only populates from the couple's Sage-chat messages and contract PDFs, not from coordinator-venue conversations. (d) Even if captured, nothing cross-checks any of it against the day-of timeline, which is couple-authored and generic ("Cake Cutting," no distinction for a groom's cake). |

### Correction to what I told you live, now that source-registry.ts and the brain-dump route were checked properly

I undersold the ingestion side in the room. TikTok and Instagram organic are
**both** registered, working capture paths via brain-dump screenshots (real
`callAIVision` call, confirmed at `src/app/api/brain-dump/route.ts:373`), same
as Google Ads, Facebook/Meta Ads, Instagram Ads, Pinterest Ads, GA4, and blog
SEO — every one of these has a written import guide, a 30-day cadence, and a
freshness nudge on `/intel/sources/track`. What is genuinely missing is not
capture, it's the **downstream comparison and correlation logic**: nothing
compares one platform's trend against another's, and nothing correlates any of
it against tours specifically. Per Isadora's framing above, this was ingested on
purpose; the fix is to wire it forward, not to build new capture.

### Tangential patterns in this report

- **"Built, never wired forward" is the dominant shape here**, more than in
  report 1. Reviews sentiment, social-to-tours correlation, and the
  reallocation recommendations page are three separate instances of real,
  working compute or storage with no path to a screen a coordinator or CEO
  would ever open.
- **No reconciliation layer exists anywhere in the product.** The groom's cake
  is the sharpest example, but the same shape (nothing cross-checks A against
  B before it becomes a problem) likely recurs — worth a dedicated pass rather
  than a single fix once W-something below lands.
- **Stub connectors are a named, deliberate scope decision, not an oversight.**
  `NOVEMBER-PLAN.md`'s "Parked until after November" list already excludes
  Meta/Google/TikTok *spend connectors* specifically. The plan below respects
  that boundary — it fixes the wiring around the existing manual capture path,
  it does not propose building the automated connectors early.

---

## Data ingestion inventory

Three ways data gets into Bloom House today, with what's actually true for
each, not what the label implies.

### A. Live API / webhook (fully automatic once connected)

| Source | Status |
|---|---|
| Gmail | Working (Rixey's own connection is currently broken — operator issue per NOVEMBER-PLAN.md, not a product gap) |
| Calendly | Working, webhook always live |
| OpenPhone | Working, API-key based |
| Twilio SMS | Working, webhook |
| Zoom | Working, OAuth + sync |
| Instagram DMs | Built, blocked on Meta app credentials (operator step) |
| Google Places reviews | Working, poll |
| FRED economic indicators | Working |
| Open-Meteo weather | Working for temp/precip/forecast — **no severity/alert field, see W45 below** |
| Website pixel | Working once installed (first-party, not a third-party API, but automatic thereafter) |

### B. CSV download, then upload

| Source | Reachable from | Status |
|---|---|---|
| HoneyBook | `/onboarding/crm-import` | Working |
| The Knot Pro — leads export | `/onboarding/crm-import` | Working, **onboarding-only door, see W41** |
| Knot/WeddingWire storefront-activity funnel | `/onboarding/crm-import` | Working |
| Knot visitor-activity | `/onboarding/crm-import` | Working |
| Tour-scheduler exports (Calendly/Acuity/Square/ics) | `/onboarding/tour-scheduler-import` | Working |
| Web-form/calculator exports | `/onboarding/web-form-import` | Working |
| Reviews bulk paste | `/intel/reviews/paste` | Working |
| Any `source-registry.ts` platform's monthly report (Knot, WeddingWire, Zola, HCTG, Google Ads, Meta Ads, Pinterest Ads, TikTok Ads, GA4, Search Console) | `/agent/brain-dump` | Working, CSV accepted alongside screenshots |

### C. Screenshot, read by Sage's vision model

All of these go through the same real, working door: `Agent → Brain-dump`,
`/api/brain-dump/route.ts` → `callAIVision`.

| Source | Status |
|---|---|
| Knot / WeddingWire / Zola / HCTG performance tile | Working |
| Google Ads / Meta Ads / Instagram Ads / Pinterest Ads / TikTok Ads spend tile | Working |
| Instagram Insights (organic reach/profile visits) | Working |
| TikTok Analytics (organic views/profile visits) | Working |
| A single review, screenshotted | Working (`reviews_from_screenshot` case) |
| Instagram **new-follower list** (named followers, not aggregate metrics) | Text-paste works; the dedicated screenshot uploader is built and disabled ("V1.1"), and its vision-extraction code (`vision-prompt.ts`) is never called from any live route — **see W42** |
| Facebook / Pinterest **new-follower list** or engagement detail | Not built — the aggregate ad-spend and organic-reach paths above exist for these platforms, but no per-handle/per-engagement capture exists the way the (partial) Instagram one does |

---

## Cross-cutting patterns, both reports

1. **Ingestion is in much better shape than the surface suggests.** Nearly
   every marketing/social/review data source has a real, working capture path.
   The gap is consistently downstream: the data lands in a table and nothing
   reads it into the screen that would make it matter (reviews sentiment,
   social-to-tours, reallocation recommendations), or it lands on the wrong
   side of the portal (contracts, timeline, personal info).
2. **Reachability, not existence, is the recurring defect.** Four separate
   findings across both reports (Knot leads CSV, marketing-roi recommendations,
   pixel-config, marketing-spend — the last two already fixed in W39) are the
   same bug: a real feature with no door in.
3. **No reconciliation layer exists anywhere.** Nothing in the product
   currently checks a promise made in conversation against what actually
   happens (the groom's cake), or an inquiry against its reply (partial), or a
   weather event against a tour outcome the week it happened (not built at
   all).
4. **The stub connectors (Google Ads, TikTok Ads) are a known, deliberate
   parking**, not a gap to fix in this wave. The plan below works with the
   manual capture path that already exists for both.

---

## Wave 6 and wave 7 plan

Numbering continues from W40. Every item below states what "done" looks like
so a workstream can be graded, not just built. Two waves because the first is
genuinely "finish what's already wired most of the way" (wave 5's own shape),
the second is more architectural (coordinator/couple parity, the
reconciliation layer) and benefits from the reimport being live to test
against real data.

### Wave 6 — wire forward what's already flowing in

| # | Workstream | Owns (files) | Done when |
|---|---|---|---|
| W41 | Reach what's already built: nav entry for `/intel/marketing-roi/recommendations` (Intel → Conversion, near Marketing Spend); a daily-reachable door for the Knot leads CSV re-upload (not just onboarding) — likely a link from `/intel/sources/track` or `/agent/brain-dump` into the structured `crm-import` flow rather than a UI rebuild; delete `/org` and `/sage` per the W39 "delete" verdict | `nav-config.ts`, `intel/marketing-roi/recommendations/page.tsx` (remove gate), `org/page.tsx`, `sage/page.tsx` (delete), one new link | A coordinator can reach the reallocation page and re-run a Knot leads import without knowing a URL; `/org` and `/sage` are gone; `check:links` still passes |
| W42 | Finish the Instagram follower-screenshot capture: wire the existing `vision-prompt.ts` into `/api/intel/social-integration/capture`, enable the file input in `CaptureNowModal.tsx` | `capture/route.ts`, `CaptureNowModal.tsx`, `vision-prompt.ts` | A screenshot of a followers list produces the same `social_captures`/`social_engagements` rows the text-paste path produces today, tested against a real screenshot fixture |
| W43 | Make review sentiment real: run sentiment/theme extraction at ingestion time (Google Places poll, CSV/paste import, and the brain-dump `reviews_from_screenshot` case) so `reviews.sentiment_score`/`themes` actually get written | `google-places.ts`, `data-import.ts`, brain-dump route's review case | `/intel/reviews`'s sentiment trend renders a real direction, not "—", on a venue with reviews |
| W44 | Add a tours channel to the correlation engine, so social volume (already reaching `marketing_metric` via brain-dump) can be paired against it | `correlation-engine.ts`, `format-series-label.ts` | `/intel/macro-correlations` can show a real Instagram/TikTok-volume-vs-tours-booked card when the data supports it, `enoughData`-gated like everything else |
| W45 | Weather severity: add a severity/alert field to weather ingestion, fix or remove the dead tornado-keyword branch in `weather-cancellation.ts`, widen the "active anomaly" window so a weekend event is still visible the following week | `weather.ts`, `weather-cancellation.ts`, `climate-context.ts`, one migration | A severe-weather day from the past 7-14 days surfaces in the hypothesis prompt and on `/intel/weather`'s "notable past weather" section, not just same-day |
| — | Carried forward from the existing "Follow-ups for wave 5" list, unchanged | `crm-import/index.ts` (progression event type), `phrase-selector.ts` decision, Instagram reply send path (blocked on Meta credentials — operator), investor-materials template | As already scoped in NOVEMBER-PLAN.md |

### Wave 7 — coordinator/couple parity and the reconciliation layer

| # | Workstream | Owns (files) | Done when |
|---|---|---|---|
| W46 | Coordinator contract search: surface the couple-side contract search (already built, already works) on the coordinator's own wedding page, scoped to coordinator role | `portal/weddings/[id]/page.tsx`, `couple/contracts` API (read-scope extension) | A coordinator can search a wedding's contracts by name/vendor/content from `/portal/weddings/[id]` without switching to the couple portal |
| W47 | Coordinator can build/edit the day-of timeline, not just view it | `portal/weddings/[id]/page.tsx` (TimelineTab), `_couple-pages/timeline/page.tsx` (extract the shared builder) | A coordinator can add/edit/reorder a timeline event from the wedding page and it's the same row the couple sees |
| W48 | Personal/relationship info on the actual meeting page: bring a coordinator-appropriate view of the identity-reconstruction profile onto `/portal/weddings/[id]`, not just `/intel/clients/[id]` | `portal/weddings/[id]/page.tsx`, `ReconstructedIdentityPanel.tsx` | The wedding page shows the couple's story/preferences, not just logistics, without opening a different tool |
| W49 | One connected table map: link `guest_list`/`seating_tables` data into the konva table-map editor so a coordinator can assign a named guest to a table visually | `table-map/page.tsx`, `seating/page.tsx` (shared data model), `GuestsTab` | Dragging a guest's name onto a table in the visual editor writes the same assignment the couple's seating page reads, both directions |
| W50 | Turn on freeform detail capture in the live pipeline: wire the existing (currently dead) `specialRequests` catch-all into email/call processing, cost-gated so it doesn't add a model call to every message (e.g. only on messages the classifier already flags high-signal) | `extraction.ts`, `email/pipeline.ts` | A test email mentioning an unusual reception detail produces a structured, reviewable row, not just raw text |
| W51 | Planning Notes from venue conversations, not only the couple's chatbot: extend note extraction to coordinator-venue interactions | `planning-extraction.ts`, `email/pipeline.ts` | A detail mentioned on a call or in an email to the venue lands in Planning Notes the same way a Sage-chat mention does |
| W52 | Commitment reconciliation: a scheduled check (30/14/7 days out) diffing captured commitments (W50/W51 output) against the day-of timeline, flagging anything mentioned but missing | New `src/lib/services/commitments/**`, a cron entry, a coordinator-facing queue (new tab or reuse the knowledge-gaps shape) | Given a test wedding with a planning note mentioning a groom's cake and no matching timeline event, the flag fires before the wedding date |

### What stays parked, on purpose

Real Google Ads / TikTok Ads / Meta Ads API connectors stay parked per
`NOVEMBER-PLAN.md`. Nothing above proposes building them — W41-W45 work
entirely with the manual brain-dump capture path that already exists and is
already good enough to answer the CEO's channel questions once the pages are
reachable.

### Sequencing note

Wave 6 needs no new data and no reimport, it's all wiring against what's
already flowing in or already stored, matching wave 5's own "finish what can
be finished without data" shape — it could plausibly run alongside wave 5's
tail or immediately after. Wave 7 touches more surfaces per workstream
(coordinator UI reuse of couple-side components) and benefits from testing
against real, reimported Rixey data rather than the demo seed, so it's placed
after the reimport in the sequence, not before it.
