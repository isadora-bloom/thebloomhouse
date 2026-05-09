/**
 * Phantom-partner cleanup (Wave 2.5).
 *
 * Anchor docs:
 *   - IDENTITY-CAPTURE-DESIGN.md § 3d (partner-placeholder duplicates)
 *   - bloom-constitution.md (forensic identity reconstruction — losers
 *     are tombstoned via merged_into_id, never hard-deleted)
 *
 * Why this endpoint exists
 * ------------------------
 * The Wave 2A backfill caught greeting/HTML/venue-name evidence but
 * never ran a phantom-partner pass. Live data still shows pairs like
 * `Hannah Lord & Hannah Lord`, `Sam Demarest & Sam Demarest`,
 * `Jessica Antiskay & Jessica Antiskay`. These are LLM extraction
 * artefacts: the body classifier reads "thanks, Hannah" from a sender
 * sign-off and emits partnerName='Hannah' when partner1 is already
 * Hannah. The chokepoint phantom-partner detector
 * (`detectPhantomPartner` in name-capture.ts) catches this prospectively;
 * this endpoint applies the same detector retroactively to historical
 * data.
 *
 * Algorithm per wedding
 * ---------------------
 *   1. Fetch partner1 + partner2 people rows (role IN ('partner1','partner2'),
 *      not tombstoned).
 *   2. Run `detectPhantomPartner(p1, p2)` — same first name lower-case,
 *      partner2 has no last name AND no own email.
 *   3. If phantom: tombstone partner2 (`merged_into_id = partner1.id`),
 *      stamp `weddings.partner_count = 1`. NO hard delete (Constitution
 *      invariant).
 *   4. DryRun shows what WOULD merge with before/after, no writes.
 *
 * Method: POST
 * Body: { dryRun?: boolean (default true), limit?: number, offset?: number }
 * Auth: getPlatformAuth + auth.venueId
 *
 * Returns:
 *   {
 *     ok: true,
 *     dryRun: boolean,
 *     weddings_scanned: number,
 *     phantoms_found: number,
 *     phantoms_cleaned: number,   // only non-zero when dryRun=false
 *     hasMore: boolean,
 *     next_offset: number | null,
 *     diffs: Array<{
 *       weddingId: string,
 *       partner1: { id: string; first: string | null; last: string | null; email: string | null },
 *       partner2: { id: string; first: string | null; last: string | null; email: string | null },
 *       reason: string,
 *     }>,
 *   }
 *
 * Hard rule: dryRun defaults to TRUE. Caller must pass `dryRun: false`
 * explicitly to mutate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { detectPhantomPartner } from '@/lib/services/identity/name-capture'

export const maxDuration = 300

const DEFAULT_LIMIT = 100
const HARD_MAX_LIMIT = 500

interface PostBody {
  dryRun?: boolean
  limit?: number
  offset?: number
}

interface PartnerSnapshot {
  id: string
  first: string | null
  last: string | null
  email: string | null
}

interface PhantomDiff {
  weddingId: string
  partner1: PartnerSnapshot
  partner2: PartnerSnapshot
  reason: string
}

export async function POST(req: NextRequest) {
  // Two auth paths — coordinator session via getPlatformAuth, or
  // CRON_SECRET + explicit `venueId` in the body for ops-side runs.
  // Same dryRun-defaults-true semantics either way.
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string
  if (cronAuth) {
    let parsed: { venueId?: string } = {}
    try { parsed = await req.clone().json() as { venueId?: string } } catch { /* ignore */ }
    if (!parsed.venueId) return badRequest('CRON_SECRET path requires venueId in body')
    venueId = parsed.venueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot run phantom-partner cleanup')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  // Hard-rule: dryRun defaults TRUE.
  const dryRun = body.dryRun === false ? false : true
  const limit = Math.max(1, Math.min(HARD_MAX_LIMIT, Math.floor(typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT)))
  const offset = Math.max(0, Math.floor(typeof body.offset === 'number' ? body.offset : 0))

  const supabase = createServiceClient()

  // Wedding cohort — non-tombstoned, ordered for stable paging.
  const { data: weddingRows, error: weddingErr, count } = await supabase
    .from('weddings')
    .select('id, partner_count', { count: 'exact' })
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (weddingErr) {
    return NextResponse.json({ ok: false, error: weddingErr.message }, { status: 500 })
  }

  const weddings = (weddingRows ?? []) as Array<{ id: string; partner_count: number | null }>
  const totalCount = count ?? weddings.length

  const diffs: PhantomDiff[] = []
  let phantomsCleaned = 0

  for (const w of weddings) {
    // Skip weddings already marked as one-partner.
    if (w.partner_count === 1) continue

    const { data: peopleRows } = await supabase
      .from('people')
      .select('id, role, first_name, last_name, email, created_at')
      .eq('wedding_id', w.id)
      .is('merged_into_id', null)
      .in('role', ['partner1', 'partner2'])

    const people = (peopleRows ?? []) as Array<{
      id: string
      role: string
      first_name: string | null
      last_name: string | null
      email: string | null
      created_at: string | null
    }>

    if (people.length < 2) continue

    // Find partner1 + partner2 explicitly. If multiple of either, take
    // the earliest by created_at (stable ordering).
    const partner1Candidates = people.filter((p) => p.role === 'partner1').sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    const partner2Candidates = people.filter((p) => p.role === 'partner2').sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    const p1 = partner1Candidates[0]
    const p2 = partner2Candidates[0]
    if (!p1 || !p2) continue

    const isPhantom = detectPhantomPartner(
      { first: p1.first_name, last: p1.last_name, email: p1.email },
      { first: p2.first_name, last: p2.last_name, email: p2.email },
    )
    if (!isPhantom) continue

    diffs.push({
      weddingId: w.id,
      partner1: { id: p1.id, first: p1.first_name, last: p1.last_name, email: p1.email },
      partner2: { id: p2.id, first: p2.first_name, last: p2.last_name, email: p2.email },
      reason: 'duplicate_first_no_distinguishing_data',
    })

    if (dryRun) continue

    // Tombstone partner2 + stamp partner_count=1. Soft tombstone via
    // merged_into_id (Constitution invariant: never hard-delete).
    try {
      await supabase
        .from('people')
        .update({ merged_into_id: p1.id })
        .eq('id', p2.id)
      await supabase
        .from('weddings')
        .update({ partner_count: 1 })
        .eq('id', w.id)
      phantomsCleaned += 1
    } catch (err) {
      console.warn('[cleanup-phantom-partners] tombstone failed', {
        weddingId: w.id,
        err: err instanceof Error ? err.message : err,
      })
    }
  }

  const processedSoFar = offset + weddings.length
  const hasMore = processedSoFar < totalCount

  return NextResponse.json({
    ok: true,
    dryRun,
    weddings_scanned: weddings.length,
    phantoms_found: diffs.length,
    phantoms_cleaned: dryRun ? 0 : phantomsCleaned,
    total_in_venue: totalCount,
    next_offset: hasMore ? processedSoFar : null,
    hasMore,
    diffs,
  })
}
