/**
 * cleanup-booked-couples.mjs — reusable cleanup for the three
 * booked-couples data-quality problems at Rixey Manor:
 *
 *   1. Cross-source duplicate couples (merge into the canonical wedding).
 *   2. Possessive "'s" leaking into person names (strip it).
 *   3. Venue-own-address people minted as couples (tombstone / clear).
 *
 * Plus: dedupe stacked people on a wedding after a merge.
 *
 * DRY-RUN by default. Pass --apply to write.
 *
 *   node scripts/cleanup-booked-couples.mjs           # dry-run
 *   node scripts/cleanup-booked-couples.mjs --apply    # apply
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('tsx/esm', pathToFileURL('./'))

const APPLY = process.argv.includes('--apply')
const env = {}
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2].trim(); if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1)
  env[m[1]] = v.split('\\')[0].trim()
}
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
process.env.SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { mergeWeddings } = await import('../src/lib/services/identity/resolver.ts')
const { mergePeople } = await import('../src/lib/services/identity/merge-people.ts')
const { mirrorCoupleFromWedding } = await import('../src/lib/services/identity/mirror-couple.ts')

const tag = APPLY ? '[APPLY]' : '[DRY-RUN]'
console.log(`\n${tag} cleanup-booked-couples\n`)

// ---------------------------------------------------------------------------
// Problem 1 — duplicate clusters. canonical -> [duplicates]
// Picked by: real wedding_date AND booking_value present; tie-break earliest
// created_at. Confirmed by diagnostic 2026-05-16.
// ---------------------------------------------------------------------------
const MERGE_PLAN = [
  // Nick Busekrus & Ai Vy Le
  { canonical: '292a6c4b-9d58-447a-beaa-387e834d9c1d', duplicates: ['0aa62f17-78ec-403d-b968-8b09cb3b73ba'] },
  // Ariana Gleason & Mitchell
  { canonical: 'cdbc10ff-1094-452b-b09b-c1a32ff5a556', duplicates: ['53eedcdb-ee17-4fc8-ac3a-3c41ce1c4274'] },
  // Valerie & Christian Harper (3-way)
  { canonical: 'ca342d9e-e6f6-417f-8372-0e807268710e', duplicates: ['1dbad969-746c-467d-83d2-ffefab47ed87', 'bda40f99-6847-45ec-a687-690a343a2e3c'] },
  // Gabriella Ponzini & Jake Kinder
  { canonical: 'd8230318-a2d6-403d-ab18-dc169259d33e', duplicates: ['a726fc68-49dc-4d40-b9bf-0874de0bdb20'] },
  // Jody & Suzi Frye
  { canonical: '8861ba5e-b0d1-4600-aca7-433711ed88f8', duplicates: ['eb2ef010-1b23-4884-a35d-a4d76c055d22'] },
  // Rachel & John Davis
  { canonical: '4ec28b39-ce99-417b-88f1-8382ae4f2986', duplicates: ['91a6628f-0c89-4cdd-9f8d-ea62b25acf20'] },
]

// Weddings that have stacked partner2 people independent of a merge.
const STANDALONE_DEDUP_WEDDINGS = ['a4f62e5a-5902-4807-be2d-151e888752cf']

// Problem 3 — venue-address weddings.
//   2aa6ceaf — "(Unknown) Baker test" / grace@  -> tombstone (test data, no couple)
//   b34f8792 — "Paul Blogs" / accounts@         -> tombstone (placeholder, no couple)
//   d501a3bc — "Allison Gleason" + "Dale Roop"  -> real couple, just clear bad email
const TOMBSTONE_WEDDINGS = [
  '2aa6ceaf-ba14-429c-b588-2f465d5c2303',
  'b34f8792-26b8-49f9-99ff-5ac2c92ed7cd',
]
const CLEAR_VENUE_EMAIL_PEOPLE = [
  { personId: '3933a8e0-2b4c-4fc7-ba4d-12c92f63a7c2', wedding: 'd501a3bc-b872-46d0-8f85-204446a21541' },
]

const ALIAS = { nick: 'nicholas', nicky: 'nicholas', mike: 'michael', mikey: 'michael', chris: 'christopher', matt: 'matthew', dave: 'david', dan: 'daniel', danny: 'daniel', joe: 'joseph', tom: 'thomas', tcommy: 'thomas', will: 'william', billy: 'william', bill: 'william', jim: 'james', jimmy: 'james', rob: 'robert', bob: 'robert', greg: 'gregory', ben: 'benjamin', sam: 'samuel', alex: 'alexander', kate: 'katherine', katie: 'katherine', kathy: 'katherine', cathy: 'catherine', liz: 'elizabeth', beth: 'elizabeth', abby: 'abigail', gabby: 'gabriella', gabi: 'gabriella', jen: 'jennifer', jenny: 'jennifer', becca: 'rebecca', becky: 'rebecca', maggie: 'margaret', max: 'maximillian', maxi: 'maximillian' }
const norm = s => (s ?? '').trim().toLowerCase()
const canonFirst = s => { const n = norm(s); return ALIAS[n] ?? n }
const isJunkName = s => { const n = norm(s); return !n || n === 'unknown' || n === '(unknown)' || n === 'null' || n === 'wedding' || n === 'weddings' }

async function getPeople(weddingId) {
  const { data } = await supabase
    .from('people')
    .select('id, wedding_id, role, first_name, last_name, email, phone, created_at, name_confidence')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
  return data ?? []
}

/**
 * After all people are on one wedding, collapse rows sharing a normalised
 * first name, keep the most-complete row, then set roles partner1/partner2.
 */
async function dedupePeopleOnWedding(weddingId) {
  let people = await getPeople(weddingId)
  // group by canonical first name; junk names are their own bucket key
  // 'junk' so they fold into a real-named row when possible.
  const groups = new Map()
  for (const p of people) {
    const key = isJunkName(p.first_name) ? '__junk__' : canonFirst(p.first_name)
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  const score = p => (p.email ? 4 : 0) + (p.phone ? 2 : 0) + (!isJunkName(p.first_name) ? 1 : 0) + (p.last_name ? 1 : 0)
  // collapse non-junk groups
  for (const [key, members] of groups) {
    if (key === '__junk__') continue
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => score(b) - score(a) || new Date(a.created_at) - new Date(b.created_at))
    const keep = sorted[0]
    for (const m of sorted.slice(1)) {
      console.log(`    dedupe-people: keep ${keep.id} ("${keep.first_name}") <- merge ${m.id} ("${m.first_name}")`)
      if (APPLY) {
        await mergePeople({
          supabase, venueId: VENUE, keepPersonId: keep.id, mergePersonId: m.id,
          tier: 'high', signals: [{ type: 'name_match', detail: `same first name on wedding ${weddingId}`, weight: 1 }],
          mergedBy: 'system:cleanup-booked-couples',
        })
      }
    }
  }
  // fold junk-named rows into a real partner row if one exists with a free slot
  if (groups.has('__junk__')) {
    people = await getPeople(weddingId)
    const real = people.filter(p => !isJunkName(p.first_name))
    const junk = people.filter(p => isJunkName(p.first_name))
    // if we already have 2 real partners, merge each junk into the lowest-data real row
    for (const j of junk) {
      if (real.length >= 2) {
        // merge into the real row that lacks an email (so junk's email, if any, fills it)
        const target = [...real].sort((a, b) => score(a) - score(b))[0]
        console.log(`    dedupe-people(junk): keep ${target.id} ("${target.first_name}") <- merge junk ${j.id} ("${j.first_name}")`)
        if (APPLY) {
          await mergePeople({
            supabase, venueId: VENUE, keepPersonId: target.id, mergePersonId: j.id,
            tier: 'high', signals: [{ type: 'junk_fold', detail: `folded junk-named row on wedding ${weddingId}`, weight: 1 }],
            mergedBy: 'system:cleanup-booked-couples',
          })
        }
      }
    }
  }
  // re-read and assign roles partner1 (earliest) / partner2
  const final = await getPeople(weddingId)
  if (final.length > 2) {
    console.log(`    WARN: wedding ${weddingId} still has ${final.length} people after dedup — leaving roles untouched, review manually`)
    return
  }
  const sorted = [...final].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  for (let i = 0; i < sorted.length; i++) {
    const wantRole = i === 0 ? 'partner1' : 'partner2'
    if (sorted[i].role !== wantRole) {
      console.log(`    set role ${sorted[i].id} ("${sorted[i].first_name}") ${sorted[i].role} -> ${wantRole}`)
      if (APPLY) await supabase.from('people').update({ role: wantRole }).eq('id', sorted[i].id)
    }
  }
}

async function deleteOrphanCoupleRow(weddingId) {
  // a merged-away / tombstoned wedding's couples mirror row must go, or the
  // portal list keeps showing the dead couple.
  const { data } = await supabase.from('couples').select('id').eq('source_wedding_id', weddingId)
  for (const c of data ?? []) {
    console.log(`    delete orphan couples row ${c.id} (source_wedding_id=${weddingId})`)
    if (APPLY) await supabase.from('couples').delete().eq('id', c.id)
  }
}

// ===========================================================================
// Problem 1 — merge duplicate weddings
// ===========================================================================
console.log('--- Problem 1: merge duplicate weddings ---')
const touchedWeddings = new Set()
for (const { canonical, duplicates } of MERGE_PLAN) {
  console.log(`  canonical ${canonical}  <-  ${duplicates.join(', ')}`)
  touchedWeddings.add(canonical)
  for (const dup of duplicates) {
    if (APPLY) {
      await mergeWeddings(canonical, dup, { supabase, reason: 'cleanup-booked-couples: cross-source duplicate couple' })
    }
    await deleteOrphanCoupleRow(dup)
  }
}

// Dedupe stacked people on every canonical wedding + the standalone ones.
console.log('\n--- dedupe stacked people ---')
for (const w of [...touchedWeddings, ...STANDALONE_DEDUP_WEDDINGS]) {
  console.log(`  wedding ${w}`)
  await dedupePeopleOnWedding(w)
}

// ===========================================================================
// Problem 2 — strip possessive 's from person names
// ===========================================================================
console.log('\n--- Problem 2: strip possessive names ---')
const { data: allPeople } = await supabase
  .from('people')
  .select('id, first_name, last_name')
  .eq('venue_id', VENUE)
  .is('merged_into_id', null)
const POSS = /['’][sS]?$/
const stripPoss = v => (v ? v.replace(/['’][sS]?$/u, '').trim() || null : v)
for (const p of allPeople ?? []) {
  const fnBad = p.first_name && POSS.test(p.first_name)
  const lnBad = p.last_name && POSS.test(p.last_name)
  if (!fnBad && !lnBad) continue
  const updates = {}
  if (fnBad) updates.first_name = stripPoss(p.first_name)
  if (lnBad) updates.last_name = stripPoss(p.last_name)
  console.log(`  ${p.id}  "${p.first_name}"/"${p.last_name}" -> "${updates.first_name ?? p.first_name}"/"${updates.last_name ?? p.last_name}"`)
  if (APPLY) await supabase.from('people').update(updates).eq('id', p.id)
}

// ===========================================================================
// Problem 3 — venue-address couples
// ===========================================================================
console.log('\n--- Problem 3: venue-address couples ---')
for (const w of TOMBSTONE_WEDDINGS) {
  console.log(`  tombstone wedding ${w} (non_couple_at = now)`)
  if (APPLY) {
    await supabase.from('weddings').update({ non_couple_at: new Date().toISOString() }).eq('id', w)
  }
  await deleteOrphanCoupleRow(w)
}
for (const { personId, wedding } of CLEAR_VENUE_EMAIL_PEOPLE) {
  console.log(`  clear venue email off person ${personId} (wedding ${wedding} stays a real couple)`)
  if (APPLY) await supabase.from('people').update({ email: null }).eq('id', personId)
}

// ===========================================================================
// Re-mirror every affected canonical/real wedding so the couples list is fresh
// ===========================================================================
console.log('\n--- re-mirror couples ---')
const remirror = new Set([...touchedWeddings, ...STANDALONE_DEDUP_WEDDINGS])
for (const { wedding } of CLEAR_VENUE_EMAIL_PEOPLE) remirror.add(wedding)
// also re-mirror any wedding that owned a possessive-fixed person
for (const p of allPeople ?? []) {
  if ((p.first_name && POSS.test(p.first_name)) || (p.last_name && POSS.test(p.last_name))) {
    const { data: pr } = await supabase.from('people').select('wedding_id').eq('id', p.id).maybeSingle()
    if (pr?.wedding_id) remirror.add(pr.wedding_id)
  }
}
for (const w of remirror) {
  console.log(`  mirror ${w}`)
  if (APPLY) await mirrorCoupleFromWedding({ venueId: VENUE, weddingId: w, supabase })
}

console.log(`\n${tag} done.${APPLY ? '' : '  Re-run with --apply to write.'}\n`)
process.exit(0)
