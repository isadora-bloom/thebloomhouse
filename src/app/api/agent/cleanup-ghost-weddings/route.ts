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
// A wedding is "ghost" iff ANY of:
//   (A) inquiry-stage, no linked people, no linked interactions (original
//       definition — rows the broken pipeline created and abandoned), OR
//   (B) inquiry-stage AND its linked partner1 email matches one of the
//       venue's own gmail_connections.email_address entries. This is the
//       "Sage at Rixey Manor" bug — an outbound email from the coordinator
//       got misclassified as an inbound inquiry and promoted to a pipeline
//       card with the venue itself as the couple. Never valid.
//
// Safe by construction: in (A) there is nothing to lose; in (B) the
// "couple" is literally the venue's own address, which cannot be a real
// lead.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  // Optional: ?selfDomains=rixeymanor.com,other.com — fallback when the
  // venue hasn't linked a Gmail connection yet (so gmail_connections is
  // empty and rule B would otherwise catch nothing).
  const url = new URL(req.url)
  const paramDomains = (url.searchParams.get('selfDomains') ?? '')
    .split(',')
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)

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

  // Which of these have any people? (and what emails are on them)
  const { data: peopleRows } = await supabase
    .from('people')
    .select('wedding_id, email, role')
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

  // Load the venue's own Gmail connection addresses for rule (B).
  const { data: connectionsData } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  const selfEmails = new Set(
    ((connectionsData ?? []) as Array<{ email_address: string }>)
      .map((c) => (c.email_address || '').toLowerCase().trim())
      .filter(Boolean)
  )

  // Rule (B): weddings whose partner1 person has an email that belongs to
  // the venue itself. These should never have been inquiries. We match by
  // exact email (gmail_connections) OR by domain (selfDomains query param)
  // so this works even before the venue has linked Gmail.
  const selfDomains = new Set(paramDomains)
  const selfWeddingIds = new Set<string>()
  if (selfEmails.size > 0 || selfDomains.size > 0) {
    for (const p of peopleRows ?? []) {
      const email = ((p.email as string) || '').toLowerCase().trim()
      if (!email) continue
      if (selfEmails.has(email)) {
        selfWeddingIds.add(p.wedding_id as string)
        continue
      }
      const atIdx = email.lastIndexOf('@')
      if (atIdx !== -1) {
        const domain = email.slice(atIdx + 1)
        if (selfDomains.has(domain)) {
          selfWeddingIds.add(p.wedding_id as string)
        }
      }
    }
  }

  // Rule (B'): weddings where NO partner1 person exists at all, but the
  // only attached interactions are from a self domain/email. Those are
  // also self-ghosts — the "couple" was literally Rixey's outbound.
  const { data: selfInterRows } = await supabase
    .from('interactions')
    .select('wedding_id, from_email, direction')
    .in('wedding_id', weddingIds)
    .eq('direction', 'inbound')

  const matchesSelf = (fromEmail: string): boolean => {
    const e = (fromEmail || '').toLowerCase().trim()
    if (!e) return false
    if (selfEmails.has(e)) return true
    const atIdx = e.lastIndexOf('@')
    if (atIdx === -1) return false
    return selfDomains.has(e.slice(atIdx + 1))
  }

  // For each wedding, check if every inbound interaction is self.
  const interByWedding = new Map<string, string[]>()
  for (const r of selfInterRows ?? []) {
    const wid = r.wedding_id as string
    if (!wid) continue
    if (!interByWedding.has(wid)) interByWedding.set(wid, [])
    interByWedding.get(wid)!.push((r.from_email as string) ?? '')
  }
  for (const [wid, emails] of interByWedding.entries()) {
    if (emails.length === 0) continue
    if (emails.every((e) => matchesSelf(e))) selfWeddingIds.add(wid)
  }

  // Rule (A): empty weddings.
  const emptyWeddings = weddingIds.filter(
    (id) => !withPeople.has(id) && !withInteractions.has(id)
  )

  const ghosts = Array.from(new Set([...emptyWeddings, ...selfWeddingIds]))

  if (ghosts.length === 0) {
    return NextResponse.json({ scanned: weddingIds.length, deleted: 0 })
  }

  // For self-weddings (rule B), there are real rows attached — the
  // coordinator's own outbound message and a bogus "partner1" person
  // holding the venue's own email. Unwind those first so the delete
  // doesn't leave dangling FKs or re-orphan legit interactions.
  if (selfWeddingIds.size > 0) {
    const selfIds = Array.from(selfWeddingIds)
    // Delete the bogus venue-as-partner person rows.
    await supabase
      .from('people')
      .delete()
      .in('wedding_id', selfIds)
    // Clear wedding_id on interactions so they revert to orphaned state
    // (direction=outbound from the venue, not tied to any lead).
    await supabase
      .from('interactions')
      .update({ wedding_id: null })
      .in('wedding_id', selfIds)
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
    empty: emptyWeddings.length,
    self: selfWeddingIds.size,
  })
}
