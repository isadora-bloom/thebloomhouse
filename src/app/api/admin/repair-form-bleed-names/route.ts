/**
 * One-shot repair endpoint — NULL out people.first_name / people.last_name
 * on rows where the legacy name-upgrade regex pipeline wrote Calendly
 * form-bleed tokens ("Whole Weekend", "Final Walkthrough", etc.) as
 * the displayed name.
 *
 * Why this exists
 * ---------------
 * The class fix (name-upgrade.ts skipping `key:value` lines + token
 * blacklist + migration 322 calendly_qa column) prevents NEW corruption,
 * but legacy people rows already have first_name='Whole', last_name=
 * 'Weekend' on disk. NULLing those fields gives the reconstruct judge
 * a clean canvas — it already refuses these patterns
 * (config/prompts/identity-reconstruction.ts §5).
 *
 * The same logic lives in scripts/repair-form-bleed-names.ts for CLI use.
 * This endpoint mirrors that script for one-shot manual fire from the
 * coordinator dashboard / curl.
 *
 * Selection rule
 * --------------
 *   name_evidence IS NULL OR name_evidence = '[]'::jsonb
 *   AND (first_name ∈ FORM_BLEED_TOKENS.firstHeads
 *        OR last_name ∈ FORM_BLEED_TOKENS.lastTails)
 *
 * What we change
 * --------------
 * NULL first_name and last_name. Don't touch email/phone/role/
 * display_handle — those are still real signals. The reconstruct cron /
 * live name-upgrade pipeline will repopulate on the next signal.
 *
 * Auth
 * ----
 * Venue-scoped via `getPlatformAuth`. Demo rejected. Mirrors
 * /api/admin/identity/upgrade-names.
 *
 * Method: POST
 *   Body: { dryRun?: boolean }
 *
 * Returns:
 *   {
 *     ok: true,
 *     dryRun: boolean,
 *     scanned: number,
 *     matched: number,
 *     repaired: number,
 *     samples: Array<{ id, wedding_id, original_first, original_last }>
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { FORM_BLEED_TOKENS } from '@/lib/services/identity/name-upgrade'

export const maxDuration = 300

const SAMPLE_CAP = 100

interface PostBody {
  dryRun?: boolean
}

interface PeopleRow {
  id: string
  wedding_id: string | null
  venue_id: string
  first_name: string | null
  last_name: string | null
  name_evidence: unknown
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run repair-form-bleed-names')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  const venueId: string = auth.venueId

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const dryRun = body.dryRun === true

  const firstHeads = new Set<string>(FORM_BLEED_TOKENS.firstHeads as readonly string[])
  const lastTails = new Set<string>(FORM_BLEED_TOKENS.lastTails as readonly string[])

  const supabase = createServiceClient()

  // Pull candidate population (people with empty name_evidence).
  // Volume bounded by venue's people count (O(weddings)); in-memory
  // filter on token membership is fine.
  const { data: rows, error } = await supabase
    .from('people')
    .select('id, wedding_id, venue_id, first_name, last_name, name_evidence')
    .eq('venue_id', venueId)
    .or('name_evidence.is.null,name_evidence.eq.[]')
    .is('merged_into_id', null)

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }
  const candidates = (rows ?? []) as PeopleRow[]

  const matches = candidates.filter((p) => {
    const f = (p.first_name ?? '').trim()
    const l = (p.last_name ?? '').trim()
    if (!f && !l) return false
    if (f && firstHeads.has(f)) return true
    if (l && lastTails.has(l)) return true
    return false
  })

  const samples: Array<{
    id: string
    wedding_id: string | null
    original_first: string | null
    original_last: string | null
  }> = []
  let repaired = 0

  for (const p of matches) {
    if (samples.length < SAMPLE_CAP) {
      samples.push({
        id: p.id,
        wedding_id: p.wedding_id,
        original_first: p.first_name,
        original_last: p.last_name,
      })
    }
    // Always log to stdout for audit; cron-style logs survive even
    // when the JSON response is truncated.
    console.log('[repair-form-bleed-names]', JSON.stringify({
      action: dryRun ? 'would-null-out' : 'null-out',
      id: p.id,
      wedding_id: p.wedding_id,
      venue_id: p.venue_id,
      original_first: p.first_name,
      original_last: p.last_name,
    }))
    if (dryRun) continue
    const { error: updErr } = await supabase
      .from('people')
      .update({ first_name: null, last_name: null })
      .eq('id', p.id)
      .is('merged_into_id', null)
    if (updErr) {
      console.warn(`[repair-form-bleed-names] update failed for ${p.id}:`, updErr.message)
      continue
    }
    repaired += 1
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    scanned: candidates.length,
    matched: matches.length,
    repaired: dryRun ? 0 : repaired,
    samples,
  })
}
