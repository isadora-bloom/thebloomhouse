# Supabase Schema Audit Report
**Project:** The Bloom House
**Stack:** Next.js (App Router) + TypeScript + Supabase
**Date:** 2026-04-11
**Tables in schema:** 120
**Tables with code references (this repo):** 107
**Tables used by sibling repo (`thebloomhouse-website`):** 7 (`website_*`)
**Orphaned tables:** 6
**Ghost references:** 0

> **Note:** This audit is scoped to the `bloom-house` platform codebase. The Supabase project is shared with a sibling repo `thebloomhouse-website` (the live marketing site at thebloomhouse.ai), which consumes the `website_*` tables. Those are active cross-repo dependencies and are NOT orphans.

---

## Active Tables

Sorted by reference count descending. Reference count = number of `.from('table')` call sites in `src/` (including duplicates across files).

| # | Table | Refs | Key Files |
|---|-------|------|-----------|
| 1 | `weddings` | 76 | src/lib/services/heat-mapping.ts; src/lib/services/anomaly-detection.ts; src/lib/services/daily-digest.ts |
| 2 | `venue_config` | 64 | src/app/(platform)/settings/page.tsx; src/app/(platform)/agent/notifications/page.tsx; src/app/(platform)/portal/shuttle-config/page.tsx |
| 3 | `venues` | 48 | src/app/api/cron/route.ts; src/lib/services/trends.ts; src/lib/services/daily-digest.ts |
| 4 | `drafts` | 35 | src/lib/services/email-pipeline.ts; src/app/(platform)/agent/drafts/page.tsx; src/lib/services/daily-digest.ts |
| 5 | `guest_list` | 26 | src/app/_couple-pages/guests/page.tsx; src/app/_couple-pages/seating/page.tsx; src/app/api/public/wedding-website/route.ts |
| 6 | `voice_preferences` | 22 | src/app/(platform)/agent/rules/page.tsx; src/app/(platform)/settings/voice/page.tsx; src/app/(platform)/agent/learning/page.tsx |
| 7 | `interactions` | 20 | src/lib/services/email-pipeline.ts; src/lib/services/follow-up-sequences.ts; src/app/api/agent/sync/route.ts |
| 8 | `venue_group_members` | 18 | src/app/(platform)/agent/codes/page.tsx; src/app/(platform)/agent/drafts/page.tsx; src/app/(platform)/page.tsx |
| 9 | `draft_feedback` | 17 | src/lib/services/learning.ts; src/lib/services/email-pipeline.ts; src/app/(platform)/agent/drafts/page.tsx |
| 10 | `knowledge_base` | 17 | src/lib/services/knowledge-base.ts; src/app/(platform)/portal/kb/page.tsx; src/app/(platform)/onboarding/page.tsx |
| 11 | `people` | 16 | src/lib/services/email-pipeline.ts; src/lib/services/heat-mapping.ts; src/lib/services/router-brain.ts |
| 12 | `checklist_items` | 15 | src/app/_couple-pages/checklist/page.tsx; src/lib/services/sage-brain.ts; src/app/_couple-pages/page.tsx |
| 13 | `contracts` | 15 | src/app/api/couple/contracts/route.ts; src/app/_couple-pages/contracts/page.tsx; src/app/_couple-pages/page.tsx |
| 14 | `venue_ai_config` | 13 | src/lib/services/follow-up-sequences.ts; src/app/(platform)/agent/settings/page.tsx; src/app/(platform)/settings/personality/page.tsx |
| 15 | `user_profiles` | 12 | src/middleware.ts; src/lib/api/auth-helpers.ts; src/components/shell/user-menu.tsx |
| 16 | `engagement_events` | 11 | src/lib/services/heat-mapping.ts; src/lib/services/email-pipeline.ts; src/lib/services/anomaly-detection.ts |
| 17 | `review_language` | 11 | src/lib/services/review-language.ts; src/lib/services/intel-brain.ts; src/lib/services/sage-intelligence.ts |
| 18 | `guest_tag_assignments` | 11 | src/app/_couple-pages/guests/page.tsx; src/app/_couple-pages/ceremony/page.tsx; src/app/_couple-pages/seating/page.tsx |
| 19 | `ceremony_order` | 11 | src/app/_couple-pages/party/page.tsx; src/app/_couple-pages/ceremony/page.tsx |
| 20 | `admin_notifications` | 10 | src/lib/services/admin-notifications.ts; src/app/(platform)/agent/inbox/page.tsx; src/app/_couple-pages/worksheets/page.tsx |
| 21 | `contacts` | 9 | src/lib/services/router-brain.ts; src/lib/services/email-pipeline.ts; src/lib/services/follow-up-sequences.ts |
| 22 | `messages` | 9 | src/app/api/couple/messages/route.ts; src/app/(platform)/portal/messages/page.tsx; src/lib/services/follow-up-sequences.ts |
| 23 | `bar_shopping_list` | 9 | src/app/_couple-pages/bar/page.tsx |
| 24 | `booked_vendors` | 9 | src/app/_couple-pages/vendors/page.tsx; src/app/_couple-pages/chat/page.tsx; src/app/_couple-pages/page.tsx |
| 25 | `vendor_recommendations` | 9 | src/app/api/public/vendor-portal/route.ts; src/app/(platform)/portal/vendors/page.tsx; src/app/_couple-pages/preferred-vendors/page.tsx |
| 26 | `api_costs` | 8 | src/lib/ai/cost-tracker.ts; src/lib/ai/client.ts; src/lib/services/daily-digest.ts |
| 27 | `photo_library` | 8 | src/app/_couple-pages/photos/page.tsx |
| 28 | `lead_score_history` | 7 | src/lib/services/heat-mapping.ts; src/app/(platform)/intel/clients/[id]/page.tsx |
| 29 | `budget_items` | 7 | src/app/_couple-pages/budget/page.tsx; src/lib/services/sage-brain.ts; src/app/_couple-pages/chat/page.tsx |
| 30 | `wedding_config` | 7 | src/app/_couple-pages/budget/page.tsx; src/app/_couple-pages/guests/page.tsx; src/lib/services/sage-brain.ts |
| 31 | `guest_tags` | 7 | src/app/_couple-pages/guests/page.tsx; src/app/_couple-pages/ceremony/page.tsx; src/app/_couple-pages/seating/page.tsx |
| 32 | `allergy_registry` | 7 | src/app/_couple-pages/allergies/page.tsx; src/app/api/public/wedding-website/route.ts |
| 33 | `weather_data` | 6 | src/lib/services/weather.ts; src/lib/services/sage-intelligence.ts; src/lib/services/intel-brain.ts |
| 34 | `search_trends` | 6 | src/lib/services/trends.ts; src/lib/services/intel-brain.ts; src/app/api/intel/trends/route.ts |
| 35 | `trend_recommendations` | 6 | src/app/api/intel/recommendations/route.ts; src/lib/services/trends.ts; src/lib/services/intel-brain.ts |
| 36 | `economic_indicators` | 6 | src/lib/services/economics.ts; src/app/(platform)/intel/market-pulse/page.tsx; src/lib/services/intel-brain.ts |
| 37 | `timeline` | 6 | src/app/_couple-pages/timeline/page.tsx; src/lib/services/sage-brain.ts; src/app/_couple-pages/page.tsx |
| 38 | `wedding_party` | 6 | src/app/_couple-pages/party/page.tsx |
| 39 | `sage_conversations` | 6 | src/app/_couple-pages/chat/page.tsx; src/app/api/portal/sage/route.ts |
| 40 | `borrow_selections` | 6 | src/app/_couple-pages/venue-inventory/page.tsx |
| 41 | `portal_section_config` | 6 | src/app/api/portal/section-config/route.ts; src/app/(platform)/portal/section-settings/page.tsx; src/app/(platform)/portal/weddings/[id]/portal/page.tsx |
| 42 | `venue_seasonal_content` | 5 | src/lib/services/client-brain.ts; src/lib/services/inquiry-brain.ts; src/lib/services/sage-brain.ts |
| 43 | `anomaly_alerts` | 5 | src/lib/services/anomaly-detection.ts; src/lib/services/daily-digest.ts; src/lib/services/sage-intelligence.ts |
| 44 | `ai_briefings` | 5 | src/lib/services/briefings.ts; src/lib/services/daily-digest.ts |
| 45 | `email_sync_state` | 5 | src/lib/services/gmail.ts; src/app/(platform)/agent/settings/page.tsx; src/app/api/agent/gmail/route.ts |
| 46 | `wedding_details` | 5 | src/app/api/couple/wedding-details/route.ts; src/app/_couple-pages/wedding-details/page.tsx |
| 47 | `wedding_detail_config` | 5 | src/app/api/portal/wedding-detail-config/route.ts; src/app/_couple-pages/wedding-details/page.tsx |
| 48 | `decor_inventory` | 5 | src/app/_couple-pages/decor/page.tsx |
| 49 | `bedroom_assignments` | 5 | src/app/_couple-pages/rooms/page.tsx |
| 50 | `wedding_tables` | 5 | src/app/api/couple/tables/route.ts; src/app/_couple-pages/tables/page.tsx |
| 51 | `follow_up_sequences` | 5 | src/app/(platform)/agent/sequences/page.tsx |
| 52 | `learned_preferences` | 5 | src/app/(platform)/agent/learning/page.tsx |
| 53 | `client_match_queue` | 5 | src/app/(platform)/intel/matching/page.tsx |
| 54 | `organisations` | 4 | src/app/(platform)/settings/page.tsx; src/components/shell/scope-selector.tsx; src/app/(platform)/super-admin/page.tsx |
| 55 | `auto_send_rules` | 4 | src/lib/services/autonomous-sender.ts; src/app/(platform)/agent/settings/page.tsx |
| 56 | `venue_usps` | 4 | src/lib/services/client-brain.ts; src/lib/services/inquiry-brain.ts; src/lib/services/sage-brain.ts |
| 57 | `lost_deals` | 4 | src/app/(platform)/intel/lost-deals/page.tsx; src/lib/services/heat-mapping.ts |
| 58 | `planning_notes` | 4 | src/lib/services/planning-extraction.ts; src/app/api/couple/contracts/route.ts |
| 59 | `makeup_schedule` | 4 | src/app/_couple-pages/beauty/page.tsx |
| 60 | `source_attribution` | 4 | src/lib/services/intel-brain.ts; src/app/api/cron/route.ts; src/app/(platform)/intel/sources/page.tsx |
| 61 | `consultant_metrics` | 4 | src/lib/services/intel-brain.ts; src/app/(platform)/intel/team-compare/page.tsx; src/app/(platform)/intel/team/page.tsx |
| 62 | `staffing_assignments` | 4 | src/app/_couple-pages/staffing/page.tsx |
| 63 | `seating_tables` | 4 | src/app/_couple-pages/seating/page.tsx |
| 64 | `guest_meal_options` | 4 | src/app/_couple-pages/guests/page.tsx; src/app/api/public/wedding-website/route.ts |
| 65 | `shuttle_schedule` | 4 | src/app/_couple-pages/transportation/page.tsx |
| 66 | `client_codes` | 4 | src/app/(platform)/agent/codes/page.tsx; src/app/couple/[slug]/layout.tsx; src/app/(platform)/intel/clients/[id]/page.tsx |
| 67 | `sage_uncertain_queue` | 4 | src/app/(platform)/portal/sage-queue/page.tsx; src/app/api/portal/sage/route.ts |
| 68 | `phrase_usage` | 3 | src/lib/ai/phrase-selector.ts |
| 69 | `budget_payments` | 3 | src/app/_couple-pages/budget/page.tsx |
| 70 | `wedding_worksheets` | 3 | src/app/_couple-pages/worksheets/page.tsx |
| 71 | `bar_recipes` | 3 | src/app/_couple-pages/bar/page.tsx |
| 72 | `natural_language_queries` | 3 | src/lib/services/intel-brain.ts; src/app/(platform)/intel/nlq/page.tsx |
| 73 | `guest_care_notes` | 3 | src/app/_couple-pages/guest-care/page.tsx |
| 74 | `wedding_website_settings` | 3 | src/app/_couple-pages/website/page.tsx; src/app/api/public/wedding-website/route.ts |
| 75 | `inspo_gallery` | 3 | src/app/_couple-pages/inspo/page.tsx |
| 76 | `rehearsal_dinner` | 3 | src/app/_couple-pages/rehearsal/page.tsx |
| 77 | `rsvp_config` | 3 | src/app/_couple-pages/rsvp-settings/page.tsx; src/app/api/public/wedding-website/route.ts |
| 78 | `section_finalisations` | 3 | src/app/_couple-pages/final-review/page.tsx |
| 79 | `voice_training_sessions` | 3 | src/app/(platform)/settings/voice/page.tsx |
| 80 | `campaigns` | 3 | src/app/(platform)/intel/campaigns/page.tsx |
| 81 | `intelligence_extractions` | 2 | src/lib/services/email-pipeline.ts; src/app/(platform)/agent/inbox/page.tsx |
| 82 | `activity_log` | 2 | src/lib/services/activity-logger.ts |
| 83 | `booked_dates` | 2 | src/lib/services/inquiry-brain.ts |
| 84 | `bar_planning` | 2 | src/app/_couple-pages/bar/page.tsx |
| 85 | `wedding_timeline` | 2 | src/app/_couple-pages/chat/page.tsx; src/app/_couple-pages/transportation/page.tsx |
| 86 | `accommodations` | 2 | src/app/_couple-pages/stays/page.tsx; src/app/api/public/wedding-website/route.ts |
| 87 | `marketing_spend` | 2 | src/app/api/cron/route.ts; src/app/(platform)/intel/sources/page.tsx |
| 88 | `rsvp_responses` | 2 | src/app/api/public/wedding-website/route.ts |
| 89 | `error_logs` | 2 | src/app/(platform)/agent/errors/page.tsx |
| 90 | `sequence_steps` | 2 | src/app/(platform)/agent/sequences/page.tsx |
| 91 | `knowledge_gaps` | 2 | src/app/(platform)/agent/knowledge-gaps/page.tsx |
| 92 | `tours` | 2 | src/app/(platform)/intel/tours/page.tsx |
| 93 | `venue_health` | 2 | src/app/(platform)/intel/portfolio/page.tsx; src/app/(platform)/intel/health/page.tsx |
| 94 | `social_posts` | 2 | src/app/(platform)/intel/social/page.tsx |
| 95 | `relationships` | 2 | src/app/(platform)/agent/relationships/page.tsx |
| 96 | `annotations` | 2 | src/app/(platform)/intel/annotations/page.tsx |
| 97 | `venue_groups` | 1 | src/components/shell/scope-selector.tsx |
| 98 | `heat_score_config` | 1 | src/lib/services/heat-mapping.ts |
| 99 | `onboarding_progress` | 1 | src/app/_couple-pages/getting-started/page.tsx |
| 100 | `borrow_catalog` | 1 | src/app/_couple-pages/venue-inventory/page.tsx |
| 101 | `venue_resources` | 1 | src/app/_couple-pages/resources/page.tsx |
| 102 | `storefront` | 1 | src/app/_couple-pages/picks/page.tsx |
| 103 | `venue_assets` | 1 | src/app/_couple-pages/downloads/page.tsx |
| 104 | `voice_training_responses` | 1 | src/app/(platform)/settings/voice/page.tsx |
| 105 | `notifications` | 1 | src/app/(platform)/agent/notifications/page.tsx |
| 106 | `notification_tokens` | 1 | src/app/(platform)/agent/notifications/page.tsx |
| 107 | `budget` | 1 | src/app/(platform)/portal/weddings/[id]/portal/page.tsx |

Note: `weddings` is also referenced from `supabase/functions/heat-decay/index.ts` and `venues` from `supabase/functions/email-poll/index.ts` (Edge Functions). These are counted in the schema but not in the `src/` reference totals above.

---

## Orphaned Tables (in DB, not used in code)

### `brand_assets`
- **Last migration:** `supabase/migrations/024_brand_assets.sql`
- **Has data risk:** No — 0 rows
- **Has RLS policies:** Yes — 2 policies
- **Row count:** 0
- **FK in:** none (no tables depend on it)
- **FK out:** `venue_id` -> `venues`
- **Recommendation:** KEEP (short-term) / ARCHIVE (if unused at launch)
- **Reasoning:** The Settings UI (`src/app/(platform)/settings/page.tsx` lines 530/536) explicitly instructs admins to "add image URLs directly to the brand_assets table" — it's intended to be a manually-populated config table for brand assets the Agent/Portal will consume later. No code path queries it yet. Safe to keep while the brand voice work is in flight; revisit if not wired up by launch.

### `couple_budget`
- **Last migration:** `supabase/migrations/017_missing_tables.sql`
- **Has data risk:** Minor — 1 row (appears to be leftover seed)
- **Has RLS policies:** Yes — 7 policies
- **Row count:** 1
- **FK in:** none
- **FK out:** `venue_id` -> `venues`, `wedding_id` -> `weddings`
- **Recommendation:** ARCHIVE (then DELETE)
- **Reasoning:** `AUDIT-FIX-REPORT.md` line 76 explicitly notes the app switched from `couple_budget` to `budget_items`. Current code (budget page, sage-brain, chat) reads `budget_items` / `budget_payments` / `wedding_config` exclusively. The single row is stale seed data. Migrate any needed row to `budget_items` if real, then drop.

### `follow_up_sequence_templates`
- **Last migration:** `supabase/migrations/009_full_feature_parity.sql` (also redefined in 025)
- **Has data risk:** Yes — 6 rows (system templates)
- **Has RLS policies:** No — 0 policies
- **Row count:** 6
- **FK in:** `wedding_sequences.template_id` -> this table
- **FK out:** `venue_id` -> `venues`
- **Recommendation:** KEEP (needs human review — see below)
- **Reasoning:** Code queries `follow_up_sequences` (the per-wedding instance table), not `follow_up_sequence_templates` (the template catalogue). The template table is referenced only by SQL migrations (025) and seed files. It may be intentionally dormant (system-level template library) or may have been replaced entirely by `follow_up_sequences`. Either the agent/sequences page needs a "Browse templates" UI wired up, or both `follow_up_sequence_templates` and `wedding_sequences` should be dropped together.

### `reviews`
- **Last migration:** `supabase/migrations/031_reviews_table.sql`
- **Has data risk:** Yes — 12 rows (seeded reviews)
- **Has RLS policies:** Yes — 8 policies
- **Row count:** 12
- **FK in:** none
- **FK out:** `venue_id` -> `venues`
- **Recommendation:** KEEP
- **Reasoning:** Explicitly added in migration 031 with seed data (`supabase/seed-reviews.sql`). The `review-language` service extracts phrases from arbitrary text passed in, but the `reviews` table is the logical raw-review store it will eventually iterate over for bulk ingestion (the service exports a `reviews: Array<...>` loop API). Keep as source data; wire it up in the intel/reviews page.

### `seating_assignments`
- **Last migration:** `supabase/migrations/004_portal_tables.sql` (also amended in 021)
- **Has data risk:** Minor — 4 rows
- **Has RLS policies:** Yes — 5 policies
- **Row count:** 4
- **FK in:** none
- **FK out:** `guest_id` -> `guest_list`, `table_id` -> `seating_tables`, `venue_id` -> `venues`, `wedding_id` -> `weddings`
- **Recommendation:** ARCHIVE (needs human review)
- **Reasoning:** The `_couple-pages/seating/page.tsx` uses `seating_tables` + `guest_tag_assignments` but does NOT query `seating_assignments` at all. It's mentioned in `BLUEPRINT.md` §951 as part of the design, so it may have been superseded by a simpler denormalized model (assignments tracked via `guest_list.table_id` or similar). Confirm the seating UX doesn't need it before dropping.

### 🟢 `website_*` family — EXCLUDE from orphan list
The 7 `website_*` tables (`website_contacts`, `website_content`, `website_faqs`, `website_images`, `website_pricing`, `website_team`, `website_testimonials`) appear orphaned from the `bloom-house` platform codebase's perspective, but they are **actively used by the separate `thebloomhouse-website` repo** — which is the live marketing site at thebloomhouse.ai. Both codebases share the same Supabase project.

**Status:** KEEP (cross-repo dependency)
**Action:** None. These are NOT orphans. Do NOT drop.
**Note for future audits:** When auditing by code reference, cross-reference both `bloom-house` and `thebloomhouse-website` repos before flagging `website_*` tables as orphans.

### `wedding_sequences`
- **Last migration:** `supabase/migrations/009_full_feature_parity.sql`
- **Has data risk:** Yes — 13 rows
- **Has RLS policies:** No — 0 policies
- **Row count:** 13
- **FK in:** none
- **FK out:** `template_id` -> `follow_up_sequence_templates`, `venue_id` -> `venues`, `wedding_id` -> `weddings`
- **Recommendation:** ARCHIVE (needs human review — see `follow_up_sequence_templates`)
- **Reasoning:** Paired with `follow_up_sequence_templates` as a replaced/dormant subsystem. Current code only uses `follow_up_sequences` + `sequence_steps`. Either finish wiring the template->instance flow or drop both tables together. Having 13 rows suggests seed data was loaded at some point but never surfaced.

---

## Ghost References (in code, not in schema)

**None.** Every `.from('tablename')` call in `src/` and `supabase/functions/` resolves to an existing public table. No typos, no stale references, no broken queries.

---

## Needs Human Review

Three ambiguous cases where the schema may be intentionally ahead of the code, or intentionally behind, and the team should decide:

1. **`brand_assets` (0 rows, 2 policies)** — Settings UI tells users to populate it manually, but no page reads it. Either wire a brand-assets reader into the Agent/Portal AI prompt layer, or drop it and use `venue_assets` (which is already in use).

2. **`follow_up_sequence_templates` + `wedding_sequences`** — a complete template->instance subsystem sits beside the active `follow_up_sequences` + `sequence_steps` subsystem. Only one model should survive. Recommend: compare 025 (`follow_up_sequences`) vs 009 (`wedding_sequences`) and pick one.

3. **`seating_assignments` (4 rows)** — design doc in `BLUEPRINT.md` still lists it, but the seating page uses a different model (`seating_tables` + `guest_tag_assignments`). Either restore it as the canonical join table or remove it from the blueprint.

4. **`reviews` (12 rows, seeded)** — raw reviews table exists with data but nothing reads it. The `intel/reviews` page reads the derived `review_language` phrases. Wire up a "source reviews" view on the reviews page, or decide that phrases-only is the contract and drop the raw table.

---

## System Tables (excluded from audit)

The audit covers only the `public` schema. The following Supabase-managed schemas/tables were excluded:

- `auth.*` — Supabase Auth (users, sessions, identities, mfa_*, etc.)
- `storage.*` — Supabase Storage (buckets, objects, migrations)
- `realtime.*` and `_realtime.*` — Realtime subscriptions infrastructure
- `supabase_migrations.schema_migrations` — migration ledger
- `extensions.*`, `graphql.*`, `pgsodium.*`, `vault.*`, `net.*` — extension schemas

Additionally, these are **Storage buckets, not tables** (referenced via `supabase.storage.from(...)` in code) and were correctly excluded from the table audit:

- `venue-assets` — referenced in `src/app/(platform)/portal/seating-config/page.tsx`
- (Other buckets — `couple-photos`, `inspo-gallery`, etc. — are configured in the Supabase dashboard and managed separately from SQL migrations.)
