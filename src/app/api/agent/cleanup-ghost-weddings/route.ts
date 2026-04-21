import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/cleanup-ghost-weddings
//
// Removes weddings rows that were created by the original (broken) pipeline
// run and never got populated: no linked people, no linked interactions,
// still in status='inquiry'. These show up on the pipeline kanban as empty
// cards with no partner name, no email — pure noise.
//
// A wedding is "ghost" iff:
//   - venue_id matches the caller's scope
//   - status = 'inquiry'   (never advanced)
//   - no rows in people where wedding_id = this.id
//   - no rows in interactions where wedding_id = this.id
//
// Safe by construction: any wedding the user has actually touched will have
// at least one interaction stamped to it, or a partner linked via people.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Pull all inquiry-stage weddings in this venue.
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')

  if (wErr) {
    return NextResponse.json({ error: wErr.message }, { status: 500 })
  }
  if (!weddings || weddings.length === 0) {
    return NextResponse.json({ scanned: 0, deleted: 0 })
  }

  const weddingIds = weddings.map((w) => w.id as string)

  // Which of these have any people?
  const { data: peopleRows } = await supabase
    .from('people')
    .select('wedding_id')
    .in('wedding_id', weddingIds)

  // Which of these have any interactions?
  const { data: interactionRows } = await supabase
    .from('interactions')
    .select('wedding_id')
    .in('wedding_id', weddingIds)

  const withPeople = new Set(
    (peopleRows ?? []).map((r) => r.wedding_id as string).filter(Boolean)
  )
  const withInteractions = new Set(
    (interactionRows ?? []).map((r) => r.wedding_id as string).filter(Boolean)
  )

  const ghosts = weddingIds.filter(
    (id) => !withPeople.has(id) && !withInteractions.has(id)
  )

  if (ghosts.length === 0) {
    return NextResponse.json({ scanned: weddingIds.length, deleted: 0 })
  }

  // Clean ancillary rows that FK to weddings with ON DELETE SET NULL/CASCADE,
  // but some helper tables (engagement_events, booked_dates, drafts) may
  // still hold references. Delete the ones we know about explicitly so the
  // pipeline kanban and analytics stay clean.
  await supabase.from('engagement_events').delete().in('wedding_id', ghosts)
  await supabase.from('drafts').delete().in('wedding_id', ghosts)
  await supabase.from('intelligence_extractions').delete().in('wedding_id', ghosts)

  const { error: delErr, count } = await supabase
    .from('weddings')
    .delete({ count: 'exact' })
    .in('id', ghosts)

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({
    scanned: weddingIds.length,
    deleted: count ?? ghosts.length,
  })
}
