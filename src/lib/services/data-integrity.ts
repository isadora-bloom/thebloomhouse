/**
 * Data integrity invariants — shared module.
 *
 * Same 8 invariants the CLI runs in scripts/data-integrity-check.ts.
 * Extracted so the daily cron sweep (src/app/api/cron/data-integrity-sweep/
 * route.ts) calls the exact same logic, guaranteeing the script and
 * the cron always agree on what "data-integrity-clean" means.
 *
 * Each invariant returns an array of violations; clean = empty.
 *
 * Why these specific invariants:
 *   The 2026-04-30 Rixey timeline-corruption sweep uncovered 4
 *   distinct corruption patterns (time conflation, direction
 *   misclassification, source inheritance, inquiry mispinning). Each
 *   pattern leaves a specific signature in the data; the invariants
 *   below check for those signatures plus 3 structural sanity
 *   invariants (orphan weddings, future timestamps, dedup).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface InvariantResult {
  /** Stable identifier — used in intelligence_insights.context_id and JSON output. */
  id: string
  /** Human-readable name for the cron's body field + CLI output. */
  name: string
  /** Why a violation matters; surfaces in the anomalies UI. */
  meaning: string
  /** Total violation count. */
  count: number
  /** Up to N example violations. */
  sample: Record<string, unknown>[]
}

const SAMPLE_LIMIT = 10

interface RawWedding {
  id: string
  inquiry_date: string | null
  tour_date: string | null
  status?: string | null
  source?: string | null
}

interface RawInteraction {
  id: string
  direction: string | null
  from_email: string | null
  subject?: string | null
  timestamp?: string | null
  gmail_message_id?: string | null
}

async function checkCausality(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data } = await sb
    .from('weddings')
    .select('id, inquiry_date, tour_date')
    .eq('venue_id', venueId)
    .not('tour_date', 'is', null)
    .not('inquiry_date', 'is', null)
  const rows = ((data ?? []) as Array<RawWedding & { inquiry_date: string; tour_date: string }>)
  const violations: Record<string, unknown>[] = []
  for (const w of rows) {
    const inq = new Date(w.inquiry_date).getTime()
    const tour = new Date(w.tour_date).getTime()
    if (tour < inq - 24 * 3_600_000) violations.push({ wedding_id: w.id, inquiry_date: w.inquiry_date, tour_date: w.tour_date })
  }
  return {
    id: 'causality_tour_before_inquiry',
    name: 'Tour completed before inquiry received',
    meaning: 'A wedding whose tour_date precedes its inquiry_date by >24h indicates corrupted timestamps. The tour cannot logically happen before the customer inquired.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkDirectionParity(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data: ownData } = await sb
    .from('interactions')
    .select('from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .not('from_email', 'is', null)
  const own = new Set<string>()
  for (const r of (ownData ?? []) as Array<{ from_email: string | null }>) {
    const e = (r.from_email ?? '').toLowerCase().trim()
    if (e) own.add(e)
  }
  if (own.size === 0) {
    return {
      id: 'direction_from_venue_own',
      name: 'Inbound interaction from a venue-owned address',
      meaning: 'No outbound history yet; check is trivially clean for new venues.',
      count: 0,
      sample: [],
    }
  }
  const { data: bad } = await sb
    .from('interactions')
    .select('id, direction, from_email, subject, timestamp')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .in('from_email', Array.from(own))
    .limit(SAMPLE_LIMIT * 5)
  const violations = ((bad ?? []) as RawInteraction[])
  return {
    id: 'direction_from_venue_own',
    name: 'Inbound interaction from a venue-owned address',
    meaning: 'An interaction marked direction=inbound but from_email is the venue\'s own sending address means a Sage outbound was misclassified. Cascades into signal-inference firing on our own marketing copy and inflating heat scores.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT) as unknown as Record<string, unknown>[],
  }
}

async function checkFalsePositiveEvents(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data: outboundIds } = await sb
    .from('interactions')
    .select('id')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
  const ids = ((outboundIds ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) {
    return {
      id: 'engagement_event_on_outbound',
      name: 'Engagement event tied to an outbound interaction',
      meaning: 'No outbound interactions; check is trivially clean.',
      count: 0,
      sample: [],
    }
  }
  const { data: events } = await sb
    .from('engagement_events')
    .select('id, event_type, metadata, occurred_at')
    .eq('venue_id', venueId)
    .in('event_type', [
      'tour_requested', 'high_specificity', 'sustained_engagement',
      'high_commitment_signal', 'email_reply_received',
    ])
    .limit(5000)
  const idSet = new Set(ids)
  const violations: Record<string, unknown>[] = []
  for (const e of ((events ?? []) as Array<{ id: string; event_type: string; metadata: { interaction_id?: string | null } | null; occurred_at: string | null }>)) {
    const iid = e.metadata?.interaction_id
    if (iid && idSet.has(iid)) violations.push(e as unknown as Record<string, unknown>)
  }
  return {
    id: 'engagement_event_on_outbound',
    name: 'Signal-inference event fired on an outbound interaction',
    meaning: 'An engagement_event whose interaction_id points to an outbound row means signal-inference matched patterns on our own marketing copy. Inflates heat. Delete the false positive and recompute heat.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkInquiryParity(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', venueId)
  const violations: Record<string, unknown>[] = []
  for (const w of ((weddings ?? []) as Array<{ id: string; inquiry_date: string | null }>)) {
    if (!w.inquiry_date) continue
    const { data: first } = await sb
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .not('timestamp', 'is', null)
      .order('timestamp', { ascending: true })
      .limit(1)
    const earliest = (first?.[0] as { timestamp: string } | undefined)?.timestamp
    if (!earliest) continue
    const drift = Math.abs(new Date(earliest).getTime() - new Date(w.inquiry_date).getTime()) / 3_600_000
    if (drift >= 48) {
      violations.push({ wedding_id: w.id, inquiry_date: w.inquiry_date, earliest_inbound: earliest, drift_hours: Math.round(drift) })
      if (violations.length >= SAMPLE_LIMIT * 5) break
    }
  }
  return {
    id: 'inquiry_date_drift',
    name: 'Wedding inquiry_date drifts >48h from earliest inbound interaction',
    meaning: 'Suggests inquiry_date was stamped to wall-clock NOW (backfill artifact) or pinned to a later non-inquiry email. Blocks accurate first-touch attribution.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkWeddingHasPeople(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, source')
    .eq('venue_id', venueId)
  const violations: Record<string, unknown>[] = []
  for (const w of ((weddings ?? []) as Array<RawWedding>)) {
    const { count } = await sb
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', w.id)
    if ((count ?? 0) === 0) {
      violations.push({ wedding_id: w.id, status: w.status, source: w.source })
      if (violations.length >= SAMPLE_LIMIT * 5) break
    }
  }
  return {
    id: 'wedding_has_people',
    name: 'Wedding row with zero linked people (ghost lead)',
    meaning: 'A wedding without people is invisible on the leads UI and breaks contact resolution. Either repopulate the person or delete the wedding.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkNoFutureEvents(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const nowIso = new Date().toISOString()
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, inquiry_date, tour_date')
    .eq('venue_id', venueId)
  const violations: Record<string, unknown>[] = []
  for (const w of ((weddings ?? []) as Array<RawWedding>)) {
    if (w.inquiry_date && w.inquiry_date > nowIso) {
      violations.push({ wedding_id: w.id, field: 'inquiry_date', value: w.inquiry_date })
    }
    if (w.status === 'tour_completed' && w.tour_date && w.tour_date > nowIso) {
      violations.push({ wedding_id: w.id, field: 'tour_date_when_completed', value: w.tour_date, status: w.status })
    }
    if (violations.length >= SAMPLE_LIMIT * 5) break
  }
  return {
    id: 'no_future_event_times',
    name: 'Wedding with inquiry/tour timestamp in the future',
    meaning: 'Catches pipeline bugs that stamp temporal fields from email body parses (e.g. parsing a date from a forward-dated email signature) or from wall-clock NOW after a system clock skew.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkDuplicateGmailIds(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const { data: ints } = await sb
    .from('interactions')
    .select('id, gmail_message_id')
    .eq('venue_id', venueId)
    .not('gmail_message_id', 'is', null)
  const counts = new Map<string, string[]>()
  for (const r of ((ints ?? []) as Array<{ id: string; gmail_message_id: string | null }>)) {
    if (!r.gmail_message_id) continue
    const arr = counts.get(r.gmail_message_id) ?? []
    arr.push(r.id)
    counts.set(r.gmail_message_id, arr)
  }
  const violations: Record<string, unknown>[] = []
  for (const [mid, ids] of counts.entries()) {
    if (ids.length > 1) {
      violations.push({ gmail_message_id: mid, dup_count: ids.length, interaction_ids: ids.slice(0, 5) })
    }
  }
  return {
    id: 'duplicate_gmail_message_ids',
    name: 'Same Gmail message_id ingested more than once',
    meaning: 'The dedup logic in email-pipeline.isEmailProcessed failed. Causes double-counted replies, duplicate engagement events, inflated heat. Check the dedup keys when this fires.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

async function checkSourceConsistency(sb: SupabaseClient, venueId: string): Promise<InvariantResult> {
  const KNOWN_DOMAINS: Record<string, string> = {
    '@calendly.com': 'calendly',
    '@calendlymail.com': 'calendly',
    '@acuityscheduling.com': 'acuity',
    '@honeybook.com': 'honeybook',
    '@dubsado.com': 'dubsado',
    '@theknot.com': 'the_knot',
    '@knotemail.com': 'the_knot',
    '@weddingwire.com': 'wedding_wire',
    '@herecomestheguide.com': 'here_comes_the_guide',
  }
  const { data: tps } = await sb
    .from('wedding_touchpoints')
    .select('id, touch_type, source, metadata')
    .eq('venue_id', venueId)
    .in('touch_type', ['tour_booked', 'calendly_booked', 'inquiry', 'email_reply', 'tour_conducted'])
  const violations: Record<string, unknown>[] = []
  for (const tp of ((tps ?? []) as Array<{ id: string; touch_type: string; source: string | null; metadata: { interaction_id?: string | null; engagement_event_id?: string | null } | null }>)) {
    let iid = tp.metadata?.interaction_id ?? null
    if (!iid && tp.metadata?.engagement_event_id) {
      const { data: ee } = await sb
        .from('engagement_events')
        .select('metadata')
        .eq('id', tp.metadata.engagement_event_id)
        .maybeSingle()
      iid = ((ee as { metadata: { interaction_id?: string | null } | null } | null)?.metadata?.interaction_id) ?? null
    }
    if (!iid) continue
    const { data: ix } = await sb.from('interactions').select('from_email').eq('id', iid).maybeSingle()
    const fromEmail = (((ix as { from_email: string | null } | null)?.from_email) ?? '').toLowerCase()
    if (!fromEmail) continue
    for (const [domain, expectedSource] of Object.entries(KNOWN_DOMAINS)) {
      if (fromEmail.includes(domain) && tp.source !== expectedSource) {
        violations.push({
          touchpoint_id: tp.id,
          touch_type: tp.touch_type,
          current_source: tp.source,
          expected_source: expectedSource,
          from_email: fromEmail,
        })
        break
      }
    }
    if (violations.length >= SAMPLE_LIMIT * 5) break
  }
  return {
    id: 'touchpoint_source_consistency',
    name: 'Touchpoint source disagrees with linked interaction\'s channel',
    meaning: 'A tour_booked touchpoint with source=website but linked to a Calendly notification means the touchpoint inherited the wedding\'s legacy first-touch source. Renders wrong channel labels in the journey UI.',
    count: violations.length,
    sample: violations.slice(0, SAMPLE_LIMIT),
  }
}

/**
 * Run all invariants for one venue and return the result array.
 * Order is deterministic so coordinator UIs and JSON consumers can
 * rely on positional indexing.
 */
export async function runDataIntegrityChecks(
  sb: SupabaseClient,
  venueId: string,
): Promise<InvariantResult[]> {
  return Promise.all([
    checkCausality(sb, venueId),
    checkDirectionParity(sb, venueId),
    checkFalsePositiveEvents(sb, venueId),
    checkInquiryParity(sb, venueId),
    checkWeddingHasPeople(sb, venueId),
    checkNoFutureEvents(sb, venueId),
    checkDuplicateGmailIds(sb, venueId),
    checkSourceConsistency(sb, venueId),
  ])
}

/**
 * Sweep every venue, run the invariants, and persist current
 * violations as `anomaly_alerts` rows so coordinators see them
 * on /intel/anomalies (which reads from anomaly_alerts, not
 * intelligence_insights). Idempotent — one row per (venue,
 * invariant) pair; updated daily.
 *
 * Self-heal: when an invariant returns 0 violations on a venue
 * that previously had an unacknowledged data-integrity row, the
 * row is deleted. The anomaly_alerts table doesn't have a
 * 'resolved' state distinct from 'acknowledged', so deletion
 * keeps the alert list focused on currently-open issues. The
 * audit trail of past data-integrity violations lives in git
 * commits + the playbook, not in anomaly_alerts.
 */
export async function runDataIntegritySweepAllVenues(
  sb: SupabaseClient,
): Promise<{
  venues_scanned: number
  anomalies_opened: number
  anomalies_updated: number
  anomalies_resolved: number
  errors: string[]
}> {
  const summary = { venues_scanned: 0, anomalies_opened: 0, anomalies_updated: 0, anomalies_resolved: 0, errors: [] as string[] }
  const { data: venues } = await sb
    .from('venues')
    .select('id, name')
  for (const venue of (venues ?? []) as Array<{ id: string; name: string }>) {
    summary.venues_scanned++
    let results: InvariantResult[]
    try {
      results = await runDataIntegrityChecks(sb, venue.id)
    } catch (err) {
      summary.errors.push(`${venue.name}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // Pull existing data_integrity rows for this venue. metric_name
    // holds the invariant id so we can find existing rows to upsert.
    const { data: openRows } = await sb
      .from('anomaly_alerts')
      .select('id, metric_name')
      .eq('venue_id', venue.id)
      .eq('alert_type', 'data_integrity')
    const openByInvariant = new Map<string, { id: string }>()
    for (const r of (openRows ?? []) as Array<{ id: string; metric_name: string }>) {
      openByInvariant.set(r.metric_name, { id: r.id })
    }

    for (const r of results) {
      const existing = openByInvariant.get(r.id) ?? null

      if (r.count === 0) {
        if (existing) {
          // Self-heal: clean now → drop the row. Idempotent re-runs
          // of this sweep won't spam the alerts list.
          await sb
            .from('anomaly_alerts')
            .delete()
            .eq('id', existing.id)
          summary.anomalies_resolved++
        }
        continue
      }

      // The /intel/anomalies UI expects causes as an array where
      // each row has cause/likelihood/action fields. Map our
      // sample violations into that shape so the page renders.
      const causes = r.sample.slice(0, 5).map((s) => ({
        cause: JSON.stringify(s),
        likelihood: 'high' as const,
        action: 'Run scripts/onboard-data-cleanup.ts --apply for this venue, then re-run the integrity check.',
        source: 'data_integrity',
        invariant_id: r.id,
      }))
      if (existing) {
        await sb
          .from('anomaly_alerts')
          .update({
            current_value: r.count,
            ai_explanation: r.meaning,
            causes,
          })
          .eq('id', existing.id)
        summary.anomalies_updated++
      } else {
        await sb
          .from('anomaly_alerts')
          .insert({
            venue_id: venue.id,
            alert_type: 'data_integrity',
            metric_name: r.id,
            current_value: r.count,
            severity: 'warning',
            ai_explanation: r.meaning,
            causes,
            acknowledged: false,
          })
        summary.anomalies_opened++
      }
    }
  }
  return summary
}
