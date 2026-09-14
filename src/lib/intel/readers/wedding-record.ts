/**
 * Wedding record reader — W65 of NOVEMBER-PLAN.md wave 9.
 *
 * The couple-facing pages and the wedding-record surfaces (couple
 * dashboard, addresses, couple photo, the couple-portal layout, the
 * coordinator's wedding page, its portal preview and its print view)
 * each grew their own `.from('weddings')` / `.from('people')` read for
 * the handful of facts every one of them needs: the date, the couple's
 * names, a guest count, the booked package, the event code and where
 * the couple stands in the lifecycle. This is the one reader that
 * answers all of that.
 *
 * Sourcing, in order of preference:
 *   - names, lifecycle state and the operator-facing stage come from the
 *     spine (`couples`, via `loadCoupleJourney` in canonical.ts, which
 *     already reconciles the spine state with the per-wedding machine
 *     stage — see lib/services/lifecycle/vocabulary.ts). A couple with
 *     no mirrored spine row yet reads honest-empty rather than guessed.
 *   - the wedding date prefers the spine's `couples.wedding_date` (kept
 *     in step by the mirror writer) and falls back to the legacy row.
 *   - guest count, the package label, the event code, the code
 *     extension and the couple photo URL have no spine equivalent today.
 *     They are read from the wedding's own legacy row, ONCE, here — the
 *     one place this reader is allowed to touch it. Nowhere else in
 *     `src/app` should open a second `weddings` read for these.
 *   - the booked package is then resolved against the `packages`
 *     catalog (not a legacy table) the same way the couple dashboard
 *     always has: case-insensitive name match, falling back to the bare
 *     label when the catalog has no matching row.
 *
 * Tenancy: every query is scoped by `venueId`; a weddingId from a
 * foreign venue reads as not-found, never another tenant's row.
 *
 * Injectable client (`loadWeddingRecord`) so this is unit-tested with a
 * fake, in-memory Supabase client — no database required. The public
 * `getWeddingRecord` wraps the service client for real callers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCoupleJourney, type LifecycleState } from '@/lib/intel/canonical'
import type { OperatorStageResult } from '@/lib/services/lifecycle/vocabulary'

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface WeddingRecordPackage {
  name: string
  description: string | null
  seasonOrTier: string | null
}

export interface WeddingRecord {
  weddingId: string
  venueId: string
  /** The spine couple mirrored to this wedding, when one exists. */
  coupleId: string | null
  /** True when either a spine couple or the legacy row was found. False
   *  means honest-empty: neither a couple nor a wedding at this id, in
   *  this venue. */
  found: boolean
  weddingDate: string | null
  /** "Chloe & Ryan" — first names, built from the spine's
   *  `primary_contact_name` / `partner_contact_name`. Null when there is
   *  no mirrored couple yet; callers supply their own "there" / "your
   *  wedding" fallback the way the dashboard already does. */
  coupleNames: string | null
  /** `weddings.guest_count_estimate` — a coordinator's planning figure,
   *  not the actual `guest_list` row count. No spine equivalent. */
  guestCount: number | null
  package: WeddingRecordPackage | null
  /** `weddings.event_code` — the couple-invite code. No spine
   *  equivalent. */
  eventCode: string | null
  /** `weddings.code_extension` — suffix used by `formatBloomNumber`
   *  alongside a `client_codes` row. No spine equivalent. */
  codeExtension: string | null
  couplePhotoUrl: string | null
  /** `couples.lifecycle_state`. Null when there is no mirrored couple. */
  lifecycle: LifecycleState | null
  /** The one operator-facing stage — same value `getCoupleJourney`
   *  returns, so a page that shows both never disagrees with itself. */
  operatorStage: OperatorStageResult | null
  /** Mirrors `operatorStage.because`. Null when there is no couple. */
  because: string | null
}

function emptyRecord(weddingId: string, venueId: string): WeddingRecord {
  return {
    weddingId,
    venueId,
    coupleId: null,
    found: false,
    weddingDate: null,
    coupleNames: null,
    guestCount: null,
    package: null,
    eventCode: null,
    codeExtension: null,
    couplePhotoUrl: null,
    lifecycle: null,
    operatorStage: null,
    because: null,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Name building
// ─────────────────────────────────────────────────────────────────────

/** First token of a "First Last" string. Null on an empty/blank name. */
function firstNameOf(full: string | null | undefined): string | null {
  if (!full) return null
  const trimmed = full.trim()
  if (!trimmed) return null
  return trimmed.split(/\s+/)[0]
}

/** "Chloe & Ryan" from the spine's two contact-name fields. Null when
 *  neither side has a name on file. */
function buildCoupleNames(
  primaryContactName: string | null | undefined,
  partnerContactName: string | null | undefined,
): string | null {
  const parts = [firstNameOf(primaryContactName), firstNameOf(partnerContactName)].filter(
    (s): s is string => Boolean(s),
  )
  if (parts.length === 0) return null
  return parts.join(' & ')
}

// ─────────────────────────────────────────────────────────────────────
// Raw row shapes
// ─────────────────────────────────────────────────────────────────────

interface RawCoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  wedding_date: string | null
  lifecycle_state: string | null
  merged_into_id: string | null
}

interface RawWeddingRow {
  id: string
  wedding_date: string | null
  guest_count_estimate: number | null
  package_name: string | null
  package: string | null
  event_code: string | null
  code_extension: string | null
  couple_photo_url: string | null
}

interface RawPackageRow {
  name: string
  description: string | null
  season: string | null
  tier: string | null
}

// ─────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────

/** Spine-first, legacy-once. See module doc for the sourcing order. */
export async function loadWeddingRecord(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string,
): Promise<WeddingRecord> {
  if (!weddingId || !venueId) return emptyRecord(weddingId, venueId)

  // 1. Spine couple, keyed by the legacy wedding id. Excludes a
  //    merged-away couple so a stale mirror doesn't outrank a fresher
  //    one under a different id.
  const { data: coupleRow } = await supabase
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name, wedding_date, lifecycle_state, merged_into_id')
    .eq('source_wedding_id', weddingId)
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .maybeSingle<RawCoupleRow>()

  // 2. The wedding's own legacy row — the ONE place this reader reads
  //    it, for the fields the spine does not carry yet.
  const { data: weddingRow } = await supabase
    .from('weddings') // legacy-read-ok: the wedding record's own row, read in one place until Phase 3 retires the mirror
    .select(
      'id, wedding_date, guest_count_estimate, package_name, package, event_code, code_extension, couple_photo_url',
    )
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle<RawWeddingRow>()

  if (!coupleRow && !weddingRow) return emptyRecord(weddingId, venueId)

  // 3. Package catalog resolution (`packages` — not a legacy table).
  //    Same precedence the couple dashboard has always used:
  //    package_name, then package, then honest-null. Matched
  //    case-insensitively in JS rather than `.ilike()` — the dashboard's
  //    original query escaped `%`/`_` before every ilike call, which
  //    turns it into a plain case-insensitive equality check anyway, so
  //    fetching the venue's packages and comparing here is the same
  //    match with one fewer round-trip pattern to keep in sync.
  const packageLabel =
    (weddingRow?.package_name ?? null) || (weddingRow?.package ?? null) || null
  let pkg: WeddingRecordPackage | null = null
  if (packageLabel) {
    const { data: pkgRows } = await supabase
      .from('packages')
      .select('name, description, season, tier')
      .eq('venue_id', venueId)
      .eq('kind', 'package')
    const needle = packageLabel.trim().toLowerCase()
    const pkgRow = ((pkgRows ?? []) as RawPackageRow[]).find(
      (row) => (row.name ?? '').trim().toLowerCase() === needle,
    )
    pkg = pkgRow
      ? {
          name: pkgRow.name,
          description: pkgRow.description ?? null,
          seasonOrTier: pkgRow.season ?? pkgRow.tier ?? null,
        }
      : { name: packageLabel, description: null, seasonOrTier: null }
  }

  // 4. Names + lifecycle + the one operator stage, all from the spine,
  //    via the reconciliation `getCoupleJourney` already does.
  let coupleNames: string | null = null
  let lifecycle: LifecycleState | null = null
  let operatorStage: OperatorStageResult | null = null
  let because: string | null = null
  if (coupleRow) {
    coupleNames = buildCoupleNames(coupleRow.primary_contact_name, coupleRow.partner_contact_name)
    lifecycle = (coupleRow.lifecycle_state as LifecycleState) ?? null
    const journey = await loadCoupleJourney(supabase, venueId, coupleRow.id)
    operatorStage = journey.operatorStage
    because = journey.because
  }

  return {
    weddingId,
    venueId,
    coupleId: coupleRow?.id ?? null,
    found: true,
    weddingDate: coupleRow?.wedding_date ?? weddingRow?.wedding_date ?? null,
    coupleNames,
    guestCount: weddingRow?.guest_count_estimate ?? null,
    package: pkg,
    eventCode: weddingRow?.event_code ?? null,
    codeExtension: weddingRow?.code_extension ?? null,
    couplePhotoUrl: weddingRow?.couple_photo_url ?? null,
    lifecycle,
    operatorStage,
    because,
  }
}

/** Public entry point — wraps the service client. */
export async function getWeddingRecord(
  weddingId: string,
  venueId: string,
  supabase?: SupabaseClient,
): Promise<WeddingRecord> {
  if (!weddingId || !venueId) return emptyRecord(weddingId, venueId)
  if (supabase) return loadWeddingRecord(supabase, weddingId, venueId)
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadWeddingRecord(createServiceClient(), weddingId, venueId)
}
