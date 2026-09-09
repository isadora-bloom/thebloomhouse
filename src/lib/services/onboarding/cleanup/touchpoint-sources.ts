/**
 * Step 4 of the onboarding cleanup pipeline — repair touchpoint
 * sources.
 *
 * Extracted from scripts/backfill-touchpoint-sources.ts (kept as a
 * thin CLI wrapper). wedding_touchpoints.source sometimes inherited
 * the wedding's legacy first-touch source instead of the actual
 * channel the touchpoint occurred on (e.g. a Calendly tour_booked
 * touchpoint rendering as "Website"). Infers the correct source from
 * the linked interaction's from_email domain and rewrites it.
 * Requires step 1 (direction reclassify) for from_email to be trusted.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

function inferSourceFromEmail(fromEmail: string | null): string | null {
  if (!fromEmail) return null
  const e = fromEmail.toLowerCase()
  if (e.includes('@calendly.com') || e.includes('@calendlymail.com')) return 'calendly'
  if (e.includes('@acuityscheduling.com')) return 'acuity'
  if (e.includes('@honeybook.com')) return 'honeybook'
  if (e.includes('@dubsado.com')) return 'dubsado'
  if (e.includes('@theknot.com') || e.includes('@knotemail.com')) return 'the_knot'
  if (e.includes('@weddingwire.com')) return 'wedding_wire'
  if (e.includes('@herecomestheguide.com')) return 'here_comes_the_guide'
  return null
}

export async function backfillTouchpointSources(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('touchpoint_sources', '4. Repair touchpoint sources')
  const errors: string[] = []
  const samples: string[] = []

  const PAGE = 500
  let from = 0
  let scanned = 0
  let fixed = 0

  for (;;) {
    const { data, error } = await sb
      .from('wedding_touchpoints')
      .select('id, touch_type, source, metadata, wedding_id')
      .eq('venue_id', venueId)
      .in('touch_type', ['tour_booked', 'calendly_booked', 'inquiry', 'email_reply', 'tour_conducted'])
      .range(from, from + PAGE - 1)
    if (error) { errors.push(`fetch @${from}: ${error.message}`); break }
    const rows = (data ?? []) as Array<{ id: string; touch_type: string; source: string | null; metadata: { interaction_id?: string | null; engagement_event_id?: string | null } | null; wedding_id: string }>
    if (rows.length === 0) break

    for (const r of rows) {
      scanned++
      let interactionId = r.metadata?.interaction_id ?? null
      if (!interactionId) {
        const eeId = r.metadata?.engagement_event_id
        if (eeId) {
          const { data: ee } = await sb
            .from('engagement_events')
            .select('metadata')
            .eq('id', eeId)
            .maybeSingle()
          interactionId = ((ee as { metadata: { interaction_id?: string | null } | null } | null)?.metadata?.interaction_id) ?? null
        }
      }
      if (!interactionId && r.touch_type === 'inquiry') {
        const { data: firstInbound } = await sb
          .from('interactions')
          .select('id')
          .eq('wedding_id', r.wedding_id)
          .eq('direction', 'inbound')
          .not('timestamp', 'is', null)
          .order('timestamp', { ascending: true })
          .limit(1)
        interactionId = ((firstInbound?.[0] as { id: string } | undefined)?.id) ?? null
      }
      if (!interactionId) continue
      const { data: ix } = await sb
        .from('interactions')
        .select('from_email')
        .eq('id', interactionId)
        .maybeSingle()
      const ixRow = ix as { from_email: string | null } | null
      if (!ixRow) continue

      const inferred = inferSourceFromEmail(ixRow.from_email)
      if (!inferred) continue
      if (r.source === inferred) continue

      fixed++
      if (samples.length < 8) {
        samples.push(`${r.touch_type} ${r.id.slice(0, 8)}…: source ${r.source ?? 'null'} → ${inferred} (from ${ixRow.from_email})`)
      }
      if (apply) {
        const { error: updErr } = await sb.from('wedding_touchpoints').update({ source: inferred }).eq('id', r.id)
        if (updErr) errors.push(`${r.id}: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    from += PAGE
  }

  result.counts = { scanned, fixed }
  result.samples = samples
  result.errors = errors
  return result
}
