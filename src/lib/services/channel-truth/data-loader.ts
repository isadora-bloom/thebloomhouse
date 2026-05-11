/**
 * Bloom House — Wave 24 shared data loader.
 *
 * Anchor docs:
 *   - feedback_deep_fix_vs_bandaid.md (one loader, all questions read
 *     the same shape — band-aid resistance)
 *   - bloom-phase-b-decisions.md (attribution_events architecture; Wave
 *     24 reads via attribution_events.intent_class to stay abstract
 *     across Wave 23's listing_platform_patterns rename)
 *
 * Each answer compute function calls loadAttributionDataset() once; the
 * loader pages attribution_events + weddings + (when relevant)
 * discovery_sources + disagreement_findings, then returns a shaped
 * dataset every per-question function can filter cheaply.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** One attribution_events row in the shape Wave 24 cares about. */
export interface AttributionRow {
  id: string
  venue_id: string
  wedding_id: string | null
  source_platform: string | null
  /** Wave 7B forensic role. */
  role: string | null
  /** Wave 16 forensic intent. */
  intent_class: string | null
  /** Wave 22 prompt version disclosure. */
  prompt_version_classified_under: string | null
  intent_classified_at: string | null
  decided_at: string | null
  reverted_at: string | null
}

/** One weddings row in the shape Wave 24 cares about. */
export interface WeddingRow {
  id: string
  venue_id: string
  status: string | null
  source: string | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
  booking_value: number | null
}

/** One discovery_sources row (self-reported channel). */
export interface DiscoverySourceRow {
  id: string
  venue_id: string
  wedding_id: string | null
  canonical_source: string | null
  captured_at: string | null
}

/** One disagreement_findings row (crm_source axis). */
export interface DisagreementCrmSourceRow {
  id: string
  venue_id: string
  wedding_id: string | null
  axis: string
  stated_value: unknown
  forensic_value: unknown
  magnitude_score: number | null
  confidence_0_100: number | null
  status: string
  last_observed_at: string | null
}

export interface MarketingSpendRecord {
  venue_id: string
  channel: string
  spend_date: string | null
  amount_cents: number | null
}

export interface AttributionDataset {
  venueId: string
  venueLabel: string
  attribution: AttributionRow[]
  weddings: WeddingRow[]
  discovery: DiscoverySourceRow[]
  crmSourceDisagreements: DisagreementCrmSourceRow[]
  marketingSpend: MarketingSpendRecord[]
  /** Most-recent intent_classified_at across all attribution rows. */
  data_freshness_iso: string
  /** wedding_id → status/booked map for fast lookup. */
  weddingById: Map<string, WeddingRow>
}

const PAGE_SIZE = 1000

async function pageTable<T>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  venueId: string,
  extra?: (q: ReturnType<SupabaseClient['from']> extends infer R ? unknown : never) => unknown,
  // Use any here to be generous with Supabase's chainable query type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filterFn?: (q: any) => any,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  while (rows.length < 50_000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = sb.from(table).select(columns).eq('venue_id', venueId)
    if (filterFn) q = filterFn(q)
    q = q.range(from, from + PAGE_SIZE - 1)
    const { data, error } = await q
    if (error) throw new Error(`load ${table}: ${error.message}`)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

export async function loadAttributionDataset(
  venueId: string,
  sb: SupabaseClient,
): Promise<AttributionDataset> {
  // Venue label
  let venueLabel = 'venue'
  const { data: venueRow } = await sb
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  if (venueRow && typeof (venueRow as { name?: string }).name === 'string') {
    venueLabel = (venueRow as { name: string }).name
  }

  // attribution_events
  const attribution = await pageTable<AttributionRow>(
    sb,
    'attribution_events',
    'id, venue_id, wedding_id, source_platform, role, intent_class, prompt_version_classified_under, intent_classified_at, decided_at, reverted_at',
    venueId,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.is('reverted_at', null),
  )

  // weddings
  const weddings = await pageTable<WeddingRow>(
    sb,
    'weddings',
    'id, venue_id, status, source, inquiry_date, booked_at, lost_at, booking_value',
    venueId,
  )

  // discovery_sources
  let discovery: DiscoverySourceRow[] = []
  try {
    discovery = await pageTable<DiscoverySourceRow>(
      sb,
      'discovery_sources',
      'id, venue_id, wedding_id, canonical_source, captured_at',
      venueId,
    )
  } catch (err) {
    // discovery_sources may not be populated for every venue; swallow
    // so the page does not 500 on a venue with no Calendly intake.
    discovery = []
    // eslint-disable-next-line no-console
    console.warn('[channel-truth] discovery_sources load failed:', err)
  }

  // disagreement_findings axis=crm_source (Wave 17)
  let crmSourceDisagreements: DisagreementCrmSourceRow[] = []
  try {
    crmSourceDisagreements = await pageTable<DisagreementCrmSourceRow>(
      sb,
      'disagreement_findings',
      'id, venue_id, wedding_id, axis, stated_value, forensic_value, magnitude_score, confidence_0_100, status, last_observed_at',
      venueId,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (q: any) => q.eq('axis', 'crm_source').eq('status', 'active'),
    )
  } catch {
    crmSourceDisagreements = []
  }

  // marketing_spend_records (used by knot_real_cac question)
  let marketingSpend: MarketingSpendRecord[] = []
  try {
    marketingSpend = await pageTable<MarketingSpendRecord>(
      sb,
      'marketing_spend_records',
      'venue_id, channel, spend_date, amount_cents',
      venueId,
    )
  } catch {
    marketingSpend = []
  }

  // Build wedding-by-id map
  const weddingById = new Map<string, WeddingRow>()
  for (const w of weddings) weddingById.set(w.id, w)

  // Data freshness — most-recent classified timestamp.
  let mostRecent: string = '1970-01-01T00:00:00Z'
  for (const a of attribution) {
    if (a.intent_classified_at && a.intent_classified_at > mostRecent) {
      mostRecent = a.intent_classified_at
    }
  }
  if (mostRecent === '1970-01-01T00:00:00Z') {
    // Fallback to decided_at if no intent classification has run.
    for (const a of attribution) {
      if (a.decided_at && a.decided_at > mostRecent) {
        mostRecent = a.decided_at
      }
    }
  }

  return {
    venueId,
    venueLabel,
    attribution,
    weddings,
    discovery,
    crmSourceDisagreements,
    marketingSpend,
    data_freshness_iso: mostRecent,
    weddingById,
  }
}

/**
 * Normalise Knot-ish platform tokens. attribution_events.source_platform
 * has historically had multiple shapes ("the_knot", "theknot",
 * "theknot.com"); collapse for grouping.
 */
export function normalisePlatform(raw: string | null | undefined): string {
  if (!raw) return '(unknown)'
  const s = raw.toLowerCase().trim()
  if (s === 'theknot.com' || s === 'theknot' || s === 'the_knot') return 'the_knot'
  if (s === 'weddingwire.com' || s === 'weddingwire') return 'weddingwire'
  if (s === 'herecomestheguide.com' || s === 'hctg' || s === 'here_comes_the_guide') return 'hctg'
  return s
}

/** Is this an inquiry-funnel platform (the kind Wave 16 cares about)? */
export function isListingPlatform(platform: string): boolean {
  return [
    'the_knot',
    'weddingwire',
    'hctg',
    'brides_com',
    'zola',
    'junebug',
    'carats_cake',
    'style_me_pretty',
  ].includes(platform)
}
