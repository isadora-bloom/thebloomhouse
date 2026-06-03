# Hardening Scope — Swallowed Writes & Prod-Write Script Gating

Scoped 2026-06-03. Two hardening areas surfaced while fixing the integration-tests-write-to-prod class (commits `b30f2a1`, `8dfcf68`). Both are instances of *"a write that can silently go wrong."* This document scopes them — it is **not** a blanket fix list; each area needs per-site judgment, and the tiers below say where.

Anchor doctrine: a writing operation must either (a) handle its error, or (b) document why it's safe to ignore (idempotent dedup). A test/script that writes must refuse the prod ref unless explicitly authorized.

---

## Area 1 — Swallowed writes in `src/`

### Measured surface
- **526** `.insert(` / `.upsert(` call sites in `src/`.
- **~123** are statement-level awaited writes with **no `{ error }` capture** (`await x.from(t).insert(y)` with the result discarded). supabase-js returns `{ error }` rather than throwing, so these fail **silently**.
- **0** are marked `void` — so the fire-and-forget ones aren't flagged as intentional; they look identical to oversights.

### Key finding — the spine is already safe
The identity-spine writes go through dedicated, error-checked writer modules that are the **correct** pattern and are NOT in the swallowed set:
- `identity/touchpoints-writer.ts`, `identity/attribution-events-writer.ts` — explicit `23505` handling, return `inserted=false`.
- `identity/progression.ts`, `identity/route-by-tier.ts`, `identity/mirror-couple.ts`, `identity/calendly-to-signal.ts` — `onConflict` / `ignoreDuplicates` / `23505`-as-success by design.

The swallowed writes are **direct `.from(t).insert()` calls in API routes + ancillary services that bypass these helpers**, e.g.:
- `app/api/webhooks/calendly/route.ts:365` → `tours` insert (a webhook silently dropping a tour = lost booking signal)
- `app/api/agent/reply/route.ts:123` → `interactions` insert
- `app/api/portal/mint-wedding/route.ts:175` + `app/api/agent/reprocess-orphans/route.ts:261` + `brain-dump/imports.ts:212` → `people` insert
- `lib/services/brain/sage.ts:138` → `engagement_events` insert

### Triage of the ~123 by target (top tables)
- **Tier 1 — silent data loss in core data** (~40 sites): `people`(8), `engagement_events`(8), `couple_merge_events`(7), `tours`(5), `interactions`(3), `tangential_signals`(4), `wedding_touchpoints`(3), `wedding_lifecycle_events`(4). A swallowed error here loses identity/heat/funnel data.
- **Tier 2 — feature data** (~40 sites): `knowledge_base`(7), `voice_preferences`(3), `reviews`(3), `draft_feedback`(12), `checklist_items`(3), `ceremony_order`(3), `pricing_history`(3), `lost_deals`(3), `client_match_queue`(3), …
- **Tier 3 — telemetry / logs / notifications** (~40 sites): `admin_notifications`(13), `api_costs`(3), `twilio_webhook_log`(3), `tracer_run_events`(3), `sage_conversations`(3). Losing one row is acceptable; at most log on error.

### The load-bearing nuance (why this is NOT a blanket change)
Some swallowed inserts **intentionally** ignore a `23505` unique-violation because the write is idempotent (re-processing the same signal). Blindly adding `if (error) throw` would break those. Each Tier-1 site must be classified: *oversight* (capture + log/raise) vs *idempotent* (document + ignore `23505` only). The spine writers are the reference for how idempotent writes should look.

### Proposed treatment
1. Add a tiny shared helper, e.g. `lib/db/writeOrLog(query, ctx)` — awaits the write, on error emits a structured `logEvent({level:'error', event_type:'db.write_failed', …})`; an option `{ throwOn: ['*'], ignore: ['23505'] }` lets Tier-1 callers raise while idempotent callers ignore only the dup. (Reuses the existing observability logger.)
2. Migrate call sites **tier by tier** (Tier 1 → 2 → 3), classifying idempotent-vs-oversight per site.
3. Add a CI ratchet: `scripts/check-swallowed-writes.mjs` counts `^\s*await .*\.(insert|upsert)\(` in `src/`, baselined at the current number, **may only fall** (prevents new swallowed writes). Same shape as the existing cleanup-budget/no-mirror-source ratchets.

### Effort / risk
- Tier 1: ~1 session. Tier 2: ~1 session. Tier 3 (helper + bulk): ~1 session. Ratchet + helper: ~0.5 session.
- Risk: **low** if done per-tier with the idempotent classification; the only behavioral change is Tier-1 raising on genuine failures (intended). tsc + the ratchet verify; no DB needed for the helper/ratchet.

### Checklist
- [ ] Build `lib/db/writeOrLog` helper + unit test (mock client).
- [ ] Build + baseline `scripts/check-swallowed-writes.mjs` ratchet; wire to CI (informational first).
- [ ] Tier 1 migration (core-data writes in routes/services) — classify idempotent vs oversight per site.
- [ ] Tier 2 migration (feature data).
- [ ] Tier 3 migration (telemetry — log-only).
- [ ] Flip the ratchet to enforcing once Tier 1 is clean.

---

## Area 2 — Prod-write script gating in `scripts/`

### Measured surface
- **88** non-test scripts create a client **and** mutate (insert/update/delete/upsert/rpc).
- **27** have no clear safety gate (no `--apply`/`--allow-prod`/dry-run/prod-refuse). The 27 span very different risk, so this is tiered.

### Tiers
- **Tier A — destructive, ungated, casually runnable (HIGH, ~5–6):**
  - `selfreview-data-cleanup.ts` — **DELETEs** `storefront` / `borrow_catalog` / `borrow_selections` / `venue_resources` (no gate).
  - `cleanup-pending-drafts.mjs`, `cleanup-wave19-test.mjs` — delete/update.
  - `repair-low-quality-syncs.mjs`, `run-non-couple-tombstone.mjs` — bulk updates.
  - Treatment: default to **dry-run**; require `--apply` to write and refuse the prod ref unless `--allow-prod`. ~1 session.
- **Tier B — migration appliers (`apply-wave13..24.mjs` ×~10, `apply-pending-migrations.ts`):** intentional prod writes, run deliberately by the operator. Most `apply-wave*` are **one-shot historical** (those migrations are long applied) → the better move is **archive/delete** them, not gate them. ~0.5 session of triage.
- **Tier C — `check-*` / `diag-*` / `smoke-*` / `seed-golden-venue` (~10):** mostly read/verify; the mutate match is often incidental. `seed-golden-venue.ts` should **refuse prod** (same as the tests — it upserts a test venue). Verify the rest, action only the real writers. ~0.5 session.

### Proposed treatment
1. Add a shared `scripts/_safety.ts` exporting `assertNotProd(url, { allowFlag: '--allow-prod' })` + `requireApply(argv)` — so the guard isn't copy-pasted (it currently is, across `branch-sql.mjs` + the 7 test fixes). 
2. Tier A: wire dry-run-by-default + `assertNotProd`. Tier C: `assertNotProd` on `seed-golden-venue`. Tier B: archive the spent one-shot appliers; gate `apply-pending-migrations` with an echo-confirm.

### Effort / risk
- Tier A ~1 session; Tiers B+C ~1 session (mostly classification + a couple guards). Risk: low (additive guards; default-dry-run is strictly safer).

### Checklist
- [ ] `scripts/_safety.ts` shared guard (`assertNotProd` + `requireApply`); refactor `branch-sql.mjs` + the 7 guarded tests onto it.
- [ ] Tier A: dry-run-by-default + `--apply` + `assertNotProd` on the 5–6 destructive scripts.
- [ ] Tier C: `assertNotProd` on `seed-golden-venue`; verify the `check-*`/`diag-*` mutate matches are incidental.
- [ ] Tier B: archive spent `apply-wave*` one-shots; confirm-gate `apply-pending-migrations`.

---

## Recommended sequencing
1. **Area 2 Tier A first** (highest blast radius: ungated destructive deletes that touch prod) — ~1 session.
2. **Area 1 Tier 1** (core-data silent loss) + the ratchet — ~1.5 sessions.
3. Remaining Area 1 tiers + Area 2 B/C — ~2 sessions.

Total ≈ 4–5 focused sessions. Each step is tsc-/ratchet-verifiable; only Area 1 needs the idempotent-vs-oversight judgment per Tier-1 site (the one place this can't be mechanical).
