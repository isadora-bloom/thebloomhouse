/**
 * Wedding-scoped name-evidence audit + manual-override API.
 *
 * Wave 2D (2026-05-09). Surfaces the new `people.name_evidence`,
 * `people.platform_handles`, `people.display_handle`, and
 * `people.name_confidence` columns introduced by migration 255.
 *
 * GET  /api/intel/name-evidence/[weddingId]
 *   Returns one row per partner (role IN ('partner1','partner2')) with
 *   the picked display name, confidence chip, evidence chain (sorted
 *   pinned-first then confidence DESC then captured_at DESC), and the
 *   per-platform handle map.
 *
 *   Phase 1 reality: most rows have an empty `name_evidence` array. The
 *   panel renders gracefully — it shows a "no evidence chain yet" empty
 *   state and lets the coordinator override regardless.
 *
 * POST /api/intel/name-evidence/[weddingId]
 *   Body: { personId: string, firstName: string, lastName: string }
 *   Coordinator manual override. Appends a confidence-100 evidence row
 *   tagged `manual_override`, then writes the new first/last/confidence
 *   onto the people row directly (Phase 2 picker is not built yet, so
 *   this endpoint is also the picker for the override case).
 *
 * Auth: getPlatformAuth — venue-scoped. Demo cannot mutate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { logEvent } from '@/lib/observability/logger'

interface NameEvidenceEntry {
  source?: string
  value?: { first?: string | null; last?: string | null } | null
  raw?: string
  confidence?: number | null
  captured_at?: string | null
  interaction_id?: string | null
  pinned?: boolean
  superseded?: boolean
}

interface PersonOut {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  display_handle: string | null
  name_confidence: number | null
  name_picked_source: string | null
  email: string | null
  phone: string | null
  platform_handles: Record<string, string | null>
  name_evidence: NameEvidenceEntry[]
}

async function loadWeddingForVenue(weddingId: string, venueId: string) {
  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id, partner_count')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return null
  if (wedding.venue_id !== venueId) return null
  return wedding as { id: string; venue_id: string; partner_count: number | null }
}

// ---------------------------------------------------------------------------
// GET — name evidence + handles for every partner
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const wedding = await loadWeddingForVenue(weddingId, auth.venueId)
  if (!wedding) return forbidden('wedding not in venue scope')

  const supabase = createServiceClient()

  // Try the mig-255 columns first; fall back to legacy when the column
  // hasn't shipped to this environment yet. Wave 2D is a UI layer that
  // must render on either side of the migration boundary.
  let rows: Array<Record<string, unknown>> = []
  const fullSelect =
    'id, role, first_name, last_name, email, phone, name_evidence, ' +
    'display_handle, name_confidence, name_picked_source, platform_handles'
  const { data: fullRows, error: fullErr } = await supabase
    .from('people')
    .select(fullSelect)
    .eq('wedding_id', weddingId)
    .eq('venue_id', auth.venueId)

  if (fullErr) {
    const msg = (fullErr as { message?: string }).message ?? ''
    if (/column .* does not exist/i.test(msg)) {
      const legacy = await supabase
        .from('people')
        .select('id, role, first_name, last_name, email, phone')
        .eq('wedding_id', weddingId)
        .eq('venue_id', auth.venueId)
      rows = (legacy.data ?? []) as unknown as Array<Record<string, unknown>>
    } else {
      return NextResponse.json({ error: msg || 'people query failed' }, { status: 500 })
    }
  } else {
    rows = (fullRows ?? []) as unknown as Array<Record<string, unknown>>
  }

  const partners: PersonOut[] = rows
    .filter((r) => r.role === 'partner1' || r.role === 'partner2')
    .map((r) => {
      const evidenceRaw = (r.name_evidence as NameEvidenceEntry[] | null) ?? []
      const evidence = Array.isArray(evidenceRaw)
        ? evidenceRaw.filter((e) => e && typeof e === 'object')
        : []
      // Sort: pinned first, then confidence DESC, then captured_at DESC.
      const sorted = [...evidence].sort((a, b) => {
        const aPinned = a.pinned === true ? 1 : 0
        const bPinned = b.pinned === true ? 1 : 0
        if (aPinned !== bPinned) return bPinned - aPinned
        const aConf = typeof a.confidence === 'number' ? a.confidence : -1
        const bConf = typeof b.confidence === 'number' ? b.confidence : -1
        if (aConf !== bConf) return bConf - aConf
        const aTs = a.captured_at ?? ''
        const bTs = b.captured_at ?? ''
        return bTs.localeCompare(aTs)
      })
      const handles = (r.platform_handles as Record<string, string | null> | null) ?? {}
      return {
        id: r.id as string,
        role: r.role as string,
        first_name: (r.first_name as string | null) ?? null,
        last_name: (r.last_name as string | null) ?? null,
        display_handle: (r.display_handle as string | null) ?? null,
        name_confidence:
          typeof r.name_confidence === 'number' ? (r.name_confidence as number) : null,
        name_picked_source: (r.name_picked_source as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        platform_handles: handles && typeof handles === 'object' ? handles : {},
        name_evidence: sorted,
      }
    })

  return NextResponse.json({
    partners,
    partnerCount: wedding.partner_count ?? null,
  })
}

// ---------------------------------------------------------------------------
// POST — coordinator manual override
// ---------------------------------------------------------------------------

interface PostBody {
  personId?: string
  firstName?: string
  lastName?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot override identity')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const wedding = await loadWeddingForVenue(weddingId, auth.venueId)
  if (!wedding) return forbidden('wedding not in venue scope')

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }
  if (!body.personId) return badRequest('personId is required')
  const first = (body.firstName ?? '').trim().slice(0, 80)
  const last = (body.lastName ?? '').trim().slice(0, 80)
  if (!first && !last) return badRequest('first or last name required')

  const supabase = createServiceClient()

  // Load current evidence to append to, scoped to this wedding/venue.
  const { data: person, error: pErr } = await supabase
    .from('people')
    .select('id, wedding_id, venue_id, name_evidence')
    .eq('id', body.personId)
    .maybeSingle()
  if (pErr) {
    const msg = (pErr as { message?: string }).message ?? ''
    if (/column .* does not exist/i.test(msg)) {
      return NextResponse.json(
        { error: 'name_evidence column not deployed yet — run migration 255' },
        { status: 503 },
      )
    }
    return NextResponse.json({ error: msg || 'person lookup failed' }, { status: 500 })
  }
  if (!person) return NextResponse.json({ error: 'person not found' }, { status: 404 })
  if (person.venue_id !== auth.venueId || person.wedding_id !== weddingId) {
    return forbidden('person not in scope')
  }

  const existing: NameEvidenceEntry[] = Array.isArray(person.name_evidence)
    ? (person.name_evidence as NameEvidenceEntry[])
    : []
  const newEntry: NameEvidenceEntry = {
    source: 'manual_override',
    value: { first: first || null, last: last || null },
    confidence: 100,
    captured_at: new Date().toISOString(),
    interaction_id: null,
    pinned: true,
  }
  const nextEvidence = [...existing, newEntry]

  // Phase 2 picker isn't built yet; for the manual-override path we ARE
  // the picker. Coordinator's typed name wins, confidence stamps to 100,
  // source = 'manual_override'. This is intentional even after the
  // picker ships — manual override is law per the design doc §4b.
  const { error: updErr } = await supabase
    .from('people')
    .update({
      name_evidence: nextEvidence,
      first_name: first || null,
      last_name: last || null,
      name_confidence: 100,
      name_picked_source: 'manual_override',
    })
    .eq('id', body.personId)

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  // Telemetry — analytics chain uses this to measure how much manual
  // cleanup the system requires per venue.
  logEvent({
    level: 'info',
    msg: 'identity.name_override',
    venueId: auth.venueId,
    actor: `user:${auth.userId}`,
    event_type: 'identity.manual_override',
    outcome: 'ok',
    data: {
      wedding_id: weddingId,
      person_id: body.personId,
      had_evidence: existing.length > 0,
    },
  })

  // Fire the identity-discovery cascade in the background. A
  // coordinator-confirmed name is the strongest possible identity
  // binding — anonymous storefront signals (Knot proxy "User <hex>",
  // IG "@justinandsandy_wedding") that match this first_name +
  // last_initial in the engagement window now have evidence to bind.
  // Fire-and-forget: the override write already succeeded, the
  // cascade is pure follow-up. Never block the operator's UI.
  void (async () => {
    try {
      const { triggerIdentityCascade } = await import(
        '@/lib/services/identity/cascade-on-enrichment'
      )
      // Use the same service client the override write ran on. Auth
      // is already validated above so this can run with full
      // service-role scope.
      await triggerIdentityCascade({
        venueId: auth.venueId as string,
        weddingId,
        supabase,
        reason: 'name_evidence_override',
      })
    } catch (err) {
      console.warn(
        '[name-evidence] cascade fire-and-forget threw:',
        err instanceof Error ? err.message : err,
      )
    }
  })()

  return NextResponse.json({ ok: true })
}
