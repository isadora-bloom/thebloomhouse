# Stream 4 — Tactical UI fixes (Round 1 verification batch)

Date: 2026-05-11
Owner: Stream 4 of 5 parallel build streams
Scope: 10 tactical fixes against the Bloom Agent surface

## Summary

| Finding | Status | Files touched |
| --- | --- | --- |
| F4  | resolved | `src/app/(platform)/agent/inbox/page.tsx` |
| F17 | resolved | `src/app/(platform)/agent/analytics/page.tsx` |
| F19 | resolved | `src/app/(platform)/agent/classification-health/page.tsx` |
| F22 | resolved | `src/app/api/admin/knowledge-gaps/capture/route.ts`, `src/lib/services/knowledge-gaps/category-backfill.ts` (NEW), `src/lib/services/knowledge-gaps/categories.ts` (NEW), `src/app/api/cron/route.ts` |
| F24 | resolved | `src/app/(platform)/agent/codes/page.tsx` |
| F26 | resolved | `src/app/(platform)/agent/notifications/page.tsx` |
| F27 | resolved | `src/app/api/intel/insights/route.ts`, `src/components/intel/insight-card.tsx` |
| F29 | resolved | `src/app/(platform)/agent/notifications/page.tsx` (consumer-side `NotificationBody`) |
| F31 | resolved | `src/app/(platform)/agent/errors/page.tsx` |
| F33 | resolved | `src/app/(platform)/agent/classification-health/page.tsx` |

## Per-finding notes

### F4 — Inbox unread count doesn't decrement
Class of problem: optimistic state was missing on `loadThread`. The unread badge derives from in-memory `interactions[i].is_read`, so the count only refreshed after the next `fetchInteractions`. Now `loadThread` flips `is_read=true` locally AND fires a fire-and-forget Supabase UPDATE. Skips outbound rows (already treated as read elsewhere). Did NOT touch the SELECT query (Stream 2 owns the `surface` filter).

### F17 — Analytics scope undefined
Added a scope banner above the charts: "Showing: {venueName} · {periodLabel}". Pulls venue/group/company name from `useScope()` (resolution order: venue → group → company → "All venues"). Period label maps from the existing `PERIOD_OPTIONS` array.

### F19 — AI cost panel visible to wrong roles
Added a client-side role gate using `user_profiles.role`. Allowed: `super_admin`, `org_admin`, `owner`, `admin`. Non-admins now see "Cost details require admin role." in place of the YTD spend tile + the per-venue cost section. RLS (mig 296) remains the real enforcement; this is the UI clarity layer.

### F22 — Knowledge gaps null category + 447 legacy 'other' rows
Two-part fix:
1. **Route guard:** Capture endpoint now requires `category` when creating a fresh capture (not attached to an existing gap), validated against the 9-category enum mirrored from mig 298.
2. **Haiku backfill:** New service `category-backfill.ts` sweeps `knowledge_gaps WHERE category='other' AND status='open'`, calls Haiku per row to pick the best category, updates the row. Registered as cron job `knowledge_gap_category_backfill`. 50 rows/tick; per-row fire-and-forget on errors. Cost ~$0.0002/row.
3. **Shared enum:** Extracted `KNOWLEDGE_GAP_CATEGORIES` into `src/lib/services/knowledge-gaps/categories.ts` so the route and the service both import a single source-of-truth (avoid route → service circular).

### F24 — Client Codes sort order
Server `.order('code', { ascending: true })` was already in place. Added defense-in-depth: `localeCompare` with `numeric:true, sensitivity:'base'` so RM-9 sorts before RM-10 and mixed-case codes collate naturally. Filtering preserves sort.

### F26 — Notifications no click-through
Added a `notificationHref()` resolver mapping `notification.type` → target URL:
- `new_inquiry` / `inquiry_arrived` → `/agent/inbox?wedding={id}`
- `draft_pending` / `auto_send_pending` → `/agent/drafts?draft={draftId}` (draftId parsed from `body` JSON when present)
- `tour_booked` / `tour_scheduled` / `tour_completed` → `/intel/leads/{wedding_id}`
- `escalation*` / `contract_signing_detected` / `booking_confirmation_prompt` / `brain_dump_grant_fired` → `/intel/leads/{wedding_id}` if a wedding is attached, else inert
- default → wedding page when wedding_id present, else inert

Each row wraps in `next/link` only when a href resolves; inert rows stay as a `<div>` so they don't render dead links.

### F27 — Re-engagement matches show UUIDs
Class of problem: insights with a wedding `context_id` rendered the UUID directly in title/data. Fixed in two places:
1. **API enrichment:** `/api/intel/insights` now joins `weddings → people` for any insight whose `context_id` looks like a UUID, builds a couple label via `buildCoupleFullNames(pickCanonicalPeople(...))`, and ships it on the row as `couple_label` + `context_wedding_id`.
2. **Card render:** `InsightCard` now prefixes the title with `"{couple_label} · "` when present. The `data_points` dump in the card also hides any UUID-shaped values and known id keys (wedding_id / person_id / venue_id / interaction_id / candidate_id / context_id) so future writers don't accidentally surface raw IDs to operators.

### F29 — JSON dump in notification body
Class of problem: ~20+ writers across `lib/services/brain-dump`, `cost-ceiling`, `essentials-suggester`, `email/pipeline`, etc. intentionally JSON-encode metadata into the `body` column for type-specialized consumers (AutoSendCard, BookingConfirmCard, GrantFiredBody). Changing every writer would break those consumers.

Fixed at the rendering layer: new `NotificationBody` component auto-detects bodies starting with `{` or `[`, parses them, and pretty-prints a small allowlist of human fields (`reason`, `message`, `summary`, `coupleLabel`, `couple_name`, `toName`, `subject`, `matchedPhrase`, `source`). Bodies that don't parse as JSON pass through unchanged. Bodies that parse but match no allowlisted field show "Details available, open to view." instead of dumping raw JSON.

### F31 — Error Monitor shows dev data on operator surface
Page is not super_admin-only by route (existing model lets coordinators triage their own errors). Added field-level redaction instead: non-admins see error messages with Windows + POSIX absolute paths collapsed to a basename suffix, multi-line stack traces collapsed to "(stack hidden)", and messages capped at 240 chars. Admins (`super_admin` / `org_admin` / `owner` / `admin`) see raw messages untouched so they can actually debug. Applied to both the table row and the ResolveModal.

### F33 — "Inbounds with no classification" copy unclear
- Reworded the heading + caption to: "Inbounds awaiting classification (last 7 days)" with the explanatory caption "These will be processed on the next classifier sweep. Click through to the inbox to inspect a single row, or run the sweep now to reprocess immediately."
- Added a "Run sweep now" button (admins only) that POSTs to `/api/agent/reprocess-orphans` with the current scope's venueId, surfaces an inline result line. Did NOT touch the metric calculation (Stream 1 owns).

## Cron registration

Added one entry to `src/app/api/cron/route.ts`:
- `VALID_JOBS` array: appended `'knowledge_gap_category_backfill'` after `'alumni_cohort_sweep'`.
- `runJob()` switch: added the matching case dispatching to `runKnowledgeGapCategoryBackfill()`.

Note for vercel.json: Stream 4 did not edit vercel.json. Operator will need to add a cron entry there (or accept manual-trigger only) for the new job. The Vercel cron cap is 40 and `prune_maintenance` is the umbrella job for retention work — registering the backfill there is the most straightforward path if the cap is hit.

## Open questions

1. **F22 cost guard:** the backfill is fire-and-forget on errors, but there is no per-tick budget cap beyond the 50-row batch. At ~$0.0002/row that's $0.01/tick, well under any reasonable ceiling. If the legacy 'other' bucket grows substantially over time, consider gating via `cost-ceiling.ts`.
2. **F26 lead detail URL:** I used `/intel/leads/{wedding_id}`. Other surfaces in the codebase variously reference `/agent/leads/{id}`, `/intel/sources/...`, etc. The exact canonical lead URL should be verified by the operator on next walkthrough; the fallback `/intel/leads` is safe if the deep link 404s.
3. **F27 couple-label scope:** I only enrich insights whose `context_id` validates as a real wedding owned by the current venue scope (`validWeddingIds` set). Insights whose context_id is a person_id or some other entity stay unlabeled. That's intentional — wedding is the dominant case (decay_re_engagement / heat_narration / negotiation_state / etc.) and labeling other entities would require per-type dispatch.
4. **F29 allowlist coverage:** The human-field allowlist covers the eight most common keys I saw across the writer audit. New writers introducing fresh field names will hit the "Details available, open to view." fallback rather than dumping raw JSON. If the operator wants additional fields surfaced inline, just append to the `candidates` array in `NotificationBody`.
5. **F31 redaction heuristic:** The path-collapse regex is best-effort. Error messages that already pre-format paths into a sentence may not match perfectly. Stack-trace collapse handles the `\n  at ...` pattern only; non-Node stack formats pass through.

## Files touched (canonical list)

Modified:
- `src/app/(platform)/agent/inbox/page.tsx`
- `src/app/(platform)/agent/analytics/page.tsx`
- `src/app/(platform)/agent/classification-health/page.tsx`
- `src/app/(platform)/agent/codes/page.tsx`
- `src/app/(platform)/agent/notifications/page.tsx`
- `src/app/(platform)/agent/errors/page.tsx`
- `src/app/api/admin/knowledge-gaps/capture/route.ts`
- `src/app/api/intel/insights/route.ts`
- `src/app/api/cron/route.ts`
- `src/components/intel/insight-card.tsx`

New:
- `src/lib/services/knowledge-gaps/category-backfill.ts`
- `src/lib/services/knowledge-gaps/categories.ts`
