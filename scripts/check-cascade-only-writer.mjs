#!/usr/bin/env node
/**
 * Guard: the cascade is the only creation path for spine + legacy
 * identity tables. R1 from CASCADE-CANONICAL-WRITER.md — a CREATION
 * boundary, not a commit boundary. This script blocks `.insert(...)` /
 * `.upsert(...)` on the guarded tables outside the cascade allowed-
 * writer surface. UPDATEs are NOT blocked (lifecycle / heat / metadata
 * routes keep their own functions).
 *
 * Companion to §1.6 of CONSOLIDATION-PLAN-PHASED.md, §P4 of
 * PHASE-1-BATCH-1.md, §7 Pbatch2-9 of PHASE-1-BATCH-2.md, and the
 * `src/lib/spine/cascade.ts` barrel.
 *
 * Guarded tables — split into two sets:
 *
 *   SPINE (the new identity-first model, post-doctrine 2026-05-14):
 *     - couples
 *     - touchpoints
 *     - fragments
 *     - couple_merge_events
 *
 *   LEGACY identity tables (still receive dual-writes; phasing out
 *   per CONSOLIDATION-PLAN-PHASED.md Phase 3):
 *     - weddings
 *     - people
 *     - interactions
 *     - attribution_events
 *     - wedding_touchpoints
 *     - candidate_identities
 *
 * Allowed-writer surface (NOT a violation): the explicit
 * CHOKEPOINT_FILES set below. Per Pbatch2-9 (2026-05-26 pressure-test
 * remediation v2), this guard was previously a directory-prefix
 * allowlist (`src/lib/services/identity/` + `src/lib/spine/`), which
 * blanket-exempted anything under `identity/` — including
 * `calendly-outcomes.ts`, which writes spine `touchpoints` direct
 * (Calendly C11/C12) and is a genuine cascade-chokepoint violation.
 * The restructure is from PREFIX-allowlist to FILE-allowlist: only the
 * explicit chokepoint files may write the guarded tables; any other
 * `identity/` file gets scanned just like a non-identity file and
 * either flagged or grandfathered with a one-line justification.
 *
 * Anything outside the chokepoint surface that does a direct
 * `.insert(...)` / `.upsert(...)` against a guarded table is either:
 *   (a) a NEW violation — the guard fails CI, the dev routes through
 *       the cascade barrel (`@/lib/spine/cascade`), OR
 *   (b) a known legacy site — listed in GRANDFATHERED with a one-line
 *       justification, scheduled to be migrated in a later phase.
 *
 * Also scans for `.rpc('lock_and_mint_couple', ...)` calls outside
 * the chokepoint surface — those bypass the TypeScript
 * `lockAndMintCouple` wrapper and would skip the audit /
 * couple_merge_events bookkeeping in the wrapper.
 *
 * Doesn't catch (honest gaps):
 *   - String-interpolated table names like `.from(tableName).insert(...)`.
 *     The cascade's writers all use string literals; if a dynamic-table
 *     bypass appears it needs a manual audit.
 *   - SQL template literals via supabase.rpc('sql', ...) or raw
 *     postgres clients — out of scope (no current callers).
 *   - Raw `INSERT INTO` SQL in `.sql` files under `supabase/migrations/` —
 *     out of scope (migrations are the schema authority, not application
 *     code). The guard does scan `src/` for stray `INSERT INTO` strings
 *     and flags them; in practice the only hits are docstrings.
 *   - Server actions that build a row object and pass it to a helper —
 *     if the helper itself does the insert from inside the allowed
 *     surface, that's fine; if the helper is outside and accepts a
 *     table name as a parameter, the guard misses it (see first gap).
 *
 * Usage:
 *
 *   node scripts/check-cascade-only-writer.mjs
 *
 * Exit 0 = clean. Exit 1 = new direct insert/upsert site detected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Guarded tables. INSERT/UPSERT to any of these outside the allowed
// surface is a chokepoint violation.
// ---------------------------------------------------------------------------
const SPINE_TABLES = [
  'couples',
  'touchpoints',
  'fragments',
  'couple_merge_events',
]
const LEGACY_IDENTITY_TABLES = [
  'weddings',
  'people',
  'interactions',
  'attribution_events',
  'wedding_touchpoints',
  'candidate_identities',
]
const GUARDED_TABLES = [...SPINE_TABLES, ...LEGACY_IDENTITY_TABLES]

// ---------------------------------------------------------------------------
// Chokepoint allowlist — EXPLICIT FILE LIST (post-Pbatch2-9 restructure).
//
// Files in this Set are permitted to call `.insert` / `.upsert` on the
// guarded tables directly. Everything else — including OTHER files
// under `src/lib/services/identity/` — gets scanned, and either
// surfaces as a NEW violation or matches a GRANDFATHERED entry below.
//
// Each entry's comment justifies WHY this file is a chokepoint (vs a
// helper that should route through one of the other chokepoints).
// New chokepoints require an architectural review — adding a file
// here expands the spine-write surface area; usually the right answer
// is "route through linkSignal".
// ---------------------------------------------------------------------------
const CHOKEPOINT_FILES = new Set([
  // The barrel itself. Re-exports the cascade primitives under one
  // import path (`@/lib/spine/cascade`). Doesn't insert directly but
  // its declarations belong in the surface for symmetry.
  'src/lib/spine/cascade.ts',

  // linkSignal orchestrator — whole-cascade entry (match → judge →
  // route-by-tier → mint/attach/candidate/fragment). Calls
  // insertTouchpoint inline at :241.
  'src/lib/services/identity/forwards-linker.ts',

  // Routes to mint/attach/fragment after the matcher decides tier.
  // Calls insertTouchpoint at :99 + :129 and insertFragment at :198.
  'src/lib/services/identity/route-by-tier.ts',

  // couples chokepoint via the `lock_and_mint_couple` RPC (advisory-
  // locked per migration 359). The ONLY sanctioned caller of that RPC.
  'src/lib/services/identity/mint-couple.ts',

  // people-table chokepoint. Carries the partner2 enrich-or-skip
  // invariant (Phase 1 §P2 + migration 367 unique index).
  'src/lib/services/identity/mint-person.ts',

  // legacy weddings-table chokepoint (adopted 2026-05-12).
  'src/lib/services/identity/mint-wedding.ts',

  // Owns the spine touchpoint + fragment INSERT helpers
  // (insertTouchpoint at :324, insertFragment at :356) which the
  // forwards-linker and route-by-tier chokepoints both call. ALSO
  // contains the Backwards Tracer batch-walk writers (couples /
  // touchpoints / fragments / couple_merge_events for fragment_promoted
  // audit at :805). Both responsibilities are doctrinally cascade-
  // internal — the Tracer is the historical-arrival counterpart to
  // linkSignal's live-arrival path.
  'src/lib/services/identity/tracer.ts',

  // Legacy `wedding_touchpoints` idempotent writer. Pre-336 race-safe
  // helper used by backtrack.ts. Doesn't write spine tables but lives
  // here so the Batch-1 P3 contract ("the chokepoint that owns
  // touchpoint writes for the legacy limb") is in the same surface.
  'src/lib/services/identity/touchpoints-writer.ts',

  // Phase A `couples` mirror — called from mintWedding's Branch A +
  // Branch B exits to keep couples in sync with weddings/people.
  // Doctrine: dual-write hook (IDENTITY-FIRST-ARCHITECTURE.md §8).
  'src/lib/services/identity/mirror-couple.ts',

  // Ghost-resurrection hook — called from route-by-tier post-attach
  // (:112 + :175). UPDATEs couples.lifecycle_state + INSERTs a
  // `couple_merge_events` audit row (resurrection / resurrection_rejected).
  // Cascade-internal lifecycle helper.
  'src/lib/services/identity/resurrection.ts',

  // Canonical people/weddings INSERT site — `createPerson` (:795) and
  // `createWedding` (:1127 + :1139 mig-fallback) are what mintPerson /
  // mintWedding delegate to. Both sibling guards
  // (check-no-direct-people-insert.mjs CANONICAL set +
  // check-no-direct-wedding-insert.mjs CANONICAL set) list this file
  // as canonical. Keep all three guards in sync.
  'src/lib/services/identity/resolver.ts',

  // merge-people canonical writer — INSERTs the merged-winner people
  // row during person-merge cascade (the canonical winner of a merge,
  // not a fresh identity). Listed in check-no-direct-people-insert
  // CANONICAL too.
  'src/lib/services/identity/merge-people.ts',

  // Profile→people projection — keeps the legacy people row in sync
  // with the forensic profile (the source of truth). 3 INSERT sites
  // (:210, :758, :885). Listed in check-no-direct-people-insert
  // CANONICAL too.
  'src/lib/services/identity/profile-to-people-sync.ts',

  // Stream KK cross-source reconciliation — clones a loser-wedding's
  // person onto the winner during merge cascade. Continuity-preserving,
  // not a fresh identity. Listed in check-no-direct-people-insert
  // CANONICAL too.
  'src/lib/services/identity/reconciliation.ts',

  // Idempotent attribution_events writer — the canonical writer that
  // every other path is supposed to route through (per
  // attribution-events-writer.ts header: "the application-level
  // cooperator" for migration 336 uniqueness). 2 INSERT sites
  // (:75 + :99 retry).
  'src/lib/services/identity/attribution-events-writer.ts',

  // candidate-to-wedding resolver (Phase B/PB.3). Writes one
  // `wedding_touchpoints` row per linked candidate signal at :631 as
  // part of the Tier-1 deterministic attach. Cascade-internal — the
  // candidate resolver is the legacy-side parallel of route-by-tier.
  'src/lib/services/identity/candidate-resolver.ts',

  // Pbatch2-1 + Pbatch2-10: Calendly→NormalizedSignal builder + the
  // narrow `tourCancellationFallback` writer (:329). Doctrinally
  // cascade-internal — owns the cancellation-only fallback path that
  // exists because linkSignal returns `fragment` for identity-poor
  // cancellations and D9 cohort funnel reads `tour_cancelled`
  // touchpoints not fragments. The header docstring explicitly
  // documents this as a chokepoint-scoped exception. If a SECOND
  // fallback shape appears, that one needs its own justification.
  'src/lib/services/identity/calendly-to-signal.ts',
])

// ---------------------------------------------------------------------------
// Grandfathered call sites. Each entry is a Map from file-path to a
// one-line justification. Listed sites are KNOWN bypasses that the
// project hasn't yet migrated to the cascade barrel — they emit an
// informational line at run time but do NOT fail CI. New violations
// against the guarded tables fail; the grandfather list is a checklist
// for Phases 3/4 to chip down.
//
// A grandfather entry covers ALL guarded-table inserts in that file.
// When the last bypass site in a file is migrated, remove the entry.
// ---------------------------------------------------------------------------
const GRANDFATHERED = new Map([
  // --- LEGACY weddings/people inserts (mirror the sibling guards) ---
  // Pre-2026-05-13 `people.insert` sites awaiting migration to
  // `mintPerson`. Identical reasoning to
  // `check-no-direct-people-insert.mjs`'s grandfather list — keep the
  // two lists in sync. `pipeline.ts` itself is NOT here for the
  // `people` table (the M2/M3/M4/M5 flips removed all four sites per
  // PHASE-1-BATCH-1.md §3.2-§3.3), but it IS still listed below for
  // `interactions` + `candidate_identities`.
  [
    'src/app/api/agent/reprocess-orphans/route.ts',
    'people.insert — pre-migration call site, planned for the mintPerson rollout (mirrors check-no-direct-people-insert grandfather).',
  ],
  [
    'src/app/api/portal/mint-wedding/route.ts',
    'people.insert from the portal mint-wedding route — pre-migration call site, planned for mintPerson rollout.',
  ],
  [
    'src/lib/services/brain-dump/imports.ts',
    'people.insert + interactions.insert in brain-dump offline batch importer — low-risk migration, scheduled first per check-no-direct-people-insert order-of-work.',
  ],
  [
    'src/lib/services/data-integrity/remediation/wedding-has-people.ts',
    'people.insert in the wedding-has-people backfill remediation script — runs offline; will route through mintPerson in the remediation-script sweep.',
  ],
  [
    'src/lib/services/crm-import/index.ts',
    'people.insert + interactions.insert on CSV ingestion (HoneyBook/Knot). Same migration pass as data-import.ts.',
  ],
  [
    'src/lib/services/data-import.ts',
    'people.insert (HoneyBook + Knot legacy CSV ingestion). Migrates alongside crm-import.',
  ],
  [
    'src/lib/services/brain/router.ts',
    'people.insert at brain/router.ts:351 — mints from in-thread evidence when the resolver missed. Migrates with pipeline.ts findOrCreateContact (per sibling-guard sequencing).',
  ],
  [
    'src/app/_couple-pages/addresses/page.tsx',
    "people.insert role='parent' from the couple-side parent-address form. Out of mintPerson's scope today (parent address records, not identity matching).",
  ],

  // --- pipeline.ts: clean for spine + people + weddings (the Phase 1
  // Batch 1 flips), but still has legitimate legacy writes for the
  // OTHER guarded tables that the cascade does NOT own today. ---
  [
    'src/lib/services/email/pipeline.ts',
    'interactions.insert (5 sites: inbound email body, outbound draft mirror, scheduling-event log) + candidate_identities.insert (sub-zero candidate at :2836). The cascade does not yet own interaction-row creation OR sub-zero candidate logging — both are Phase 3 limb-migration work per CONSOLIDATION-PLAN-PHASED.md §3.',
  ],

  // --- interactions: every channel ingester writes its own row. ---
  // The cascade owns identity/touchpoints but not interactions yet —
  // interactions is a Phase 3 limb. Each ingester is its own
  // chokepoint-by-channel today; collapse comes in Phase 3.
  [
    'src/app/api/webhooks/twilio/route.ts',
    'interactions.insert for inbound SMS. Twilio ingester owns the interaction row; Phase 3 limb-migration moves to a cascade interactions writer.',
  ],
  [
    'src/lib/services/ingestion/openphone.ts',
    'interactions.insert for OpenPhone call/SMS ingestion. Same channel-ingester pattern as Twilio.',
  ],
  [
    'src/lib/services/ingestion/zoom.ts',
    'interactions.insert for Zoom meeting transcript ingestion. Same channel-ingester pattern.',
  ],
  [
    'src/app/api/agent/reply/route.ts',
    'interactions.insert for the outbound agent reply (operator-authored reply mirror).',
  ],
  [
    'src/app/api/agent/send/route.ts',
    'interactions.insert for the outbound agent send (Sage-authored outbound mirror).',
  ],
  [
    'src/app/api/agent/messages/reply/route.ts',
    'interactions.insert for the operator-side message reply path.',
  ],
  [
    'src/app/api/couple/messages/route.ts',
    'interactions.insert for the couple-portal-side message send. Couple-authored interaction row.',
  ],

  // --- attribution_events: two non-canonical writers besides the
  // canonical attribution-events-writer.ts. ---
  [
    'src/lib/services/discovery-source/capture.ts',
    'attribution_events.insert for the discovery-self-report capture path (the operator-asked "how did you find us" answer). Bypasses the canonical writer because it is a single low-volume insert with no race window; will route through attribution-events-writer.ts in the cascade-collapse pass. Also closed by Pbatch2-6 (linkSignal({action_type:"discovery_self_report"})).',
  ],
  [
    'src/lib/services/intel/referrals/resolve.ts',
    'attribution_events.insert at intel/referrals/resolve.ts — referral self-report resolution. Same low-volume path as discovery-source/capture.ts; same migration pass. Folded into Pbatch2-6 scope as parallel linkSignal({action_type:"referral_self_report"}).',
  ],

  // --- wedding_touchpoints: writers outside the canonical
  // touchpoints-writer.ts (which IS a chokepoint). ---
  [
    'src/lib/services/attribution/touchpoints.ts',
    'wedding_touchpoints.insert for status-change touchpoints (e.g. Calendly final_walkthrough auto-promote to booked needs a contract_signed touchpoint to close the funnel). Lives outside identity/ because it is funnel-completion, not identity-cascade.',
  ],

  // --- candidate_identities: candidate-clusterer is the upstream
  // candidate-cluster writer (pre-identity-resolution stage). Now
  // surfaced by the Pbatch2-9 restructure (was silently exempted by
  // the old directory-prefix allowlist). ---
  [
    'src/lib/services/identity/candidate-clusterer.ts',
    "candidate_identities.insert/upsert in the candidate-clusterer (upstream of mintPerson). Lives under src/lib/services/identity/ but is NOT a chokepoint file — it writes the pre-resolution candidate-cluster table, not a spine table. Newly visible after Pbatch2-9 restructure; same migration class as data-import.ts (legacy ingestion writer chip-down in Phase 3).",
  ],

  // --- spine: legitimate writers outside the chokepoint surface ---
  // Each entry below covers a SPINE table (couples / touchpoints /
  // fragments / couple_merge_events) write outside the chokepoint
  // surface. These are the highest-priority chip-down list — Phase 1
  // §P3b explicitly routed `tracer.ts:730` through `lockAndMintCouple`
  // (now done). The non-tracer sites are operator-driven admin
  // endpoints where the cascade chokepoint would actively work against
  // the intent (e.g. manual unmerge needs to CREATE a couple split off
  // an existing one; a couple-mint that re-attaches via the resolver
  // is the wrong shape).
  [
    'src/app/api/admin/identity/unmerge/route.ts',
    "Operator-driven manual unmerge: inserts a fresh `couples` row, attached `fragments`, and a `couple_merge_events` audit row. The cascade chokepoint would resolve to the existing couple via the matcher; the unmerge intent is to FORCE a split. Legitimate bypass — but the cascade contract should grow an explicit `splitCouple` primitive (Phase 4 follow-up).",
  ],
  [
    'src/app/api/admin/intel/lifecycle-audit/apply/route.ts',
    'couple_merge_events.insert as a manual-merge audit row from the lifecycle-audit operator UI. Audit-only write; no couple creation. The cascade audit chokepoint should grow a `recordLifecycleEvent` primitive (Phase 4 follow-up).',
  ],
  [
    'src/app/api/admin/intel/lifecycle-audit/bulk-apply/route.ts',
    'couple_merge_events.insert (bulk) — same operator audit shape as the per-row apply endpoint.',
  ],
  [
    'src/app/api/admin/identity/resolve/route.ts',
    'couple_merge_events.insert for candidate_confirmed / candidate_rejected operator decisions. Audit-only write.',
  ],

  // --- spine: NEW grandfather entries surfaced by Pbatch2-9
  // restructure. These files were silently exempted by the old
  // directory-prefix allowlist for `src/lib/services/identity/` and
  // are now scanned. Each gets either a legitimate-helper
  // justification OR an explicit "will be closed by Batch 2" note. ---
  // calendly-outcomes.ts grandfather REMOVED 2026-05-26 — Pbatch2
  // phase B steps 3+4 (C11 + C12 flips) routed both direct upsert
  // sites through linkSignal / linkSignalBatch, with the Pbatch2-10
  // cancellation-fallback (in calendly-to-signal.ts) covering the
  // identity-poor path. The file is now scan-clean.
  [
    'src/lib/services/identity/tracer-rebind.ts',
    'touchpoints.upsert in the one-shot mirror-backfilled-couples rebind sweep (admin endpoint /api/admin/identity/tracer-rebind). Not a live-path writer; not a chokepoint. Doctrinally cascade-internal — same Tracer family as tracer.ts. Could be promoted to CHOKEPOINT_FILES if a second admin sweep needs the same write pattern; for now grandfathered as a narrow operator-driven helper. Newly visible after Pbatch2-9 restructure.',
  ],
])

// ---------------------------------------------------------------------------
// Patterns. Multi-line regexes — `.from('<TABLE>')` can sit on its own
// line with `.insert(` / `.upsert(` on the next.
// ---------------------------------------------------------------------------
const insertUpsertPattern = (table) =>
  new RegExp(
    `\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)\\s*\\n?\\s*\\.\\s*(insert|upsert)\\s*\\(`,
    'g',
  )

// Raw SQL fallback — INSERT INTO <table>.
const sqlInsertPattern = (table) =>
  new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'gi')

// Direct RPC call to the cascade lock-and-mint RPC (bypasses the TS
// `lockAndMintCouple` wrapper which is the only sanctioned caller).
const rpcMintCouplePattern = /\.rpc\(\s*['"`]lock_and_mint_couple['"`]/g

const OFFENDERS = []
const GRANDFATHER_HITS = []

function isAllowed(rel) {
  return CHOKEPOINT_FILES.has(rel)
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      if (entry === '__tests__') continue
      walk(full)
    } else if (st.isFile()) {
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue
      scan(full)
    }
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function record(rel, line, table, op) {
  if (GRANDFATHERED.has(rel)) {
    GRANDFATHER_HITS.push({ file: rel, line, table, op })
  } else {
    OFFENDERS.push({ file: rel, line, table, op })
  }
}

function scan(file) {
  const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
  if (isAllowed(rel)) return
  const text = readFileSync(file, 'utf8')

  for (const table of GUARDED_TABLES) {
    const reSupabase = insertUpsertPattern(table)
    let m
    while ((m = reSupabase.exec(text)) !== null) {
      const op = m[1] // 'insert' | 'upsert'
      record(rel, lineOf(text, m.index), table, op)
    }
    const reSql = sqlInsertPattern(table)
    while ((m = reSql.exec(text)) !== null) {
      // Skip lines inside JS line comments / strings is hard via regex.
      // Crude guard: if the match line starts with `*` or `//`, skip —
      // it's almost certainly a docstring reference. The sibling guards
      // accept the same false-negative cost.
      const line = lineOf(text, m.index)
      const lineText = text.split('\n')[line - 1] ?? ''
      const trimmed = lineText.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
      record(rel, line, table, 'INSERT INTO')
    }
  }

  // RPC bypass: any `.rpc('lock_and_mint_couple', ...)` outside the
  // chokepoint surface. Only `src/lib/services/identity/mint-couple.ts`
  // should hit this — and that's in the chokepoint surface so it
  // returns early before this loop runs.
  let m
  while ((m = rpcMintCouplePattern.exec(text)) !== null) {
    record(rel, lineOf(text, m.index), 'lock_and_mint_couple', 'rpc')
  }
}

walk(SRC_DIR)

// Emit grandfather acknowledgments (one line per file, not per hit, to
// keep the log readable).
const grandfatherFiles = new Map()
for (const h of GRANDFATHER_HITS) {
  if (!grandfatherFiles.has(h.file)) grandfatherFiles.set(h.file, [])
  grandfatherFiles.get(h.file).push(h)
}
for (const [file, hits] of grandfatherFiles) {
  const tables = [...new Set(hits.map((h) => `${h.table}.${h.op}`))].join(', ')
  // eslint-disable-next-line no-console
  console.log(`grandfathered: ${file} — ${tables} — ${GRANDFATHERED.get(file)}`)
}

if (OFFENDERS.length === 0) {
  // eslint-disable-next-line no-console
  console.log(`\nOK — no new direct insert/upsert sites detected on guarded tables: ${GUARDED_TABLES.join(', ')}.`)
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\nFAIL — direct insert/upsert/RPC sites detected on guarded cascade tables:\n')
for (const o of OFFENDERS) {
  // eslint-disable-next-line no-console
  console.error(`  ${o.file}:${o.line}: ${o.table} ${o.op} outside chokepoint`)
}
// eslint-disable-next-line no-console
console.error(
  '\nRoute through the cascade barrel at `@/lib/spine/cascade` (linkSignal /'
    + ' lockAndMintCouple / mintPerson / mintWedding).',
)
// eslint-disable-next-line no-console
console.error(
  'If this is a legitimate non-cascade writer (operator-driven admin shape,'
    + ' status-change touchpoint, etc.), add it to GRANDFATHERED in this script'
    + ' with a one-line justification.',
)
// eslint-disable-next-line no-console
console.error('See CASCADE-CANONICAL-WRITER.md + CONSOLIDATION-PLAN-PHASED.md §1.6.\n')
process.exit(1)
