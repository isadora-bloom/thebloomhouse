/**
 * Web-visit stitch — bind anonymous pixel visits to a couple's record.
 *
 * Anchor: ORIGIN-INGESTION-SPEC.md §5 / GC-13. The web pixel
 * (/api/v1/visit → `web_visits`) captures UTM / click-ids / referrer /
 * landing path for every anonymous pageview on the venue's marketing
 * site, keyed by a first-party cookie `anon_visitor_id`. That capture is
 * forensically valuable — it's the venue's only first-touch attribution
 * input for the days between an ad click and the form fill — but today it
 * is ORPHANED from identity. `web_visits` rows never reach a couple.
 *
 * What this module does
 * ---------------------
 * When an anonymous visitor later identifies (e.g. submits the wedding-
 * cost calculator with an email, carrying their `anon_visitor_id` cookie
 * forward), this stitch finds that visitor's `web_visits` rows and records
 * the EARLIEST UTM / referrer / landing as the couple's acquisition source
 * — written as a touchpoint through the canonical `linkSignal` cascade so
 * the UTM finally lands on the couple's record (touchpoints.raw_payload),
 * not floating in an anonymous table.
 *
 * Why aggregate_only tier
 * -----------------------
 * A pixel pageview carries no per-person identity (it's IP-hash + UA-hash
 * only). We deliberately bind it via the `legacy_wedding_id` fast path —
 * never letting it mint or match a couple on its own. The signal is purely
 * an attribution payload attached to an already-resolved couple, so the
 * tier is `aggregate_only` and identity_hint is null.
 *
 * Carry-forward integration point (READ — not yet wired)
 * ------------------------------------------------------
 * As of this writing there is NO code path that carries `anon_visitor_id`
 * from the pixel cookie into an identified record. `linkWebVisitsToCandidate`
 * in src/lib/services/intel/web-pixel.ts exists but has ZERO callers, and
 * no calculator / web-form submit reads the `bloom_visitor_id` cookie. So
 * `stitchVisitsToCouple` is the PRIMARY export: the caller (the calculator
 * / web-form submit handler) must pass the `anonVisitorId` it lifts from
 * the cookie plus the resolved `coupleId`. `backfillStitchAll` can only
 * stitch couples that ALREADY have an anon→identity linkage recorded on a
 * `web_visits.candidate_identity_id` whose candidate resolved to a wedding
 * mirrored as a couple — until the calculator carry-forward is wired, that
 * set is empty and backfill is a safe no-op.
 *
 * Self-contained: accepts the Supabase service client as a parameter; does
 * not create its own client. Idempotent — re-running is a no-op because the
 * touchpoint's UNIQUE(venue_id, channel, external_id) absorbs the re-fire.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignal, type NormalizedSignal } from '@/lib/spine/cascade'

/** Subset of `web_visits` columns this stitch reads (migration 309). */
interface WebVisitRow {
  id: string
  anon_visitor_id: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
  gclid: string | null
  fbclid: string | null
  ttclid: string | null
  msclkid: string | null
  referrer: string | null
  landing_path: string | null
  occurred_at: string
}

const WEB_VISIT_COLUMNS =
  'id, anon_visitor_id, utm_source, utm_medium, utm_campaign, utm_term, ' +
  'utm_content, gclid, fbclid, ttclid, msclkid, referrer, landing_path, occurred_at'

/** A web_visit row carries usable attribution iff any UTM / click-id /
 *  referrer is present. A bare pageview (all null) is not worth binding. */
function hasAttribution(v: WebVisitRow): boolean {
  return Boolean(
    v.utm_source ||
      v.utm_medium ||
      v.utm_campaign ||
      v.utm_term ||
      v.utm_content ||
      v.gclid ||
      v.fbclid ||
      v.ttclid ||
      v.msclkid ||
      v.referrer,
  )
}

/** Resolve the couple a `web_visits.candidate_identity_id` ultimately
 *  belongs to: candidate → resolved_wedding_id → couples.source_wedding_id.
 *  Returns null if the candidate isn't resolved to a wedding yet, or the
 *  wedding hasn't been mirrored into a couple. */
async function coupleForCandidate(
  supabase: SupabaseClient,
  venueId: string,
  candidateIdentityId: string,
): Promise<string | null> {
  const { data: cand } = await supabase
    .from('candidate_identities')
    .select('resolved_wedding_id')
    .eq('id', candidateIdentityId)
    .maybeSingle()
  const weddingId = (cand as { resolved_wedding_id: string | null } | null)
    ?.resolved_wedding_id
  if (!weddingId) return null

  const { data: couple } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .maybeSingle()
  return (couple as { id: string } | null)?.id ?? null
}

export interface StitchVisitsArgs {
  supabase: SupabaseClient
  venueId: string
  /** The resolved couple to attribute the acquisition source to. */
  coupleId: string
  /** The first-party cookie value lifted from the calculator / form submit. */
  anonVisitorId: string
}

export interface StitchVisitsResult {
  /** True iff a UTM/referrer-bearing touchpoint was attached (or already
   *  existed) on the couple. */
  utmBound: boolean
  /** Number of web_visits rows found for this anon_visitor_id in the venue. */
  visits: number
}

/**
 * PRIMARY export. Bind the EARLIEST attribution-bearing `web_visits` row
 * for `anonVisitorId` to `coupleId` as a `web` / `web_visit` touchpoint.
 *
 * We pick the earliest visit because §5 defines first-touch as the first
 * non-null UTM/referrer across a (venue, anon_visitor_id) cluster — that is
 * the click that originally acquired the visitor, days before they filled a
 * form. The touchpoint reaches the couple via the `legacy_wedding_id` fast
 * path (looked up from the couple), so the pixel signal never matches or
 * mints on its own — it only enriches an already-resolved couple.
 */
export async function stitchVisitsToCouple(
  args: StitchVisitsArgs,
): Promise<StitchVisitsResult> {
  const { supabase, venueId, coupleId, anonVisitorId } = args
  if (!venueId || !coupleId || !anonVisitorId) {
    return { utmBound: false, visits: 0 }
  }

  const { data, error } = await supabase
    .from('web_visits')
    .select(WEB_VISIT_COLUMNS)
    .eq('venue_id', venueId)
    .eq('anon_visitor_id', anonVisitorId)
    .order('occurred_at', { ascending: true })
  if (error) {
    throw new Error(`web-visit-stitch: load visits failed: ${error.message}`)
  }
  const visits = (data ?? []) as unknown as WebVisitRow[]
  if (visits.length === 0) return { utmBound: false, visits: 0 }

  // Earliest visit that actually carries attribution. Fall back to the
  // earliest visit overall (records the landing even when bare) only if
  // none carry UTM — but report utmBound=false in that case.
  const earliestWithUtm = visits.find(hasAttribution)
  const chosen = earliestWithUtm ?? visits[0]
  const utmBound = Boolean(earliestWithUtm)

  // Resolve the couple's legacy wedding so the signal takes linkSignal's
  // legacy_wedding_id fast path (attach, never match/mint).
  const { data: couple } = await supabase
    .from('couples')
    .select('source_wedding_id')
    .eq('id', coupleId)
    .eq('venue_id', venueId)
    .maybeSingle()
  const legacyWeddingId =
    (couple as { source_wedding_id: string | null } | null)?.source_wedding_id ??
    null

  const signal: NormalizedSignal = {
    external_id: `webvisit:${chosen.anon_visitor_id}:${chosen.id}`,
    channel: 'web',
    action_type: 'web_visit',
    occurred_at: new Date(chosen.occurred_at).toISOString(),
    signal_tier: 'aggregate_only',
    identity_hint: null,
    legacy_wedding_id: legacyWeddingId,
    raw_payload: {
      anon_visitor_id: chosen.anon_visitor_id,
      utm_source: chosen.utm_source,
      utm_medium: chosen.utm_medium,
      utm_campaign: chosen.utm_campaign,
      utm_term: chosen.utm_term,
      utm_content: chosen.utm_content,
      gclid: chosen.gclid,
      fbclid: chosen.fbclid,
      ttclid: chosen.ttclid,
      msclkid: chosen.msclkid,
      referrer: chosen.referrer,
      landing_path: chosen.landing_path,
      first_touch_at: chosen.occurred_at,
      cluster_size: visits.length,
      stitched_couple_id: coupleId,
    },
  }

  await linkSignal({ supabase, venueId, signal, source: 'web_visit_stitch' })

  return { utmBound, visits: visits.length }
}

export interface BackfillStitchArgs {
  supabase: SupabaseClient
  venueId: string
}

export interface BackfillStitchResult {
  stitched: number
}

/**
 * Backfill: for every (venue, anon_visitor_id) cluster that has ALREADY
 * been resolved to a candidate identity (`web_visits.candidate_identity_id`
 * set), and whose candidate resolved to a wedding that has been mirrored
 * into a couple, run the stitch so the UTM reaches the couple.
 *
 * Until the calculator / web-form carry-forward is wired (see module
 * header — `linkWebVisitsToCandidate` has no callers today), no
 * `web_visits` row carries a `candidate_identity_id`, so this iterates over
 * an empty set and returns { stitched: 0 }. That is the honest, safe state.
 * Once the carry-forward lands, this becomes the historical sweep.
 */
export async function backfillStitchAll(
  args: BackfillStitchArgs,
): Promise<BackfillStitchResult> {
  const { supabase, venueId } = args
  if (!venueId) return { stitched: 0 }

  const { data, error } = await supabase
    .from('web_visits')
    .select('anon_visitor_id, candidate_identity_id')
    .eq('venue_id', venueId)
    .not('candidate_identity_id', 'is', null)
  if (error) {
    throw new Error(`web-visit-stitch: backfill scan failed: ${error.message}`)
  }
  const rows = (data ?? []) as {
    anon_visitor_id: string
    candidate_identity_id: string
  }[]
  if (rows.length === 0) return { stitched: 0 }

  // Collapse to one (anon_visitor_id → candidate) pair per visitor; all
  // rows in a cluster share the same resolved candidate.
  const byVisitor = new Map<string, string>()
  for (const r of rows) {
    if (r.anon_visitor_id && r.candidate_identity_id) {
      byVisitor.set(r.anon_visitor_id, r.candidate_identity_id)
    }
  }

  let stitched = 0
  for (const [anonVisitorId, candidateIdentityId] of byVisitor) {
    const coupleId = await coupleForCandidate(
      supabase,
      venueId,
      candidateIdentityId,
    )
    if (!coupleId) continue
    const r = await stitchVisitsToCouple({
      supabase,
      venueId,
      coupleId,
      anonVisitorId,
    })
    if (r.utmBound) stitched++
  }

  return { stitched }
}
