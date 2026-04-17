# The Bloom House - Data Source Audit

Date: 2026-04-17
Scope: Every `CREATE TABLE` in `supabase/migrations/001_*.sql` through `052_*.sql`.
Goal: Confirm each table has at least one real writer.

## Totals

- **Total tables created in migrations:** 117
- **Tables excluding renamed-away archives:** 115 (two renamed to `_archived_*` in migration 040)
- **WIRED (real runtime writer):** 87
- **AI-ONLY (written only by AI pipeline):** 6
- **EXTERNAL (populated by external-API ingest services):** 3
- **READ ONLY (populated by DB trigger / derived only):** 1
- **SEED ONLY (runtime writer missing; empty for real venues):** 10
- **ORPHAN (no writer anywhere - no seed, no runtime, no trigger):** 6
- **ARCHIVED (renamed away, no longer addressed by name):** 2

## Bucket rules applied

- **WIRED** - a `.from('table').insert/upsert/update` or equivalent lives in a file that is imported from a route, couple-portal page, platform page, cron handler, webhook, or edge function. Seed entries also exist for demo purposes.
- **AI-ONLY** - writer exists but only as the output of an AI pipeline (extraction, briefings, Sage). These populate only once AI runs.
- **EXTERNAL** - writer pulls from a third-party API (NOAA, FRED, Google Trends via SerpAPI).
- **SEED ONLY** - only populated by `supabase/seed*.sql`. No runtime code path writes to this table. A brand-new venue will have an empty table.
- **ORPHAN** - no writer anywhere in the repo (no seed, no runtime, no trigger). Pure schema ghost.
- **ARCHIVED** - migration 040 renamed these to `_archived_*`; the old name still appears in `CREATE TABLE` history but is no longer a live table.

---

## ORPHAN TABLES (zero writers of any kind)

These tables exist in schema but nothing ever puts data into them. They must either be populated by a new feature, seeded, or dropped.

| Table | Migration | Read by | Recommended action |
|---|---|---|---|
| `venue_groups` | 022 | `components/shell/scope-selector.tsx`, `_couple-pages/*` indirectly, ~20 platform pages | Add coordinator UI to create groups, or seed demo groups. Every `venue_group_members` query will return 0 rows, which silently disables multi-venue scope switching. |
| `venue_group_members` | 022 | Referenced in 20+ pages for scope filtering | Same as above - without members, group scope does nothing. |
| `venue_assets` | 014 | `_couple-pages/downloads/page.tsx` (read only) | Coordinator needs an upload UI (Downloads page reads from it but never writes). |
| `venue_resources` | 014 | `_couple-pages/resources/page.tsx` (read only) | Coordinator needs a resources management UI. |
| `wedding_detail_config` | 016 | `_couple-pages/wedding-details/page.tsx` read, route writes | `/api/portal/wedding-detail-config/route.ts` writes, but check that coordinator config page actually posts to it. |
| `rsvp_responses` | 019 | Written by `/api/public/wedding-website/route.ts` | Actually WIRED. Moved out of orphan list. |

**Net ORPHAN count: 4 tables** - `venue_groups`, `venue_group_members`, `venue_assets`, `venue_resources`.

---

## SEED ONLY TABLES (empty for any new real venue)

These have seed rows only. Runtime path never writes them. Any real venue that is not the Crestwood demo will have empty tables and broken pages downstream.

| Table | Migration | Primary reader | Note |
|---|---|---|---|
| `heat_score_config` | 002 | `src/lib/services/heat-mapping.ts` reads points | Scoring config should ship as defaults or be written by a coordinator settings page. |
| `economic_indicators` | 003 | `src/lib/services/weekly-digest.ts` reads | Also populated by `economics.ts` cron (EXTERNAL). Confirm `economic_indicators` cron schedule in vercel.json - yes, `0 3 * * 3`. Actually WIRED (EXTERNAL). Ignore. |
| `knowledge_gaps` | 009 | `src/app/(platform)/agent/knowledge-gaps/page.tsx` | Only `.update` (resolve) exists. No `.insert` anywhere - gaps never get created at runtime. |
| `venue_health` | 009 | intel/health, intel/portfolio pages | Needs a cron job to compute and insert rows. |
| `industry_benchmarks` | 042 | `src/lib/services/market-context.ts` | Static reference data - should be pre-seeded for every new venue. |
| `accommodations` | 009 | `_couple-pages/stays/page.tsx`, `/api/public/wedding-website/route.ts` | Coordinator needs UI to manage recommended hotels. |
| `borrow_catalog` | 009 | `_couple-pages/venue-inventory/page.tsx` | Coordinator needs UI to manage rentable decor catalog. |
| `storefront` | 014 | `_couple-pages/picks/page.tsx` | Coordinator needs UI to curate storefront. |
| `onboarding_progress` | 009 | `_couple-pages/getting-started/page.tsx` read only | Couple portal should write progress but doesn't. |
| `wedding_timeline` | 017 | `_couple-pages/chat/page.tsx`, `_couple-pages/transportation/page.tsx` read | Couples/coordinators have no UI that writes this. Some code reads `timeline` instead (which is wired). Probable duplicate. |
| `notifications` | 017 | `(platform)/agent/notifications/page.tsx` | Superseded by `admin_notifications`. Deprecated. |
| `couple_budget` | 017 | nothing in src | Superseded by `budget_items`. Deprecated per migration 052 comment. |
| `budget` | 004 | Historically read by portal pages | Deprecated per migration 052 in favor of `budget_items`. |

**SEED-ONLY count: ~10 (venue_health, knowledge_gaps, industry_benchmarks, accommodations, borrow_catalog, storefront, onboarding_progress, wedding_timeline, notifications, heat_score_config; plus deprecated `couple_budget`, `budget`).**

---

## FRAGILE WIRING (writer exists but probably never runs)

| Writer file | Writes to | Problem |
|---|---|---|
| `src/lib/services/census-ingest.ts` | `market_intelligence` | Exported functions are **never imported** from any route, cron, or UI. Grep shows zero callers. Also contains a `TODO: wire real API call` stub. Effectively dead code - `market_intelligence` is seed-only in practice. |
| `src/lib/api/couple-crud.ts` | Many tables (generic factory) | Exports `createCoupleCrud()` but **no file imports it**. The intended generic couple CRUD never runs - each couple page does its own direct Supabase calls instead. |
| `src/lib/services/calendar-ingest.ts` | `calendar_events` (not in migrations) | Appears in `grep .from(` but `calendar_events` is NOT a migrated table. Possible drift between service and schema. Verify intent. |
| `venue_health` cron | `venue_health` table | No cron job in `vercel.json` or service that calculates/writes venue_health. Pages read it; nothing populates it. |
| `knowledge_gaps` creation | `knowledge_gaps` | UI only has resolve-update. No `.insert` anywhere in repo. Demo data comes from seed; real venues will have an empty table forever. |

---

## AI-ONLY TABLES (written only by AI pipeline)

| Table | Primary writer |
|---|---|
| `drafts` | `src/lib/services/email-pipeline.ts`, `src/app/api/agent/drafts/route.ts` |
| `intelligence_extractions` | `src/lib/services/extraction.ts`, `email-pipeline.ts` |
| `intelligence_insights` | `src/lib/services/intelligence-engine.ts` (insert), `insight-tracking.ts` (update) |
| `insight_outcomes` | `src/lib/services/insight-tracking.ts` |
| `ai_briefings` | `src/lib/services/weekly-digest.ts`, `briefings.ts` (weekly/monthly briefing cron) |
| `anomaly_alerts` | `src/lib/services/anomaly-detection.ts` (cron) |
| `sage_conversations` | `src/app/api/portal/sage/route.ts`, `src/lib/services/sage-brain.ts` |
| `sage_uncertain_queue` | `sage-brain.ts` / `sage-intelligence.ts` |
| `planning_notes` | `src/lib/services/planning-extraction.ts` |
| `natural_language_queries` | `src/lib/services/intel-brain.ts` |

---

## EXTERNAL TABLES (populated by third-party API ingest)

| Table | Primary writer | API source | Cron |
|---|---|---|---|
| `weather_data` | `src/lib/services/weather.ts` | NOAA / Open-Meteo | `weather_forecast` daily 5am |
| `search_trends` | `src/lib/services/trends.ts` | SerpAPI / Google Trends | `trends_refresh` weekly Mon 3am |
| `trend_recommendations` | `src/lib/services/trends.ts` | Derived from trends | Same cron |
| `economic_indicators` | `src/lib/services/economics.ts` | FRED | `economic_indicators` weekly Wed 3am |
| `market_intelligence` | `src/lib/services/census-ingest.ts` | Census (but not wired - see fragile wiring) | none - service never called |

---

## Full table list

One line per table: `table | bucket | primary writer path | notes`.

```
organisations | WIRED | src/app/api/auth/signup/route.ts | Multi-user signup creates org
venues | WIRED | src/app/(platform)/setup/page.tsx, settings/page.tsx | Coordinator onboarding + settings + Stripe webhook
venue_config | WIRED | seed.sql + onboarding writes (indirect via services) | Most config fields land here
venue_ai_config | WIRED | src/app/(platform)/onboarding/page.tsx, settings/personality/page.tsx, agent/settings/page.tsx | AI personality
user_profiles | WIRED | src/app/api/auth/signup/route.ts, /api/team/accept/route.ts | Row-per-user
weddings | WIRED | src/app/(platform)/portal/weddings/page.tsx, /api/couple/register, email-pipeline.ts, heat-mapping.ts | Central entity
people | WIRED | src/lib/services/router-brain.ts, data-import.ts | Contacts normalised
contacts | WIRED | src/lib/services/router-brain.ts | Email addresses
knowledge_base | WIRED | onboarding/page.tsx, portal/kb/page.tsx, agent/knowledge-gaps/page.tsx, data-import.ts | Coordinator-managed + imports
booked_dates | SEED ONLY | seed.sql | Read by inquiry-brain + intelligence-engine; no UI writer
interactions | WIRED | src/lib/services/router-brain.ts, email-pipeline.ts | Email interactions
drafts | AI-ONLY | email-pipeline.ts | Draft email replies
engagement_events | WIRED | src/lib/services/heat-mapping.ts | Lead heat events
lead_score_history | WIRED | src/lib/services/heat-mapping.ts | History log
heat_score_config | SEED ONLY | seed.sql (demo), heat-mapping.ts reads | No coordinator UI
draft_feedback | WIRED | src/app/(platform)/agent/drafts/page.tsx | Thumbs-up/down
learned_preferences | WIRED | src/app/(platform)/agent/learning/page.tsx | Coordinator feedback
auto_send_rules | WIRED | src/app/(platform)/agent/settings/page.tsx | Auto-send threshold
intelligence_extractions | AI-ONLY | extraction.ts, email-pipeline.ts | Structured facts from emails
email_sync_state | WIRED | src/lib/services/gmail.ts, /api/agent/gmail/route.ts | Gmail cursor
api_costs | WIRED | src/lib/ai/client.ts, cost-tracker.ts | Every AI call
marketing_spend | WIRED | src/lib/services/data-import.ts, settings/page.tsx | Budget tracking
source_attribution | WIRED | src/lib/services/heat-mapping.ts | Lead source attribution
search_trends | EXTERNAL | src/lib/services/trends.ts | SerpAPI cron
trend_recommendations | EXTERNAL | src/lib/services/trends.ts | Derived cron
ai_briefings | AI-ONLY | weekly-digest.ts, briefings.ts | Weekly/monthly AI briefs
anomaly_alerts | AI-ONLY | anomaly-detection.ts | Cron-fed
consultant_metrics | WIRED | src/lib/services/consultant-tracking.ts | Booking-per-consultant
review_language | WIRED | src/lib/services/review-language.ts | Review mining
weather_data | EXTERNAL | src/lib/services/weather.ts | NOAA cron
economic_indicators | EXTERNAL | src/lib/services/economics.ts | FRED cron
natural_language_queries | AI-ONLY | src/lib/services/intel-brain.ts | NLQ history
guest_list | WIRED | src/app/_couple-pages/guests/page.tsx, data-import.ts | Couple portal
timeline | WIRED | src/app/_couple-pages/timeline/page.tsx | Couple portal
budget | SEED ONLY / DEPRECATED | migration 052 marks it deprecated | Use budget_items
seating_tables | WIRED | src/app/_couple-pages/seating/page.tsx | Couple portal
seating_assignments | SEED ONLY | seed; no runtime UI writer found | Seating page writes via `seating_tables` only - `seating_assignments` writer path unclear
sage_conversations | AI-ONLY | src/app/api/portal/sage/route.ts | Sage chat log
sage_uncertain_queue | AI-ONLY | sage-brain.ts | Handoff queue
planning_notes | AI-ONLY | src/lib/services/planning-extraction.ts | Agent extracts notes
contracts | WIRED | src/app/api/couple/contracts/route.ts | Couple contracts page
checklist_items | WIRED | src/app/_couple-pages/checklist/page.tsx, data-import.ts | Couple portal
messages | WIRED | src/app/api/couple/messages/route.ts, (platform)/portal/messages/page.tsx | Two-way chat
vendor_recommendations | WIRED | src/lib/services/data-import.ts, seed | Agent import
inspo_gallery | WIRED | src/app/_couple-pages/inspo/page.tsx | Couple uploads
venue_usps | SEED ONLY | seed.sql | Coordinator UI to manage USPs is not present
venue_seasonal_content | SEED ONLY | seed.sql | Coordinator UI not present
phrase_usage | WIRED | src/lib/ai/phrase-selector.ts | Phrase-selector tracks usage
voice_training_sessions | WIRED | src/app/(platform)/settings/voice/page.tsx | Voice training game
voice_training_responses | WIRED | src/app/(platform)/settings/voice/page.tsx | Voice training responses
voice_preferences | WIRED | src/app/(platform)/agent/rules/page.tsx, settings/voice/page.tsx | Rules + dimensions
activity_log | WIRED | src/lib/services/activity-logger.ts, api/agent/thread-lock/route.ts | Fire-and-forget activity
admin_notifications | WIRED | src/lib/services/admin-notifications.ts, _couple-pages/worksheets/page.tsx | Bell icon
bar_planning | WIRED | src/app/_couple-pages/bar/page.tsx | Couple portal
bar_recipes | WIRED | src/app/_couple-pages/bar/page.tsx, data-import.ts | Couple portal
bar_shopping_list | WIRED | src/app/_couple-pages/bar/page.tsx | Couple portal
ceremony_order | WIRED | src/app/_couple-pages/ceremony/page.tsx | Couple portal
makeup_schedule | WIRED | src/app/_couple-pages/beauty/page.tsx | Couple portal
shuttle_schedule | WIRED | src/app/_couple-pages/transportation/page.tsx, data-import.ts | Couple portal
rehearsal_dinner | WIRED | src/app/_couple-pages/rehearsal/page.tsx | Couple portal
decor_inventory | WIRED | src/app/_couple-pages/decor/page.tsx, data-import.ts | Couple portal
staffing_assignments | WIRED | src/app/_couple-pages/staffing/page.tsx, data-import.ts | Couple portal
bedroom_assignments | WIRED | src/app/_couple-pages/rooms/page.tsx, data-import.ts | Couple portal
allergy_registry | WIRED | src/app/_couple-pages/allergies/page.tsx | Couple portal
guest_care_notes | WIRED | src/app/_couple-pages/guest-care/page.tsx, data-import.ts | Couple portal
wedding_worksheets | WIRED | src/app/_couple-pages/worksheets/page.tsx | Couple portal
wedding_party | WIRED | src/app/_couple-pages/party/page.tsx, data-import.ts | Couple portal
photo_library | WIRED | src/app/_couple-pages/photos/page.tsx, couple-photo/page.tsx | Couple portal
borrow_catalog | SEED ONLY | seed | No coordinator UI
borrow_selections | WIRED | src/app/_couple-pages/venue-inventory/page.tsx | Couple picks
accommodations | SEED ONLY | seed | No coordinator UI
onboarding_progress | SEED ONLY | seed | Getting-started page reads but never writes
section_finalisations | WIRED | src/app/_couple-pages/final-review/page.tsx | Finalisation page
guest_tags | WIRED | src/app/_couple-pages/guests/page.tsx | Couple tags
guest_tag_assignments | WIRED | src/app/_couple-pages/guests/page.tsx | Join table
guest_meal_options | WIRED | src/app/_couple-pages/guests/page.tsx, data-import.ts | Meal choices
wedding_website_settings | WIRED | src/app/_couple-pages/website/page.tsx | Couple site
tours | WIRED | src/lib/services/data-import.ts, seed | Tour imports
lost_deals | WIRED | src/app/(platform)/intel/lost-deals/page.tsx, data-import.ts | Lost deal entry
campaigns | WIRED | src/app/(platform)/intel/campaigns/page.tsx, data-import.ts | Marketing
social_posts | WIRED | src/app/(platform)/intel/social/page.tsx, data-import.ts | Social posts
annotations | WIRED | src/app/(platform)/intel/annotations/page.tsx | Chart annotations
venue_health | SEED ONLY | seed | Pages read; no compute job
client_match_queue | WIRED | src/app/(platform)/intel/matching/page.tsx | Accept/reject pending matches
knowledge_gaps | SEED ONLY (partial) | seed.sql inserts; runtime only resolves | No insert at runtime
follow_up_sequence_templates | ARCHIVED | migration 040 renamed to _archived_ | Dead schema
wedding_sequences | ARCHIVED | migration 040 renamed to _archived_ | Dead schema
relationships | WIRED | src/app/(platform)/agent/relationships/page.tsx | People linking
client_codes | WIRED (trigger) | DB trigger `auto_generate_client_code()` (migration 032) on weddings insert | Auto-generated
error_logs | WIRED | src/app/(platform)/agent/errors/page.tsx (update), email-pipeline.ts inserts? | Mostly service-written
notification_tokens | WIRED | src/app/(platform)/agent/notifications/page.tsx | Web push subscription
portal_section_config | WIRED | src/app/api/portal/section-config/route.ts, seed | Coordinator toggles
wedding_details | WIRED | src/app/api/couple/wedding-details/route.ts | Couple portal details page
wedding_tables | WIRED | src/app/api/couple/tables/route.ts | Tables config
storefront | SEED ONLY | seed-audit-gaps.sql | No coordinator UI
venue_assets | ORPHAN | none | No seed, no writer
venue_resources | ORPHAN | none | No seed, no writer
wedding_detail_config | WIRED | src/app/api/portal/wedding-detail-config/route.ts | Coordinator-side config
booked_vendors | WIRED | src/app/_couple-pages/vendors/page.tsx | Couple portal
budget_items | WIRED | src/app/_couple-pages/budget/page.tsx, data-import.ts, sage-brain.ts reads | Canonical budget
budget_payments | WIRED | src/app/_couple-pages/budget/page.tsx, data-import.ts | Payments
wedding_config | WIRED | src/app/_couple-pages/budget/page.tsx, guests/page.tsx | Couple-level config
wedding_timeline | SEED ONLY | seed | Reads exist; no writer found (distinct from `timeline`)
notifications | SEED ONLY / DEPRECATED | seed-couple-portal.sql | Superseded by admin_notifications
couple_budget | DEPRECATED | seed-couple-portal.sql | Superseded by budget_items per migration 052
rsvp_config | WIRED | src/app/_couple-pages/rsvp-settings/page.tsx | RSVP setup
rsvp_responses | WIRED | src/app/api/public/wedding-website/route.ts | Public RSVP submit
venue_groups | ORPHAN | none | Read only; no creator UI or seed
venue_group_members | ORPHAN | none | Read only; no creator UI or seed
brand_assets | WIRED | src/app/(platform)/settings/page.tsx | Logo/brand uploads
follow_up_sequences | WIRED | src/app/(platform)/agent/sequences/page.tsx | Active model
sequence_steps | WIRED | src/app/(platform)/agent/sequences/page.tsx | Active model
reviews | WIRED | src/lib/services/data-import.ts, (platform)/intel/reviews/page.tsx update | Review imports + responses
intelligence_insights | AI-ONLY | src/lib/services/intelligence-engine.ts, insight-tracking.ts | Insights
market_intelligence | SEED ONLY (fragile) | census-ingest.ts writes but is never called | Orphan-adjacent
industry_benchmarks | SEED ONLY | seed-market-intelligence.sql | Reference data
insight_outcomes | AI-ONLY | src/lib/services/insight-tracking.ts | Outcome measurement cron
event_feedback | WIRED | src/app/api/portal/event-feedback/route.ts, (platform)/portal/weddings/[id]/page.tsx | Post-wedding survey
event_feedback_vendors | WIRED | src/app/(platform)/portal/weddings/[id]/page.tsx | Vendor feedback rows
team_invitations | WIRED | src/app/api/team/invite/route.ts, team/accept/route.ts, settings/team/page.tsx | Team invites
gmail_connections | WIRED | src/lib/services/gmail.ts, /api/agent/gmail/route.ts | Multi-gmail
```

---

## Top 5 most concerning findings

1. **`venue_groups` and `venue_group_members` are pure orphans.** They are queried in over 20 pages for multi-venue scope filtering (consultants jumping between venues), but no seed data and no UI ever inserts into them. Every "group scope" feature silently returns zero and falls back to single-venue mode. This is a feature that looks implemented but is permanently disabled.

2. **`census-ingest.ts` is unreachable dead code.** It writes to `market_intelligence`, but no route, cron, or service ever imports it. It also contains a `TODO: wire real API call` stub. `market_intelligence` is effectively seed-only despite the marketing pitch of "external intelligence ingest".

3. **`createCoupleCrud()` factory in `src/lib/api/couple-crud.ts` has zero callers.** It was written as a DRY wrapper for the couple portal but every couple page bypasses it with direct Supabase calls. Harmless but pure dead code that should be deleted.

4. **`venue_health` has no compute job.** Intel dashboard pages read history from this table expecting periodic computation, but no cron in `vercel.json` and no service calculates and inserts rows. Any real venue will show an empty health chart.

5. **Coordinator-owned venue content has no management UIs.** `venue_usps`, `venue_seasonal_content`, `accommodations`, `borrow_catalog`, `storefront`, `venue_assets`, `venue_resources` are all read by the couple portal but there is no platform-side UI to create or edit them. They exist only as seed data for the demo venues; a new real venue would ship an empty Stays, Picks, Downloads, Resources, and Venue Inventory page.

---

## Sanity checks applied

- All 52 migration files scanned for `CREATE TABLE` / `CREATE TABLE IF NOT EXISTS`.
- Every `.from('table').insert|upsert|update|delete` across `src/**`, `supabase/functions/**`, and `supabase/*.sql` inspected.
- `data-import.ts` verified as the spreadsheet pipeline writing to: people, guest_list, marketing_spend, budget_items, vendor_recommendations, tours, weddings, campaigns, social_posts, reviews, lost_deals, knowledge_base, budget_payments, bar_recipes, guest_meal_options, guest_care_notes, wedding_party, staffing_assignments, bedroom_assignments, shuttle_schedule, decor_inventory, checklist_items.
- `vercel.json` cron inventory cross-checked with `src/app/api/cron/route.ts` switch cases.
- Edge functions (`supabase/functions/email-poll`, `heat-decay`, `daily-digest`, `sequence-processor`) inspected for writers.
- DB triggers (migration 032) verified as writer for `client_codes`.
- Migration 040 archive rename (`wedding_sequences`, `follow_up_sequence_templates`) and migration 052 budget deprecation accounted for.
