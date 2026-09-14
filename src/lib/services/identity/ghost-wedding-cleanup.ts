/**
 * Venue-self-bug cleanup — the injectable core behind
 * POST /api/agent/cleanup-ghost-weddings.
 *
 * The rule
 * --------
 * A "self-bug" wedding is one the venue accidentally raised against
 * itself: the coordinator's own outbound mail came back through the
 * pipeline as an inbound inquiry, so a pipeline card exists with the
 * venue as the couple. Two ways to spot one, both narrow on purpose:
 *
 *   B   partner1's email is one of the venue's own addresses (or a
 *       domain the operator passed in);
 *   B'  every inbound interaction on the wedding is from the venue
 *       itself — catches the case with no partner1 row at all.
 *
 * What it does about it
 * ---------------------
 * Tombstones, never deletes. `weddings.non_couple_at` +
 * `non_couple_reason = 'venue_self_bug'` (migration 332), the same
 * soft-tombstone the retroactive non-couple sweep uses. Hard DELETE on
 * `weddings` or `people` is a forensic-trail violation under the
 * constitution: the row is the record that the bug fired against this
 * venue, and deleting it destroys the only evidence of that. The bogus
 * person rows and the misfiled interactions are detached
 * (`wedding_id = NULL`), not removed.
 *
 * Rule A — "inquiry with no people and no interactions" — was retired in
 * the 2026-05-13 pass. An empty inquiry is signal that a thread was
 * opened, not garbage; filtering it off a pipeline view is a read
 * concern.
 *
 * Idempotent: a second run over a venue with no untombstoned self-bugs
 * writes nothing.
 *
 * Lives here rather than in the route so it can be tested against a fake
 * client — a test that could not observe the writes could not tell
 * tombstoning from deleting, which is the one thing that must not
 * regress.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface GhostCleanupResult {
  scanned: number
  tombstoned: number
  note: string
}

export const GHOST_CLEANUP_NOTE =
  'Rule A (empty-inquiry deletion) retired per doctrine; only venue-self-bug rows tombstoned. ' +
  'Constitution-compliant soft-tombstone via weddings.non_couple_at.'

export class GhostCleanupError extends Error {}

function normaliseEmail(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().trim() : ''
}

export async function cleanupGhostWeddings(
  supabase: SupabaseClient,
  venueId: string,
  paramDomains: readonly string[] = [],
): Promise<GhostCleanupResult> {
  // Pull all inquiry-stage weddings in this venue that aren't already
  // tombstoned. Booked/completed/lost are out of scope — coordinator
  // confirmation overrides bug-suspicion.
  // legacy-read-ok: LEGACY-ONLY repair primitive. The self-bug rows this
  // sweep tombstones exist only in the legacy mirror, and the tombstone
  // column it sets (weddings.non_couple_at, migration 332) is on the
  // same row. See REPAIR-ENDPOINTS.md.
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .is('non_couple_at', null)
    .is('merged_into_id', null)

  if (wErr) throw new GhostCleanupError(wErr.message)
  const weddingIds = ((weddings ?? []) as Array<{ id: string }>).map((w) => w.id)
  if (weddingIds.length === 0) {
    return { scanned: 0, tombstoned: 0, note: GHOST_CLEANUP_NOTE }
  }

  // Load partner1 person rows for these weddings so we can match Rule B
  // (partner1 email == venue's own).
  // legacy-read-ok: LEGACY-ONLY repair primitive, same sweep — the bogus
  // person row is the evidence being detached. See REPAIR-ENDPOINTS.md.
  const { data: peopleRows } = await supabase
    .from('people')
    .select('wedding_id, email')
    .in('wedding_id', weddingIds)

  // The venue's own Gmail addresses, plus any domains the operator
  // passed in as a fallback for a venue that has not linked Gmail yet.
  const { data: connectionsData } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  const selfEmails = new Set(
    ((connectionsData ?? []) as Array<{ email_address: string }>)
      .map((c) => normaliseEmail(c.email_address))
      .filter(Boolean),
  )
  const selfDomains = new Set(paramDomains.map((d) => d.toLowerCase().trim()).filter(Boolean))

  const matchesSelf = (email: unknown): boolean => {
    const e = normaliseEmail(email)
    if (!e) return false
    if (selfEmails.has(e)) return true
    const atIdx = e.lastIndexOf('@')
    if (atIdx === -1) return false
    return selfDomains.has(e.slice(atIdx + 1))
  }

  const selfWeddingIds = new Set<string>()
  if (selfEmails.size > 0 || selfDomains.size > 0) {
    for (const p of (peopleRows ?? []) as Array<{ wedding_id: string; email: unknown }>) {
      if (matchesSelf(p.email)) selfWeddingIds.add(p.wedding_id)
    }
  }

  // Rule B': weddings whose ONLY inbound interactions are from self.
  // legacy-read-ok: LEGACY-ONLY repair primitive — the misfiled inbound
  // it inspects is a legacy message-log row, which the spine does not
  // carry. See REPAIR-ENDPOINTS.md.
  const { data: inboundRows } = await supabase
    .from('interactions')
    .select('wedding_id, from_email')
    .in('wedding_id', weddingIds)
    .eq('direction', 'inbound')

  const inboundByWedding = new Map<string, unknown[]>()
  for (const r of (inboundRows ?? []) as Array<{ wedding_id: string | null; from_email: unknown }>) {
    if (!r.wedding_id) continue
    if (!inboundByWedding.has(r.wedding_id)) inboundByWedding.set(r.wedding_id, [])
    inboundByWedding.get(r.wedding_id)!.push(r.from_email)
  }
  for (const [wid, emails] of inboundByWedding.entries()) {
    if (emails.length === 0) continue
    if (emails.every((e) => matchesSelf(e))) selfWeddingIds.add(wid)
  }

  if (selfWeddingIds.size === 0) {
    return { scanned: weddingIds.length, tombstoned: 0, note: GHOST_CLEANUP_NOTE }
  }

  const selfIds = Array.from(selfWeddingIds)
  const now = new Date().toISOString()

  // 1. Soft-tombstone the wedding rows. The row stays for forensic
  //    audit; readers filter on non_couple_at IS NULL.
  const { error: tombErr } = await supabase
    .from('weddings')
    .update({ non_couple_at: now, non_couple_reason: 'venue_self_bug' })
    .in('id', selfIds)
    .is('non_couple_at', null)
  if (tombErr) throw new GhostCleanupError(tombErr.message)

  // 2. Detach the bogus partner1 person rows. Keeping the row preserves
  //    the email that triggered the bug.
  await supabase.from('people').update({ wedding_id: null }).in('wedding_id', selfIds)

  // 3. Detach the misfiled inbound. These were the coordinator's own
  //    messages picked up as inbound; they are not lead-side signal.
  await supabase.from('interactions').update({ wedding_id: null }).in('wedding_id', selfIds)

  return { scanned: weddingIds.length, tombstoned: selfIds.length, note: GHOST_CLEANUP_NOTE }
}
