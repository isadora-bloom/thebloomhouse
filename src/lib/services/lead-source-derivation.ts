/**
 * Lead-source derivation cron + audit (Stream KK / migration 177).
 *
 * For each active wedding (`merged_into_id IS NULL`) where
 * `lead_source IS NULL`, walks a 6-tier priority chain to backfill
 * the canonical first-touch lead source:
 *
 *   Priority 0 (skip): coordinator override via `attribution_priority`
 *     (rarely set; respects a per-wedding hand-curated value).
 *
 *   Priority 1: explicit `lead_source` from `source_records[]` —
 *     any reconciliation-merged loser that carried a lead_source
 *     value. (This is the "Calendly tour Q&A filled the HoneyBook gap"
 *     path materialized after reconciliation.) Confidence: high.
 *
 *   Priority 2: tour-event Q&A. Look at scheduling_events /
 *     interactions linked to this wedding for a parsed
 *     "where did you hear about us?" answer. Confidence: high.
 *
 *   Priority 3: web-form / calculator submission. If the wedding has
 *     an interaction whose source is a web form, lead_source = 'website'.
 *     Confidence: medium.
 *
 *   Priority 4: inbound email from-domain analysis. Map the earliest
 *     inbound interaction's sender domain to a known channel
 *     (knot/weddingwire/zola → that platform; common consumer-mail →
 *     'direct'). Confidence: medium.
 *
 *   Priority 5: UTM tag from any attribution_event. Pull
 *     attribution_events whose evidence references a utm_source on
 *     the candidate's first signal. Confidence: low.
 *
 *   Priority 6: leave NULL with reason='no_signal'. Confidence: low.
 *
 * Each decision writes a `lead_source_derivation_log` row. Coordinator
 * override (POST /api/intel/clients/[id]/lead-source-override) writes
 * a `decided_by='coordinator'` row AND stamps
 * `weddings.attribution_priority` so future cron re-runs skip the
 * default chain.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DerivationPriority = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type DerivationConfidence = 'high' | 'medium' | 'low'

export interface DerivedLeadSource {
  source: string | null
  priority: DerivationPriority
  confidence: DerivationConfidence
  evidence: Record<string, unknown>
}

export interface DerivationLogRow {
  id: string
  venue_id: string
  wedding_id: string
  derived_at: string
  derived_source: string | null
  priority_used: number
  evidence: Record<string, unknown>
  confidence: DerivationConfidence
  decided_by: 'auto' | 'coordinator' | 'reconcile'
  decided_by_user_id: string | null
  reason: string | null
}

// ---------------------------------------------------------------------------
// Email-domain → channel map (Priority 4)
// ---------------------------------------------------------------------------

const PLATFORM_DOMAIN_MAP: Record<string, string> = {
  // Vendor platforms — when a relay email comes from these, the lead
  // is from that platform.
  'theknot.com': 'the_knot',
  'mail.theknot.com': 'the_knot',
  'auth.theknot.com': 'the_knot',
  'weddingwire.com': 'weddingwire',
  'mail.weddingwire.com': 'weddingwire',
  'authsolic.com': 'weddingwire',
  'zola.com': 'zola',
  'mail.zola.com': 'zola',
  'herecomestheguide.com': 'herecomestheguide',
  'wedsites.com': 'wedsites',
  'honeybook.com': 'honeybook',
  'calendly.com': 'calendly',
  'acuityscheduling.com': 'acuity',
}

const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me',
])

function classifyDomain(domain: string): { source: string; confidence: DerivationConfidence } | null {
  const d = domain.toLowerCase().trim()
  if (!d) return null
  if (PLATFORM_DOMAIN_MAP[d]) return { source: PLATFORM_DOMAIN_MAP[d], confidence: 'medium' }
  // Subdomain match — e.g. "newsletter.theknot.com".
  for (const [k, v] of Object.entries(PLATFORM_DOMAIN_MAP)) {
    if (d.endsWith('.' + k) || d === k) return { source: v, confidence: 'medium' }
  }
  if (CONSUMER_MAIL_DOMAINS.has(d)) return { source: 'direct', confidence: 'low' }
  return null
}

// ---------------------------------------------------------------------------
// Priority chain executor
// ---------------------------------------------------------------------------

interface WeddingForDerivation {
  id: string
  venue_id: string
  inquiry_date: string | null
  source_records: unknown[]
  attribution_priority: { priority?: string[] } | null
  source: string | null
  source_detail: string | null
}

async function tryPriority1ExplicitFromSourceRecords(
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource | null> {
  const records = (wedding.source_records ?? []) as Array<Record<string, unknown>>
  for (const rec of records) {
    const fields = Array.isArray(rec.fields_provided) ? (rec.fields_provided as string[]) : []
    if (fields.includes('lead_source')) {
      // Pull the actual value from the rec — recorded by the
      // reconciliation backfill plan.
      const v = rec.value ?? rec.lead_source ?? rec.source
      if (v && typeof v === 'string') {
        return {
          source: v,
          priority: 1,
          confidence: 'high',
          evidence: { source_record: rec },
        }
      }
    }
    // Even without an explicit fields_provided entry, a CRM source
    // record with a `source` value is a hint. Use it but mark medium.
    if (rec.source && typeof rec.source === 'string' && rec.source !== 'unknown') {
      return {
        source: rec.source as string,
        priority: 1,
        confidence: 'medium',
        evidence: { source_record: rec, note: 'inferred from source_records[].source' },
      }
    }
  }
  return null
}

async function tryPriority2TourQa(
  supabase: SupabaseClient,
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource | null> {
  // Look at scheduling_events / interactions whose extracted body
  // includes a "where did you hear about us?" answer. The Calendly
  // parser already extracts hearSource. We check:
  //   (a) interactions.extracted_identity (jsonb) — may contain
  //       hear_source under a parsed field.
  //   (b) interactions.subject + full_body for the literal Q.
  const { data: interactions, error } = await supabase
    .from('interactions')
    .select('id, subject, full_body, extracted_identity, timestamp, type')
    .eq('wedding_id', wedding.id)
    .order('timestamp', { ascending: true })
    .limit(20)
  if (error) return null

  for (const i of (interactions ?? []) as Array<Record<string, unknown>>) {
    const ei = i.extracted_identity as Record<string, unknown> | null | undefined
    const hearFromExtracted = ei && typeof ei === 'object'
      ? (ei.hear_source ?? ei.hearSource ?? ei.where_did_you_hear) as string | undefined
      : undefined
    if (hearFromExtracted && typeof hearFromExtracted === 'string') {
      const normalised = normaliseHearSource(hearFromExtracted)
      // T5-Rixey-NN bug #7: never stamp an HTML fragment onto lead_source.
      if (!looksLikeHtmlFragment(normalised) && normalised) {
        return {
          source: normalised,
          priority: 2,
          confidence: 'high',
          evidence: {
            interaction_id: i.id,
            question: 'where did you hear about us',
            answer: hearFromExtracted,
          },
        }
      }
    }
    // Body-scan fallback.
    // T5-Rixey-NN bug #7: web-form bodies can contain raw HTML —
    // strip tags before regex-matching so '</strong>' / '<br>' / etc.
    // never leak into the captured answer chunk.
    const body = stripHtml(String(i.full_body ?? ''))
    const m = body.match(/where did you (?:first )?hear about us[^\n]*[:?]\s*([^\n]{1,200})/i)
    if (m && m[1].trim()) {
      const ans = m[1].trim().replace(/^[-:]\s*/, '')
      const normalised = normaliseHearSource(ans)
      // Final guard — if the normalised value still looks like HTML
      // (defensive, normaliseHearSource already strips tags), skip.
      if (looksLikeHtmlFragment(normalised) || !normalised) continue
      return {
        source: normalised,
        priority: 2,
        confidence: 'high',
        evidence: {
          interaction_id: i.id,
          question: 'where did you hear about us',
          answer: ans,
          extraction: 'body_regex',
        },
      }
    }
  }
  return null
}

async function tryPriority3WebForm(
  supabase: SupabaseClient,
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource | null> {
  // Calculator + web-form submissions land as interactions whose type
  // is 'form' OR whose source is a known web-form provenance. We check
  // on `crm_source` first; failing that, on subject prefix.
  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, type, subject, crm_source, timestamp')
    .eq('wedding_id', wedding.id)
    .order('timestamp', { ascending: true })
    .limit(20)
  for (const i of (interactions ?? []) as Array<Record<string, unknown>>) {
    const subj = String(i.subject ?? '').toLowerCase()
    const type = String(i.type ?? '').toLowerCase()
    if (type === 'form' || type === 'website_submission' || subj.includes('calculator') || subj.includes('quote request')) {
      return {
        source: 'website',
        priority: 3,
        confidence: 'medium',
        evidence: { interaction_id: i.id, type, subject: subj },
      }
    }
  }
  return null
}

async function tryPriority4EmailDomain(
  supabase: SupabaseClient,
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource | null> {
  // Earliest inbound interaction's from-domain.
  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, from_email, direction, timestamp')
    .eq('wedding_id', wedding.id)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: true })
    .limit(5)
  for (const i of (interactions ?? []) as Array<Record<string, unknown>>) {
    const from = String(i.from_email ?? '')
    const at = from.indexOf('@')
    if (at < 0) continue
    const domain = from.slice(at + 1).toLowerCase()
    const cls = classifyDomain(domain)
    if (cls) {
      return {
        source: cls.source,
        priority: 4,
        confidence: cls.confidence,
        evidence: { interaction_id: i.id, from, domain },
      }
    }
  }
  return null
}

async function tryPriority5UtmFromAttributionEvents(
  supabase: SupabaseClient,
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource | null> {
  // attribution_events.signal_id → tangential_signals (which carry
  // raw_payload jsonb that may include a utm_source). Cheap check:
  // if any attribution_event for this wedding has a signal whose
  // raw payload mentions utm, surface that.
  const { data: events } = await supabase
    .from('attribution_events')
    .select('id, signal_id, source_platform, is_first_touch')
    .eq('wedding_id', wedding.id)
    .order('decided_at', { ascending: true })
    .limit(10)
  if (!events || events.length === 0) return null

  // Prefer is_first_touch event.
  const sorted = [...events].sort((a, b) => {
    const ai = (a as { is_first_touch?: boolean }).is_first_touch ? 1 : 0
    const bi = (b as { is_first_touch?: boolean }).is_first_touch ? 1 : 0
    return bi - ai
  })

  for (const ev of sorted as Array<Record<string, unknown>>) {
    if (!ev.signal_id) continue
    const { data: sig } = await supabase
      .from('tangential_signals')
      .select('id, raw_payload, source_platform')
      .eq('id', ev.signal_id)
      .maybeSingle()
    if (!sig) continue
    const raw = (sig as { raw_payload?: Record<string, unknown> | null }).raw_payload
    if (raw && typeof raw === 'object') {
      const utm = (raw.utm_source ?? raw.utm_campaign ?? raw.utm_medium) as string | undefined
      if (utm && typeof utm === 'string') {
        return {
          source: `utm:${utm}`,
          priority: 5,
          confidence: 'low',
          evidence: { attribution_event_id: ev.id, signal_id: sig.id, utm },
        }
      }
    }
    // Even without UTM, an attribution event tells us something.
    const platform = String(sig.source_platform ?? ev.source_platform ?? '')
    if (platform) {
      return {
        source: platform,
        priority: 5,
        confidence: 'low',
        evidence: { attribution_event_id: ev.id, signal_id: sig.id, platform },
      }
    }
  }
  return null
}

/**
 * T5-Rixey-NN bug #7: web-form bodies often contain raw HTML
 * ("<strong>Where did you hear about us?</strong> The Knot"). The
 * priority-2 body-regex captures the chunk after "?" and before the
 * next newline — which can be `</strong>` followed by the actual
 * answer on a new line. Strip HTML tags + collapse whitespace before
 * pattern-matching so the canonical channel name surfaces instead of
 * a tag fragment.
 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')          // strip tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Returns true if a derived lead-source value looks like an HTML
 * fragment (e.g. '</strong>', '<br>', etc.). Such values must never
 * land in weddings.lead_source — the derivation chain should fall
 * through to lower-priority strategies. Per T5-Rixey-NN bug #7.
 */
function looksLikeHtmlFragment(s: string | null | undefined): boolean {
  if (!s) return false
  return /[<>]/.test(s)
}

function normaliseHearSource(answer: string): string {
  // Strip HTML before classifying so '<strong>The Knot</strong>' still
  // resolves to 'the_knot' and we don't return a literal tag fragment.
  const cleaned = stripHtml(answer)
  const a = cleaned.toLowerCase().trim()
  if (!a) return ''
  if (/knot/.test(a)) return 'the_knot'
  if (/wedding ?wire/.test(a)) return 'weddingwire'
  if (/zola/.test(a)) return 'zola'
  if (/here ?comes ?the ?guide/.test(a)) return 'herecomestheguide'
  if (/instagram|insta\b|ig\b/.test(a)) return 'instagram'
  if (/facebook|fb\b/.test(a)) return 'facebook'
  if (/tik ?tok/.test(a)) return 'tiktok'
  if (/pinterest/.test(a)) return 'pinterest'
  if (/google/.test(a)) return 'google'
  if (/referr|friend|family|word of mouth/.test(a)) return 'referral'
  if (/wedding planner|planner/.test(a)) return 'planner_referral'
  if (/drove ?by|driving|saw the sign/.test(a)) return 'drive_by'
  // T5-Rixey-NN cleanup pass: previous fallback was `a.slice(0, 80)`
  // which let unrelated body fragments (Calendly Pro-tip footers,
  // form-noise) slip through as fake "lead sources". Bail to '' so
  // the chain falls through to lower-priority strategies. Only return
  // a free-text answer when it looks like a plausible single-channel
  // word (≤ 30 chars, no URL fragments, no newlines).
  if (cleaned.length <= 30 && !/[\n\r]/.test(cleaned) && !/(https?:|view event|pro tip)/i.test(cleaned)) {
    return cleaned.toLowerCase().trim()
  }
  return ''
}

/**
 * Reject any derived source that looks like an HTML tag fragment.
 * Per T5-Rixey-NN bug #7: the priority-2 body-regex was extracting
 * '</strong>' from web-form HTML bodies. Any candidate containing
 * '<' or '>' should be discarded so the chain falls through to
 * lower-priority strategies (email-domain, UTM) instead of stamping
 * the HTML onto weddings.lead_source.
 */
function isAcceptableLeadSource(d: DerivedLeadSource | null): d is DerivedLeadSource {
  if (!d || !d.source) return false
  if (looksLikeHtmlFragment(d.source)) return false
  return true
}

/** Run the priority chain for one wedding. */
export async function deriveLeadSourceForWedding(
  supabase: SupabaseClient,
  wedding: WeddingForDerivation,
): Promise<DerivedLeadSource> {
  // Priority 0: coordinator override.
  const override = wedding.attribution_priority?.priority ?? null
  if (override && Array.isArray(override) && override.length > 0) {
    return {
      source: override[0],
      priority: 0,
      confidence: 'high',
      evidence: { coordinator_override: wedding.attribution_priority },
    }
  }

  const p1 = await tryPriority1ExplicitFromSourceRecords(wedding)
  if (isAcceptableLeadSource(p1)) return p1

  const p2 = await tryPriority2TourQa(supabase, wedding)
  if (isAcceptableLeadSource(p2)) return p2

  const p3 = await tryPriority3WebForm(supabase, wedding)
  if (isAcceptableLeadSource(p3)) return p3

  const p4 = await tryPriority4EmailDomain(supabase, wedding)
  if (isAcceptableLeadSource(p4)) return p4

  const p5 = await tryPriority5UtmFromAttributionEvents(supabase, wedding)
  if (isAcceptableLeadSource(p5)) return p5

  return {
    source: null,
    priority: 6,
    confidence: 'low',
    evidence: { reason: 'no_signal' },
  }
}

/**
 * Cron entry — runs the chain for every active wedding in the venue
 * with NULL lead_source. Writes the derived value back to weddings +
 * appends a row to lead_source_derivation_log.
 */
export interface DeriveVenueResult {
  venueId: string
  weddingsScanned: number
  derived: number
  noSignal: number
  perPriority: Record<number, number>
  errors: string[]
}

export async function deriveLeadSourceForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DeriveVenueResult> {
  const result: DeriveVenueResult = {
    venueId,
    weddingsScanned: 0,
    derived: 0,
    noSignal: 0,
    perPriority: {},
    errors: [],
  }

  // Active + lead_source-NULL set.
  const { data: weddingsRaw, error } = await supabase
    .from('weddings')
    .select('id, venue_id, inquiry_date, source_records, attribution_priority, source, source_detail')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .limit(500) // cap so a never-derived backlog doesn't blow function timeout

  if (error) {
    result.errors.push(`wedding load failed: ${error.message}`)
    return result
  }

  const weddings = ((weddingsRaw ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ''),
    venue_id: String(r.venue_id ?? ''),
    inquiry_date: (r.inquiry_date as string | null) ?? null,
    source_records: Array.isArray(r.source_records) ? (r.source_records as unknown[]) : [],
    attribution_priority: (r.attribution_priority as { priority?: string[] } | null) ?? null,
    source: (r.source as string | null) ?? null,
    source_detail: (r.source_detail as string | null) ?? null,
  })) as WeddingForDerivation[]

  result.weddingsScanned = weddings.length

  for (const w of weddings) {
    try {
      const derived = await deriveLeadSourceForWedding(supabase, w)
      result.perPriority[derived.priority] = (result.perPriority[derived.priority] ?? 0) + 1

      if (derived.source) {
        // Update weddings.lead_source.
        const { error: updErr } = await supabase
          .from('weddings')
          .update({ lead_source: derived.source })
          .eq('id', w.id)
          .is('lead_source', null) // race-guard
        if (updErr) {
          result.errors.push(`wedding ${w.id} update: ${updErr.message}`)
          continue
        }
        result.derived += 1
      } else {
        result.noSignal += 1
      }

      // Always log — even no-signal decisions are useful audit so
      // coordinators can see "we tried, found nothing".
      const { error: logErr } = await supabase
        .from('lead_source_derivation_log')
        .insert({
          venue_id: w.venue_id,
          wedding_id: w.id,
          derived_source: derived.source,
          priority_used: derived.priority,
          evidence: derived.evidence,
          confidence: derived.confidence,
          decided_by: 'auto',
        })
      if (logErr) {
        result.errors.push(`log ${w.id}: ${logErr.message}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown derive error'
      result.errors.push(`wedding ${w.id}: ${msg}`)
    }
  }

  return result
}

/**
 * Cron wrapper — every active venue. Invoked by the
 * `derive_lead_source` cron job at 06:00 UTC daily.
 */
export async function deriveLeadSourceAllVenues(
  supabase: SupabaseClient,
): Promise<Record<string, DeriveVenueResult>> {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name')
    .is('archived_at', null)
  if (error) {
    logEvent({
      level: 'error',
      msg: 'derive-lead-source.venues-load-failed',
      event_type: 'derive_lead_source',
      outcome: 'fail',
      data: { error: error.message },
    })
    return {}
  }

  const out: Record<string, DeriveVenueResult> = {}
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    try {
      out[v.id] = await deriveLeadSourceForVenue(supabase, v.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      logEvent({
        level: 'error',
        msg: 'derive-lead-source.venue-failed',
        event_type: 'derive_lead_source',
        outcome: 'fail',
        venueId: v.id,
        data: { error: msg },
      })
      out[v.id] = {
        venueId: v.id,
        weddingsScanned: 0,
        derived: 0,
        noSignal: 0,
        perPriority: {},
        errors: [msg],
      }
    }
  }
  return out
}

/**
 * Coordinator override — sets attribution_priority on the wedding +
 * writes a derivation_log row with decided_by='coordinator'. The
 * stored attribution_priority short-circuits future cron re-runs.
 */
export async function recordCoordinatorOverride(
  supabase: SupabaseClient,
  args: {
    venueId: string
    weddingId: string
    leadSource: string
    coordinatorUserId?: string | null
    reason?: string | null
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const priorityPayload = {
    priority: [args.leadSource],
    set_by: args.coordinatorUserId ?? null,
    set_at: new Date().toISOString(),
    reason: args.reason ?? null,
  }

  const { error: upErr } = await supabase
    .from('weddings')
    .update({
      lead_source: args.leadSource,
      attribution_priority: priorityPayload,
    })
    .eq('id', args.weddingId)
    .eq('venue_id', args.venueId)
  if (upErr) return { ok: false, error: upErr.message }

  const { error: logErr } = await supabase
    .from('lead_source_derivation_log')
    .insert({
      venue_id: args.venueId,
      wedding_id: args.weddingId,
      derived_source: args.leadSource,
      priority_used: 0,
      evidence: { coordinator_override: priorityPayload },
      confidence: 'high',
      decided_by: 'coordinator',
      decided_by_user_id: args.coordinatorUserId ?? null,
      reason: args.reason ?? null,
    })
  if (logErr) return { ok: false, error: logErr.message }

  return { ok: true }
}
