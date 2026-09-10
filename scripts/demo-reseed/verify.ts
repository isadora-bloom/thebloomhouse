/**
 * demo-reseed — read-back verification.
 *
 * Read-only. Runs with or without `--apply`, and answers the five
 * questions the 2026-09-08 walk asked and could not get a straight answer
 * to:
 *
 *   1. How many couples are on the spine per demo venue? (Finding 4:
 *      legacy tables full, `couples` effectively empty.)
 *   2. How many touchpoints sit behind them? (Same finding, second half.)
 *   3. What does the heat distribution look like? (Finding 5: all 61
 *      leads Frozen. A pass here means NOT everything is Frozen.)
 *   4. Does Pulse have anything to show?
 *   5. What `business_name` does each demo venue actually carry?
 *      (Finding 1: Hawthorne read "Rixey Manor".)
 *
 * `wedding_heat` is the truth about heat, not the generator's prediction.
 * That is the whole reason this mode exists.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEMO_VENUES, HERO_WEDDING_ID } from './roster'

export interface VenueVerification {
  venueId: string
  venueName: string
  businessName: string | null
  isDemo: boolean | null
  couples: number
  couplesByLifecycle: Record<string, number>
  touchpoints: number
  weddings: number
  heatByTier: Record<string, number>
  pulseItems: number
  /** Set when Pulse could not be aggregated; the count above is then
   *  meaningless and says so rather than reading zero. */
  pulseError: string | null
}

export interface VerifyReport {
  venues: VenueVerification[]
  heroWeddingPresent: boolean
  heroChecklistRows: number
  heroGuestRows: number
  heroTimelineRows: number
  /** True when the spine is populated and heat is not uniformly frozen. */
  pass: boolean
  failures: string[]
}

async function countRows(
  supabase: SupabaseClient,
  table: string,
  venueId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  if (error) return 0
  return count ?? 0
}

async function countByWedding(
  supabase: SupabaseClient,
  table: string,
  weddingId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
  if (error) return 0
  return count ?? 0
}

export interface VerifyDeps {
  /** `aggregatePulse` from `@/lib/services/intel/pulse-aggregator`.
   *  Injected so a test can run the report without the aggregator's
   *  own dependency tree. */
  aggregatePulse?: (
    supabase: SupabaseClient,
    venueId: string,
    opts?: { limit?: number; sinceDays?: number },
  ) => Promise<unknown[]>
}

export async function verifyReseed(
  supabase: SupabaseClient,
  deps: VerifyDeps = {},
): Promise<VerifyReport> {
  const venues: VenueVerification[] = []
  const failures: string[] = []

  for (const venue of DEMO_VENUES) {
    const { data: venueRow } = await supabase
      .from('venues')
      .select('id, name, is_demo')
      .eq('id', venue.id)
      .maybeSingle()

    const { data: configRow } = await supabase
      .from('venue_config')
      .select('business_name')
      .eq('venue_id', venue.id)
      .maybeSingle()

    const { data: coupleRows } = await supabase
      .from('couples')
      .select('id, lifecycle_state')
      .eq('venue_id', venue.id)
      .is('merged_into_id', null)

    const couplesByLifecycle: Record<string, number> = {}
    for (const row of (coupleRows ?? []) as Array<{ lifecycle_state: string }>) {
      couplesByLifecycle[row.lifecycle_state] =
        (couplesByLifecycle[row.lifecycle_state] ?? 0) + 1
    }

    const { data: heatRows } = await supabase
      .from('wedding_heat')
      .select('temperature_tier')
      .eq('venue_id', venue.id)

    const heatByTier: Record<string, number> = {
      hot: 0,
      warm: 0,
      cool: 0,
      cold: 0,
      frozen: 0,
    }
    for (const row of (heatRows ?? []) as Array<{ temperature_tier: string | null }>) {
      const tier = row.temperature_tier ?? 'frozen'
      heatByTier[tier] = (heatByTier[tier] ?? 0) + 1
    }

    let pulseItems = 0
    let pulseError: string | null = null
    if (deps.aggregatePulse) {
      try {
        const items = await deps.aggregatePulse(supabase, venue.id, { limit: 50 })
        pulseItems = items.length
      } catch (err) {
        pulseError = err instanceof Error ? err.message : String(err)
      }
    } else {
      pulseError = 'aggregatePulse not supplied'
    }

    const record: VenueVerification = {
      venueId: venue.id,
      venueName: venue.name,
      businessName: (configRow as { business_name?: string } | null)?.business_name ?? null,
      isDemo: (venueRow as { is_demo?: boolean } | null)?.is_demo ?? null,
      couples: (coupleRows ?? []).length,
      couplesByLifecycle,
      touchpoints: await countRows(supabase, 'touchpoints', venue.id),
      weddings: await countRows(supabase, 'weddings', venue.id),
      heatByTier,
      pulseItems,
      pulseError,
    }
    venues.push(record)

    if (record.couples === 0) failures.push(`${venue.name}: no couples on the spine`)
    if (record.touchpoints === 0) failures.push(`${venue.name}: no touchpoints`)
    if (record.businessName !== venue.name) {
      failures.push(
        `${venue.name}: venue_config.business_name reads "${record.businessName ?? 'null'}"`,
      )
    }
    const live = record.heatByTier.hot + record.heatByTier.warm + record.heatByTier.cool
    const total = Object.values(record.heatByTier).reduce((a, b) => a + b, 0)
    if (total > 0 && live === 0) {
      failures.push(`${venue.name}: every lead reads cold or frozen — the live clock did not take`)
    }
  }

  const { data: heroRow } = await supabase
    .from('weddings')
    .select('id')
    .eq('id', HERO_WEDDING_ID)
    .maybeSingle()
  const heroWeddingPresent = Boolean(heroRow)
  if (!heroWeddingPresent) {
    failures.push(`hero wedding ${HERO_WEDDING_ID} is missing — the couple portal will be empty`)
  }

  const heroChecklistRows = heroWeddingPresent
    ? await countByWedding(supabase, 'checklist_items', HERO_WEDDING_ID)
    : 0
  const heroGuestRows = heroWeddingPresent
    ? await countByWedding(supabase, 'guest_list', HERO_WEDDING_ID)
    : 0
  const heroTimelineRows = heroWeddingPresent
    ? await countByWedding(supabase, 'timeline', HERO_WEDDING_ID)
    : 0

  return {
    venues,
    heroWeddingPresent,
    heroChecklistRows,
    heroGuestRows,
    heroTimelineRows,
    pass: failures.length === 0,
    failures,
  }
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = []
  for (const v of report.venues) {
    lines.push(`  ${v.venueName} (${v.venueId})`)
    lines.push(`    business_name : ${v.businessName ?? 'null'}   is_demo: ${String(v.isDemo)}`)
    lines.push(
      `    spine         : ${v.couples} couples, ${v.touchpoints} touchpoints, ${v.weddings} weddings`,
    )
    const lifecycle = Object.entries(v.couplesByLifecycle)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')
    lines.push(`    lifecycle     : ${lifecycle || 'none'}`)
    const heat = Object.entries(v.heatByTier)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')
    lines.push(`    heat          : ${heat}`)
    lines.push(
      `    pulse         : ${v.pulseError ? `unavailable (${v.pulseError})` : `${v.pulseItems} items`}`,
    )
  }
  lines.push('')
  lines.push(
    `  hero wedding  : ${report.heroWeddingPresent ? 'present' : 'MISSING'}` +
      ` — checklist ${report.heroChecklistRows}, guests ${report.heroGuestRows},` +
      ` timeline ${report.heroTimelineRows}`,
  )
  lines.push('')
  if (report.pass) {
    lines.push('  VERIFY PASS')
  } else {
    lines.push('  VERIFY FAIL')
    for (const f of report.failures) lines.push(`    - ${f}`)
  }
  return lines.join('\n')
}
