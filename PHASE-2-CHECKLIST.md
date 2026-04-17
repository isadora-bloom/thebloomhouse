# Phase 2: Intelligence Engine Build Checklist

**Status:** Planning complete. Ready for build.
**Date:** 2026-04-07
**Phase 1 recap:** 8 pattern detectors, `intelligence_insights` table with lifecycle, `market_intelligence` + `industry_benchmarks` seeded (5 regions, 23 benchmarks), `MarketContextCard` on dashboard, cron integration via `runAllVenueIntelligence`.

---

## Table of Contents

- [Section A: Post-Event Feedback System](#section-a-post-event-feedback-system)
- [Section B: Insight Surfacing](#section-b-insight-surfacing)
- [Section C: Operational Pattern Detectors](#section-c-operational-pattern-detectors)
- [Section D: External Data Ingestion Plan](#section-d-external-data-ingestion-plan)
- [Section E: Dynamic Weekly Digest](#section-e-dynamic-weekly-digest)
- [Section F: Insight-Action-Result Tracking](#section-f-insight-action-result-tracking)

---

## Section A: Post-Event Feedback System

### A.1 — New Schema: `event_feedback` table

**Priority:** P0 | **Complexity:** M | **Dependencies:** None

```sql
CREATE TABLE event_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  submitted_by uuid REFERENCES user_profiles(id),

  -- Overall Assessment
  overall_rating integer NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  couple_satisfaction integer CHECK (couple_satisfaction BETWEEN 1 AND 5), -- coordinator's read
  timeline_adherence text CHECK (timeline_adherence IN ('on_time', 'minor_delays', 'significant_delays')),

  -- Timeline Delays
  delay_phases text[] DEFAULT '{}',  -- e.g. ['cocktail_to_reception', 'ceremony_start']
  delay_notes text,

  -- Guest Experience
  guest_complaints text,
  guest_complaint_count integer DEFAULT 0,

  -- Catering
  catering_quality integer CHECK (catering_quality BETWEEN 1 AND 5),
  dietary_handling integer CHECK (dietary_handling BETWEEN 1 AND 5),  -- how well dietary needs were met
  service_timing integer CHECK (service_timing BETWEEN 1 AND 5),
  catering_notes text,

  -- Review Readiness
  review_readiness text CHECK (review_readiness IN ('yes', 'no', 'wait')),
  review_readiness_notes text,

  -- Freeform
  what_went_well text,
  what_to_change text,

  -- AI-Assisted Response Draft
  proactive_response_draft text,  -- AI-generated in case of negative review
  proactive_response_approved boolean DEFAULT false,

  -- Metadata
  feedback_triggered_at timestamptz,  -- when the system prompted for feedback
  submitted_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_event_feedback_venue ON event_feedback(venue_id);
CREATE INDEX idx_event_feedback_wedding ON event_feedback(wedding_id);
CREATE INDEX idx_event_feedback_rating ON event_feedback(overall_rating);
```

- [ ] Create migration `043_event_feedback.sql` — **P0** / S
- [ ] Add RLS policies (authenticated read/write, scoped to venue) — **P0** / S

### A.2 — New Schema: `event_feedback_vendors` table

**Priority:** P0 | **Complexity:** S | **Dependencies:** A.1

```sql
CREATE TABLE event_feedback_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_feedback_id uuid NOT NULL REFERENCES event_feedback(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES booked_vendors(id) ON DELETE SET NULL,
  vendor_name text NOT NULL,     -- denormalized for display even if vendor deleted
  vendor_type text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  notes text,
  would_recommend boolean,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_efv_feedback ON event_feedback_vendors(event_feedback_id);
CREATE INDEX idx_efv_vendor ON event_feedback_vendors(vendor_id);
```

- [ ] Create migration `044_event_feedback_vendors.sql` — **P0** / S
- [ ] Add RLS policies — **P0** / S

### A.3 — Feedback Trigger Logic

**Priority:** P0 | **Complexity:** M | **Dependencies:** A.1

**When it triggers:** 3 days after `wedding_date` on weddings with `status = 'booked'` or `status = 'completed'`.

**Source tables:**
- `weddings` — `wedding_date`, `status`, `venue_id`
- `event_feedback` — check if feedback already submitted for this wedding

**Implementation:**
- [ ] Add new cron job `post_event_feedback_check` to `src/app/api/cron/route.ts` — **P0** / S
  - Runs daily at 9am
  - Queries `weddings` where `wedding_date <= now() - 3 days` AND `status IN ('booked', 'completed')` AND no row in `event_feedback` for that `wedding_id`
  - For each match: insert a row in `event_feedback` with `feedback_triggered_at = now()` and null ratings (signals "pending")
  - Optionally creates an in-app notification (see A.6)
- [ ] Add `VALID_JOBS` entry `'post_event_feedback_check'` to cron route — **P0** / S

### A.4 — Feedback Form UI (Coordinator Side)

**Priority:** P0 | **Complexity:** L | **Dependencies:** A.1, A.2

**Where it lives:** New tab on `portal/weddings/[id]` page. Tab label: "Post-Event Feedback". Only visible when `wedding_date` is in the past.

**Source tables for pre-populating the form:**
- `booked_vendors` — list all vendors for the wedding to generate per-vendor rating rows
- `timeline` — list timeline phases as delay dropdown options
- `guest_list` — count for context
- `allergy_registry` — count for dietary context

**New UI components:**
- [ ] `PostEventFeedbackTab` component on `portal/weddings/[id]/page.tsx` — **P0** / L
  - Star rating inputs (1-5) for: overall, couple satisfaction, catering quality, dietary handling, service timing
  - Radio group for timeline adherence (on time / minor / significant)
  - Multi-select dropdown for delay phases (populated from `timeline` categories: ceremony, cocktail_hour, dinner, toasts, first_dance, cake_cutting, send_off, other)
  - Per-vendor rating section: loop through `booked_vendors`, each gets 1-5 stars + notes + "would recommend" toggle
  - Textarea: guest complaints, what went well, what to change
  - Review readiness radio: yes / no / wait
  - Submit button
- [ ] `VendorRatingCard` sub-component (vendor name, type, star input, notes, recommend toggle) — **P0** / M
- [ ] Form validation (overall_rating required, at least 1 vendor rated) — **P0** / S

### A.5 — AI-Assisted Proactive Review Response

**Priority:** P1 | **Complexity:** M | **Dependencies:** A.4

**When:** If `overall_rating <= 3` OR `couple_satisfaction <= 3` OR `review_readiness = 'no'`, offer a "Draft proactive response" button.

**Implementation:**
- [ ] API route `POST /api/portal/event-feedback/draft-response` — **P1** / M
  - Input: `event_feedback_id`
  - Reads the full feedback (including vendor ratings, guest complaints, what went well)
  - Calls `callAI` with a prompt to draft a professional, empathetic response acknowledging specific issues while highlighting positives
  - Saves to `event_feedback.proactive_response_draft`
- [ ] UI: "Draft Response" button + editable textarea showing the draft — **P1** / M
- [ ] "Approve for use" toggle → sets `proactive_response_approved = true` — **P1** / S

### A.6 — Feedback Notification

**Priority:** P1 | **Complexity:** S | **Dependencies:** A.3

- [ ] When feedback is triggered, create entry in `admin_notifications` (or a new in-app notification system if one doesn't exist) — **P1** / S
  - Text: "Post-event feedback is ready for [Couple Name]'s wedding on [date]. Complete it while it's fresh."
  - Links to: `portal/weddings/[id]#feedback`
- [ ] Badge on the weddings list page showing pending feedback count — **P1** / S

### A.7 — Feeding the Intelligence Engine

**Priority:** P1 | **Complexity:** M | **Dependencies:** A.1, A.2, Section C detectors

**How event_feedback feeds detectors:**
- `event_feedback.timeline_adherence` + `delay_phases` → Section C.2 (Timeline Adherence Patterns)
- `event_feedback_vendors.rating` → Section C.3 (Vendor Performance Tracking)
- `event_feedback.catering_quality` + `dietary_handling` → Section C.4 (Guest Experience Predictor)
- `event_feedback.overall_rating` + `couple_satisfaction` + `review_readiness` → Section C.6 (Review Prediction)

- [ ] Add `event_feedback` to the intelligence engine's data sources (no new detector yet, data collection phase) — **P1** / S

---

## Section B: Insight Surfacing

### B.1 — Dashboard Insights Feed

**Priority:** P0 | **Complexity:** M | **Dependencies:** None (uses existing `intelligence_insights` table)

**Source table:** `intelligence_insights` WHERE `status IN ('new', 'seen')` AND `expires_at > now()` ORDER BY `priority DESC, created_at DESC` LIMIT 5

**Target UI:** `src/app/(platform)/page.tsx` (main dashboard)

- [ ] `DashboardInsightsFeed` component — **P0** / M
  - Shows top 5 new/unseen insights, ranked by priority (critical > high > medium > low)
  - Each card shows: priority badge, insight_type icon, title, body (truncated), action button
  - "Mark as seen" on card view (updates `status = 'seen'`, `seen_at = now()`)
  - "View all" link to a dedicated insights page
  - Collapses to a single-line summary on mobile
- [ ] API route `GET /api/intel/insights` — fetches insights for current venue scope — **P0** / S
- [ ] API route `PATCH /api/intel/insights/[id]` — update status (seen, acted_on, dismissed) — **P0** / S
- [ ] Add the feed below the stats cards on `page.tsx` — **P0** / S

### B.2 — Inline Insights: Agent Inbox

**Priority:** P1 | **Complexity:** M | **Dependencies:** B.1

**Source tables:**
- `intelligence_insights` WHERE `category IN ('response_time', 'couple_behavior')` — lead-specific
- `weddings` — join on wedding_id for the selected thread
- `engagement_events` — current heat score context

**Target UI:** `src/app/(platform)/agent/inbox/page.tsx`

- [ ] `InboxInsightBanner` — contextual insight shown when viewing a specific thread — **P1** / M
  - Shows: booking probability estimate (from couple behavior detector), response urgency (from response time detector)
  - Source: cross-reference the current `wedding_id` against `intelligence_insights.data_points` OR compute on-the-fly from `engagement_events` + `interactions`
  - Example: "This couple has 3.2x higher engagement than average lost leads. Respond within 30 min to maximize conversion."

### B.3 — Inline Insights: Agent Pipeline

**Priority:** P1 | **Complexity:** M | **Dependencies:** B.1

**Source tables:**
- `intelligence_insights` WHERE `category = 'lead_conversion'` AND `insight_type = 'risk'` — stall warnings
- `weddings` — pipeline data

**Target UI:** `src/app/(platform)/agent/pipeline/page.tsx`

- [ ] `PipelineStallWarnings` — sidebar or banner showing stalled leads from Detector 6 — **P1** / M
  - Highlights leads with `updated_at` > 14 days ago
  - Shows estimated at-risk revenue
  - "Re-engage" action button per lead

### B.4 — Inline Insights: Agent Leads

**Priority:** P2 | **Complexity:** S | **Dependencies:** B.1

**Source:** `intelligence_insights` WHERE `category = 'couple_behavior'` — heat tier patterns

**Target UI:** `src/app/(platform)/agent/leads/page.tsx`

- [ ] Add heat tier distribution mini-chart (cold/warm/hot counts) with linked insight — **P2** / S

### B.5 — Inline Insights: Intel Dashboard

**Priority:** P0 | **Complexity:** M | **Dependencies:** B.1

**Source:** `intelligence_insights` — all categories, top 10, plus `anomaly_alerts`

**Target UI:** `src/app/(platform)/intel/dashboard/page.tsx`

- [ ] Replace static anomaly cards with `InsightFeed` component showing combined anomaly + insight stream — **P0** / M
  - Merges `anomaly_alerts` + `intelligence_insights` into one chronological feed
  - Each card has: type badge, severity indicator, title, body, action, acknowledge/dismiss buttons
  - Filter by category and priority

### B.6 — Inline Insights: Intel Sources

**Priority:** P1 | **Complexity:** S | **Dependencies:** B.1

**Source:** `intelligence_insights` WHERE `category = 'source_attribution'` — from Detector 3 (Source Quality)

**Target UI:** `src/app/(platform)/intel/sources/page.tsx`

- [ ] Add `InsightPanel` with source quality insights below the source table — **P1** / S
  - Already using `InsightPanel` component on this page, extend with real data from `intelligence_insights`

### B.7 — Inline Insights: Intel Tours

**Priority:** P1 | **Complexity:** S | **Dependencies:** B.1

**Source:** `intelligence_insights` WHERE `category = 'lead_conversion'` — from Detector 2 (Day-of-Week)

**Target UI:** `src/app/(platform)/intel/tours/page.tsx`

- [ ] Add day-of-week pattern insight card showing best/worst tour days — **P1** / S

### B.8 — Inline Insights: Intel Lost Deals

**Priority:** P1 | **Complexity:** S | **Dependencies:** B.1

**Source:** `intelligence_insights` WHERE category matches lost deal patterns — from Detector 8

**Target UI:** `src/app/(platform)/intel/lost-deals/page.tsx`

- [ ] Add pattern explanation insight panel — **P1** / S
  - Shows top loss reason, stage concentration, competitor mentions

### B.9 — Inline Insights: Portal Weddings List

**Priority:** P1 | **Complexity:** M | **Dependencies:** B.1, Section C detectors

**Source:** `event_feedback` (operational insights), `section_finalisations` (readiness), `checklist_items` (completion)

**Target UI:** `src/app/(platform)/portal/weddings/page.tsx`

- [ ] Add "Readiness Score" column to weddings table — **P1** / M
  - Calculated from: `section_finalisations` count / total sections, `checklist_items` completion %, days to wedding
  - Color-coded: green (on track), yellow (behind), red (at risk)
- [ ] Add "Needs Feedback" badge for weddings past wedding_date without `event_feedback` — **P1** / S

### B.10 — Inline Insights: Wedding Profile (portal/weddings/[id])

**Priority:** P1 | **Complexity:** M | **Dependencies:** B.1

**Source tables:**
- `intelligence_insights` — filtered to wedding-specific insights (via `data_points` containing the wedding_id or via a new `wedding_id` column on `intelligence_insights`)
- `event_feedback` — if completed, show summary
- `section_finalisations` — readiness overview

**Target UI:** `src/app/(platform)/portal/weddings/[id]/page.tsx`

- [ ] Add optional `wedding_id` column to `intelligence_insights` for per-wedding insights — **P1** / S
  ```sql
  ALTER TABLE intelligence_insights ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL;
  CREATE INDEX idx_insights_wedding ON intelligence_insights(wedding_id);
  ```
- [ ] `WeddingInsightsSidebar` component — shows all insights for this specific wedding — **P1** / M
  - Includes: readiness score, feedback summary, operational predictions
  - Full insight history with status tracking

### B.11 — Insight Action System (Universal)

**Priority:** P0 | **Complexity:** M | **Dependencies:** B.1

**Schema additions to `intelligence_insights`:**
```sql
ALTER TABLE intelligence_insights
  ADD COLUMN IF NOT EXISTS acted_on_note text,        -- what the coordinator did
  ADD COLUMN IF NOT EXISTS acted_on_by uuid REFERENCES user_profiles(id),
  ADD COLUMN IF NOT EXISTS dismissed_reason text,
  ADD COLUMN IF NOT EXISTS dismissed_by uuid REFERENCES user_profiles(id);
```

**UI — applies to ALL insight cards everywhere:**
- [ ] `InsightActionBar` component — **P0** / M
  - Three actions on every insight card:
    1. **"Seen"** — marks `status = 'seen'`, `seen_at = now()` (auto-triggers on view, or manual button)
    2. **"Act on this"** — opens a small modal: text input "What did you do?", saves to `acted_on_note`, sets `status = 'acted_on'`, `acted_on_at = now()`
    3. **"Dismiss"** — opens confirm with optional reason, sets `status = 'dismissed'`, `dismissed_at = now()`
  - After "Act on this": system tracks the underlying metric for outcome measurement (Section F)
- [ ] Add migration for new columns — **P0** / S
- [ ] Keyboard shortcuts: `s` = seen, `a` = act, `d` = dismiss (when insight card is focused) — **P2** / S

### B.12 — Dedicated Insights Page

**Priority:** P1 | **Complexity:** L | **Dependencies:** B.1, B.11

**Target UI:** New page at `src/app/(platform)/intel/insights/page.tsx`

- [ ] Full insights list with filtering — **P1** / L
  - Filters: status (new/seen/acted_on/dismissed/expired), category (all 11), priority, date range
  - Sort: by priority, by date, by impact_score
  - Bulk actions: mark multiple as seen/dismissed
  - Search by title/body text
  - Shows outcome tracking badge when available (Section F)

---

## Section C: Operational Pattern Detectors

### C.1 — Portal Engagement to Event Quality Predictor

**Priority:** P1 | **Complexity:** L | **Dependencies:** A.1 (for outcome data)

**Source tables:**
- `checklist_items` — `COUNT(*) WHERE is_completed = true` / `COUNT(*)` per wedding
- `section_finalisations` — `COUNT(*) WHERE couple_signed_off = true` per wedding
- `booked_vendors` — `COUNT(*) WHERE is_booked = true` per wedding
- `guest_list` — `COUNT(*)` per wedding (completeness proxy)
- `timeline` — `COUNT(*)` per wedding
- `allergy_registry` — `COUNT(*)` per wedding
- `event_feedback` — `overall_rating` (outcome variable)

**Insight template:**
> "Couples who complete 12+ portal sections by 6 weeks out average a 4.7 event rating vs 4.1 for those with fewer than 8 sections. [Couple Name] has completed [X] of [Y] sections with [Z] weeks to go."

**Implementation:**
- [ ] New detector `detectPortalEngagementQuality` in `intelligence-engine.ts` — **P1** / L
  - Correlates portal completion metrics at various milestones (12w, 8w, 6w, 4w, 2w before wedding) with `event_feedback.overall_rating`
  - Minimum data: 10 completed weddings with event_feedback
  - Generates both historical pattern insights AND per-wedding predictions
- [ ] Register in `runIntelligenceAnalysis` detector array — **P1** / S
- [ ] Add `'operational'` to the `category` CHECK constraint on `intelligence_insights` — **P1** / S

### C.2 — Timeline Adherence Patterns

**Priority:** P1 | **Complexity:** M | **Dependencies:** A.1 (requires event_feedback.timeline_adherence + delay_phases)

**Source tables:**
- `event_feedback` — `timeline_adherence`, `delay_phases`, `delay_notes`
- `timeline` — wedding timeline structure

**Insight template:**
> "Your last 3 weddings ran behind at the cocktail-to-reception transition. Consider adding a 15-minute buffer between cocktail hour and dinner service."

**Implementation:**
- [ ] New detector `detectTimelineAdherencePatterns` in `intelligence-engine.ts` — **P1** / M
  - Aggregates `delay_phases` across all event_feedback for the venue
  - Identifies phases that appear in >30% of delay reports
  - Minimum data: 5 event_feedback entries
  - Compares on-time events vs delayed events on venue ratings

### C.3 — Vendor Performance Tracking

**Priority:** P1 | **Complexity:** M | **Dependencies:** A.2 (requires event_feedback_vendors)

**Source tables:**
- `event_feedback_vendors` — `vendor_name`, `vendor_type`, `rating`, `would_recommend`
- `booked_vendors` — to identify the vendor across weddings

**Insight template:**
> "Caterer 'Silver Spoon Catering' has been rated 3/5 or lower on the last 2 events. Consider discussing concerns or recommending alternatives."

**Implementation:**
- [ ] New detector `detectVendorPerformancePatterns` in `intelligence-engine.ts` — **P1** / M
  - Aggregates vendor ratings across events by `vendor_name` (fuzzy match) or `vendor_id`
  - Flags vendors with avg rating < 3.5 across 2+ events
  - Flags vendors with `would_recommend = false` on 2+ events
  - Highlights top-performing vendors (avg >= 4.5, 3+ events)
  - Minimum data: 3 event_feedback_vendors entries per vendor

### C.4 — Guest Experience Predictor

**Priority:** P2 | **Complexity:** M | **Dependencies:** A.1

**Source tables:**
- `guest_care_notes` — `COUNT(*)` per wedding
- `allergy_registry` — `COUNT(*)` per wedding, check for `severity = 'severe'` or `'life_threatening'`
- `shuttle_schedule` — `COUNT(*)` per wedding
- `guest_list` — total guest count, dietary_restrictions completeness
- `event_feedback` — `guest_complaint_count`, `dietary_handling`

**Insight template:**
> "3 weddings with incomplete dietary info had guest complaints about food. This wedding is missing 18 dietary entries for 140 guests."

**Implementation:**
- [ ] New detector `detectGuestExperienceRisks` in `intelligence-engine.ts` — **P2** / M
  - Correlates guest data completeness (allergy %, care notes %, shuttle coverage) with `event_feedback.guest_complaint_count`
  - For upcoming weddings: checks completeness thresholds and generates per-wedding warnings
  - Minimum data: 5 completed weddings with event_feedback

### C.5 — Couple Readiness Assessment

**Priority:** P1 | **Complexity:** M | **Dependencies:** None (uses existing tables)

**Source tables:**
- `section_finalisations` — `COUNT(*) WHERE couple_signed_off = true` per wedding
- `checklist_items` — `COUNT(*) WHERE is_completed = true` per wedding
- `weddings` — `wedding_date` for milestone calculation

**Insight template:**
> "This couple has only finalized 3 of 14 sections with 3 weeks to go. Average couples at this milestone have finalized 9. Consider scheduling a check-in call."

**Implementation:**
- [ ] New detector `detectCoupleReadiness` in `intelligence-engine.ts` — **P1** / M
  - For each upcoming wedding (4-12 weeks out):
    - Calculates section completion percentage
    - Compares to historical averages at the same weeks-out milestone
    - Flags couples significantly behind average
  - Generates per-wedding insights (requires `wedding_id` column from B.10)
  - Minimum data: 5 completed weddings to build the baseline

### C.6 — Review Prediction

**Priority:** P2 | **Complexity:** L | **Dependencies:** A.1, C.1, C.5

**Source tables:**
- `event_feedback` — `overall_rating`, `couple_satisfaction`, `review_readiness`
- `section_finalisations` — portal engagement proxy
- `checklist_items` — portal engagement proxy
- `interactions` — email engagement volume
- `engagement_events` — heat score

**Insight template:**
> "Based on coordinator feedback (4.5/5) and high planning engagement (12/14 sections), this couple is likely to leave a 4-5 star review. Ask them within 48 hours of the wedding."

**Implementation:**
- [ ] New detector `detectReviewPrediction` in `intelligence-engine.ts` — **P2** / L
  - Combines: event_feedback rating, portal engagement score, email engagement, timeline adherence
  - Produces a predicted review score (1-5) with confidence
  - If predicted 4-5: generates "ask for review" action with optimal timing (48 hours post-event)
  - If predicted 1-3: generates "use proactive response draft" action
  - Minimum data: 10 event_feedback entries + 5 actual reviews to calibrate

### C.7 — Register All New Detectors

**Priority:** P1 | **Complexity:** S | **Dependencies:** C.1-C.6

- [ ] Add all new detectors to the `detectors` array in `runIntelligenceAnalysis()` — **P1** / S
- [ ] Expand the `category` CHECK constraint on `intelligence_insights` to include: `'operational'`, `'vendor_quality'`, `'guest_experience'`, `'readiness'`, `'review_prediction'` — **P1** / S
  ```sql
  ALTER TABLE intelligence_insights DROP CONSTRAINT intelligence_insights_category_check;
  ALTER TABLE intelligence_insights ADD CONSTRAINT intelligence_insights_category_check
    CHECK (category IN (
      'lead_conversion', 'response_time', 'team_performance',
      'pricing', 'seasonal', 'source_attribution', 'couple_behavior',
      'capacity', 'competitive', 'weather', 'market',
      'operational', 'vendor_quality', 'guest_experience', 'readiness', 'review_prediction'
    ));
  ```

---

## Section D: External Data Ingestion Plan

### Tier 1 Sources (Build Now)

#### D.1 — Census ACS (Demographics)

**Priority:** P0 | **Complexity:** M | **Dependencies:** None

- **API:** `https://api.census.gov/data/2023/acs/acs5` (free, key required)
- **Populates:** `market_intelligence` — `population`, `median_household_income`, `median_age`
- **Frequency:** Annually (data updates once/year)
- **Region resolution:** County and state level
- [ ] New service file `src/lib/services/census.ts` — **P0** / M
  - Fetches ACS 5-year estimates for: B01003 (population), B19013 (median income), B01002 (median age)
  - Maps county FIPS codes to existing `region_key` in `market_intelligence`
  - Upserts rows with `data_year` and `source = 'census_acs'`
- [ ] Add cron job `census_refresh` — runs monthly (checks for new annual data) — **P0** / S
- **Build timing:** Now

#### D.2 — CDC Marriage Statistics

**Priority:** P1 | **Complexity:** M | **Dependencies:** None

- **API:** `https://data.cdc.gov/resource/` (SODA API, free)
- **Populates:** `market_intelligence` — `marriages_per_year`, `marriage_rate_per_1000`
- **Frequency:** Annually (CDC publishes with ~1 year lag)
- **Region resolution:** State level
- [ ] New service file `src/lib/services/marriage-stats.ts` — **P1** / M
  - Fetches NVSS marriage data by state
  - Upserts into `market_intelligence` with `source = 'cdc_nvss'`
- [ ] Add cron job `marriage_stats_refresh` — runs monthly — **P1** / S
- **Build timing:** Now

#### D.3 — County Marriage Licenses

**Priority:** P2 | **Complexity:** L | **Dependencies:** None

- **Data source:** County clerk websites (no standard API; varies by jurisdiction)
- **Populates:** `market_intelligence` — local demand indicators
- **Frequency:** Monthly where data is available
- **Region resolution:** County level
- [ ] Research: identify if top 5 target counties have machine-readable data — **P2** / S
- [ ] If available: build scrapers per county; if not: manual data entry interface — **P2** / L
- **Build timing:** When we have paying customers

#### D.4 — NOAA Climate Normals

**Priority:** P0 | **Complexity:** S | **Dependencies:** None (extends existing `weather.ts`)

- **API:** `https://www.ncei.noaa.gov/access/services/data/v1` (NOAA CDO, existing integration)
- **Populates:** `weather_data` — already partially done; extend with 30-year climate normals
- **Frequency:** On venue onboarding + annually
- **Region resolution:** Station-specific (mapped via `venues.noaa_station_id`)
- [ ] Extend `src/lib/services/weather.ts` — add `fetchClimateNormals(venueId)` function — **P0** / S
  - Fetches NOAA 30-year normals (NORMAL_DLY dataset) for the venue's station
  - Populates monthly average high/low temp, precipitation, for all 12 months
  - Uses `year = 9999` or similar sentinel for "normal" data vs actual forecasts
- **Build timing:** Now

#### D.5 — Holiday/Event Calendar

**Priority:** P1 | **Complexity:** S | **Dependencies:** None

- **Data source:** Static JSON + Nager.Date API (`https://date.nager.at/api/v3/PublicHolidays/{year}/US`)
- **Populates:** New `calendar_events` table OR `feature_flags` on `venue_config`
- **Frequency:** Annually (load next year's calendar)
- [ ] New table `calendar_events` — **P1** / S
  ```sql
  CREATE TABLE calendar_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date date NOT NULL,
    name text NOT NULL,
    type text CHECK (type IN ('federal_holiday', 'school_break', 'local_event', 'industry_event')),
    region text DEFAULT 'US',  -- can be state-specific
    impacts_demand boolean DEFAULT true,
    demand_modifier float DEFAULT 1.0,  -- 1.5 = 50% above normal
    created_at timestamptz DEFAULT now()
  );
  ```
- [ ] Service function to fetch and seed public holidays — **P1** / S
- [ ] Static config for school break periods (Labor Day to Memorial Day mapping) — **P1** / S
- **Build timing:** Now

#### D.6 — BLS CPI (Consumer Price Index)

**Priority:** P1 | **Complexity:** M | **Dependencies:** None

- **API:** `https://api.bls.gov/publicAPI/v2/timeseries/data/` (free with registration)
- **Populates:** `economic_indicators` — extend with CPI series
- **Frequency:** Monthly
- **Series:** CUUR0000SA0 (CPI All Urban), CUUR0000SEHA (CPI Housing)
- [ ] Extend `src/lib/services/economics.ts` — add BLS CPI fetcher — **P1** / M
  - Adds `cpi_all_urban` and `cpi_housing` indicator names
  - Integrates into `calculateDemandScore` for purchasing power context
- **Build timing:** Now

#### D.7 — Zillow ZHVI (Home Values)

**Priority:** P2 | **Complexity:** M | **Dependencies:** None

- **Data source:** `https://www.zillow.com/research/data/` (CSV download, free)
- **Populates:** `market_intelligence` — new column `median_home_value`
- **Frequency:** Monthly
- **Region resolution:** Metro and county level
- [ ] Add `median_home_value integer` column to `market_intelligence` — **P2** / S
- [ ] New service file `src/lib/services/zillow.ts` — **P2** / M
  - Downloads Zillow ZHVI CSV, parses metro/county data
  - Upserts into `market_intelligence` with `source = 'zillow_zhvi'`
- **Build timing:** Build next month

#### D.8 — FRED Economic Data (Extended)

**Priority:** P0 | **Complexity:** S | **Dependencies:** None (extends existing `economics.ts`)

- **API:** `https://api.stlouisfed.org/fred/series/observations` (existing integration)
- **Populates:** `economic_indicators` — already fetching 5 series; add more
- **Frequency:** Monthly (existing cron)
- **New series:**
  - CPIAUCSL (CPI Urban) — for inflation tracking
  - UNRATE (Unemployment) — for labor market context
  - MORTGAGE30US (30-year mortgage rate) — household financial pressure indicator
- [ ] Add 3 new series to `FRED_SERIES` map in `economics.ts` — **P0** / S
- [ ] Update `calculateDemandScore` to factor in new series — **P0** / S
- **Build timing:** Now

### Tier 2 Sources (Build Next Month or Later)

#### D.9 — Knot/WeddingWire Competitive Listings

**Priority:** P2 | **Complexity:** XL | **Dependencies:** None

- **Data source:** No official API. Requires web scraping or manual data entry.
- **Populates:** New `competitive_landscape` table
- [ ] New table `competitive_landscape` — **P2** / M
  ```sql
  CREATE TABLE competitive_landscape (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    competitor_name text NOT NULL,
    source_platform text CHECK (source_platform IN ('the_knot', 'weddingwire', 'google', 'manual')),
    listing_url text,
    price_range_min integer,
    price_range_max integer,
    rating float,
    review_count integer,
    capacity_min integer,
    capacity_max integer,
    distance_miles float,
    last_checked_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  ```
- [ ] Manual entry UI for competitor data (form on intel/competitive page) — **P2** / L
- [ ] Optional: SerpAPI Google search for "[city] wedding venues" to discover competitors — **P2** / L
- **Build timing:** When we have paying customers

#### D.10 — Google Maps Hotels (Nearby Accommodations)

**Priority:** P2 | **Complexity:** M | **Dependencies:** None

- **API:** Google Places API (Nearby Search) — `$0.032/request`
- **Populates:** `accommodations` table (already exists)
- **Frequency:** On venue onboarding + quarterly refresh
- [ ] New service `src/lib/services/nearby-hotels.ts` — **P2** / M
  - Takes venue lat/lng, searches "hotel" within 15-mile radius
  - Populates `accommodations` with name, address, website, distance
- **Build timing:** Build next month

#### D.11 — Google Trends Extended

**Priority:** P1 | **Complexity:** S | **Dependencies:** None (extends existing `trends.ts`)

- **API:** SerpAPI Google Trends (existing integration)
- **Populates:** `search_trends` — add more terms
- **Frequency:** Weekly (existing cron)
- **New terms:** `"elopement"`, `"micro wedding"`, `"destination wedding [state]"`, `"wedding planner [city]"`
- [ ] Add new terms to `TREND_TERMS` in `trends.ts` — **P1** / S
- **Build timing:** Now

#### D.12 — School Calendar Data

**Priority:** P2 | **Complexity:** S | **Dependencies:** D.5 (uses `calendar_events`)

- **Data source:** Static config per state (school year start/end dates)
- **Populates:** `calendar_events` with `type = 'school_break'`
- [ ] Hardcode major school break periods for target states (VA, MD, DC, NC) — **P2** / S
  - Summer: June 15 - Aug 25 (approximate)
  - Winter: Dec 20 - Jan 3
  - Spring: March 20 - March 28
- **Build timing:** When we have paying customers

#### D.13 — Vendor Density Analysis

**Priority:** P2 | **Complexity:** L | **Dependencies:** D.9

- **Data source:** Derived from `vendor_recommendations` + `booked_vendors` + competitive landscape
- **Populates:** `market_intelligence.venue_count_estimate` (refine existing seed data)
- [ ] Service function to count unique vendors by type within venue's metro area — **P2** / M
- **Build timing:** When we have paying customers

---

## Section E: Dynamic Weekly Digest

### E.1 — Redesign Weekly Briefing as Intelligence Digest

**Priority:** P0 | **Complexity:** L | **Dependencies:** B.1 (insight surfacing), A.1 (event feedback)

**Current state:** `briefings.ts` generates weekly/monthly briefings from `weddings` + `trends` + `weather` + `economics` + `anomaly_alerts`. It does NOT currently incorporate `intelligence_insights`.

**What feeds the new digest:**
| Section | Source Tables | Source Service |
|---------|-------------|----------------|
| Leads needing attention | `weddings` (stalled), `intelligence_insights` (category=lead_conversion, type=risk) | `intelligence-engine.ts` Detector 6 |
| Performance this week | `weddings` (new inquiries, bookings, lost), `source_attribution`, `consultant_metrics` | `briefings.ts` existing |
| Pattern spotlight | `intelligence_insights` (top new insight, highest impact_score) | `intelligence-engine.ts` |
| Seasonal advisory | `market_intelligence` (inquiry_seasonality), `weather_data`, `calendar_events` (D.5) | `market-context.ts`, `weather.ts` |
| Event prep alerts | `weddings` (next 2 weeks), `section_finalisations`, `checklist_items` | New aggregation query |
| Quick wins | `intelligence_insights` (type=recommendation, status=new, complexity=low) | `intelligence-engine.ts` |

**When it runs:** Monday 6:00 AM venue local time (use `venue_config.timezone`)

**Delivery:** In-app notification + email via existing `briefings.ts` email delivery

- [ ] Refactor `generateWeeklyBriefing` in `briefings.ts` to include `intelligence_insights` data — **P0** / L
  - Add query: top 3 new `intelligence_insights` by `impact_score DESC` from the last 7 days
  - Add query: stalled pipeline leads (from Detector 6 data, or query `weddings` directly)
  - Add query: upcoming weddings in next 14 days with readiness scores
  - Add query: quick wins (low-effort insights: `insight_type = 'recommendation'`, `priority IN ('high', 'medium')`)
- [ ] Update AI system prompt to structure these into the 6 sections listed above — **P0** / M
- [ ] Add new briefing sections to the `BriefingContent` type — **P0** / S
  ```typescript
  interface BriefingContentV2 extends BriefingContent {
    leads_needing_attention: { wedding_id: string; couple_name: string; stage: string; days_stalled: number; value: number }[]
    pattern_spotlight: { title: string; body: string; action: string; impact_score: number } | null
    event_prep_alerts: { wedding_id: string; couple_name: string; wedding_date: string; readiness_pct: number; missing_sections: string[] }[]
    quick_wins: { title: string; action: string }[]
  }
  ```

### E.2 — Update Briefings UI

**Priority:** P1 | **Complexity:** M | **Dependencies:** E.1

**Target UI:** `src/app/(platform)/intel/briefings/page.tsx`

- [ ] Redesign briefing display to show the 6 structured sections — **P1** / M
  - **Leads Needing Attention:** Table with couple name, stage, days stalled, value, "Re-engage" CTA
  - **Performance:** Metric cards (inquiries, bookings, conversion, revenue) with sparkline vs prior week
  - **Pattern Spotlight:** Feature card with the week's top insight, expandable for full detail
  - **Seasonal Advisory:** Weather + demand seasonality combined card
  - **Event Prep Alerts:** Card per upcoming wedding with readiness progress bar
  - **Quick Wins:** Numbered action list with "Mark Done" checkboxes

### E.3 — In-App Notification for New Briefings

**Priority:** P1 | **Complexity:** M | **Dependencies:** E.1

- [ ] New table `notifications` (if not already exists) — **P1** / S
  ```sql
  CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    user_id uuid REFERENCES user_profiles(id),
    type text NOT NULL CHECK (type IN ('briefing', 'feedback_due', 'insight', 'alert', 'system')),
    title text NOT NULL,
    body text,
    link text,           -- in-app URL to navigate to
    read_at timestamptz,
    created_at timestamptz DEFAULT now()
  );
  ```
- [ ] Notification bell in top bar with unread count — **P1** / M
- [ ] Create notification when weekly briefing is generated — **P1** / S
- [ ] Create notification when event feedback is due — **P1** / S

---

## Section F: Insight-Action-Result Tracking

### F.1 — New Schema: `insight_outcomes` table

**Priority:** P1 | **Complexity:** M | **Dependencies:** B.11

```sql
CREATE TABLE insight_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid NOT NULL REFERENCES intelligence_insights(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- What was the metric at the time of action?
  metric_category text NOT NULL,      -- e.g., 'response_time', 'lead_conversion'
  metric_key text NOT NULL,           -- e.g., 'avg_monday_response_minutes'
  baseline_value float NOT NULL,      -- value when insight was acted on
  baseline_measured_at timestamptz NOT NULL,

  -- What is the metric now?
  current_value float,
  current_measured_at timestamptz,

  -- Calculated improvement
  change_absolute float,
  change_percent float,
  estimated_impact_dollars float,     -- rough revenue impact estimate

  -- Status
  status text DEFAULT 'tracking' CHECK (status IN ('tracking', 'improved', 'no_change', 'declined', 'insufficient_data')),
  measurement_window_days integer DEFAULT 30,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_insight_outcomes_insight ON insight_outcomes(insight_id);
CREATE INDEX idx_insight_outcomes_venue ON insight_outcomes(venue_id);
CREATE INDEX idx_insight_outcomes_status ON insight_outcomes(status);
```

- [ ] Create migration `045_insight_outcomes.sql` — **P1** / S
- [ ] Add RLS policies — **P1** / S

### F.2 — Baseline Capture on "Act on This"

**Priority:** P1 | **Complexity:** M | **Dependencies:** F.1, B.11

**When the coordinator clicks "Act on this":**
1. The system reads the current value of the metric referenced by the insight's `category` + `data_points`
2. Creates an `insight_outcomes` row with `baseline_value` and `baseline_measured_at`
3. Sets `measurement_window_days` based on insight type:
   - `response_time`: 14 days
   - `lead_conversion`: 30 days
   - `seasonal`: 30 days
   - `team_performance`: 14 days
   - `source_attribution`: 30 days

**Source tables for baseline measurement (varies by category):**
| Category | Metric Query |
|----------|-------------|
| `response_time` | AVG(first_response_at - inquiry_date) from `weddings` last 14 days |
| `lead_conversion` | COUNT(booked) / COUNT(*) from `weddings` last 30 days |
| `team_performance` | Latest `consultant_metrics` for referenced consultant |
| `source_attribution` | Latest `source_attribution` for referenced source |
| `seasonal` | Current month booking count from `booked_dates` |
| `couple_behavior` | AVG engagement score from `engagement_events` last 30 days |

- [ ] New service `src/lib/services/outcome-tracking.ts` — **P1** / M
  - `captureBaseline(insightId, venueId)` — queries the relevant metric and creates the outcome row
  - `measureOutcome(outcomeId)` — re-queries the metric and updates current_value + change fields
  - `evaluateAllOutcomes(venueId)` — batch check all tracking outcomes past their window

### F.3 — Outcome Measurement Cron

**Priority:** P1 | **Complexity:** M | **Dependencies:** F.2

- [ ] Add cron job `outcome_measurement` to `src/app/api/cron/route.ts` — **P1** / S
  - Runs daily
  - Queries `insight_outcomes WHERE status = 'tracking' AND current_measured_at IS NULL AND created_at + measurement_window_days < now()`
  - For each: calls `measureOutcome(outcomeId)` to re-measure the metric
  - Sets `status` based on result:
    - `improved`: change_percent > 10% in desired direction
    - `no_change`: |change_percent| <= 10%
    - `declined`: change_percent > 10% in wrong direction
    - `insufficient_data`: not enough data points to measure

### F.4 — Outcome Display: Insight Detail

**Priority:** P1 | **Complexity:** M | **Dependencies:** F.3

**Where this chain displays:**

1. **On the insight card itself** (everywhere insights appear):
   - After outcome is measured, show a small badge: "Improved 32%" (green) or "No change" (gray) or "Declined 15%" (red)

2. **On the dedicated insights page** (B.12):
   - Full outcome history in the insight detail view
   - Shows: baseline, current, change, estimated impact

3. **In the weekly digest** (E.1):
   - "Since you acted on 'Respond faster on Mondays' 3 weeks ago, your Monday response time improved from 58min to 32min. Estimated impact: 2 additional bookings."

4. **On a new ROI section** on `intel/roi/page.tsx`:
   - Aggregate view: total insights acted on, % that improved, estimated total revenue impact

- [ ] `InsightOutcomeBadge` component — shows improvement/decline/no-change on insight cards — **P1** / S
- [ ] Add outcomes section to insight detail on B.12 page — **P1** / M
- [ ] Include outcome summaries in weekly digest prompt (E.1) — **P1** / S
- [ ] Add "Intelligence ROI" section to `intel/roi/page.tsx` — **P1** / M
  - KPIs: Total insights generated, % acted on, % improved, estimated revenue impact
  - Timeline chart: insights over time, actions over time, improvements over time

### F.5 — AI-Generated Outcome Narrative

**Priority:** P2 | **Complexity:** M | **Dependencies:** F.3

- [ ] When an outcome is measured as `improved`, call AI to generate a narrative — **P2** / M
  - Input: insight title, action taken, baseline, current, change
  - Output: 1-2 sentence celebration/explanation
  - Example: "Your Monday response time improved from 58min to 32min since you acted on this insight 3 weeks ago. At your historical conversion rates, this faster response likely contributed to 2 additional bookings worth approximately $30,000."
  - Store in `insight_outcomes` as a new `narrative text` column

---

## Summary: Migration Sequence

All new schema changes required, in order:

| # | Migration | Tables/Columns | Section |
|---|-----------|---------------|---------|
| 043 | `event_feedback` | `event_feedback` table | A.1 |
| 044 | `event_feedback_vendors` | `event_feedback_vendors` table | A.2 |
| 045 | `insight_outcomes` | `insight_outcomes` table | F.1 |
| 046 | `intelligence_insights_extensions` | `wedding_id`, `acted_on_note`, `acted_on_by`, `dismissed_reason`, `dismissed_by` on `intelligence_insights` | B.10, B.11 |
| 047 | `intelligence_insights_categories` | Expand `category` CHECK constraint | C.7 |
| 048 | `calendar_events` | `calendar_events` table | D.5 |
| 049 | `notifications` | `notifications` table | E.3 |
| 050 | `competitive_landscape` | `competitive_landscape` table | D.9 |
| 051 | `market_intelligence_extensions` | `median_home_value` column | D.7 |
| 052 | `insight_outcomes_narrative` | `narrative text` column on `insight_outcomes` | F.5 |

---

## Summary: New Service Files

| Service | Section | Priority | Complexity |
|---------|---------|----------|------------|
| `src/lib/services/census.ts` | D.1 | P0 | M |
| `src/lib/services/marriage-stats.ts` | D.2 | P1 | M |
| `src/lib/services/nearby-hotels.ts` | D.10 | P2 | M |
| `src/lib/services/zillow.ts` | D.7 | P2 | M |
| `src/lib/services/outcome-tracking.ts` | F.2 | P1 | M |

---

## Summary: New UI Components

| Component | Location | Section | Priority | Complexity |
|-----------|----------|---------|----------|------------|
| `DashboardInsightsFeed` | `(platform)/page.tsx` | B.1 | P0 | M |
| `InsightActionBar` | `components/intel/` | B.11 | P0 | M |
| `PostEventFeedbackTab` | `portal/weddings/[id]` | A.4 | P0 | L |
| `VendorRatingCard` | `components/portal/` | A.4 | P0 | M |
| `InsightFeed` (combined) | `intel/dashboard` | B.5 | P0 | M |
| `InsightOutcomeBadge` | `components/intel/` | F.4 | P1 | S |
| `InboxInsightBanner` | `agent/inbox` | B.2 | P1 | M |
| `PipelineStallWarnings` | `agent/pipeline` | B.3 | P1 | M |
| `WeddingInsightsSidebar` | `portal/weddings/[id]` | B.10 | P1 | M |
| `NotificationBell` | `components/shell/` | E.3 | P1 | M |
| `BriefingSections` (redesign) | `intel/briefings` | E.2 | P1 | M |

---

## Summary: New API Routes

| Route | Method | Section | Priority |
|-------|--------|---------|----------|
| `GET /api/intel/insights` | GET | B.1 | P0 |
| `PATCH /api/intel/insights/[id]` | PATCH | B.11 | P0 |
| `POST /api/portal/event-feedback/draft-response` | POST | A.5 | P1 |
| `GET /api/notifications` | GET | E.3 | P1 |
| `PATCH /api/notifications/[id]` | PATCH | E.3 | P1 |

---

## Summary: Cron Job Additions

| Job Name | Frequency | Section | Priority |
|----------|-----------|---------|----------|
| `post_event_feedback_check` | Daily 9am | A.3 | P0 |
| `outcome_measurement` | Daily | F.3 | P1 |
| `census_refresh` | Monthly | D.1 | P0 |
| `marriage_stats_refresh` | Monthly | D.2 | P1 |

---

## Build Order Recommendation

### Sprint 1 (Week 1-2): Foundation
1. Migration 043-044 (event_feedback tables) — A.1, A.2
2. Migration 046 (intelligence_insights extensions) — B.10, B.11
3. `InsightActionBar` component — B.11
4. `GET/PATCH /api/intel/insights` routes — B.1
5. `DashboardInsightsFeed` on main dashboard — B.1
6. Post-event feedback form UI — A.4

### Sprint 2 (Week 3-4): Surfacing + External Data
7. Inline insight panels on intel pages (B.5-B.8)
8. FRED extended series + Census service (D.8, D.1)
9. NOAA climate normals extension (D.4)
10. Holiday calendar table + seed (D.5)
11. Event feedback trigger cron (A.3)
12. AI proactive response draft (A.5)

### Sprint 3 (Week 5-6): Operational Detectors
13. Couple readiness detector (C.5) — no event_feedback dependency
14. Portal engagement detector (C.1) — starts collecting data
15. Timeline adherence detector (C.2) — requires event_feedback data
16. Vendor performance detector (C.3)
17. Expand categories on intelligence_insights (C.7)
18. Wedding profile insight sidebar (B.10)

### Sprint 4 (Week 7-8): Feedback Loop + Digest
19. Migration 045 (insight_outcomes) — F.1
20. Outcome tracking service — F.2
21. Outcome measurement cron — F.3
22. Refactored weekly digest with insights — E.1
23. Briefings page redesign — E.2
24. Notifications table + bell — E.3
25. Outcome badges on insight cards — F.4

### Sprint 5 (Week 9-10): Tier 2 + Polish
26. BLS CPI integration (D.6)
27. CDC marriage stats (D.2)
28. Google Trends extended terms (D.11)
29. Guest experience predictor (C.4)
30. Review prediction detector (C.6)
31. Dedicated insights page with filtering (B.12)
32. Intelligence ROI section on roi page (F.4)
33. AI outcome narratives (F.5)

---

## Metrics for Success

By Phase 2 completion, measure:
- **Insight generation rate:** X new insights per venue per week
- **Act-on rate:** % of insights marked as "acted on" (target: >30%)
- **Improvement rate:** % of acted-on insights that measurably improved (target: >50%)
- **Feedback completion rate:** % of past weddings with event_feedback (target: >80%)
- **Digest engagement:** % of weekly digests opened/read (target: >70%)
- **External data freshness:** all Tier 1 sources updated within the last 30 days
