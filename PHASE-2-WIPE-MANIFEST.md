# Phase 2 — Wipe Manifest

**Date:** 2026-05-22 · **For:** `CONSOLIDATION-PLAN-PHASED.md` Phase 2 (wipe + reimport).
**Source:** full per-table classification pass over 309 `CREATE TABLE` statements across 365 migrations, cross-checked against the existing wipe scripts.

This is the exact, table-by-table wipe/preserve list. Phase 2's wipe runs **from this manifest**, not from a phrase. A naive "wipe the identity tables" would destroy 22 tables of operator-entered work — this manifest exists so it doesn't.

---

## Buckets

| Bucket | ~Count | Action |
|---|---|---|
| **WIPE** | ~78 | Identity/pipeline tables — every row reproducible by reimporting HoneyBook + Calendly + Gmail through the unified cascade. Wiped + rebuilt. |
| **PRESERVE-VENUE** | ~70 | Venue config, AI training, OAuth connections, external feeds (weather/FRED/census), agency + marketing config, system logs. No couple/wedding dependency. Untouched. |
| **PRESERVE-EVENT** | ~40 | Couple-portal / event-planning tables — `wedding_id`-keyed, survive because `weddings` survives (D1). Untouched. |
| **DANGER** | **22 + 1 column-cluster** | Operator/couple-entered, NOT reproducible from source. Per-table verdict below. |

**WIPE categories:** identity-first spine (`couples`, `touchpoints`, `fragments`, `agent_couple_links`, `couple_merge_events`, `couple_progression_events`, `candidate_matches`, `tracer_run_events` — all migration 346); legacy pipeline (`weddings`, `people`, `interactions`, `drafts`, `attribution_events`, `wedding_touchpoints`, `engagement_events`, `candidate_identities`, `tangential_signals`); derived intel (`couple_intel`, `couple_identity_profile`, `venue_intel`, `venue_thesis`, intel rollups/snapshots); all `*_jobs` queues; `crm_import_rows` + `import_runs`.

**PRESERVE-VENUE categories:** `venues`/`venue_config`/`venue_ai_config`; OAuth (`gmail_connections`, `zoom_connections`, `openphone_connections`, `google_ads_connections`); voice training (`voice_preferences`, `voice_training_sessions`, `learned_preferences`); `reviews` + `review_language`; `knowledge_base`; `brand_assets`/`venue_assets`/`venue_resources`; `marketing_spend`/`marketing_channels`/agency tables; external feeds (`weather_*`, `fred_*`, `search_trends`, `web_visits`); `tracked_sources`; `auto_send_rules`/`heat_score_config`; system logs (`api_costs`, `cron_runs`).

**PRESERVE-EVENT categories:** `guest_list`/`guest_tags`/`rsvp_*`; `budget_items`/`budget_payments`; `seating_tables`/`wedding_tables`/`table_map_layouts`; `contracts`; `checklist_items`; `timeline`; `messages`; `inspo_gallery`/`photo_library`/`day_of_media`; `wedding_details`/`wedding_party`; `bar_*`/`ceremony_*`; logistics (`makeup_schedule`, `shuttle_schedule`, `rehearsal_dinner`, `bedroom_assignments`, `allergy_registry`, `decor_inventory`, `staffing_*`); `booked_vendors`/`vendor_checklist`; `wedding_website_settings`; `sage_conversations` (couple↔Sage chat — NOT in any source).

---

## DANGER — 22 tables + 1 column-cluster (operator/couple-entered, not reproducible)

| # | Table | What is lost if wiped | Verdict |
|---|---|---|---|
| 1 | `wedding_internal_notes` | coordinator free-text notes per couple | **PRESERVE-IN-PLACE** (wedding survives → notes survive) |
| 2 | `brain_dump_entries` | coordinator observations, uploaded PDFs/voice notes — a brand-asset surface | **PRESERVE-IN-PLACE** (venue-keyed, no FK to wiped tables) |
| 3 | `brain_dump_pattern_grants` | operator-approved learned patterns | **PRESERVE-IN-PLACE** |
| 4 | `knowledge_captures` | operator-folded-in knowledge (the `active` decision) | **PRESERVE-IN-PLACE** |
| 5 | `knowledge_gaps` | operator-resolved gap status | **PRESERVE-IN-PLACE** |
| 6 | `evidence_overrides` | manual "this evidence is wrong" dismissals | **EXPORT-AND-REMERGE** — `wedding_id`-keyed; remap after reimport |
| 7 | `handle_merge_decisions` | operator @handle merge accept/reject/defer | **PRESERVE-IN-PLACE** (keyed on handles, not wedding ids) |
| 8 | `identity_decision_clusters` | operator merge-cluster decisions | **EXPORT-AND-REMERGE** — references `canonical_person_id`; replay against new identities |
| 9 | `couple_merge_events` (manual rows only) | manual merge/unmerge/resurrection decisions | **EXPORT-AND-REMERGE** the `manual_*`/`resurrection*` rows; pipeline rows wipe |
| 10 | `candidate_matches` (resolutions) | operator confirm/reject/not-sure decisions | **EXPORT** resolutions as a matcher-calibration corpus; queue wipes |
| 11 | `person_merges` | manual people-merge history | **EXPORT** for audit (FK to people is wiped — cannot remerge directly) |
| 12 | `integrity_remediations` | which invariants the operator chose to remediate | **PRESERVE-IN-PLACE** (venue-keyed audit) |
| 13 | `intel_acknowledgments` | dismissed/snoozed intel insights | **PRESERVE-IN-PLACE** (keyed on insight string keys — survives cleanly) |
| 14 | `insight_outcomes` | operator-recorded outcomes of acted-on insights | **PRESERVE-IN-PLACE** |
| 15 | `event_feedback` / `event_feedback_vendors` | post-event coordinator debrief + vendor ratings | **PRESERVE-IN-PLACE** — ⚠ remove from the Tier-8 wipe script |
| 16 | `draft_feedback` | the voice-training accept/reject/edit signal — the single most valuable operator signal | **EXPORT-AND-REMERGE** — `wedding_id`-keyed; ⚠ remove from both wipe scripts |
| 17 | `draft_edit_insights` | derived edit insights | **PRESERVE** if #16 preserved, else rederive |
| 18 | `annotations` | operator notes pinned to intel charts | **PRESERVE-IN-PLACE** — ⚠ remove from the Tier-8 wipe script |
| 19 | `natural_language_queries` | operator's saved NL queries | **PRESERVE-IN-PLACE** (low value; default keep) |
| 20 | `discovery_feedback_actions` | operator feedback on discovery suggestions | **EXPORT** as calibration corpus |
| 21 | `discovery_sources` | pasted storefront captures (Knot/IG) — NOT in HoneyBook/Calendly/Gmail | **EXPORT-AND-REMERGE** (re-derivable from `brain_dump_entries` if preserved; export as safety net) |
| 22 | `re_engagement_actions` (operator-edited rows) | operator edits to re-engagement drafts | **EXPORT** edited rows; regenerate the rest |
| C | `weddings` columns: `owner_note`, `owner_photo`, manual `lead_source` overrides, operator `calendly_qa` edits | operator-typed fields on an otherwise-reproducible row | **COLUMN-LEVEL EXPORT-AND-REMERGE** — export keyed by a stable id (email / external CRM id), reapply after reimport |

**Pattern:** ~14 of 22 are venue-keyed and survive a wipe cleanly (PRESERVE-IN-PLACE — they just must not be in the wipe list). ~8 are wedding/people-keyed and need EXPORT-AND-REMERGE — exported before the wipe, re-attached after reimport once the new couple/wedding ids exist.

---

## Two bugs in the EXISTING wipe scripts — must fix before Phase 2

1. **`scripts/wipe-rixey-tier8-fresh.mjs` wrongly WIPEs operator data:** `event_feedback`, `annotations`, `natural_language_queries`, `draft_feedback`, and `sage_conversations`/`sage_uncertain_queue` (couple↔Sage chat). Remove all from its `WIPE_TABLES`.
2. **Neither wipe script touches the identity-first spine** (`couples`, `touchpoints`, `fragments`, `agent_couple_links`, `couple_merge_events`, `couple_progression_events`, `candidate_matches`, `tracer_run_events` — migration 346, dated *after* the scripts were written). Phase 2's wipe MUST include them, or the reimport collides with stale `couples` rows on `uq_couples_source_wedding`.

Phase 2 does not reuse either script as-is. It runs a fresh wipe built from this manifest.

---

## Operator-decision items (confirm before running)

- `voice_dna_derivations` / `voice_dna_jobs` — reproducible from the email corpus; the Tier-8 script preserves them by choice. Either is safe.
- `email_sync_state` — **must be wiped / watermark-reset** so the Gmail re-sync does a full backfill instead of resuming from the stale watermark.
- `processed_zoom_meetings` / `processed_sms_messages` — dedup ledgers; wipe alongside `interactions` so Zoom/SMS re-ingest.

## UNKNOWN — verify before wiping

- `tour_prep_briefs` — AI-generated (→ WIPE), but if the operator UI (`TourPrepBriefPanel.tsx`) allows *editing* the brief, operator edits are a column-level danger. 2-minute UI check.
- `ai_briefings`, `venue_health_history`, `external_signal_health`, `venue_location_derivations` — recomputed metrics; default PRESERVE-VENUE (harmless if stale).
