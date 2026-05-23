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
 * PHASE-1-BATCH-1.md, and the `src/lib/spine/cascade.ts` barrel.
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
 * Allowed-writer surface (NOT a violation):
 *   - Files under `src/lib/services/identity/` (the cascade module —
 *     the chokepoints + their internal helpers live here).
 *   - `src/lib/spine/cascade.ts` (the barrel re-exporting chokepoints).
 *   - The cascade-RPC caller `src/lib/services/identity/mint-couple.ts`
 *     is in that directory, so it's covered.
 *
 * Anything outside that surface that does a direct `.insert(...)` /
 * `.upsert(...)` against a guarded table is either:
 *   (a) a NEW violation — the guard fails CI, the dev routes through
 *       the cascade barrel (`@/lib/spine/cascade`), OR
 *   (b) a known legacy site — listed in GRANDFATHERED with a one-line
 *       justification, scheduled to be migrated in a later phase.
 *
 * Also scans for `.rpc('lock_and_mint_couple', ...)` calls outside
 * `src/lib/services/identity/` — those bypass the TypeScript
 * `lockAndMintCouple` wrapper and would skip the audit /
 * couple_merge_events bookkeeping in the wrapper.
 *
 * Doesn't catch (honest gaps):
 *   - String-interpolated table names like `.from(tableName).insert(...)`.
 *     The cascade's writers all use string literals; if a dynamic-table
 *     bypass appears it needs a manual audit.
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
// Allowed-writer surface. Files matching any of these path prefixes are
// permitted to call `.insert` / `.upsert` on guarded tables directly:
// they ARE the cascade module or its barrel.
// ---------------------------------------------------------------------------
const ALLOWED_PATH_PREFIXES = [
  'src/lib/services/identity/',
  'src/lib/spine/',
]

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
    'attribution_events.insert for the discovery-self-report capture path (the operator-asked "how did you find us" answer). Bypasses the canonical writer because it is a single low-volume insert with no race window; will route through attribution-events-writer.ts in the cascade-collapse pass.',
  ],
  [
    'src/lib/services/intel/referrals/resolve.ts',
    'attribution_events.insert at intel/referrals/resolve.ts — referral self-report resolution. Same low-volume path as discovery-source/capture.ts; same migration pass.',
  ],

  // --- wedding_touchpoints: two non-canonical writers besides the
  // canonical touchpoints-writer.ts (which lives in identity/, so it's
  // already in the allowed surface). ---
  [
    'src/lib/services/attribution/touchpoints.ts',
    'wedding_touchpoints.insert for status-change touchpoints (e.g. Calendly final_walkthrough auto-promote to booked needs a contract_signed touchpoint to close the funnel). Lives outside identity/ because it is funnel-completion, not identity-cascade.',
  ],

  // --- candidate_identities: candidate-clusterer is the upstream
  // candidate-cluster writer (pre-identity-resolution stage). ---
  [
    'src/lib/services/identity/candidate-clusterer.ts',
    "candidate_identities.insert/upsert in the candidate-clusterer (upstream of mintPerson). IS under src/lib/services/identity/ so already allowed — listed here only for the audit trail.",
  ],

  // --- spine: legitimate writers outside the cascade barrel today ---
  // Each entry below covers a SPINE table (couples / touchpoints /
  // fragments / couple_merge_events) write outside identity/. These
  // are the highest-priority chip-down list — Phase 1 §P3b explicitly
  // routes `tracer.ts:730` through `lockAndMintCouple`. The non-
  // tracer sites are operator-driven admin endpoints where the
  // cascade chokepoint would actively work against the intent (e.g.
  // manual unmerge needs to CREATE a couple split off an existing
  // one; a couple-mint that re-attaches via the resolver is the
  // wrong shape).
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
  return ALLOWED_PATH_PREFIXES.some((p) => rel.startsWith(p))
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

  // RPC bypass: any `.rpc('lock_and_mint_couple', ...)` outside
  // identity/. Only `src/lib/services/identity/mint-couple.ts` should
  // hit this — and that's in the allowed surface so it returns early
  // before this loop runs.
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
