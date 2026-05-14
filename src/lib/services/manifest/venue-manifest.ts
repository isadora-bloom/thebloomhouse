/**
 * Venue Data Manifest
 *
 * Anchor: Round 2 audit Pattern B (AI Without a Map, 2026-05-14).
 * The audit found Briefings hallucinating "80 inquiries" and Ask
 * Anything asking the user for data the system already has. Root
 * cause: AI surfaces get DATA (counts, rows, summaries) but never a
 * SCHEMA that tells them what they have access to, what they don't,
 * and what's out of scope.
 *
 * The manifest is that schema. It's the FIRST chunk of every AI
 * system prompt: "you can answer questions about these tables, in
 * these time windows; the following topics are out of scope; the
 * following integrations are not connected." With the manifest in
 * place, Briefings stops making up numbers (it can see exactly what
 * data exists), NLQ refuses cleanly when out of scope, matching
 * reasoning becomes venue-specific.
 *
 * Agent-side coupling: per the agent-impact pass (2026-05-14), this
 * is also wired into Sage's inquiry brain so drafts can reference
 * real venue stats ("most couples here book within 23 days of
 * inquiring") instead of generic voice-DNA prose.
 *
 * Caching: in-memory map, 1h TTL per venue. Built on-demand. The
 * NOW reference is captured at build time so all time windows in
 * a single manifest are coherent.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export interface ManifestColumn {
  name: string
  type: string
  plain_english: string
  populated_pct: number | null
}

export interface ManifestTable {
  name: string
  display_name: string
  row_count: number
  earliest_date: string | null
  latest_date: string | null
  columns: ManifestColumn[]
  answers: string[]
  joins_to: string[]
}

export interface ManifestOutOfScope {
  topic: string
  reason: string
  redirect?: string
}

export interface ManifestUnconnectedIntegration {
  name: string
  display_name: string
  note: string
}

export interface ManifestTimeWindows {
  inquiry_history_from: string | null
  inquiry_history_to: string | null
  /** Mean (tour_date - inquiry_date) in days. Null when fewer than 5 samples. */
  typical_inquiry_to_tour_days: number | null
  /** Mean (booked_at - tour_date) in days. Null when fewer than 5 samples. */
  typical_tour_to_book_days: number | null
  /** Mean (booked_at - inquiry_date) — full funnel. Null when fewer than 5 samples. */
  typical_inquiry_to_book_days: number | null
  /** Match-eligibility band in days. Tunable per venue; default 180. */
  match_eligibility_band_days: number
  /** True when weather_history has any rows for this venue. */
  weather_history_available: boolean
}

export interface VenueManifest {
  generated_at: string
  venue_id: string
  venue_name: string
  tables: ManifestTable[]
  out_of_scope: ManifestOutOfScope[]
  empty_tables: string[]
  unconnected_integrations: ManifestUnconnectedIntegration[]
  time_windows: ManifestTimeWindows
}

// -----------------------------------------------------------------------
// CACHE
// -----------------------------------------------------------------------

interface CacheEntry {
  manifest: VenueManifest
  expires_at: number
}

const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1h

/** Invalidate the cached manifest for a venue. Call when an
 *  integration connects/disconnects, or a venue config changes
 *  the match-eligibility band. */
export function invalidateVenueManifest(venueId: string): void {
  CACHE.delete(venueId)
}

/** Invalidate every cached manifest. Call from migration deploys. */
export function invalidateAllVenueManifests(): void {
  CACHE.clear()
}

// -----------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------

/**
 * Fetch the manifest for a venue. Cached for 1h.
 * Cold reads cost ~15 small SELECT count(*) queries.
 */
export async function getVenueManifest(venueId: string): Promise<VenueManifest> {
  const now = Date.now()
  const cached = CACHE.get(venueId)
  if (cached && cached.expires_at > now) return cached.manifest

  const manifest = await buildVenueManifest(venueId)
  CACHE.set(venueId, { manifest, expires_at: now + CACHE_TTL_MS })
  return manifest
}

/**
 * Format the manifest as a system-prompt chunk. Designed to be the
 * FIRST section of any AI system prompt — before task instructions,
 * before voice DNA, before anything else. Tells the LLM what it has
 * and what's out of scope.
 */
export function manifestToSystemPrompt(manifest: VenueManifest): string {
  const lines: string[] = []
  lines.push(`# Venue Data Manifest`)
  lines.push(`Venue: ${manifest.venue_name}`)
  lines.push(`Generated: ${manifest.generated_at}`)
  lines.push('')
  lines.push(`## What you can reason about`)
  lines.push('')
  for (const t of manifest.tables) {
    if (t.row_count === 0) continue
    const dateRange =
      t.earliest_date && t.latest_date
        ? ` (${t.earliest_date} → ${t.latest_date})`
        : ''
    lines.push(`### ${t.display_name} (${t.row_count} rows${dateRange})`)
    if (t.answers.length > 0) {
      lines.push(`Answers questions like:`)
      for (const a of t.answers) lines.push(`  - ${a}`)
    }
    lines.push('')
  }

  if (manifest.time_windows.typical_inquiry_to_book_days !== null) {
    lines.push(`## Typical funnel timing for this venue`)
    if (manifest.time_windows.typical_inquiry_to_tour_days !== null) {
      lines.push(
        `- Inquiry to tour: ${manifest.time_windows.typical_inquiry_to_tour_days} days average`,
      )
    }
    if (manifest.time_windows.typical_tour_to_book_days !== null) {
      lines.push(
        `- Tour to booking: ${manifest.time_windows.typical_tour_to_book_days} days average`,
      )
    }
    if (manifest.time_windows.typical_inquiry_to_book_days !== null) {
      lines.push(
        `- Inquiry to booking: ${manifest.time_windows.typical_inquiry_to_book_days} days average`,
      )
    }
    lines.push('')
  }

  if (manifest.empty_tables.length > 0) {
    lines.push(`## Tables that exist but have no data yet for this venue`)
    for (const t of manifest.empty_tables) lines.push(`- ${t}`)
    lines.push('')
  }

  if (manifest.unconnected_integrations.length > 0) {
    lines.push(`## Integrations not connected for this venue`)
    for (const i of manifest.unconnected_integrations) {
      lines.push(`- ${i.display_name}: ${i.note}`)
    }
    lines.push('')
  }

  if (manifest.out_of_scope.length > 0) {
    lines.push(`## Out of scope — refuse cleanly if asked`)
    for (const o of manifest.out_of_scope) {
      const redirect = o.redirect ? ` (Redirect: ${o.redirect})` : ''
      lines.push(`- ${o.topic}: ${o.reason}.${redirect}`)
    }
    lines.push('')
  }

  lines.push(`## Hard rules`)
  lines.push(`1. Never ask the operator to supply data you should have. If a question needs data not in this manifest, refuse cleanly with: "I don't have access to X for your venue. Here's what's adjacent: Y. To get X, [Z]."`)
  lines.push(`2. Use ONLY the tables and time windows declared above. If a question requires data outside these tables, refuse.`)
  lines.push(`3. When using "Out of scope" topics, suggest the redirect surface explicitly.`)
  lines.push(`4. If a metric uses an empty or unconnected source, say so explicitly. Do not fabricate numbers.`)

  return lines.join('\n')
}

// -----------------------------------------------------------------------
// BUILD
// -----------------------------------------------------------------------

async function buildVenueManifest(venueId: string): Promise<VenueManifest> {
  const sb = createServiceClient()

  const [venueRow, tables, timeWindows, emptyTables, unconnected] =
    await Promise.all([
      fetchVenueRow(sb, venueId),
      buildTables(sb, venueId),
      buildTimeWindows(sb, venueId),
      detectEmptyTables(sb, venueId),
      detectUnconnectedIntegrations(sb, venueId),
    ])

  return {
    generated_at: new Date().toISOString(),
    venue_id: venueId,
    venue_name: venueRow?.name ?? '(unnamed)',
    tables,
    out_of_scope: STATIC_OUT_OF_SCOPE,
    empty_tables: emptyTables,
    unconnected_integrations: unconnected,
    time_windows: timeWindows,
  }
}

async function fetchVenueRow(
  sb: SupabaseClient,
  venueId: string,
): Promise<{ name: string } | null> {
  const { data } = await sb
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return (data as { name: string } | null) ?? null
}

async function buildTables(
  sb: SupabaseClient,
  venueId: string,
): Promise<ManifestTable[]> {
  const [
    weddingsStats,
    interactionsStats,
    toursStats,
    attribStats,
    candidatesStats,
    signalsStats,
    peopleStats,
    lostDealsStats,
    cultMomentsStats,
    coupleProfileStats,
  ] = await Promise.all([
    statForTable(sb, 'weddings', 'inquiry_date', venueId),
    statForTable(sb, 'interactions', 'timestamp', venueId),
    statForTable(sb, 'tours', 'scheduled_at', venueId),
    statForTable(sb, 'attribution_events_live', 'decided_at', venueId),
    statForTable(sb, 'candidate_identities', 'created_at', venueId),
    statForTable(sb, 'tangential_signals', 'signal_date', venueId),
    statForTable(sb, 'people', 'created_at', venueId),
    statForTable(sb, 'lost_deals', 'lost_at', venueId),
    statForTable(sb, 'cultural_moments', 'event_date', venueId, { skipVenueScope: true }),
    statForTable(sb, 'couple_identity_profile', 'updated_at', venueId),
  ])

  const tables: ManifestTable[] = [
    {
      name: 'weddings',
      display_name: 'Weddings (couple records)',
      row_count: weddingsStats.count,
      earliest_date: weddingsStats.min,
      latest_date: weddingsStats.max,
      columns: [],
      answers: [
        'How many inquiries did we get last month?',
        'How many weddings booked this year?',
        'How many couples are at the touring stage right now?',
        'Which couples have inquiries older than 30 days without a tour?',
      ],
      joins_to: ['people', 'interactions', 'tours', 'attribution_events_live'],
    },
    {
      name: 'interactions',
      display_name: 'Email + SMS interactions',
      row_count: interactionsStats.count,
      earliest_date: interactionsStats.min,
      latest_date: interactionsStats.max,
      columns: [],
      answers: [
        'How many emails came in last week?',
        'What is our average response time?',
        'Which couples have not heard from us in 14 days?',
      ],
      joins_to: ['weddings', 'people'],
    },
    {
      name: 'tours',
      display_name: 'Scheduled tours',
      row_count: toursStats.count,
      earliest_date: toursStats.min,
      latest_date: toursStats.max,
      columns: [],
      answers: [
        'How many tours are scheduled this month?',
        'What is our tour-to-book conversion rate?',
        'Which weekends have the most tours booked?',
      ],
      joins_to: ['weddings'],
    },
    {
      name: 'attribution_events_live',
      display_name: 'Source attributions (post-dedup, Pattern A)',
      row_count: attribStats.count,
      earliest_date: attribStats.min,
      latest_date: attribStats.max,
      columns: [],
      answers: [
        'Which platform sent us the most inquiries?',
        'How many couples found us via Knot vs Instagram?',
        'Which sources have the best conversion rate?',
      ],
      joins_to: ['weddings', 'candidate_identities', 'tangential_signals'],
    },
    {
      name: 'candidate_identities',
      display_name: 'Platform-signal candidates (not yet matched to weddings)',
      row_count: candidatesStats.count,
      earliest_date: candidatesStats.min,
      latest_date: candidatesStats.max,
      columns: [],
      answers: [
        'How many unmatched browsing signals do we have?',
        'Which platforms have the most unresolved candidates?',
      ],
      joins_to: ['tangential_signals', 'attribution_events_live'],
    },
    {
      name: 'tangential_signals',
      display_name: 'Raw browsing / view / save signals from platforms',
      row_count: signalsStats.count,
      earliest_date: signalsStats.min,
      latest_date: signalsStats.max,
      columns: [],
      answers: [
        'How many people viewed our Knot listing last month?',
        'What is the volume of platform-level interest by month?',
      ],
      joins_to: ['candidate_identities'],
    },
    {
      name: 'people',
      display_name: 'People (couple members + family + planners)',
      row_count: peopleStats.count,
      earliest_date: peopleStats.min,
      latest_date: peopleStats.max,
      columns: [],
      answers: ['How many distinct couples have we tracked?'],
      joins_to: ['weddings', 'contacts'],
    },
    {
      name: 'lost_deals',
      display_name: 'Lost deals (couples who chose another venue or canceled)',
      row_count: lostDealsStats.count,
      earliest_date: lostDealsStats.min,
      latest_date: lostDealsStats.max,
      columns: [],
      answers: [
        'Why did we lose deals this quarter?',
        'What is the most common loss reason?',
        'Which competitors came up most in lost-deal feedback?',
      ],
      joins_to: ['weddings'],
    },
    {
      name: 'cultural_moments',
      display_name: 'Cultural moments + correlations (confirmed by venue)',
      row_count: cultMomentsStats.count,
      earliest_date: cultMomentsStats.min,
      latest_date: cultMomentsStats.max,
      columns: [],
      answers: [
        'Does Stanley Cup viewing weekend affect tour scheduling?',
        'How does Memorial Day weekend perform vs baseline?',
      ],
      joins_to: [],
    },
    {
      name: 'couple_identity_profile',
      display_name: 'Sage forensic identity reconstructions (Wave 4)',
      row_count: coupleProfileStats.count,
      earliest_date: coupleProfileStats.min,
      latest_date: coupleProfileStats.max,
      columns: [],
      answers: [
        'What do we know about a specific couple beyond their name?',
        'Which couples have phantom partner indicators?',
        'What occupations/locations have we forensically inferred?',
      ],
      joins_to: ['weddings'],
    },
  ]

  return tables
}

interface TableStat {
  count: number
  min: string | null
  max: string | null
}

async function statForTable(
  sb: SupabaseClient,
  tableName: string,
  dateCol: string,
  venueId: string,
  opts?: { skipVenueScope?: boolean },
): Promise<TableStat> {
  try {
    let countQuery = sb.from(tableName).select('id', { count: 'exact', head: true })
    if (!opts?.skipVenueScope) countQuery = countQuery.eq('venue_id', venueId)
    const { count } = await countQuery

    // For date min/max we fetch a thin sample and reduce in JS rather
    // than running two more queries. 5000 row cap keeps cost bounded.
    let dateQuery = sb.from(tableName).select(`${dateCol}`).order(dateCol, { ascending: true }).limit(1)
    if (!opts?.skipVenueScope) dateQuery = dateQuery.eq('venue_id', venueId)
    const { data: minRow } = await dateQuery

    let maxQuery = sb.from(tableName).select(`${dateCol}`).order(dateCol, { ascending: false }).limit(1)
    if (!opts?.skipVenueScope) maxQuery = maxQuery.eq('venue_id', venueId)
    const { data: maxRow } = await maxQuery

    const minVal = ((minRow?.[0] as Record<string, string | null> | undefined)?.[dateCol]) ?? null
    const maxVal = ((maxRow?.[0] as Record<string, string | null> | undefined)?.[dateCol]) ?? null

    return {
      count: count ?? 0,
      min: minVal ? formatDate(minVal) : null,
      max: maxVal ? formatDate(maxVal) : null,
    }
  } catch {
    return { count: 0, min: null, max: null }
  }
}

function formatDate(iso: string): string {
  return iso.split('T')[0]
}

async function buildTimeWindows(
  sb: SupabaseClient,
  venueId: string,
): Promise<ManifestTimeWindows> {
  // Inquiry history range
  const { data: inqMin } = await sb
    .from('weddings')
    .select('inquiry_date')
    .eq('venue_id', venueId)
    .not('inquiry_date', 'is', null)
    .order('inquiry_date', { ascending: true })
    .limit(1)
  const { data: inqMax } = await sb
    .from('weddings')
    .select('inquiry_date')
    .eq('venue_id', venueId)
    .not('inquiry_date', 'is', null)
    .order('inquiry_date', { ascending: false })
    .limit(1)

  // Funnel-timing averages. Sample-bounded for cost; ignore outliers
  // beyond reasonable bands.
  const { data: sample } = await sb
    .from('weddings')
    .select('inquiry_date, tour_date, booked_at')
    .eq('venue_id', venueId)
    .not('inquiry_date', 'is', null)
    .order('inquiry_date', { ascending: false })
    .limit(500)
  const inqToTour: number[] = []
  const tourToBook: number[] = []
  const inqToBook: number[] = []
  for (const r of (sample ?? []) as Array<{
    inquiry_date: string | null
    tour_date: string | null
    booked_at: string | null
  }>) {
    const inq = r.inquiry_date ? new Date(r.inquiry_date).getTime() : null
    const tour = r.tour_date ? new Date(r.tour_date).getTime() : null
    const book = r.booked_at ? new Date(r.booked_at).getTime() : null
    if (inq && tour) {
      const d = (tour - inq) / 86400000
      if (d > 0 && d < 365) inqToTour.push(d)
    }
    if (tour && book) {
      const d = (book - tour) / 86400000
      if (d > 0 && d < 365) tourToBook.push(d)
    }
    if (inq && book) {
      const d = (book - inq) / 86400000
      if (d > 0 && d < 730) inqToBook.push(d)
    }
  }

  // Weather history availability — flag set when we have at least 1 row.
  let weatherAvailable = false
  try {
    const { count } = await sb
      .from('weather_history')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .limit(1)
    weatherAvailable = (count ?? 0) > 0
  } catch {
    // Table may not exist yet; ignore.
  }

  // Match-eligibility band. Venue-tunable per TIER 2a; default 180d
  // until per-venue config lands. (Until then the resolver uses
  // PerPlatformWindowMap defaults; manifest reflects the policy.)
  const matchBand = 180

  return {
    inquiry_history_from: (inqMin?.[0] as { inquiry_date: string | null } | undefined)?.inquiry_date
      ? formatDate(((inqMin?.[0] as { inquiry_date: string }).inquiry_date))
      : null,
    inquiry_history_to: (inqMax?.[0] as { inquiry_date: string | null } | undefined)?.inquiry_date
      ? formatDate(((inqMax?.[0] as { inquiry_date: string }).inquiry_date))
      : null,
    typical_inquiry_to_tour_days: avg(inqToTour),
    typical_tour_to_book_days: avg(tourToBook),
    typical_inquiry_to_book_days: avg(inqToBook),
    match_eligibility_band_days: matchBand,
    weather_history_available: weatherAvailable,
  }
}

function avg(xs: number[]): number | null {
  if (xs.length < 5) return null
  const sum = xs.reduce((a, b) => a + b, 0)
  return Math.round(sum / xs.length)
}

async function detectEmptyTables(
  sb: SupabaseClient,
  venueId: string,
): Promise<string[]> {
  const empty: string[] = []
  const checks: Array<{ table: string; display: string }> = [
    { table: 'reviews', display: 'Reviews (Google/Knot/WW)' },
    { table: 'website_traffic_history', display: 'Website traffic (GA4)' },
    { table: 'marketing_spend', display: 'Marketing spend' },
    { table: 'weather_history', display: 'Weather history' },
  ]
  for (const c of checks) {
    try {
      const { count } = await sb
        .from(c.table)
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .limit(1)
      if ((count ?? 0) === 0) empty.push(c.display)
    } catch {
      empty.push(c.display)
    }
  }
  return empty
}

async function detectUnconnectedIntegrations(
  sb: SupabaseClient,
  venueId: string,
): Promise<ManifestUnconnectedIntegration[]> {
  const out: ManifestUnconnectedIntegration[] = []

  // Gmail
  const { count: gmailCount } = await sb
    .from('gmail_connections')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  if ((gmailCount ?? 0) === 0) {
    out.push({
      name: 'gmail',
      display_name: 'Gmail',
      note: 'Sage will not be able to read inbound email or send replies.',
    })
  }

  // Google Ads — table may not exist; treat as unconnected.
  try {
    const { count } = await sb
      .from('google_ads_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
    if ((count ?? 0) === 0) {
      out.push({
        name: 'google_ads',
        display_name: 'Google Ads',
        note: 'Ad spend + impression data unavailable. Cost-per-lead numbers will be partial.',
      })
    }
  } catch {
    out.push({
      name: 'google_ads',
      display_name: 'Google Ads',
      note: 'Ad spend + impression data unavailable. Cost-per-lead numbers will be partial.',
    })
  }

  // Meta Ads
  try {
    const { count } = await sb
      .from('meta_ads_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
    if ((count ?? 0) === 0) {
      out.push({
        name: 'meta_ads',
        display_name: 'Meta Ads (Instagram + Facebook)',
        note: 'Paid social spend + reach data unavailable.',
      })
    }
  } catch {
    out.push({
      name: 'meta_ads',
      display_name: 'Meta Ads (Instagram + Facebook)',
      note: 'Paid social spend + reach data unavailable.',
    })
  }

  return out
}

// -----------------------------------------------------------------------
// STATIC OUT OF SCOPE
// -----------------------------------------------------------------------
// These are topics that live in adjacent systems and should never be
// answered by Bloom. The LLM uses these to refuse cleanly with a
// redirect.

const STATIC_OUT_OF_SCOPE: ManifestOutOfScope[] = [
  {
    topic: 'Contract terms and signed agreements',
    reason: 'Contracts live in ContractHouse, separate from Bloom',
    redirect: 'Ask in /contracts on ContractHouse',
  },
  {
    topic: 'Payment processing, refunds, bank balance',
    reason: 'Payment flows live in ContractHouse + Stripe',
    redirect: 'Check Stripe dashboard or ContractHouse',
  },
  {
    topic: 'Couple-portal direct messages (read-only here)',
    reason: 'The couple-facing portal is a separate surface',
    redirect: 'Open the couple portal directly',
  },
  {
    topic: 'Vendor introductions / preferred-vendor matchmaking',
    reason: 'Bloom does not track vendor relationships beyond storage',
    redirect: 'Refer the operator to their internal vendor list',
  },
  {
    topic: 'Detailed catering / menu / floor-plan decisions',
    reason: 'Lives in the couple portal + operator notes, not in Bloom intel',
    redirect: 'Open the couple portal for the wedding in question',
  },
]
