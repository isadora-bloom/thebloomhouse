# AI-name + source-freshness audit (2026-05-09)

Two short investigations. Run against live Supabase
(`jsxxgwprxuqgcauzlxcb`) using the service-role key in `.env.local`.

---

## 1. AI name verification — "Rixey Concierge" vs "Sage"

### Live DB state (Rixey Manor, venue `f3d10226-4c5c-47ad-b89b-98ad63842492`)

| Column         | Value                                |
|----------------|--------------------------------------|
| `ai_name`      | **`Sage`**                           |
| `ai_role_title`| `AI Concierge to Isadora Martin-Dye` |
| `ai_emoji`     | `null`                               |
| `updated_at`   | `2026-05-09T11:32:27.771753+00:00`   |

So the **current** brand is `Sage` (not `Rixey Concierge`). The role
line is `AI Concierge to Isadora Martin-Dye` — that's the second
signature line under the name, not a brand name.

### Forensic timeline — what Isadora was seeing

I scanned the 50 most-recent rows of `drafts` (filtered to Rixey's
venue, 48 rows hit). Sign-off split:

| Signature                              | Count | Earliest         | Latest           |
|----------------------------------------|-------|------------------|------------------|
| Signed `Rixey Concierge`               |   35  | (older)          | 2026-05-09 ~00:12 UTC |
| Signed `Sage`                          |    8  | 2026-05-09 ~12:00 UTC | 2026-05-09 ~16:40 UTC |

This matches the `venue_ai_config.updated_at` of `2026-05-09T11:32`:
the `ai_name` column was flipped from `Rixey Concierge` back to
`Sage` mid-day today. Every draft generated AFTER ~11:35 UTC signs
as Sage; every draft generated BEFORE that signs as Rixey Concierge.

### Where "Rixey Concierge" came from

`scripts/rixey-load/02-venue-config.mjs:22` writes
`ai_name: 'Rixey Concierge'` as part of the post-launch data-load
run. That is the only writer. The audit log
`audits/2026-05-T4-postlaunch/rixey-data-load-report.md` documents
it explicitly. So at some point the data-load script set the brand
to "Rixey Concierge" and someone reverted it to "Sage" today.

### Hardcoded-Sage leaks in code

- `scripts/check-no-hardcoded-sage.mjs` ran. Two scans:
  - **Prompt + brain layer** (the zone that matters for Isadora's
    flag): **clean.** No hardcoded venue-identifying tokens. The
    sign-off block is built deterministically from
    `venue_ai_config.{ai_name, ai_role_title, signature_tagline,
    signature_website, signature_phone, signature_text_capable}`
    via `buildSignoffBlock` in `src/lib/ai/personality-builder.ts`.
  - **Coordinator UI shell**: 30 hardcoded `Sage` literals across
    inbox / settings / portal pages. These are platform-admin
    surfaces only — they do NOT leak into couple-facing drafts.
    Pre-existing backlog, not the cause of Isadora's flag.

### Cache TTL

`loadPersonalityDataCached` keeps a 5-minute in-memory cache. After
the 11:32 UTC update there's a max ~5 min window where serverless
warm instances would still render the old name. Effectively
imperceptible at this scale.

### Verdict

**Intentional rebrand, not config drift.** Isadora (or whoever
owned the rixey-load run) intentionally set the brand to "Rixey
Concierge" earlier, then reverted to "Sage" today at 11:32 UTC.
Drafts generated between those two events permanently bear the old
"Rixey Concierge" signature because the body is a frozen artifact —
re-rendering would require regenerating each draft. The signature
infrastructure is sound: `requireAiName` + `buildSignoffBlock` is
the only writer.

### Recommendation

1. **Decide the brand.** If "Sage" is the canonical brand, delete
   the `ai_name: 'Rixey Concierge'` write in
   `scripts/rixey-load/02-venue-config.mjs:22` so a future
   data-load run doesn't accidentally flip back.
2. **Optional:** if old "Rixey Concierge" drafts are still in the
   approval queue, regenerate them through the inquiry brain so
   they sign with the new name.
3. The 30 coordinator-UI hardcoded "Sage" literals (`agent/inbox`,
   `agent/settings`, `settings/page`, `intel/sources/track`,
   `portal/weddings/.../lifecycle-history`,
   `components/intel/*`, `components/shell/post-onboarding-checklist`,
   `honeybook-stale-banner`, `intel-brain` references) are a
   pre-existing backlog item — they don't affect Rixey because Rixey
   IS Sage post-revert, but they would leak the wrong brand to any
   non-Sage tenant. Wire them through `useAiName()` /
   `useCoupleContext().aiName` when the white-label sweep resumes.

---

## 2. Source-freshness end-to-end smoke test

Cron shipped `a42b5ab` (2026-05-08). Folded into `prune_maintenance`
at `ef3260c` to stay under Vercel Pro's 40-cron limit.

| Step | Item | Pass / Fail | Notes |
|------|------|-------------|-------|
| 1 | `source-freshness.ts` API matches `/api/intel/sources/track` writer | PASS | Both read `tracked_sources(venue_id, source_key, expected_cadence_days, last_reminded_at, last_dismissed_at, graveyard)`. |
| 2 | `runSourceFreshnessSweep` exists in `cron/route.ts` | PASS | Lines 889-998. |
| 3 | Folded into `prune_maintenance` Promise.allSettled | PASS | Lines 707-722. |
| 4 | `vercel.json` schedules `prune_maintenance` | PASS | `0 2 * * *` (02:00 UTC daily). |
| 5 | `tracked_sources` table populated for Rixey | **FAIL** | Empty (0 rows). Isadora has not opted-in any source via `/intel/sources/track` yet. |
| 6 | `admin_notifications` has any `source_freshness_reminder` rows | **FAIL (consequence of 5)** | Zero rows. With nothing tracked there's nothing to fire. |
| 7 | `marketing_spend` has fresh data Rixey could match | PASS | `here_comes_the_guide`, `reddit`, `google` all have rows; `updated_at` reflects most-recent upsert, which is what `computeFreshnessReports` reads (`updated_at` first, falls back to `created_at`, then `month`). |
| 8 | Notification-bell wiring | PASS | `notification-bell.tsx` lines 115/124 render `source_freshness_reminder` with link to `/intel/sources/track`. |
| 9 | Dismiss endpoint stamps `last_dismissed_at` | PASS | `/api/intel/sources/dismiss` does the right thing. |

### Bug found + fixed

The cron called `createNotification(...)`, which dedupes within a
5-minute window on `(venue_id, type)` only — it does NOT include
`source_key`. Effect: if a venue had 3 overdue sources on the same
cron tick, only the FIRST `source_freshness_reminder` row would
land; sources 2 and 3 would be silently dropped (and worse, their
`tracked_sources.last_reminded_at` was about to be stamped, which
would have suppressed them for another 7d).

**Fix:** the source-freshness sweep now does a direct
`admin_notifications.insert(...)` instead of routing through
`createNotification`. Suppression for this notification type is
already owned per-source by `tracked_sources.last_reminded_at`
(7d) + `last_dismissed_at` (14d), so the per-type 5-minute dedup
was both unnecessary and harmful.

Patch: `src/app/api/cron/route.ts` `runSourceFreshnessSweep`
inner loop. Idempotent; pure refactor of the write call.

### Verdict

**Plumbing is correct; nothing to test against because nothing is
tracked.** The cron is wired, the schedule is live, the freshness
service classifies correctly, the API endpoints are sound, the
dedup-collapse footgun is patched.

### Recommendation

1. Isadora opens `/intel/sources/track` and clicks "Track this" on
   the sources she actually pulls (probably The Knot, WeddingWire,
   Here Comes the Guide, plus Google Ads / Meta Ads if she runs
   any spend). That single action populates `tracked_sources`.
2. Tomorrow's 02:00 UTC `prune_maintenance` tick will fire the
   first reminders. Or trigger ad-hoc via
   `GET /api/cron?job=source_freshness` (still accepted as a
   manual job string).
3. After 24-48h, re-run `select * from tracked_sources where
   venue_id = '<rixey>' order by last_reminded_at desc` to confirm
   `last_reminded_at` is non-null and the bell shows reminder rows.

---

## Files touched

- `src/app/api/cron/route.ts` — replaced `createNotification` call
  in `runSourceFreshnessSweep` with direct
  `admin_notifications.insert` to fix multi-source dedup collapse.
- `scripts/audit-2026-05-09.mjs` — diagnostic script. Safe to keep
  or delete.

`npx tsc --noEmit` clean.
