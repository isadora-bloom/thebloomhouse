/**
 * scripts/shadow-compare.ts
 * =========================
 * Phase 0.1b of CONSOLIDATION-PLAN-PHASED.md — the shadow-compare harness.
 *
 * WHAT THIS IS
 * ------------
 * Phase 1's per-writer safety net (plan §1.3). For one writer it runs the
 * OLD legacy write path and the NEW cascade write path against the SAME
 * NormalizedSignal, then diffs:
 *
 *   - which couple the signal bound to        (couple_id binding)
 *   - the touchpoint-count delta on that couple
 *   - a field-level diff of the couple + touchpoint rows
 *
 * and logs every divergence as a structured JSON line plus a readable
 * summary. Phase 1 flips a writer to cascade-only once divergence is zero
 * across a representative sample (plan §1.3, §1 gate).
 *
 * This is INFRASTRUCTURE. It does not migrate anything. It exposes a
 * reusable `shadowCompare(...)` for Phase 1 to call per-writer, plus a
 * CLI for ad-hoc single-signal runs.
 *
 * ============================================================================
 *  ⚠️  DATA SAFETY — READ THIS. THIS SCRIPT WRITES TO THE DATABASE.  ⚠️
 * ============================================================================
 * Both the old path and the cascade path WRITE. There is no clean
 * non-destructive mode, and here is the honest reason why:
 *
 *   - The cascade mint goes through the `lock_and_mint_couple` Postgres
 *     RPC (migration 359). supabase-js issues every call — RPC included —
 *     as its own autocommitted transaction. A TypeScript-side
 *     BEGIN/ROLLBACK cannot wrap an RPC call; the RPC has already
 *     committed by the time control returns. So option (a) "wrap in a
 *     transaction that rolls back" is NOT feasible from this client
 *     without a server-side test-harness RPC that does not exist.
 *
 *   - Therefore this harness uses option (b)/(c): SNAPSHOT-AND-RESTORE.
 *     Before a comparison run it snapshots every couple / touchpoint /
 *     fragment / wedding / interaction / people / candidate_match /
 *     tracer_run_events row that BELONGS TO THE COMPARISON VENUE, runs
 *     both paths, captures the diff, then DELETE-and-reinserts the
 *     snapshot to undo every write. Snapshot/restore is venue-scoped.
 *
 *   - Snapshot/restore is a best-effort undo, NOT a transaction. If the
 *     process is killed mid-run, or another writer touches the venue
 *     during the run, the restore is imperfect. For that reason:
 *
 *        >>> RUN THIS ONLY AGAINST A DISPOSABLE SUPABASE BRANCH. <<<
 *        >>> NEVER AGAINST THE PRODUCTION PROJECT.               <<<
 *
 *     The persistent consolidation Supabase branch (MEMORY:
 *     bloom-tier8-snapshot, proj ref jvtnfnkgwvvfwixqivwv) is the
 *     intended target. Point .env.local at the branch, not at
 *     jsxxgwprxuqgcauzlxcb (production).
 *
 *   - As a hard gate, the harness REFUSES to run without the explicit
 *     `--i-understand-this-writes` flag (CLI) or `iUnderstandThisWrites:
 *     true` (programmatic). There is no way to run it by accident.
 *
 * RUN
 * ---
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/shadow-compare.ts \
 *     --venue=<uuid> \
 *     --writer=<writer-name> \
 *     --signal=<path-to-signal.json> \
 *     --i-understand-this-writes
 *
 *   # or an inline canned signal for a smoke run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/shadow-compare.ts --venue=<uuid> --writer=cascade-only-selftest \
 *     --canned --i-understand-this-writes
 *
 * Programmatic (what Phase 1 calls):
 *   import { shadowCompare } from '../scripts/shadow-compare'
 *   const report = await shadowCompare({
 *     supabase, venueId, writerName: 'pipeline.processIncomingEmail',
 *     signal, oldPath: async (sb, vid, sig) => { ...run legacy writer... },
 *     iUnderstandThisWrites: true,
 *   })
 *
 * HONEST GAP — THE OLD PATH IS A CALLER-SUPPLIED HOOK
 * ---------------------------------------------------
 * The cascade (new) path is self-contained: `linkSignal` takes a
 * NormalizedSignal and nothing else. The legacy writers are NOT — e.g.
 * `processIncomingEmail` in `src/lib/services/email/pipeline.ts` takes a
 * full parsed Gmail message, a Gmail client, venue config, etc., not a
 * NormalizedSignal. There is no standalone "run the old writer from a
 * signal" entry point, and inventing one per writer is exactly Phase 1's
 * Batch-1 work — not Phase 0's.
 *
 * So this harness does NOT try to invoke legacy writers itself. It takes
 * the old path as an `oldPath` callback. Phase 1, when it migrates a
 * writer, supplies a thin adapter that drives that specific legacy writer
 * and returns an `OldPathOutcome` (which couple/wedding it bound, the
 * touchpoint/interaction id). The harness owns snapshot/restore, the
 * cascade side, and the diff; Phase 1 owns the per-writer old-path glue.
 * `--canned` / `cascade-only-selftest` runs the cascade against itself so
 * the harness can be exercised before any old-path adapter exists.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

import { linkSignal } from '../src/lib/services/identity/forwards-linker'
import type { NormalizedSignal } from '../src/lib/services/identity/sources/types'

// ===========================================================================
// Types
// ===========================================================================

/**
 * The outcome an old-path adapter must report. Phase 1's per-writer glue
 * runs the legacy writer however it needs to, then fills this in so the
 * harness can diff it against the cascade result.
 *
 * `coupleId` is the cascade-spine couple the legacy write should have
 * resolved to. A legacy writer that only knows weddings supplies
 * `legacyWeddingId`; the harness resolves it to a couple via
 * `couples.source_wedding_id` for the binding comparison.
 */
export interface OldPathOutcome {
  /** Spine couple id the legacy write bound to, if the writer knows it. */
  coupleId?: string | null
  /** Legacy weddings.id the writer bound to. Resolved couple-side by the
   *  harness when `coupleId` is not directly known. */
  legacyWeddingId?: string | null
  /** Legacy touchpoint / interaction id, for reference in the report. */
  legacyTouchpointId?: string | null
  /** Free-form notes the adapter wants surfaced in the divergence log. */
  notes?: string
}

export type OldPathRunner = (
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
) => Promise<OldPathOutcome>

export interface ShadowCompareArgs {
  supabase: SupabaseClient
  /** Multi-venue-safe: every run is scoped to one venue. */
  venueId: string
  /** Stable label for the writer under test (e.g. 'calendly.webhook'). */
  writerName: string
  /** The signal both paths receive. */
  signal: NormalizedSignal
  /**
   * The legacy writer adapter. Omit (or pass undefined) to run a
   * cascade-vs-cascade self-test — useful to exercise the harness before
   * an old-path adapter exists. When omitted the report's `oldPath`
   * fields mirror the cascade result and `divergence` is trivially empty.
   */
  oldPath?: OldPathRunner
  /** Hard safety gate. Must be true or the harness throws before any write. */
  iUnderstandThisWrites: boolean
  /**
   * Skip snapshot/restore. ONLY for a venue that is already disposable
   * scratch data you intend to keep. Default false — snapshot/restore on.
   */
  noRestore?: boolean
}

/** One field-level difference between the old and new rows. */
export interface FieldDiff {
  field: string
  oldValue: unknown
  newValue: unknown
}

export interface ShadowCompareReport {
  ts: string
  writer: string
  venueId: string
  signal: {
    channel: string
    action_type: string
    external_id: string
    identity_hint: string | null
  }
  oldPath: {
    coupleId: string | null
    touchpointCount: number
    notes: string | null
  }
  newPath: {
    coupleId: string | null
    touchpointCount: number
    action: string
    touchpointId: string | null
  }
  /** Did the two paths bind to the SAME couple? The headline check. */
  coupleBindingMatches: boolean
  /** newPath.touchpointCount - oldPath.touchpointCount on the bound couple. */
  touchpointCountDelta: number
  /** Field-level diff of the couple row the two paths bound to. */
  coupleFieldDiff: FieldDiff[]
  /** Field-level diff of the touchpoint rows (best-effort pairing). */
  touchpointFieldDiff: FieldDiff[]
  /** True when EVERY check above is clean — Phase 1's flip condition. */
  divergent: boolean
  /** Human-readable one-line-per-issue list. Empty when not divergent. */
  divergenceReasons: string[]
  /** Did snapshot/restore complete cleanly? */
  restored: boolean
}

// ===========================================================================
// Snapshot / restore — venue-scoped best-effort undo
// ===========================================================================

/**
 * Tables both write paths touch, in dependency order for restore.
 * Children before parents on delete; parents before children on insert.
 * Venue-scoped: every one of these carries a `venue_id` column.
 */
const SNAPSHOT_TABLES = [
  // legacy pipeline
  'interactions',
  'people',
  'weddings',
  // cascade spine + adjacent
  'touchpoints',
  'fragments',
  'candidate_matches',
  'couple_progression_events',
  'couple_merge_events',
  'couples',
  'tracer_run_events',
] as const

type SnapshotTable = (typeof SNAPSHOT_TABLES)[number]

/**
 * couple_progression_events is keyed by couple_id, not venue_id (see
 * migration 346). It is snapshotted via a couple-id IN-list instead.
 */
const COUPLE_KEYED_TABLES = new Set<SnapshotTable>(['couple_progression_events'])

interface VenueSnapshot {
  venueId: string
  takenAt: string
  rows: Record<SnapshotTable, Array<Record<string, unknown>>>
}

async function takeSnapshot(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueSnapshot> {
  const rows = {} as Record<SnapshotTable, Array<Record<string, unknown>>>

  // Resolve the venue's couple ids first — needed for the couple-keyed tables.
  const { data: coupleRows } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
  const coupleIds = (coupleRows ?? []).map((c) => (c as { id: string }).id)

  for (const table of SNAPSHOT_TABLES) {
    let query = supabase.from(table).select('*')
    if (COUPLE_KEYED_TABLES.has(table)) {
      // couple-keyed: scope by the venue's couples. Empty list → no rows.
      query = coupleIds.length
        ? query.in('couple_id', coupleIds)
        : query.eq('couple_id', '00000000-0000-0000-0000-000000000000')
    } else {
      query = query.eq('venue_id', venueId)
    }
    const { data, error } = await query
    if (error) {
      throw new Error(`snapshot failed for ${table}: ${error.message}`)
    }
    rows[table] = (data ?? []) as Array<Record<string, unknown>>
  }

  return { venueId, takenAt: new Date().toISOString(), rows }
}

/**
 * Restore the venue to the snapshot: delete every current row in the
 * snapshot tables for the venue, then reinsert the snapshot rows.
 * Best-effort — logs but does not throw on a per-table failure so a
 * partial restore still attempts the remaining tables.
 */
async function restoreSnapshot(
  supabase: SupabaseClient,
  snap: VenueSnapshot,
): Promise<boolean> {
  let clean = true

  // Recompute the venue's current couple ids so couple-keyed deletes
  // catch couples minted DURING the run (which the snapshot did not have).
  const { data: nowCoupleRows } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', snap.venueId)
  const nowCoupleIds = (nowCoupleRows ?? []).map((c) => (c as { id: string }).id)

  // DELETE — children first (reverse dependency order).
  for (const table of [...SNAPSHOT_TABLES].reverse()) {
    let del = supabase.from(table).delete()
    if (COUPLE_KEYED_TABLES.has(table)) {
      del = nowCoupleIds.length
        ? del.in('couple_id', nowCoupleIds)
        : del.eq('couple_id', '00000000-0000-0000-0000-000000000000')
    } else {
      del = del.eq('venue_id', snap.venueId)
    }
    const { error } = await del
    if (error) {
      clean = false
      console.error(`  [restore] delete ${table} failed: ${error.message}`)
    }
  }

  // INSERT — parents first (forward dependency order).
  for (const table of SNAPSHOT_TABLES) {
    const rows = snap.rows[table]
    if (!rows.length) continue
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      const { error } = await supabase.from(table).insert(chunk)
      if (error) {
        clean = false
        console.error(
          `  [restore] insert ${table} chunk@${i} failed: ${error.message}`,
        )
      }
    }
  }

  return clean
}

// ===========================================================================
// Couple / touchpoint introspection
// ===========================================================================

/** Couple row columns compared field-by-field. created_at/updated_at and
 *  ids are excluded — they legitimately differ between runs. */
const COUPLE_DIFF_FIELDS = [
  'primary_contact_name',
  'primary_contact_email',
  'primary_contact_phone',
  'partner_contact_name',
  'partner_contact_email',
  'partner_contact_phone',
  'wedding_date',
  'lifecycle_state',
  'channel_scope',
  'source_wedding_id',
] as const

/** Touchpoint columns compared field-by-field. */
const TOUCHPOINT_DIFF_FIELDS = [
  'channel',
  'signal_tier',
  'action_type',
  'external_id',
  'occurred_at',
  'confidence_tier',
] as const

async function fetchCouple(
  supabase: SupabaseClient,
  coupleId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!coupleId) return null
  const { data } = await supabase
    .from('couples')
    .select('*')
    .eq('id', coupleId)
    .maybeSingle()
  return (data as Record<string, unknown> | null) ?? null
}

async function countTouchpoints(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string | null,
): Promise<number> {
  if (!coupleId) return 0
  const { count } = await supabase
    .from('touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('couple_id', coupleId)
  return count ?? 0
}

async function fetchTouchpoint(
  supabase: SupabaseClient,
  touchpointId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!touchpointId) return null
  const { data } = await supabase
    .from('touchpoints')
    .select('*')
    .eq('id', touchpointId)
    .maybeSingle()
  return (data as Record<string, unknown> | null) ?? null
}

/**
 * Resolve a legacy weddings.id to its spine couple via
 * `couples.source_wedding_id` (D1: the 1:1 link for booked couples).
 * Returns null when no couple mirrors the wedding.
 */
async function coupleForLegacyWedding(
  supabase: SupabaseClient,
  venueId: string,
  legacyWeddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', legacyWeddingId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

// ===========================================================================
// Diff helpers
// ===========================================================================

function diffRows(
  oldRow: Record<string, unknown> | null,
  newRow: Record<string, unknown> | null,
  fields: readonly string[],
): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const field of fields) {
    const oldValue = oldRow ? (oldRow[field] ?? null) : null
    const newValue = newRow ? (newRow[field] ?? null) : null
    // Normalise: treat undefined/'' /null as equivalent emptiness.
    const oNorm = oldValue === '' ? null : oldValue
    const nNorm = newValue === '' ? null : newValue
    if (JSON.stringify(oNorm) !== JSON.stringify(nNorm)) {
      diffs.push({ field, oldValue, newValue })
    }
  }
  return diffs
}

// ===========================================================================
// Core: shadowCompare
// ===========================================================================

/**
 * Run the old path + the cascade path for one writer / one signal, diff
 * the results, restore the venue. This is the function Phase 1 calls
 * per-writer (§1.3). It does not migrate anything — it only observes.
 */
export async function shadowCompare(
  args: ShadowCompareArgs,
): Promise<ShadowCompareReport> {
  const {
    supabase,
    venueId,
    writerName,
    signal,
    oldPath,
    iUnderstandThisWrites,
    noRestore = false,
  } = args

  if (!iUnderstandThisWrites) {
    throw new Error(
      'shadow-compare WRITES to the database. Refusing to run without ' +
        'iUnderstandThisWrites:true. Point at a DISPOSABLE Supabase branch ' +
        'first — never production.',
    )
  }
  if (!venueId) throw new Error('shadowCompare: venueId is required')

  const ts = new Date().toISOString()

  // -- 1. Snapshot the venue (unless explicitly skipped). -------------------
  let snapshot: VenueSnapshot | null = null
  if (!noRestore) {
    snapshot = await takeSnapshot(supabase, venueId)
  }

  // -- 2. Run the OLD path. -------------------------------------------------
  let oldCoupleId: string | null = null
  let oldNotes: string | null = null
  if (oldPath) {
    const outcome = await oldPath(supabase, venueId, signal)
    oldNotes = outcome.notes ?? null
    if (outcome.coupleId) {
      oldCoupleId = outcome.coupleId
    } else if (outcome.legacyWeddingId) {
      oldCoupleId = await coupleForLegacyWedding(
        supabase,
        venueId,
        outcome.legacyWeddingId,
      )
    }
  } else {
    oldNotes =
      'no oldPath adapter supplied — cascade-vs-cascade self-test mode'
  }
  const oldCoupleRow = await fetchCouple(supabase, oldCoupleId)
  const oldTouchpointCount = await countTouchpoints(
    supabase,
    venueId,
    oldCoupleId,
  )

  // -- 3. Run the NEW (cascade) path. ---------------------------------------
  const link = await linkSignal({
    supabase,
    venueId,
    signal,
    bypassCache: true, // never trust the 60s LRU inside a comparison
    source: `shadow-compare:${writerName}`,
  })
  const newCoupleId = link.matched_couple_id
  const newCoupleRow = await fetchCouple(supabase, newCoupleId)
  const newTouchpointCount = await countTouchpoints(
    supabase,
    venueId,
    newCoupleId,
  )
  const newTouchpointRow = await fetchTouchpoint(supabase, link.touchpoint_id)

  // -- 4. Diff. -------------------------------------------------------------
  const coupleBindingMatches =
    oldCoupleId !== null &&
    newCoupleId !== null &&
    oldCoupleId === newCoupleId

  // When the binding self-test mode has no old path, treat the cascade
  // result as its own baseline so the harness reports a clean run.
  const selfTest = !oldPath
  const effectiveOldCoupleId = selfTest ? newCoupleId : oldCoupleId
  const effectiveOldCoupleRow = selfTest ? newCoupleRow : oldCoupleRow
  const effectiveOldTpCount = selfTest
    ? newTouchpointCount
    : oldTouchpointCount

  const coupleFieldDiff = diffRows(
    effectiveOldCoupleRow,
    newCoupleRow,
    COUPLE_DIFF_FIELDS,
  )
  // Touchpoint diff: we can only field-diff when the new path inserted a
  // touchpoint. The old-path touchpoint lives in legacy `interactions` /
  // `wedding_touchpoints` with a different schema — its row is reported
  // by count + the adapter's `legacyTouchpointId`, not field-diffed here.
  const touchpointFieldDiff = diffRows(
    null,
    newTouchpointRow,
    TOUCHPOINT_DIFF_FIELDS,
  ).map((d) => ({ ...d, oldValue: '(legacy schema — not comparable)' }))

  const touchpointCountDelta = newTouchpointCount - effectiveOldTpCount

  // -- 5. Assemble divergence verdict. --------------------------------------
  const divergenceReasons: string[] = []
  if (!selfTest && !coupleBindingMatches) {
    divergenceReasons.push(
      `couple binding differs: old=${oldCoupleId ?? 'null'} new=${
        newCoupleId ?? 'null'
      }`,
    )
  }
  if (!selfTest && touchpointCountDelta !== 0) {
    divergenceReasons.push(
      `touchpoint count delta = ${touchpointCountDelta} ` +
        `(old=${effectiveOldTpCount} new=${newTouchpointCount})`,
    )
  }
  if (coupleFieldDiff.length > 0) {
    divergenceReasons.push(
      `couple fields differ: ${coupleFieldDiff
        .map((d) => d.field)
        .join(', ')}`,
    )
  }

  const divergent = divergenceReasons.length > 0

  const report: ShadowCompareReport = {
    ts,
    writer: writerName,
    venueId,
    signal: {
      channel: signal.channel,
      action_type: signal.action_type,
      external_id: signal.external_id,
      identity_hint: signal.identity_hint ?? null,
    },
    oldPath: {
      coupleId: oldCoupleId,
      touchpointCount: oldTouchpointCount,
      notes: oldNotes,
    },
    newPath: {
      coupleId: newCoupleId,
      touchpointCount: newTouchpointCount,
      action: link.action,
      touchpointId: link.touchpoint_id,
    },
    coupleBindingMatches: selfTest ? true : coupleBindingMatches,
    touchpointCountDelta,
    coupleFieldDiff,
    touchpointFieldDiff,
    divergent,
    divergenceReasons,
    restored: false,
  }

  // -- 6. Restore the venue. ------------------------------------------------
  if (snapshot) {
    report.restored = await restoreSnapshot(supabase, snapshot)
    if (!report.restored) {
      console.error(
        '  [restore] WARNING — restore was not clean. The comparison ' +
          'venue may hold residual rows. Re-seed the branch before the ' +
          'next run.',
      )
    }
  }

  return report
}

// ===========================================================================
// Structured logging
// ===========================================================================

/** Emit the report as one JSON line — for machine consumption / Phase 1
 *  aggregation across a representative sample. */
export function logDivergenceJson(report: ShadowCompareReport): void {
  console.log(JSON.stringify({ kind: 'shadow_compare', ...report }))
}

/** Emit the report as a readable operator summary. */
export function logDivergenceSummary(report: ShadowCompareReport): void {
  const banner = report.divergent ? 'DIVERGENT ✗' : 'CONVERGENT ✓'
  console.log('')
  console.log(`=== shadow-compare: ${report.writer} — ${banner} ===`)
  console.log(`  venue:           ${report.venueId}`)
  console.log(
    `  signal:          ${report.signal.channel}/${report.signal.action_type} ` +
      `(ext=${report.signal.external_id})`,
  )
  console.log(
    `  old path couple: ${report.oldPath.coupleId ?? '(none)'} ` +
      `· touchpoints=${report.oldPath.touchpointCount}`,
  )
  if (report.oldPath.notes) console.log(`    notes: ${report.oldPath.notes}`)
  console.log(
    `  new path couple: ${report.newPath.coupleId ?? '(none)'} ` +
      `· touchpoints=${report.newPath.touchpointCount} ` +
      `· action=${report.newPath.action}`,
  )
  console.log(`  binding matches: ${report.coupleBindingMatches}`)
  console.log(`  touchpoint delta: ${report.touchpointCountDelta}`)
  if (report.coupleFieldDiff.length) {
    console.log('  couple field diffs:')
    for (const d of report.coupleFieldDiff) {
      console.log(
        `    - ${d.field}: old=${JSON.stringify(d.oldValue)} ` +
          `new=${JSON.stringify(d.newValue)}`,
      )
    }
  }
  if (report.divergent) {
    console.log('  divergence reasons:')
    for (const r of report.divergenceReasons) console.log(`    ! ${r}`)
  }
  console.log(
    `  venue restored:  ${report.restored ? 'yes' : 'NO — see warnings above'}`,
  )
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const a of argv) {
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq === -1) out[a.slice(2)] = true
    else out[a.slice(2, eq)] = a.slice(eq + 1)
  }
  return out
}

/** A minimal, identity-sufficient canned Gmail signal for a smoke run. */
function cannedSignal(): NormalizedSignal {
  return {
    external_id: `shadow-compare-canned-${Date.now()}`,
    channel: 'gmail',
    action_type: 'reply',
    occurred_at: new Date().toISOString(),
    signal_tier: 'high',
    identity_hint: 'Shadow Compare Selftest',
    primary_name: 'Shadow Compare Selftest',
    primary_email: `shadow.compare.selftest+${Date.now()}@example.com`,
    primary_phone: null,
    partner_name: null,
    partner_email: null,
    partner_phone: null,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: { harness: 'shadow-compare', canned: true },
    legacy_wedding_id: null,
    author_class: 'couple',
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ' +
        'Run with --env-file=.env.local.',
    )
    process.exit(1)
  }

  // Loud production guard — refuse the known production project ref.
  if (SUPABASE_URL.includes('jsxxgwprxuqgcauzlxcb')) {
    console.error(
      'REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION ' +
        'project (jsxxgwprxuqgcauzlxcb). shadow-compare writes + restores; ' +
        'point .env.local at a disposable Supabase branch first.',
    )
    process.exit(1)
  }

  const venueId = typeof args.venue === 'string' ? args.venue : ''
  const writerName =
    typeof args.writer === 'string' ? args.writer : 'unnamed-writer'
  if (!venueId) {
    console.error('Missing --venue=<uuid>')
    process.exit(1)
  }
  if (!args['i-understand-this-writes']) {
    console.error(
      'shadow-compare WRITES to the database (then restores). Re-run with ' +
        '--i-understand-this-writes once you have confirmed --env-file ' +
        'points at a disposable Supabase branch.',
    )
    process.exit(1)
  }

  let signal: NormalizedSignal
  if (args.canned) {
    signal = cannedSignal()
  } else if (typeof args.signal === 'string') {
    signal = JSON.parse(readFileSync(args.signal, 'utf8')) as NormalizedSignal
  } else {
    console.error(
      'Provide --signal=<path-to-signal.json> or --canned for a smoke run.',
    )
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  })

  // The CLI runs cascade-vs-cascade self-test only — there is no generic
  // way to drive an arbitrary legacy writer from the command line. Phase 1
  // calls `shadowCompare(...)` programmatically with a real `oldPath`
  // adapter per writer. The CLI proves the harness end-to-end (snapshot →
  // cascade → diff → restore).
  const report = await shadowCompare({
    supabase,
    venueId,
    writerName,
    signal,
    oldPath: undefined,
    iUnderstandThisWrites: true,
    noRestore: Boolean(args['no-restore']),
  })

  logDivergenceSummary(report)
  logDivergenceJson(report)

  // Non-zero exit on divergence so a CI / batch caller can gate on it.
  process.exit(report.divergent ? 2 : 0)
}

// Run as a script only when invoked directly (not when imported by Phase 1).
const invokedDirectly =
  process.argv[1]?.replace(/\\/g, '/').endsWith('shadow-compare.ts') ?? false
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal:', err instanceof Error ? err.stack : err)
    process.exit(1)
  })
}
