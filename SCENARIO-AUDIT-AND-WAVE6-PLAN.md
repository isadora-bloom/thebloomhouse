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

### D. External signals — checked properly this time, not just weather and FRED

Isadora asked directly: check the APIs aren't just Google, check weather, "the
politics," everything touched on. Fair, my first pass under-covered this.
`correlation-engine.ts`'s `buildSeries` carries **eight** channels, checked
individually against their actual loader code, not the page's description of
them:

| Signal | Real API? | Status |
|---|---|---|
| Weather (Open-Meteo) | Yes | Working for temp/precip/forecast. No severity field — W45 |
| FRED (CPI, mortgage rate, S&P 500, unemployment, consumer sentiment) | Yes | Working |
| Cultural moments | Hybrid | LLM proposes, operator confirms, then enters the engine — working |
| Holiday/event calendar (`calendar.ts`) | Yes, DB-backed | Federal holidays, school holidays, university calendars, sporting events, conventions, **and election days** — working, per-venue hierarchical geo_scope |
| **Government events (`government.ts`) — the "politics" signal** | Yes, DB-backed | Real: shutdowns/threatened shutdowns/partial shutdowns, weighted 1.5x for DC/VA/MD venues to reflect federal-employee clientele exposure — directly relevant to Rixey specifically. Working, feeds the engine today |
| Census (`ingestion/census.ts`) | Yes, real US Census Bureau ACS API | Working — county/state demographics into `market_intelligence` |
| Market intelligence | Backed by the same `market_intelligence` table census populates | Not independently verified beyond census as a source — flag for a closer look if it matters, not confirmed further here |
| Google Trends (`intel/trends.ts`) | Yes, real API — via SerpAPI, not Google directly | **Config-dependent, not guaranteed live**: silently skips with a console warning if `SERPAPI_API_KEY` isn't set, and requires each venue to have a `google_trends_metro` configured. Worth an explicit check that Rixey has both before relying on it |

None of these eight are stubs. The Google Ads / TikTok Ads / Meta Ads
*spend* connectors checked earlier are the only stub connectors found in this
whole audit, and they're already correctly parked. The real gap, as W44 now
reflects, is that none of these eight can be paired against tours — only
against inquiries — so the highest-leverage single fix in this entire plan is
still W44, now worth more than originally scoped.

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

All five run in parallel, in separate worktrees, from `git reset --hard consolidation` — disjoint files, no shared ownership, no sequencing between them.

| # | Workstream | Model | Owns (files) | Done when |
|---|---|---|---|---|
| W41 | Reach what's already built: nav entry for `/intel/marketing-roi/recommendations` (Intel → Conversion, near Marketing Spend); a daily-reachable door for the Knot leads CSV re-upload (not just onboarding) — likely a link from `/intel/sources/track` or `/agent/brain-dump` into the structured `crm-import` flow rather than a UI rebuild; delete `/org` and `/sage` per the W39 "delete" verdict | Haiku | `nav-config.ts`, `intel/marketing-roi/recommendations/page.tsx` (remove gate), `org/page.tsx`, `sage/page.tsx` (delete), one new link | A coordinator can reach the reallocation page and re-run a Knot leads import without knowing a URL; `/org` and `/sage` are gone; `check:links` still passes |
| W42 | Finish the Instagram follower-screenshot capture: wire the existing `vision-prompt.ts` into `/api/intel/social-integration/capture`, enable the file input in `CaptureNowModal.tsx` | Sonnet | `capture/route.ts`, `CaptureNowModal.tsx`, `vision-prompt.ts` | A screenshot of a followers list produces the same `social_captures`/`social_engagements` rows the text-paste path produces today, tested against a real screenshot fixture |
| W43 | Make review sentiment real: run sentiment/theme extraction at ingestion time (Google Places poll, CSV/paste import, and the brain-dump `reviews_from_screenshot` case) so `reviews.sentiment_score`/`themes` actually get written | Sonnet | `google-places.ts`, `data-import.ts`, brain-dump route's review case | `/intel/reviews`'s sentiment trend renders a real direction, not "—", on a venue with reviews |
| W44 | Add a tours channel to the correlation engine. This is higher-leverage than "social vs tours" alone: `buildSeries` already carries **eight** real external channels (weather, FRED economics, cultural moments/holiday calendar including election days, government shutdown impact — a real "politics" signal, live for DC-region venues like Rixey — census demographics, and Google Trends via a real SerpAPI integration), and **none of them** can be paired against tour bookings today, only against inquiries. One missing series unlocks all eight pairings at once, not just social | Opus | `correlation-engine.ts`, `format-series-label.ts` | `/intel/macro-correlations` can show a real card for any of the eight existing channels against tours-booked, not just Instagram/TikTok volume, `enoughData`-gated like everything else |
| W45 | Weather, three modes (per Isadora 2026-09-14 — "specific, historic, and future," not just a severity flag): **specific** — add a severity/alert field, fix or remove the dead tornado-keyword branch, widen the "active anomaly" window so a weekend event is still visible the following week; **historic** — the "typical conditions per month with decade trend deltas" already has real code (`weather-climate-norms.ts`, rendered on `/intel/weather`) but depends on the 20-year archive backfill actually having been run per venue (confirmed opt-in/annual, not automatic) — activate it, don't rebuild it, and verify it's actually populated for Rixey; **future** — the decade-delta comparison is two points (this decade vs last), not the continuous "getting wetter every year" trend line Isadora described — add a proper year-over-year regression per month/metric, distinct from the 14-day operational forecast which already exists | Sonnet | `weather.ts`, `weather-cancellation.ts`, `climate-context.ts`, `weather-climate-norms.ts` (activation + new trend calc), one migration | A coordinator can see, for one venue: last weekend's actual severe event; June's normal 4pm temperature against this decade; and whether August has been trending wetter year over year — three different questions, three different answers, on the same page |
| — | Carried forward from the existing "Follow-ups for wave 5" list, unchanged | — | `crm-import/index.ts` (progression event type), `phrase-selector.ts` decision, Instagram reply send path (blocked on Meta credentials — operator), investor-materials template | As already scoped in NOVEMBER-PLAN.md |

### Reference pattern: the Rixey portal, read-only, `C:\Users\Ismar\rixey-portal`

Per Isadora 2026-09-14: the couple's experience should closely match the
original Rixey portal, which already solved this well. Checked, read-only,
not modified (per `CLAUDE.md`'s source-codebase rule). The pattern that
matters:

Rixey is **one app, shared components, a role prop** — not two divergent
implementations. `src/pages/Dashboard.jsx` (the couple's view) and
`src/pages/admin/AdminWeddingProfile.jsx` (the coordinator's view) both
import and mount the exact same `TimelineBuilder`, `TableLayoutPlanner`, and
`GuestList` components against the same `weddingId`, differing only by a
prop: the couple's page passes `userId`, the admin page passes `isAdmin`.
Same rows, same live data, both sides can edit, the component itself (not a
second implementation) decides what an admin can do that a couple can't.

Contracts run the *other* way from what Bloom does today: Rixey's
`ContractPanel` lives under `pages/admin/`, mounted from
`AdminWeddingProfile.jsx` — contract management is coordinator-primary
there, the couple's dashboard only references "Contracts & Payments" as a
status line, not a full search UI. Worth matching that direction rather than
the reverse.

This reframes W46/W47/W49 below: the target isn't "give the coordinator a
second, read-only view of what the couple built," it's "extract one shared
component per feature and mount it on both sides with a role prop," matching
Rixey exactly. W48 has no direct Rixey equivalent (the identity-reconstruction
profile is a Bloom-only concept) so it keeps its original shape.

**What this does and doesn't mean, per Isadora 2026-09-14:** the thing worth
copying from Rixey is the *architecture* (one component, one set of rows, a
role prop), not necessarily the specific UI. Bloom's own couple-side builders
were checked and, on a skim, look at least as capable as Rixey's — the
konva table editor has drag/rotate/group-select and a floor-plan background
image Rixey's canvas wasn't confirmed to have, the timeline builder has
auto-time-chaining and sunset calculation. W47 and W49 below already reflect
this: they extract *Bloom's own* existing couple-side builder into a shared
component, they do not propose porting Rixey's implementation in. Nothing
here was feature-compared line by line, so treat "keep Bloom's version, just
share it" as the default, and flag it back if an implementer finds a specific
piece where Rixey's is genuinely richer — that's a call for whoever builds
it, not a mandate baked into this plan.

### Wave 7 — coordinator/couple parity and the reconciliation layer

Sequencing within wave 7: W46, W47, W49 all touch `portal/weddings/[id]/page.tsx`
— coordinate by tab, same convention the real plan already uses for shared
files (e.g. wave 5's W35/W40 split of `crm-import/index.ts`): W46 owns a new
contracts tab or extends VendorsTab only, W47 owns TimelineTab only, W49 owns
GuestsTab plus the table-map route only. All three can still run in parallel
worktrees under that split. W50 and W51 both touch `email/pipeline.ts` —
same pattern, W50 owns the extraction-invocation call site, W51 owns the
planning-notes call site. **W52 depends on W50 and W51 landing first** (it
diffs their output against the timeline, there's nothing to diff before
they exist) — not parallel with them, runs after. W48 is fully independent,
can run alongside anything else in this wave.

| # | Workstream | Model | Owns (files) | Done when |
|---|---|---|---|---|
| W46 | Contracts, Rixey-shaped: build the coordinator-primary contract panel (search, view, key terms) on `/portal/weddings/[id]`, matching `ContractPanel`'s admin-first placement; keep a simplified status view on the couple's side rather than the current couple-only search | Sonnet | `portal/weddings/[id]/page.tsx` (new tab or extend VendorsTab), `couple/contracts` API (extend read scope to coordinator role), `_couple-pages/contracts/page.tsx` (simplify, don't remove) | A coordinator can search a wedding's contracts by name/vendor/content from `/portal/weddings/[id]`; the couple still sees their contracts, at a lighter level |
| W47 | One shared timeline builder, Rixey-shaped: extract the couple's timeline builder (`_couple-pages/timeline/page.tsx`) into a component that both `_couple-pages/timeline` and `/portal/weddings/[id]` (TimelineTab) mount against the same `timeline` rows, gated by an `isAdmin`/role prop the way `TimelineBuilder weddingId userId` vs `TimelineBuilder weddingId isAdmin` does in Rixey | Sonnet | `portal/weddings/[id]/page.tsx` (TimelineTab only), `_couple-pages/timeline/page.tsx`, new shared component | A coordinator can add/edit/reorder a timeline event from the wedding page; it's the same row, same component family, the couple sees the edit live |
| W48 | Personal/relationship info on the actual meeting page: bring a coordinator-appropriate view of the identity-reconstruction profile onto `/portal/weddings/[id]`, not just `/intel/clients/[id]` (no Rixey equivalent — Bloom-only concept) | Opus | `portal/weddings/[id]/page.tsx` (new section, own file), `ReconstructedIdentityPanel.tsx` | The wedding page shows the couple's story/preferences, not just logistics, without opening a different tool |
| W49 | One connected table map, Rixey-shaped: extract the couple's table/guest components into shared pieces (matching `TableLayoutPlanner` + `GuestList`, both mounted on both sides against the same `weddingId`) so a coordinator can assign a named guest to a table visually and the couple sees the same assignment | Sonnet | `table-map/page.tsx`, `seating/page.tsx` (shared data model), `portal/weddings/[id]/page.tsx` (GuestsTab only), new shared components | Dragging a guest's name onto a table in the visual editor writes the same assignment the couple's seating page reads, both directions, one component family not two |
| W50 | Turn on freeform detail capture in the live pipeline: wire the existing (currently dead) `specialRequests` catch-all into email/call processing, cost-gated so it doesn't add a model call to every message (e.g. only on messages the classifier already flags high-signal) | Opus | `extraction.ts`, `email/pipeline.ts` (extraction call site only) | A test email mentioning an unusual reception detail produces a structured, reviewable row, not just raw text |
| W51 | Planning Notes from venue conversations, not only the couple's chatbot: extend note extraction to coordinator-venue interactions | Opus | `planning-extraction.ts`, `email/pipeline.ts` (planning-notes call site only) | A detail mentioned on a call or in an email to the venue lands in Planning Notes the same way a Sage-chat mention does |
| W52 | Commitment reconciliation: a scheduled check (30/14/7 days out) diffing captured commitments (W50/W51 output) against the day-of timeline, flagging anything mentioned but missing | Opus | New `src/lib/services/commitments/**`, a cron entry, a coordinator-facing queue (new tab or reuse the knowledge-gaps shape) | Given a test wedding with a planning note mentioning a groom's cake and no matching timeline event, the flag fires before the wedding date |

### Wave 8 — surface it all, three audiences, and close the couple-experience loop

This is the direct answer to "build a plan for how to surface all ingested
data and use it in CEO and coordinator decision-making, and how to improve
the couple's experience." Two of these (W55, W56) are genuine new capability,
not wiring; the rest compose screens out of what waves 6-7 just finished.

**Three-audience surfacing matrix** — where each data category lands today,
and the gap wave 8 closes:

| Data category | CEO sees it? | Coordinator sees it? | Couple sees it? | Gap this wave closes |
|---|---|---|---|---|
| Marketing spend / channel ROI | Scattered across `/intel/sources`, `/intel/channels`, `/intel/marketing-roi` | Same, buried in Intel submenus | No, nor should they | W53: one consolidated story; W54: a link in from daily nav |
| Tour weekday conversion | Real, on `/intel/cohort`, but nobody's told to look there | Same | No | W53, W54 |
| Reviews (volume/stars, and after W43, sentiment) | Same gap | Same gap | Indirectly — `review-language.ts` already feeds Sage's tone (working today) | W57: an alert, not just a chart |
| Social volume (after W44, vs tours) | Not yet built anywhere | Not yet built anywhere | No | W53 |
| Weather (after W45, with severity) | No | `/intel/weather` only | No | W56 |
| Identity/personal profile | No (nor should they) | After W48, yes | **No — never personalises anything the couple sees, checked directly this session** | W55 |
| Commitment reconciliation (after W52) | No | Yes, the new queue | Indirectly, by not having things fall through | Already covered by W52 |

| # | Workstream | Model | Owns (files) | Depends on | Done when |
|---|---|---|---|---|---|
| W53 | CEO "monthly story": one screen (or a generated one-pager, reusing the TBH Report's print styling pattern) that pulls response time, weekday tour conversion, channel ROI, and review volume/rating into a single narrated view, instead of five separate pages | Sonnet | New `src/app/(platform)/intel/monthly-story/page.tsx` (or extend an existing summary page — implementer's call), `nav-config.ts` (a real entry — do not repeat W39's own lesson and ship an orphan), reusing existing canonical reads only, no new computation | W41 (reallocation page must be reachable to cite it), W43 (real sentiment to cite) | A CEO can open one page and get every answer from report 2's scenario without hunting across Intel; the page has a nav entry from day one |
| W54 | Coordinator daily-surface links: `/today` and `/agent/leads` get a one-line pointer out to the deeper answers (weekday conversion, channel spend) instead of leaving them undiscoverable in Intel submenus | Sonnet | `today/page.tsx`, `today/view-model.ts` (links only, no new data) | W41 | A coordinator on `/today` can get to the weekday-conversion table and the reallocation page in one click, not zero |
| W55 | Couple-experience personalisation: wire the identity/preference data already captured (today Intel-only) into the couple-portal Sage prompt layer, so the product's own stated USP ("4-layer custom voice") actually reaches the couple, not just venue-facing drafts | Opus | `src/lib/services/brain/**` (the couple-portal prompt builder specifically — do not touch the venue-facing draft brain), `couple_identity_profile` read path | None — identity data already exists, this is purely a wiring job, can start immediately | A couple whose profile notes a specific preference or detail gets a portal response that reflects it, verified against a fixture couple, not just theoretically wired |
| W56 | Weather-aware and conversion-informed couple nudges: surface honest, plain-language weather context on the couple's wedding-day view, and use real weekday-conversion data to make midweek tour slots an honest, informed suggestion during booking rather than an unexplained default | Sonnet | `_couple-pages/**` (wedding-day weather card), tour-booking/scheduling surface (wherever tour slots are offered to an inquiring couple) | W44, W45 | A couple sees real forecast context for their date; an inquiring lead offered a midweek tour sees why, backed by the real conversion number, not marketing copy |
| W57 | Review-buzz alert: once sentiment is real (W43), wire a "review tone is slipping" flag into `/pulse` or `/today`, so the CEO's Monday question is something the coordinator already knows about, not something raised cold in a meeting | Sonnet | `pulse-aggregator.ts` or `today` surfacing logic | W43 | A venue with a declining sentiment trend shows a flagged item on `/pulse` before the next monthly meeting, not only on a chart nobody opened |

**Parallel execution summary, waves 6-8**

```
Wave 6 (no dependencies among these five, all parallel):
  W41  W42  W43  W44  W45

Wave 7:
  W46  W47  W49  W48   <- four parallel (tab-scoped split on portal/weddings/[id]/page.tsx
                            for W46/W47/W49; W48 fully independent)
  W50  W51              <- two parallel (call-site split on email/pipeline.ts)
  W52                    <- after W50 + W51 land, not parallel with them

Wave 8:
  W53 (needs W41, W43)   W54 (needs W41)   W57 (needs W43)   <- parallel once their deps land
  W55                                                          <- independent, can start wave 6's first day
  W56 (needs W44, W45)                                         <- after wave 6
```

W55 is the one item across all three waves with zero dependencies on anything
else in this plan — it could start today, in parallel with wave 6, if there's
a spare Opus slot.

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

---

## What this plan missed, checked honestly against itself

Asked directly what I hadn't accounted for. Here's what a second pass found,
not padding — each of these would genuinely bite if the plan above ran
exactly as first written.

1. **Cron budget is at its ratchet, exactly, today.** `check:cleanup-budget`
   reports `cron_count 49/49, at budget` on this branch right now. W52's
   "a cron entry" for commitment reconciliation can't just be added — it has
   to reuse the existing cron dispatcher's schedule slots or someone has to
   consciously raise the budget number and say why. Same caution applies to
   any new periodic job wave 8 might imply (e.g. a monthly job behind W53).

2. **RLS/security scoping for every shared coordinator/couple component
   (W46, W47, W49).** "Mount the same component on both sides" is a UI
   instruction; the API routes underneath still need explicit role checks so
   a coordinator's broader session can't leak into what a couple's session
   is allowed to write, and vice versa. This needs its own design pass per
   workstream, not an assumption that reusing a component reuses safety.

3. **W55 (couple-experience personalisation) is a trust risk, not just a
   wiring job.** The identity-reconstruction data is explicitly documented
   elsewhere in this codebase as "aggregate ≠ disclose" — several existing
   dashboards deliberately never show a specific couple's personal detail
   back to anyone, only aggregates. W55 proposes using that same class of
   data to shape what a couple is told, directly. Done carelessly that reads
   as "how does this company know that," not as warmth. This needs explicit,
   careful scoping (which fields are safe to reflect back, which are strictly
   internal-only) before it's built, not discovered after a couple notices.

4. **No test/battery/isolation coverage was specified.** Every "done when"
   above is a functional description, not a gate. Matching how real waves
   report "vitest 1485/1485, golden 16/16, governance green": W43 and W44
   should add ground-truth probes to `scripts/battery-ground-truth.ts` for
   the new answerable questions (the standing rule from wave 2's own
   integration notes); anything W44/W52 add should be added to the wave 5
   two-venue isolation battery's coverage, not left for it to silently miss.

5. **Legacy-reads ratchet.** Any new read in waves 6-8 must go through a
   canonical reader or the spine, not `weddings`/`interactions` directly —
   restating this explicitly since the shared-rules block for waves 6-8 was
   never written out the way waves 1-5 each state it.

6. **Demo venue coverage.** Nothing above mentions the Crestwood demo seed.
   If W44's correlation card, W53's CEO story, or W57's review-buzz alert
   only ever have real data on Rixey, external demos and Isadora's own
   day-to-day QA won't show them working. Each new surface needs a credible
   demo-data case, not just a real-venue one.

7. **Expectation-setting on W44 specifically.** Building the tours channel
   makes the *question* answerable, it doesn't make the *answer* exist on
   day one — a correlation needs weeks or months of paired history after
   launch before `enoughData` gates open. Worth saying plainly so "we built
   it" doesn't get read as "we now know whether social posting drives
   tours."

8. **No shared-rules restatement for waves 6-8.** Waves 1-5 each open with
   "no database writes, work in your worktree, stage explicit paths, no
   `git add -A`, plain English, British spelling, no em dashes, `tsc` +
   `vitest` + governance clean before committing." None of that was
   re-stated for this plan. It should carry forward unchanged, verbatim, not
   assumed.

9. **Coordinator rollout/training isn't in scope here and should be
   someone's job.** UX-AUDIT-NON-TECHNICAL.md already establishes the
   audience is non-technical; six new tabs, a new page, and a role-shared
   timeline/table editor is a real amount of new surface for a coordinator
   to learn in one go. Not an engineering workstream, but worth a named
   owner before wave 8 ships, not after.

10. **This document itself has no nav entry problem, but it does have a
    self-consistency one worth naming out loud:** wave 8 adds real new
    surface area (a new page, new tabs, a new queue) right after W39 spent
    an entire wave trimming surface area down. Every new page above lists
    `nav-config.ts` or an explicit tab placement in its Owns column for
    exactly this reason — worth double-checking at merge time that none of
    wave 8's additions become wave 9's orphan-page audit.
