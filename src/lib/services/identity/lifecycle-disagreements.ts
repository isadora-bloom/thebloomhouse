/**
 * Where the two lifecycles disagree, per couple. Wave 5, W37.
 *
 * Sibling of `lifecycle-audit.ts`. That one asks whether the stored
 * `couples.lifecycle_state` matches what the couple's own signals say it
 * should be, which is a question about one lifecycle. This one asks
 * whether the spine and the thirteen-stage per-wedding machine are telling
 * the same story, which is a question about two.
 *
 * For every couple it reports three things side by side:
 *
 *   - the spine state (`couples.lifecycle_state`, or 'merged' when the row
 *     is a pointer at another couple);
 *   - the machine stage (`weddings.lifecycle_stage` on the mirrored
 *     wedding, null when there is no wedding or the machine has not run);
 *   - the operator stage that `deriveOperatorStage` shows on the pill,
 *     with the sentence it would put in the tooltip.
 *
 * It counts them so the reimport can be checked against the same table
 * before and after. If a couple's spine state changes but its machine
 * stage does not, this is where that shows up.
 *
 * READ-ONLY. No writes, no repair, no suggestion of one. A disagreement is
 * not automatically a bug: a couple who enquired, went quiet for four
 * months and then rang up is legitimately 'ghost' on the spine and
 * 'nurture' on the machine until the resurrection path catches up. The
 * report is for a person to read.
 *
 * Usage:
 *   const report = await lifecycleDisagreements(venueId)
 *   const report = await loadLifecycleDisagreements(supabase, venueId)   // testable
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'
import {
  ALL_MACHINE_STAGES,
  deriveOperatorStage,
  machineStageToSpineState,
  type OperatorStage,
  type SpineState,
  type SpineStateInput,
  type VocabularyAgreement,
} from '@/lib/services/lifecycle/vocabulary'

/** PostgREST caps an `in` list; the existing audit chunks at 500 and this
 *  matches it so the two behave the same on a big venue. */
const CHUNK = 500

/** Same ceiling as `runLifecycleAudit`. A venue with more couples than
 *  this gets a truncated report and is told so. */
const COUPLE_LIMIT = 10000

export interface LifecycleDisagreementRow {
  coupleId: string
  primaryName: string | null
  primaryEmail: string | null
  /** `couples.lifecycle_state`, or 'merged' when `merged_into_id` is set. */
  spineState: SpineStateInput
  /** `weddings.lifecycle_stage` on the mirrored wedding. */
  machineStage: LifecycleStage | null
  /** What the machine stage projects to on the spine. Null with no stage. */
  projectedSpineState: SpineState | null
  /** What the pill shows. */
  operatorStage: OperatorStage
  /** What the tooltip says. */
  because: string
  agreement: VocabularyAgreement
  weddingId: string | null
  weddingDate: string | null
  lastInboundAt: string | null
}

export interface LifecycleDisagreementReport {
  /** Every couple scanned, disagreements first. */
  rows: LifecycleDisagreementRow[]
  counts: {
    couplesScanned: number
    /** Couples where both lifecycles had something to say and they matched. */
    agreed: number
    /** Couples where the machine projects to a different spine state. */
    disagreed: number
    /** Couples where only one of the two had anything to say. */
    oneSided: number
    /** Couples with no mirrored wedding stage at all. */
    noMachineStage: number
    /** Couples with no spine state at all. */
    noSpineState: number
    /** Spine state -> how many couples. */
    bySpineState: Record<string, number>
    /** Machine stage -> how many couples. */
    byMachineStage: Record<string, number>
    /** Operator stage -> how many couples. What the surfaces will show. */
    byOperatorStage: Record<string, number>
    /** "ghost -> nurture" -> how many. The shape of the disagreement. */
    byDisagreementPair: Record<string, number>
  }
  /** True when the venue has more couples than this report loaded. */
  truncated: boolean
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Rows we read
// ---------------------------------------------------------------------------

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  lifecycle_state: string | null
  merged_into_id: string | null
  source_wedding_id: string | null
  wedding_date: string | null
  last_progression_at: string | null
}

interface WeddingRow {
  id: string
  lifecycle_stage: string | null
  booked_at: string | null
  status: string | null
  wedding_date: string | null
}

const MACHINE_STAGES: ReadonlySet<string> = new Set(ALL_MACHINE_STAGES)

function asMachineStage(raw: string | null): LifecycleStage | null {
  if (!raw) return null
  return MACHINE_STAGES.has(raw) ? (raw as LifecycleStage) : null
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function emptyReport(generatedAt: string): LifecycleDisagreementReport {
  return {
    rows: [],
    counts: {
      couplesScanned: 0,
      agreed: 0,
      disagreed: 0,
      oneSided: 0,
      noMachineStage: 0,
      noSpineState: 0,
      bySpineState: {},
      byMachineStage: {},
      byOperatorStage: {},
      byDisagreementPair: {},
    },
    truncated: false,
    generatedAt,
  }
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

/**
 * The testable core. Takes its client and its clock so a unit test can
 * stand it up without a database, the same dependency seam
 * `loadCoupleJourney` uses.
 */
export async function loadLifecycleDisagreements(
  supabase: SupabaseClient,
  venueId: string,
  now: Date = new Date(),
): Promise<LifecycleDisagreementReport> {
  const generatedAt = now.toISOString()
  if (!venueId) return emptyReport(generatedAt)

  const { data: couplesData, error: couplesErr } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, primary_contact_email, lifecycle_state, merged_into_id, source_wedding_id, wedding_date, last_progression_at',
    )
    .eq('venue_id', venueId)
    .limit(COUPLE_LIMIT)
  if (couplesErr) return emptyReport(generatedAt)
  const couples = (couplesData ?? []) as CoupleRow[]
  if (couples.length === 0) return emptyReport(generatedAt)

  // The machine stage lives on the mirrored wedding. Couples with no
  // wedding simply have no stage; that is data, not an error.
  const weddingIds = couples
    .map((c) => c.source_wedding_id)
    .filter((v): v is string => Boolean(v))
  const weddingById = new Map<string, WeddingRow>()
  for (let i = 0; i < weddingIds.length; i += CHUNK) {
    const slice = weddingIds.slice(i, i + CHUNK)
    const { data } = await supabase
      .from('weddings')
      .select('id, lifecycle_stage, booked_at, status, wedding_date')
      .eq('venue_id', venueId)
      .in('id', slice)
    for (const w of (data ?? []) as WeddingRow[]) weddingById.set(w.id, w)
  }

  const rows: LifecycleDisagreementRow[] = []
  const counts = emptyReport(generatedAt).counts
  counts.couplesScanned = couples.length

  for (const c of couples) {
    const wedding = c.source_wedding_id ? weddingById.get(c.source_wedding_id) ?? null : null
    const machineStage = asMachineStage(wedding?.lifecycle_stage ?? null)
    const spineState: SpineStateInput = c.merged_into_id
      ? 'merged'
      : ((c.lifecycle_state as SpineState | null) ?? null)
    const hasBooking = Boolean(
      wedding?.booked_at || (wedding?.status && wedding.status.toLowerCase() === 'booked'),
    )
    const weddingDate = c.wedding_date ?? wedding?.wedding_date ?? null

    const derived = deriveOperatorStage({
      spineState,
      machineStage,
      hasBooking,
      weddingDate,
      lastInboundAt: c.last_progression_at,
      today: now,
    })

    bump(counts.bySpineState, spineState ?? 'none')
    bump(counts.byMachineStage, machineStage ?? 'none')
    bump(counts.byOperatorStage, derived.stage)
    if (!machineStage) counts.noMachineStage += 1
    if (!spineState) counts.noSpineState += 1
    if (derived.agreement === 'agreed') counts.agreed += 1
    else if (derived.agreement === 'disagreed') counts.disagreed += 1
    else counts.oneSided += 1
    if (derived.agreement === 'disagreed') {
      bump(counts.byDisagreementPair, `${spineState ?? 'none'} -> ${machineStage ?? 'none'}`)
    }

    rows.push({
      coupleId: c.id,
      primaryName: c.primary_contact_name,
      primaryEmail: c.primary_contact_email,
      spineState,
      machineStage,
      projectedSpineState: machineStageToSpineState(machineStage),
      operatorStage: derived.stage,
      because: derived.because,
      agreement: derived.agreement,
      weddingId: c.source_wedding_id,
      weddingDate,
      lastInboundAt: c.last_progression_at,
    })
  }

  // Disagreements first, then the one-sided rows (a couple with no machine
  // stage is the next most interesting thing), then the quiet agreement.
  const rank = (a: VocabularyAgreement): number =>
    a === 'disagreed' ? 0 : a === 'one_sided' ? 1 : 2
  rows.sort((a, b) => {
    const byRank = rank(a.agreement) - rank(b.agreement)
    if (byRank !== 0) return byRank
    return (a.primaryName ?? '').localeCompare(b.primaryName ?? '')
  })

  return {
    rows,
    counts,
    truncated: couples.length >= COUPLE_LIMIT,
    generatedAt,
  }
}

/**
 * The public entry, matching the shape the rest of the read layer uses:
 * pass a venue id, get a report. Builds its own service client.
 */
export async function lifecycleDisagreements(
  venueId: string,
): Promise<LifecycleDisagreementReport> {
  if (!venueId) return emptyReport(new Date().toISOString())
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadLifecycleDisagreements(createServiceClient(), venueId)
}
