/**
 * scripts/audit-knot-duplicate-pending-drafts.ts
 * ==============================================
 * READ-ONLY audit. Scans Rixey's pending drafts directed at Knot
 * member-inbox relay addresses (`*@member.theknot.com`) and groups them
 * by the per-prospect personId extracted from the localpart. Any
 * personId with >1 pending draft is the duplicate-relay flood pattern
 * documented in `src/lib/services/identity/knot-sender-id.ts` — Knot
 * sends 3+ separate emails per inquiry, the legacy resolver minted a
 * fresh person/draft for each, and the operator sees an inbox of dupes.
 *
 * This script does NOT write. It prints what the per-personId collapse
 * would do, so the operator can spot-check before running the companion
 * `collapse-knot-duplicate-pending-drafts.ts --apply`.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/audit-knot-duplicate-pending-drafts.ts
 */

import { createClient } from '@supabase/supabase-js'
import { extractKnotPersonId } from '../src/lib/services/identity/knot-sender-id'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error(
    'ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      'Run via: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/audit-knot-duplicate-pending-drafts.ts',
  )
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

// venues.prefix lives on venue_config, not venues. Mirror cleanup-pending-drafts.mjs.
const { data: vc, error: vcErr } = await sb
  .from('venue_config')
  .select('venue_id, business_name')
  .eq('venue_prefix', 'RM')
  .single()
if (vcErr || !vc) {
  console.error('venue_config lookup failed:', vcErr)
  console.log('Falling back to known Rixey venue_id')
}
const venueId = vc?.venue_id ?? 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const venueName = vc?.business_name ?? 'Rixey Manor (fallback)'

const DIV = '-'.repeat(60)
const HDR = '='.repeat(78)

console.log(HDR)
console.log('[AUDIT] knot duplicate pending drafts — READ ONLY')
console.log(HDR)
console.log(`Venue   : ${venueName}  (${venueId})`)
console.log(`Target  : ${url}`)
console.log('')

interface DraftRow {
  id: string
  to_email: string | null
  created_at: string
  wedding_id: string | null
  confidence_score: number | null
  draft_body: string | null
}

const { data: drafts, error: draftsErr } = await sb
  .from('drafts')
  .select('id, to_email, created_at, wedding_id, confidence_score, draft_body')
  .eq('venue_id', venueId)
  .eq('status', 'pending')
  .like('to_email', '%@member.theknot.com')
  .order('created_at', { ascending: true })

if (draftsErr) {
  console.error('drafts query failed:', draftsErr)
  process.exit(1)
}

const rows: DraftRow[] = drafts ?? []
console.log(`Scanned ${rows.length} pending Knot draft(s).`)
console.log('')

// Group by personId. Skip rows whose to_email does not parse as a
// per-prospect Knot relay (extractKnotPersonId returns null for shared
// relays like leads@theknot.com — we leave those alone).
const byPerson = new Map<string, DraftRow[]>()
let unparsed = 0
for (const r of rows) {
  const pid = extractKnotPersonId(r.to_email)
  if (!pid) {
    unparsed++
    continue
  }
  const arr = byPerson.get(pid) ?? []
  arr.push(r)
  byPerson.set(pid, arr)
}

if (unparsed > 0) {
  console.log(
    `Skipped ${unparsed} pending draft(s) whose to_email did not parse as a per-prospect Knot relay.`,
  )
  console.log('')
}

// Filter to duplicates only.
const dupeGroups: Array<{ personId: string; drafts: DraftRow[] }> = []
for (const [personId, group] of byPerson) {
  if (group.length <= 1) continue
  // already sorted asc by query, but be defensive
  group.sort((a, b) => a.created_at.localeCompare(b.created_at))
  dupeGroups.push({ personId, drafts: group })
}

dupeGroups.sort((a, b) => b.drafts.length - a.drafts.length)

if (dupeGroups.length === 0) {
  console.log('No personIds with >1 pending draft. Nothing to collapse.')
} else {
  console.log(`Found ${dupeGroups.length} personId(s) with duplicate pending drafts.`)
  console.log('')
}

let totalDuplicates = 0
for (const g of dupeGroups) {
  totalDuplicates += g.drafts.length - 1
  console.log(DIV)
  console.log(`personId : ${g.personId}    (${g.drafts.length} pending drafts)`)
  console.log(DIV)
  for (let i = 0; i < g.drafts.length; i++) {
    const d = g.drafts[i]
    const tag = i === 0 ? 'CANONICAL (keep)            ' : 'DUPLICATE (would-be-rejected)'
    const body = (d.draft_body ?? '').replace(/\s+/g, ' ').slice(0, 120)
    const conf =
      d.confidence_score === null || d.confidence_score === undefined
        ? '(null)'
        : String(d.confidence_score)
    console.log(`  [${tag}]`)
    console.log(`    draft_id     : ${d.id}`)
    console.log(`    to_email     : ${d.to_email ?? '(null)'}`)
    console.log(`    created_at   : ${d.created_at}`)
    console.log(`    wedding_id   : ${d.wedding_id ?? '(null)'}`)
    console.log(`    confidence   : ${conf}`)
    console.log(`    body[0..120] : ${body}${(d.draft_body ?? '').length > 120 ? '…' : ''}`)
  }
}

console.log('')
console.log(HDR)
console.log('SUMMARY')
console.log(HDR)
console.log(`  pending Knot drafts scanned             : ${rows.length}`)
console.log(`  pending Knot drafts unparseable         : ${unparsed}`)
console.log(`  personIds with duplicates               : ${dupeGroups.length}`)
console.log(`  duplicate drafts that would be rejected : ${totalDuplicates}`)
console.log(`  drafts that would remain (canonical)    : ${dupeGroups.length}`)
console.log('')
console.log('READ-ONLY. No writes performed.')
console.log(
  'To collapse: node --env-file=.env.local node_modules/tsx/dist/cli.mjs ' +
    'scripts/collapse-knot-duplicate-pending-drafts.ts --apply',
)
console.log(HDR)
