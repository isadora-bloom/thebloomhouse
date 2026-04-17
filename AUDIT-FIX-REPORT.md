# Bloom House — Audit Fix Report (Final)
**Date:** 2026-04-08
**Scope:** All issues from consolidated platform audit (SSR crawl + Playwright)

---

## Final Results

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Total pages tested | 97 | 97 | — |
| Pages with warnings | **75** | **0** | **-100%** |
| Total issues found | **199** | **0** | **-100%** |
| Console errors | 106 | 0 | **-100%** |
| Failed requests | 92 | 0 | **-100%** |
| Bad text (NaN/undefined) | 1 | 0 | **-100%** |

### All 97 pages now pass cleanly:
- **Agent:** 14/14 clean
- **Intel:** 23/23 clean
- **Portal:** 17/17 clean
- **Couple:** 38/38 clean
- **Settings:** 5/5 clean

---

## What Was Fixed

### 4 commits, 44 files changed, ~1,500 lines modified

#### Commit 1: Main audit fixes (31 files)
**Schema column fixes (S2-S8, S12-S14):**
| Wrong Column | Correct Column | Table | Files |
|-------------|----------------|-------|-------|
| `event_date` | `wedding_date` | weddings | 6 |
| `tour_date` | `scheduled_at` | tours | 1 |
| `post_date` | `posted_at` | social_posts | 1 |
| `start_date` | `period_start` | annotations | 1 |
| `type` | `relationship_type` | relationships | 1 |
| `format` | `format_template` | client_codes | 1 |
| `query/response` | `query_text/response_text` | natural_language_queries | 1 |
| `display_order` | `sort_order` | checklist_items, budget_items | 2 |
| `share_budget_with_venue` | `budget_shared` | wedding_config | 1 |
| `food_mode, guest_tags, meal_options` | Separate tables | wedding_config → guest_tags, guest_meal_options | 1 |

**venue_config JSONB restructuring (S9, S15, S16):**
- Shuttle fields: read from `feature_flags.shuttle_config` (2 files)
- Floor plan URL: read from `feature_flags` (1 file)
- Rehearsal options: read from `feature_flags` (1 file)

**Table restructuring (S17-S19):**
- `room_blocks` → `bedroom_assignments` (table didn't exist)
- `staffing_calculator` → `staffing_assignments` (table didn't exist)
- `guest_care_notes`: restructured from single JSONB row to individual rows per care_type

**JS crash fixes (R1, R2, D1):**
- `intel/briefings`: null guard on `content.demand_outlook`
- `intel/lost-deals`: null guard in `formatLabel()`
- `intel/campaigns`: `Number.isFinite()` guards in calculation functions

**Database migrations:**
- `026_fix_venue_groups_rls.sql`: RLS policies for `venue_groups` + `venue_group_members`
- `027_demo_rls_policies.sql`: Anon read/write policies for 50 couple-portal tables
- Applied `022_venue_groups.sql` to remote (table was never created)

**Content:**
- Fixed 3 broken placeholder image URLs in seed data + live DB

#### Commit 2: Remaining Intel + Couple fixes (13 files)
- `intel/sources`: `created_at` → `calculated_at` on source_attribution
- `intel/briefings`: Optional chaining on all `content.metrics.*` accesses (~20 additions)
- `intel/tours`: Null guard in `formatLabel()`
- `intel/annotations`: Null guard + `annotation_type` column rename
- `intel/lost-deals`: `formatLabel()` returns `'Unknown'` for falsy input
- `couple/getting-started`: Partner names via `people` table join
- `couple/chat`: Payment due dates from `budget_items` not `couple_budget`
- `couple/checklist`: `task_text`→`title`, `notes`→`description`, removed unused fields
- `couple/bar`: Order by `created_at` (no `sort_order` column)
- `couple/decor`: Order by `category`+`item_name` (no `space_name`/`sort_order`)
- `couple/transportation`: Order by `departure_time` (no `sort_order`)
- `couple/timeline, getting-started, website`: `.single()` → `.maybeSingle()`

#### Commit 3: Final 3 bad-text fixes (2 files)
- `intel/lost-deals`: Null `stage`/`reason` → `'unknown'` key (not JS `undefined`)
- `intel/sources`: `fmt$()` NaN guard, null `source_name` → `'Unknown'`

---

## Test Infrastructure Added

| File | Purpose |
|------|---------|
| `playwright.config.ts` | Config targeting `bloom-house-iota.vercel.app` |
| `e2e/demo-smoke.spec.ts` | 97-page smoke suite checking 5 things per page |
| `e2e/generate-report.py` | Generates markdown report from Playwright JSON |

**What the tests check on every page:**
1. No JS console errors (runtime crashes, failed imports)
2. No bad text patterns ("undefined", "NaN", "null", "[object Object]", error messages)
3. No failed network requests (4xx/5xx API calls)
4. No broken images
5. No empty pages (< 20 chars of visible text)

**Run command:** `npx playwright test` → results in `DEMO-AUDIT-REPORT.md`

---

## Still Needs Manual Review

These can't be caught by automated testing:

- [ ] Charts/graphs render with real data (not empty containers)
- [ ] Drag-and-drop interactions work (seating, timeline reordering)
- [ ] Form submissions save and persist correctly
- [ ] Sage AI chat responds coherently with venue voice
- [ ] Cross-page data consistency (portal config ↔ couple portal display)
- [ ] Mobile/tablet responsiveness across breakpoints
- [ ] Correct venue branding per demo venue (not just Hawthorne Manor)
- [ ] Multi-venue scope switching (Hawthorne → Crestwood → Glass House → Rose Hill)
- [ ] Print/PDF export functionality
- [ ] All 4 demo venues fully seeded with distinct data
- [ ] Agent section seeded with demo emails, leads, pipeline cards
- [ ] Portal KB seeded with FAQ entries for Sage

---

*97 pages tested via Playwright Chromium. 0 console errors. 0 failed requests. 0 bad text. All clean.*
