import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/repair-wedding-people?selfDomains=rixeymanor.com
//
// Reconciles the three tables whose join drives the pipeline kanban:
//   weddings  ── interactions ── people
// The original broken flow created weddings and stamped interactions.wedding_id
// but never set people.wedding_id, which is what the kanban's
// `people!people_wedding_id_fkey` join reads. Result: 19 weddings, 0 people
// linked, every card renders "Unknown".
//
// Repair steps per inquiry-wedding in this venue:
//  1. Gather that wedding's inbound interactions whose from_email is NOT
//     on a self domain (venue's own Gmail — those are outbound misfiled
//     as inbound).
//  2. Pick the oldest such interaction. Its person_id is the real lead.
//  3. Set people.wedding_id = thisWedding for that person.
//  4. If that person has no first_name, parse interactions.from_name
//     ("Sarah Rohrschneider" → first=Sarah, last=Rohrschneider) and
//     write it back.
//  5. If the wedding has NO non-self inbound interactions at all, it's a
//     self-ghost — flag for deletion, don't link.
//
// Self-domains: pass ?selfDomains=foo.com,bar.com (comma-separated). We
// ALSO pull gmail_connections.email_address for the venue, so once that
// table is populated the query param is optional.
//
// Read/write but idempotent: running twice is a no-op on weddings already
// linked.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const url = new URL(req.url)
  const selfDomainsParam = (url.searchParams.get('selfDomains') ?? '').trim()
  const paramDomains = selfDomainsParam
    ? selfDomainsParam
        .split(',')
        .map((s) => s.toLowerCase().trim())
        .filter(Boolean)
    : []

  const supabase = createServiceClient()

  // Pull Gmail connection addresses too (may be empty — Rixey hasn't linked yet).
  const { data: connectionsData } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  const connectionEmails = ((connectionsData ?? []) as Array<{ email_address: string }>)
    .map((c) => (c.email_address || '').toLowerCase().trim())
    .filter(Boolean)
  // Union: connection emails + param-provided domains
  const selfDomains = new Set<string>(paramDomains)
  const selfEmails = new Set<string>(connectionEmails)

  const matchesSelf = (fromEmail: string): boolean => {
    const e = (fromEmail || '').toLowerCase().trim()
    if (!e) return false
    if (selfEmails.has(e)) return true
    const atIdx = e.lastIndexOf('@')
    if (atIdx === -1) return false
    const domain = e.slice(atIdx + 1)
    return selfDomains.has(domain)
  }

  // Load all weddings in this venue (all stages — we repair non-inquiry too
  // in case a lead got advanced before people was linked).
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id, status')
    .eq('venue_id', venueId)

  if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 })

  const weddingIds = (weddings ?? []).map((w) => w.id as string)
  if (weddingIds.length === 0) {
    return NextResponse.json({ scanned: 0, linked: 0, named: 0, selfGhosts: 0 })
  }

  // One big pull of all interactions attached to these weddings.
  const { data: allInter } = await supabase
    .from('interactions')
    .select('id, wedding_id, person_id, from_email, from_name, timestamp, direction')
    .in('wedding_id', weddingIds)
    .order('timestamp', { ascending: true })

  // Bucket interactions by wedding_id, keeping inbound non-self first.
  const byWedding = new Map<
    string,
    Array<{
      id: string
      person_id: string | null
      from_email: string
      from_name: string | null
      timestamp: string
      direction: string
      self: boolean
    }>
  >()
  for (const i of allInter ?? []) {
    const wid = i.wedding_id as string
    if (!wid) continue
    if (!byWedding.has(wid)) byWedding.set(wid, [])
    byWedding.get(wid)!.push({
      id: i.id as string,
      person_id: (i.person_id as string | null) ?? null,
      from_email: (i.from_email as string) ?? '',
      from_name: (i.from_name as string | null) ?? null,
      timestamp: i.timestamp as string,
      direction: (i.direction as string) ?? '',
      self: matchesSelf((i.from_email as string) ?? ''),
    })
  }

  let linked = 0
  let named = 0
  let selfGhosts = 0
  const selfGhostIds: string[] = []
  const repaired: Array<{ weddingId: string; personId: string; name: string | null }> = []

  for (const w of weddings ?? []) {
    const wid = w.id as string
    const rows = byWedding.get(wid) ?? []
    // Candidate interaction: inbound, NOT self, has person_id.
    const candidate = rows.find(
      (r) => r.direction === 'inbound' && !r.self && r.person_id
    )

    if (!candidate) {
      // No real inbound lead attached. If there ARE inbound rows but they're
      // all self, it's a self-ghost. If there are no inbound rows at all,
      // leave it for the empty-ghost cleanup path.
      const hasSelfInbound = rows.some((r) => r.direction === 'inbound' && r.self)
      if (hasSelfInbound) {
        selfGhosts++
        selfGhostIds.push(wid)
      }
      continue
    }

    const personId = candidate.person_id as string

    // Does the person exist and what's their name state?
    const { data: personRow } = await supabase
      .from('people')
      .select('id, wedding_id, first_name, last_name')
      .eq('id', personId)
      .maybeSingle()

    if (!personRow) continue

    const update: Record<string, unknown> = {}
    if (!personRow.wedding_id) update.wedding_id = wid
    if (!personRow.first_name && !personRow.last_name && candidate.from_name) {
      const clean = candidate.from_name.trim()
      // Skip noise like "The Knot" / network wrappers
      const isNetworky =
        /^the knot$/i.test(clean) || /^weddingwire$/i.test(clean) || /network$/i.test(clean)
      if (!isNetworky) {
        const [first, ...rest] = clean.split(/\s+/)
        if (first) {
          update.first_name = first
          update.last_name = rest.join(' ') || null
        }
      }
    }

    if (Object.keys(update).length === 0) continue

    const { error: updErr } = await supabase
      .from('people')
      .update(update)
      .eq('id', personId)
    if (updErr) continue

    if ('wedding_id' in update) linked++
    if ('first_name' in update) named++
    repaired.push({
      weddingId: wid,
      personId,
      name: typeof update.first_name === 'string' ? String(update.first_name) : null,
    })
  }

  return NextResponse.json({
    scanned: weddingIds.length,
    linked,
    named,
    selfGhosts,
    selfGhostIds,
    selfDomainsUsed: [...selfDomains, ...selfEmails],
    repaired,
  })
}
