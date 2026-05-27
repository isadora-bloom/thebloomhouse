/**
 * scripts/collapse-knot-duplicate-pending-drafts.ts
 * =================================================
 * Companion to `audit-knot-duplicate-pending-drafts.ts`. Same scan, but
 * with `--apply` it WRITES — for each personId with >1 pending Knot
 * draft, keep the EARLIEST (canonical) and update the rest to
 * `status='rejected'` with `feedback_notes` pinning the canonical id.
 *
 * Dry-run by default. Mirrors the audit script's output so the operator
 * sees exactly which rows will flip before adding `--apply`.
 *
 * Usage:
 *   # Dry-run (default — no writes):
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/collapse-knot-duplicate-pending-drafts.ts
 *
 *   # Apply:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/collapse-knot-duplicate-pending-drafts.ts --apply
 */

import { createClient } from '@supabase/supabase-js'
import { extractKnotPersonId } from '../src/lib/services/identity/knot-sender-id'

const APPLY = process.argv.includes('--apply')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error(
    'ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      'Run via: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/collapse-knot-duplicate-pending-drafts.ts',
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
const MODE = APPLY ? '[APPLY]' : '[DRY-RUN]'

console.log(HDR)
console.log(`${MODE} collapse knot duplicate pending drafts`)
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

const dupeGroups: Array<{ personId: string; drafts: DraftRow[] }> = []
for (const [personId, group] of byPerson) {
  if (group.length <= 1) continue
  group.sort((a, b) => a.created_at.localeCompare(b.created_at))
  dupeGroups.push({ personId, drafts: group })
}
dupeGroups.sort((a, b) => b.drafts.length - a.drafts.length)

if (dupeGroups.length === 0) {
  console.log('No personIds with >1 pending draft. Nothing to collapse.')
  console.log(HDR)
  process.exit(0)
}

console.log(`Found ${dupeGroups.length} personId(s) with duplicate pending drafts.`)
console.log('')

let totalDuplicates = 0
let totalRejected = 0
let totalFailed = 0

for (const g of dupeGroups) {
  const canonical = g.drafts[0]
  const duplicates = g.drafts.slice(1)
  totalDuplicates += duplicates.length

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

  const note = `2026-05-27 Knot per-personId duplicate collapse — canonical kept: ${canonical.id}`
  const dupIds = duplicates.map((d) => d.id)

  if (APPLY) {
    const { data: updated, error: updErr } = await sb
      .from('drafts')
      .update({ status: 'rejected', feedback_notes: note })
      .in('id', dupIds)
      .eq('venue_id', venueId)
      .eq('status', 'pending')
      .select('id')
    if (updErr) {
      console.log(`  >> WRITE FAILED: ${updErr.message}`)
      totalFailed += dupIds.length
    } else {
      const n = updated?.length ?? 0
      console.log(`  >> rejected ${n}/${dupIds.length} duplicate draft(s)`)
      console.log(`     feedback_notes: "${note}"`)
      totalRejected += n
      if (n < dupIds.length) {
        totalFailed += dupIds.length - n
        console.log(
          `     NOTE: ${dupIds.length - n} row(s) did not flip (likely status changed under us)`,
        )
      }
    }
  } else {
    console.log(`  >> would reject ${dupIds.length} duplicate draft(s)`)
    console.log(`     feedback_notes: "${note}"`)
  }
}

console.log('')
console.log(HDR)
console.log(`SUMMARY  ${MODE}`)
console.log(HDR)
console.log(`  pending Knot drafts scanned             : ${rows.length}`)
console.log(`  pending Knot drafts unparseable         : ${unparsed}`)
console.log(`  personIds with duplicates               : ${dupeGroups.length}`)
console.log(`  duplicate drafts targeted               : ${totalDuplicates}`)
console.log(`  canonical drafts kept                   : ${dupeGroups.length}`)
if (APPLY) {
  console.log(`  duplicate drafts rejected (written)     : ${totalRejected}`)
  console.log(`  failed writes                           : ${totalFailed}`)
} else {
  console.log(`  duplicate drafts that WOULD be rejected : ${totalDuplicates}`)
}
console.log('')
if (!APPLY) {
  console.log('DRY-RUN — no writes. Re-run with --apply to flip the rows.')
} else {
  console.log('Writes complete.')
}
console.log(HDR)
