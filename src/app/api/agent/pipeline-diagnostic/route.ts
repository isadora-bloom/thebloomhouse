import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// GET /api/agent/pipeline-diagnostic
//
// Dumps the state of the pipeline data path in one payload so we can see
// exactly where things are stuck: is Gmail sync writing interactions? Do
// they have person_ids? Are there reprocess candidates? How many weddings
// exist and in what shape?
//
// Read-only. Safe to hit at any time.
// ---------------------------------------------------------------------------

type CountResult = { count: number | null; error: string | null }

async function countQuery(
  supabase: ReturnType<typeof createServiceClient>,
  table: string,
  apply: (q: ReturnType<ReturnType<typeof createServiceClient>['from']>) => unknown
): Promise<CountResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (supabase.from(table) as any).select('id', { count: 'exact', head: true })
  const q = apply(base) as { count: number | null; error: { message: string } | null }
  const { count, error } = await q
  return { count: count ?? 0, error: error?.message ?? null }
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()

  // ---- Gmail connections ----
  const { data: connections } = await supabase
    .from('gmail_connections')
    .select('id, email_address, is_active, last_sync_at')
    .eq('venue_id', venueId)

  // ---- Interactions ----
  const interactionsAll = await countQuery(supabase, 'interactions', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId)
  )
  const interactionsEmailInbound = await countQuery(supabase, 'interactions', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId).eq('type', 'email').eq('direction', 'inbound')
  )
  const interactionsNoPerson = await countQuery(supabase, 'interactions', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId).eq('type', 'email').eq('direction', 'inbound').is('person_id', null)
  )
  const interactionsOrphanCandidates = await countQuery(supabase, 'interactions', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any)
      .eq('venue_id', venueId)
      .eq('type', 'email')
      .eq('direction', 'inbound')
      .is('wedding_id', null)
      .not('person_id', 'is', null)
  )

  // ---- People ----
  const peopleAll = await countQuery(supabase, 'people', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId)
  )
  const peopleLinked = await countQuery(supabase, 'people', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId).not('wedding_id', 'is', null)
  )
  const peopleUnlinked = await countQuery(supabase, 'people', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId).is('wedding_id', null)
  )
  const peopleNameless = await countQuery(supabase, 'people', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any)
      .eq('venue_id', venueId)
      .eq('role', 'partner1')
      .not('wedding_id', 'is', null)
      .is('first_name', null)
      .is('last_name', null)
  )

  // ---- Weddings ----
  const weddingsAll = await countQuery(supabase, 'weddings', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId)
  )
  const weddingsInquiry = await countQuery(supabase, 'weddings', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId).eq('status', 'inquiry')
  )

  // ---- Extractions ----
  const extractionsAll = await countQuery(supabase, 'intelligence_extractions', (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq('venue_id', venueId)
  )

  // ---- Recent inbound email sample (10) ----
  const { data: recentInbound } = await supabase
    .from('interactions')
    .select('id, timestamp, from_email, from_name, person_id, wedding_id, subject, classification')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: false })
    .limit(10)

  // ---- Orphan candidate sample (5) ----
  const { data: orphanSample } = await supabase
    .from('interactions')
    .select('id, timestamp, from_email, from_name, person_id, subject')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .is('wedding_id', null)
    .not('person_id', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(5)

  // ---- Wedding sample (10) ----
  const { data: weddingSample } = await supabase
    .from('weddings')
    .select('id, status, source, inquiry_date, wedding_date, heat_score, temperature_tier')
    .eq('venue_id', venueId)
    .order('inquiry_date', { ascending: false, nullsFirst: false })
    .limit(10)

  return NextResponse.json({
    venueId,
    gmail_connections: {
      count: connections?.length ?? 0,
      rows: (connections ?? []).map((c) => ({
        email: c.email_address,
        active: c.is_active,
        last_sync_at: c.last_sync_at,
      })),
    },
    interactions: {
      total: interactionsAll.count,
      email_inbound: interactionsEmailInbound.count,
      no_person_id: interactionsNoPerson.count,
      orphan_candidates_for_reprocess: interactionsOrphanCandidates.count,
    },
    people: {
      total: peopleAll.count,
      linked_to_wedding: peopleLinked.count,
      unlinked: peopleUnlinked.count,
      nameless_partner1_linked: peopleNameless.count,
    },
    weddings: {
      total: weddingsAll.count,
      inquiry: weddingsInquiry.count,
    },
    intelligence_extractions: {
      total: extractionsAll.count,
    },
    samples: {
      recent_inbound_emails: recentInbound ?? [],
      orphan_reprocess_candidates: orphanSample ?? [],
      recent_weddings: weddingSample ?? [],
    },
  })
}
