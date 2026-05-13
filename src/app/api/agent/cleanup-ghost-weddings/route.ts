import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/cleanup-ghost-weddings
//
// 2026-05-13 — refactored per Step 9 of bloom-identity-resolution-doctrine.
//
// History
// -------
// This endpoint used to DELETE two flavours of "ghost" wedding:
//   (A) inquiry-stage with no linked people and no linked interactions
//   (B) inquiry-stage where partner1 email matches the venue's own Gmail
//       (the "Sage at Rixey Manor" self-bug — outbound coordinator email
//       misclassified as inbound inquiry, promoted to a pipeline card
//       with the venue itself as the couple)
//
// Per the constitution and the [[bloom-repair-endpoint-classification]]
// audit, hard DELETE on weddings is a forensic-trail violation. Two
// changes:
//
//  1. **Rule A retired.** "Empty inquiry" weddings are signal, not
//     garbage — the existence of a wedding row records that a thread
//     was opened. The Wave 4 judge + name-upgrade flow eventually fill
//     these in once signal arrives. Retiring Rule A also kills the
//     overlap with `runEmptyWeddingPrune` (which is itself being retired
//     in this same Step 10 sweep). If a coordinator wants empties off
//     their pipeline view, that's a filter-on-read concern, not a
//     mutation-on-write one.
//
//  2. **Rule B converted to soft-tombstone.** Self-bug weddings get
//     `weddings.non_couple_at = NOW()` + `non_couple_reason =
//     'venue_self_bug'` (column from mig 332). The bogus partner1
//     person row gets its `wedding_id` NULLed so it stops appearing on
//     the wedding's people join but the row itself is preserved as
//     evidence the bug fired against this venue. Interactions attached
//     to the ghost wedding likewise get `wedding_id = NULL` (they were
//     outbound coordinator chatter, not lead-side signal).
//
// Going forward, this endpoint is the manual peer of
// `tombstoneNonCouples` in the daily prune_maintenance cron — same
// soft-tombstone, narrower rule (self-bug only, not the intent-class
// rollup), faster to fire when an operator notices a fresh self-bug
// during onboarding.
//
// Idempotent. Re-running on a venue with no untombstoned self-bugs is a
// no-op.
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
  // empty and the rule would otherwise catch nothing).
  const url = new URL(req.url)
  const paramDomains = (url.searchParams.get('selfDomains') ?? '')
    .split(',')
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)

  const supabase = createServiceClient()

  // Pull all inquiry-stage weddings in this venue that aren't already
  // tombstoned. Booked/completed/lost are out of scope — coordinator
  // confirmation overrides bug-suspicion.
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .is('non_couple_at', null)
    .is('merged_into_id', null)

  if (wErr) {
    return NextResponse.json({ error: wErr.message }, { status: 500 })
  }
  if (!weddings || weddings.length === 0) {
    return NextResponse.json({ scanned: 0, tombstoned: 0 })
  }

  const weddingIds = weddings.map((w) => w.id as string)

  // Load partner1 person rows for these weddings so we can match Rule B
  // (partner1 email == venue's own).
  const { data: peopleRows } = await supabase
    .from('people')
    .select('wedding_id, email')
    .in('wedding_id', weddingIds)

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
  const selfDomains = new Set(paramDomains)

  const matchesSelf = (email: string): boolean => {
    const e = (email || '').toLowerCase().trim()
    if (!e) return false
    if (selfEmails.has(e)) return true
    const atIdx = e.lastIndexOf('@')
    if (atIdx === -1) return false
    return selfDomains.has(e.slice(atIdx + 1))
  }

  // Rule B: weddings whose partner1 email belongs to the venue itself.
  const selfWeddingIds = new Set<string>()
  if (selfEmails.size > 0 || selfDomains.size > 0) {
    for (const p of peopleRows ?? []) {
      const email = (p.email as string) ?? ''
      if (matchesSelf(email)) {
        selfWeddingIds.add(p.wedding_id as string)
      }
    }
  }

  // Rule B': weddings whose ONLY inbound interactions are from self
  // (venue's outbound misfiled as inbound). Without this, a wedding
  // with no partner1 person row but with self-only interactions slips
  // through.
  const { data: inboundRows } = await supabase
    .from('interactions')
    .select('wedding_id, from_email')
    .in('wedding_id', weddingIds)
    .eq('direction', 'inbound')

  const inboundByWedding = new Map<string, string[]>()
  for (const r of inboundRows ?? []) {
    const wid = r.wedding_id as string
    if (!wid) continue
    if (!inboundByWedding.has(wid)) inboundByWedding.set(wid, [])
    inboundByWedding.get(wid)!.push((r.from_email as string) ?? '')
  }
  for (const [wid, emails] of inboundByWedding.entries()) {
    if (emails.length === 0) continue
    if (emails.every((e) => matchesSelf(e))) selfWeddingIds.add(wid)
  }

  if (selfWeddingIds.size === 0) {
    return NextResponse.json({
      scanned: weddingIds.length,
      tombstoned: 0,
    })
  }

  const selfIds = Array.from(selfWeddingIds)
  const now = new Date().toISOString()

  // 1. Soft-tombstone the wedding rows. Constitution-compliant: the row
  //    stays for forensic audit; readers must filter on non_couple_at IS NULL.
  const { error: tombErr } = await supabase
    .from('weddings')
    .update({
      non_couple_at: now,
      non_couple_reason: 'venue_self_bug',
    })
    .in('id', selfIds)
    .is('non_couple_at', null)
  if (tombErr) {
    return NextResponse.json({ error: tombErr.message }, { status: 500 })
  }

  // 2. Detach the bogus partner1 person rows from the wedding. We do NOT
  //    delete them — keeping the row preserves the email that triggered
  //    the bug. Setting wedding_id = NULL removes them from the wedding's
  //    people join (which already filters on non_couple tombstoned
  //    weddings anyway, but belt-and-suspenders).
  await supabase
    .from('people')
    .update({ wedding_id: null })
    .in('wedding_id', selfIds)

  // 3. Detach the misfiled outbound interactions. These were the
  //    coordinator's own messages picked up as inbound; they shouldn't
  //    appear as lead-side signal. Same NULL pattern.
  await supabase
    .from('interactions')
    .update({ wedding_id: null })
    .in('wedding_id', selfIds)

  return NextResponse.json({
    scanned: weddingIds.length,
    tombstoned: selfIds.length,
    note: 'Rule A (empty-inquiry deletion) retired per doctrine; only venue-self-bug rows tombstoned. Constitution-compliant soft-tombstone via weddings.non_couple_at.',
  })
}
