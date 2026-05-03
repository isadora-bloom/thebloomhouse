// Backfill: concatenated couple-name detection (T5-Rixey-UU Bug G).
//
// Some web-form / venue-calculator imports landed before the
// concat-couple-name splitter existed. Their `people.first_name`
// fields look like "Megandcooperrosenberg" or "Jganthony" — one
// glued string with no spaces.
//
// This script:
//   1. Scans people rows joined to weddings whose names "look like"
//      concatenations (length > 12, no whitespace, mixed case OR
//      all-lowercase).
//   2. Runs each candidate through splitConcatenatedCoupleName().
//   3. CONFIDENT splits → updates partner1 + creates / updates
//      partner2 with the second name (+ shared surname).
//   4. UNCONFIDENT splits → leaves the name as-is, stamps the
//      wedding with import_warnings = [{ field: 'couple_name',
//      issue: 'unparseable_concat', value: '<original>' }] so the
//      coordinator sees a "needs review" badge on the leads page.
//
// Conservative by design: false positives (wrong splits) corrupt
// both partner records, so we err toward flag-and-leave when the
// splitter isn't confident.
//
// Usage:
//   npx tsx scripts/backfill-concat-couple-names.ts            # dry-run
//   npx tsx scripts/backfill-concat-couple-names.ts --apply
//   npx tsx scripts/backfill-concat-couple-names.ts --apply --venue <uuid>

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import {
  splitConcatenatedCoupleName,
  looksLikeConcatenatedCoupleName,
} from '../src/lib/services/crm-import/primitives/couple-parser'

// ---- env loader (same shape as the other backfill scripts) ----
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null

interface PersonRow {
  id: string
  wedding_id: string | null
  venue_id: string
  role: string | null
  first_name: string | null
  last_name: string | null
}

interface WarningRow {
  field: string
  issue: string
  value?: string | null
}

async function main() {
  console.log(`backfill-concat-couple-names: ${apply ? 'APPLY' : 'DRY-RUN'}${venueId ? ` venue=${venueId}` : ' all venues'}`)

  // 1. Pull partner1 rows that look like concat candidates.
  let pq = sb
    .from('people')
    .select('id, wedding_id, venue_id, role, first_name, last_name')
    .eq('role', 'partner1')
    .not('wedding_id', 'is', null)
    .not('first_name', 'is', null)
  if (venueId) pq = pq.eq('venue_id', venueId)
  const { data: people, error: pErr } = await pq
  if (pErr) {
    console.error('people query failed:', pErr.message)
    process.exit(1)
  }

  const candidates: PersonRow[] = []
  for (const p of (people ?? []) as PersonRow[]) {
    // Build the "full" first-name candidate. Some rows have the
    // glued name in first_name only; others split it across first
    // + last (e.g. first="Megan", last="dcooperrosenberg"). We
    // re-glue and run the heuristic on that.
    const glued = `${p.first_name ?? ''}${p.last_name ?? ''}`.trim()
    if (looksLikeConcatenatedCoupleName(glued) || looksLikeConcatenatedCoupleName(p.first_name)) {
      candidates.push(p)
    }
  }

  console.log(`scanned ${(people ?? []).length} partner1 rows; found ${candidates.length} concat candidates`)

  // 2. Pull partner2 rows for those weddings — we don't want to
  //    trample existing partner2 data.
  const weddingIds = candidates.map((c) => c.wedding_id!).filter(Boolean)
  const partner2ByWedding: Record<string, PersonRow> = {}
  if (weddingIds.length > 0) {
    const { data: p2s } = await sb
      .from('people')
      .select('id, wedding_id, venue_id, role, first_name, last_name')
      .eq('role', 'partner2')
      .in('wedding_id', weddingIds)
    for (const p of (p2s ?? []) as PersonRow[]) {
      if (p.wedding_id) partner2ByWedding[p.wedding_id] = p
    }
  }

  // 3. Run the splitter, partition into confident / unconfident.
  const confident: Array<{ p: PersonRow; partner1: string; partner2: string; surname: string | null; reason: string }> = []
  const unconfident: Array<{ p: PersonRow; original: string; reason: string }> = []

  for (const p of candidates) {
    // Skip if partner2 already has a real first name — promoting
    // a split here would overwrite that. We only fix weddings with
    // a single populated partner.
    if (p.wedding_id && partner2ByWedding[p.wedding_id]?.first_name) continue

    const glued = `${p.first_name ?? ''}${p.last_name ?? ''}`.trim()
    const candidate = glued || p.first_name || ''
    const result = splitConcatenatedCoupleName(candidate)
    if (result.confidence === 'confident' && result.partner1 && result.partner2) {
      confident.push({
        p,
        partner1: result.partner1,
        partner2: result.partner2,
        surname: result.surname,
        reason: result.reason,
      })
    } else {
      unconfident.push({ p, original: candidate, reason: result.reason })
    }
  }

  console.log(`confident splits: ${confident.length}`)
  console.log(`unconfident (will be flagged): ${unconfident.length}`)

  // 4. Print preview.
  console.log('\n--- confident sample ---')
  for (const c of confident.slice(0, 10)) {
    console.log(`  wedding=${c.p.wedding_id} "${c.p.first_name} ${c.p.last_name ?? ''}" → "${c.partner1}" / "${c.partner2}${c.surname ? ' ' + c.surname : ''}" (${c.reason})`)
  }
  console.log('\n--- unconfident sample ---')
  for (const u of unconfident.slice(0, 10)) {
    console.log(`  wedding=${u.p.wedding_id} "${u.original}" — ${u.reason}`)
  }

  if (!apply) {
    console.log('\n--dry-run— pass --apply to write')
    return
  }

  // 5. Apply confident splits.
  let p1Updates = 0
  let p2Inserts = 0
  let p2Updates = 0
  for (const c of confident) {
    if (!c.p.wedding_id) continue

    // Update partner1
    const { error: u1Err } = await sb
      .from('people')
      .update({ first_name: c.partner1, last_name: c.surname })
      .eq('id', c.p.id)
    if (u1Err) {
      console.error(`partner1 update failed for ${c.p.id}: ${u1Err.message}`)
      continue
    }
    p1Updates++

    // Upsert partner2 — if a partner2 row exists with no first_name
    // we update it; otherwise insert a new one.
    const existing2 = partner2ByWedding[c.p.wedding_id]
    if (existing2) {
      const { error: u2Err } = await sb
        .from('people')
        .update({ first_name: c.partner2, last_name: c.surname })
        .eq('id', existing2.id)
      if (u2Err) {
        console.error(`partner2 update failed for ${existing2.id}: ${u2Err.message}`)
      } else {
        p2Updates++
      }
    } else {
      const { error: i2Err } = await sb.from('people').insert({
        venue_id: c.p.venue_id,
        wedding_id: c.p.wedding_id,
        role: 'partner2',
        first_name: c.partner2,
        last_name: c.surname,
      })
      if (i2Err) {
        console.error(`partner2 insert failed for wedding ${c.p.wedding_id}: ${i2Err.message}`)
      } else {
        p2Inserts++
      }
    }
  }

  // 6. Flag unconfident rows on weddings.import_warnings (jsonb).
  let flagged = 0
  for (const u of unconfident) {
    if (!u.p.wedding_id) continue
    const { data: wed } = await sb
      .from('weddings')
      .select('import_warnings')
      .eq('id', u.p.wedding_id)
      .maybeSingle()
    const existing = (wed?.import_warnings as WarningRow[] | null) ?? []
    // Skip if the warning is already there.
    if (existing.some((w) => w.field === 'couple_name' && w.value === u.original)) continue
    const next = [
      ...existing,
      { field: 'couple_name', issue: 'unparseable_concat', value: u.original },
    ]
    const { error: wErr } = await sb
      .from('weddings')
      .update({ import_warnings: next })
      .eq('id', u.p.wedding_id)
    if (wErr) {
      console.error(`warnings update failed for wedding ${u.p.wedding_id}: ${wErr.message}`)
    } else {
      flagged++
    }
  }

  console.log('\n--- applied ---')
  console.log(`partner1 updates:        ${p1Updates}`)
  console.log(`partner2 inserts:        ${p2Inserts}`)
  console.log(`partner2 updates:        ${p2Updates}`)
  console.log(`weddings flagged:        ${flagged}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
