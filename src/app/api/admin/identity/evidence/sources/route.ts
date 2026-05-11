/**
 * Wave 15 — list evidence-source rows for a wedding.
 *
 * GET /api/admin/identity/evidence/sources?weddingId=...
 *
 * Returns the dismissable evidence rows for ReconstructedIdentityPanel
 * (Wave 4 Phase 3 UI). Powered by the strict review-match filter — the
 * UI shows the same set of reviews the reconstruction prompt would see.
 *
 * Returns:
 *   {
 *     ok: true,
 *     sources: EvidenceSourceRow[],
 *     dismissedIds: string[],   // pre-populates the dismissed state
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  matchReviewToCouple,
  type PartnerNamePair,
} from '@/lib/services/identity/review-match'
import { loadEvidenceOverrides } from '@/lib/services/identity/evidence-overrides'

interface EvidenceSourceRow {
  id: string
  table: string
  evidenceKind:
    | 'review'
    | 'interaction'
    | 'calendar'
    | 'contract'
    | 'payment'
    | 'handle'
    | 'tangential_signal'
    | 'attribution_event'
    | 'tour'
    | 'profile_field'
  label: string
  detail: string | null
  timestamp: string | null
}

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const url = new URL(req.url)
  const weddingId = url.searchParams.get('weddingId')
  if (!weddingId) return badRequest('weddingId required')

  const supabase = createServiceClient()

  // Verify wedding belongs to the caller's venue.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, inquiry_date, wedding_date')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return notFound('wedding')
  const w = wedding as {
    venue_id: string
    inquiry_date: string | null
    wedding_date: string | null
  }
  if (w.venue_id !== auth.venueId) {
    return forbidden('wedding does not belong to your venue')
  }

  // Load partner names.
  const { data: peopleRows } = await supabase
    .from('people')
    .select('role, first_name, last_name')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  const partners: PartnerNamePair[] = ((peopleRows as Array<{
    role: string | null
    first_name: string | null
    last_name: string | null
  }> | null) ?? []).map((p) => ({
    role: p.role,
    first_name: p.first_name,
    last_name: p.last_name,
  }))

  const sources: EvidenceSourceRow[] = []

  // ---- Reviews (strict match) ----
  if (partners.length > 0) {
    const tokens = new Set<string>()
    for (const p of partners) {
      if (p.first_name && p.first_name.length >= 3) {
        tokens.add(p.first_name.toLowerCase())
      }
      if (p.last_name && p.last_name.length >= 3) {
        tokens.add(p.last_name.toLowerCase())
      }
    }
    if (tokens.size > 0) {
      const orExpr = Array.from(tokens)
        .slice(0, 10)
        .map((n) => `reviewer_name.ilike.%${escapeIlike(n)}%`)
        .join(',')
      const { data: reviewRows } = await supabase
        .from('reviews')
        .select('id, reviewer_name, source, rating, body, review_date, wedding_id')
        .eq('venue_id', w.venue_id)
        .or(orExpr)
        .order('review_date', { ascending: false })
        .limit(50)
      const wedAnchor = {
        inquiry_date: w.inquiry_date,
        wedding_date: w.wedding_date,
      }
      for (const r of (reviewRows ?? []) as Array<{
        id: string
        reviewer_name: string | null
        source: string | null
        rating: number | null
        body: string | null
        review_date: string | null
        wedding_id: string | null
      }>) {
        // Explicit operator-attached rows always show.
        let matched = r.wedding_id === weddingId
        if (!matched) {
          const v = matchReviewToCouple(
            { id: r.id, reviewer_name: r.reviewer_name, review_date: r.review_date },
            partners,
            wedAnchor,
          )
          matched = v.matched
        }
        if (!matched) continue
        const stars = typeof r.rating === 'number' ? `${r.rating}★` : '?★'
        sources.push({
          id: r.id,
          table: 'reviews',
          evidenceKind: 'review',
          label: `${stars} ${r.source ?? 'review'} by ${r.reviewer_name ?? '(anonymous)'}`,
          detail: (r.body ?? '').slice(0, 160) || null,
          timestamp: r.review_date,
        })
        if (sources.length >= 25) break
      }
    }
  }

  // ---- Discovery sources ----
  const { data: dsRows } = await supabase
    .from('discovery_sources')
    .select('id, canonical_source, answer_text, captured_at')
    .eq('wedding_id', weddingId)
    .order('captured_at', { ascending: false })
    .limit(5)
  for (const d of (dsRows ?? []) as Array<{
    id: string
    canonical_source: string
    answer_text: string
    captured_at: string
  }>) {
    sources.push({
      id: d.id,
      table: 'discovery_sources',
      evidenceKind: 'profile_field',
      label: `Discovery: ${d.canonical_source}`,
      detail: `"${d.answer_text}"`,
      timestamp: d.captured_at,
    })
  }

  // ---- Tangential signals ----
  const { data: tsRows } = await supabase
    .from('tangential_signals')
    .select('id, source_platform, signal_date, source_context')
    .eq('venue_id', w.venue_id)
    .limit(50)
    .order('signal_date', { ascending: false })
  // Re-filter client side by people IDs since tangential_signals binds
  // to matched_person_id not wedding_id directly.
  const { data: peopleIdsRows } = await supabase
    .from('people')
    .select('id')
    .eq('wedding_id', weddingId)
  const personIds = new Set(
    ((peopleIdsRows as Array<{ id: string }> | null) ?? []).map((p) => p.id),
  )
  // Re-fetch tangentials filtered to person ids
  if (personIds.size > 0) {
    const { data: tsForPeople } = await supabase
      .from('tangential_signals')
      .select('id, source_platform, signal_date, source_context, matched_person_id')
      .eq('venue_id', w.venue_id)
      .in('matched_person_id', Array.from(personIds))
      .order('signal_date', { ascending: false })
      .limit(10)
    for (const t of (tsForPeople ?? []) as Array<{
      id: string
      source_platform: string | null
      signal_date: string | null
      source_context: string | null
    }>) {
      sources.push({
        id: t.id,
        table: 'tangential_signals',
        evidenceKind: 'tangential_signal',
        label: `Tangential: ${t.source_platform ?? 'unknown'}`,
        detail: (t.source_context ?? '').slice(0, 160) || null,
        timestamp: t.signal_date,
      })
    }
  }
  // tsRows is fetched but not used further; suppress unused warning.
  void tsRows

  // Load active overrides for the dismissedIds list.
  const overrides = await loadEvidenceOverrides(supabase, weddingId)
  const dismissedIds: string[] = []
  for (const r of overrides.rows) {
    if (
      r.override_action === 'dismiss' ||
      r.override_action === 'unlink'
    ) {
      const id = r.evidence_ref?.id
      if (typeof id === 'string') dismissedIds.push(id)
    }
  }

  return NextResponse.json({ ok: true, sources, dismissedIds })
}

function escapeIlike(s: string): string {
  return s.replace(/[%_]/g, '\\$&').replace(/,/g, ' ')
}
