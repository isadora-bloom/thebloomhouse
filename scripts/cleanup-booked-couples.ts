/**
 * cleanup-booked-couples.ts — reusable cleanup for the three
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
 *   npx tsx scripts/cleanup-booked-couples.ts            # dry-run
 *   npx tsx scripts/cleanup-booked-couples.ts --apply     # apply
 *
 * The MERGE_PLAN / TOMBSTONE list below is specific to the Rixey
 * 2026-05-16 cleanup; re-running after data changes is safe (merges of
 * already-tombstoned weddings no-op, possessive / role fixes are
 * idempotent).
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mergeWeddings } from '../src/lib/services/identity/resolver'
import { mergePeople } from '../src/lib/services/identity/merge-people'
import { mirrorCoupleFromWedding } from '../src/lib/services/identity/mirror-couple'

const APPLY = process.argv.includes('--apply')

const env: Record<string, string> = {}
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2].trim(); if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1)
  env[m[1]] = v.split('\\')[0].trim()
}
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
process.env.SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const tag = APPLY ? '[APPLY]' : '[DRY-RUN]'
console.log(`\n${tag} cleanup-booked-couples\n`)

// ---------------------------------------------------------------------------
// Problem 1 — duplicate clusters. canonical -> [duplicates].
// Canonical = the row with a real wedding_date AND booking_value; the
// duplicate halves all have null booking_value. Confirmed by diagnostic
// 2026-05-16 (shared person email OR identical partner first-name set).
// ---------------------------------------------------------------------------
const MERGE_PLAN: Array<{ canonical: string; duplicates: string[] }> = [
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

// Weddings with stacked partner2 people independent of a merge.
const STANDALONE_DEDUP_WEDDINGS = ['a4f62e5a-5902-4807-be2d-151e888752cf']

// Problem 3 — venue-address weddings.
//   2aa6ceaf — "(Unknown) Baker test" / grace@      -> tombstone (test data)
//   b34f8792 — "Paul Blogs" / accounts@             -> tombstone (placeholder)
//   d501a3bc — "Allison Gleason" + "Dale Roop" / hello@ -> real couple, clear email
const TOMBSTONE_WEDDINGS = [
  '2aa6ceaf-ba14-429c-b588-2f465d5c2303',
  'b34f8792-26b8-49f9-99ff-5ac2c92ed7cd',
]
const CLEAR_VENUE_EMAIL_PEOPLE: Array<{ personId: string; wedding: string }> = [
  { personId: '3933a8e0-2b4c-4fc7-ba4d-12c92f63a7c2', wedding: 'd501a3bc-b872-46d0-8f85-204446a21541' },
]

const ALIAS: Record<string, string> = {
  nick: 'nicholas', nicky: 'nicholas', mike: 'michael', mikey: 'michael',
  chris: 'christopher', matt: 'matthew', dave: 'david', dan: 'daniel',
  danny: 'daniel', joe: 'joseph', tom: 'thomas', will: 'william',
  billy: 'william', bill: 'william', jim: 'james', jimmy: 'james',
  rob: 'robert', bob: 'robert', greg: 'gregory', ben: 'benjamin',
  sam: 'samuel', alex: 'alexander', kate: 'katherine', katie: 'katherine',
  kathy: 'katherine', cathy: 'catherine', liz: 'elizabeth', beth: 'elizabeth',
  abby: 'abigail', gabby: 'gabriella', gabi: 'gabriella', jen: 'jennifer',
  jenny: 'jennifer', becca: 'rebecca', becky: 'rebecca', maggie: 'margaret',
  max: 'maximillian', maxi: 'maximillian',
}
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
/** Canonical first name = first whitespace token, alias-folded. Keying on
 *  the first token collapses a corrupt "Maximillian Ashton null" row with a
 *  clean "Maximillian" row. */
const canonFirst = (s: string | null | undefined) => {
  const tok = norm(s).split(/\s+/).filter(Boolean)[0] ?? ''
  return ALIAS[tok] ?? tok
}
const isJunkName = (s: string | null | undefined) => {
  const n = norm(s)
  return !n || n === 'unknown' || n === '(unknown)' || n === 'null' || n === 'wedding' || n === 'weddings'
}
const POSS = /['’][sS]?$/u
const stripPoss = (v: string | null) => (v ? (v.replace(/['’][sS]?$/u, '').trim() || null) : v)

interface PersonRow {
  id: string
  wedding_id: string | null
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  created_at: string
}

async function getPeople(weddingId: string): Promise<PersonRow[]> {
  const { data } = await supabase
    .from('people')
    .select('id, wedding_id, role, first_name, last_name, email, phone, created_at')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
  return (data ?? []) as PersonRow[]
}

const score = (p: PersonRow) =>
  (p.email ? 4 : 0) + (p.phone ? 2 : 0) + (!isJunkName(p.first_name) ? 1 : 0) + (p.last_name ? 1 : 0)

/** Collapse rows sharing a normalised first name, fold junk-named rows,
 *  then assign roles partner1 (earliest) / partner2. */
async function dedupePeopleOnWedding(weddingId: string): Promise<void> {
  let people = await getPeople(weddingId)
  const groups = new Map<string, PersonRow[]>()
  for (const p of people) {
    const key = isJunkName(p.first_name) ? '__junk__' : canonFirst(p.first_name)
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  for (const [key, members] of groups) {
    if (key === '__junk__' || members.length < 2) continue
    const sorted = [...members].sort(
      (a, b) => score(b) - score(a) || +new Date(a.created_at) - +new Date(b.created_at),
    )
    const keep = sorted[0]
    for (const m of sorted.slice(1)) {
      console.log(`    dedupe-people: keep ${keep.id} ("${keep.first_name}") <- merge ${m.id} ("${m.first_name}")`)
      if (APPLY) {
        await mergePeople({
          supabase, venueId: VENUE, keepPersonId: keep.id, mergePersonId: m.id,
          tier: 'high',
          signals: [{ type: 'name_match', detail: `same first name on wedding ${weddingId}`, weight: 1 }],
          mergedBy: 'system:cleanup-booked-couples',
        })
      }
    }
  }
  // fold junk-named rows into a real partner row when 2 real partners exist
  if (groups.has('__junk__')) {
    people = await getPeople(weddingId)
    const real = people.filter((p) => !isJunkName(p.first_name))
    const junk = people.filter((p) => isJunkName(p.first_name))
    for (const j of junk) {
      if (real.length >= 2) {
        const target = [...real].sort((a, b) => score(a) - score(b))[0]
        console.log(`    dedupe-people(junk): keep ${target.id} ("${target.first_name}") <- merge junk ${j.id} ("${j.first_name}")`)
        if (APPLY) {
          await mergePeople({
            supabase, venueId: VENUE, keepPersonId: target.id, mergePersonId: j.id,
            tier: 'high',
            signals: [{ type: 'junk_fold', detail: `folded junk-named row on wedding ${weddingId}`, weight: 1 }],
            mergedBy: 'system:cleanup-booked-couples',
          })
        }
      }
    }
  }
  const final = await getPeople(weddingId)
  if (final.length > 2) {
    console.log(`    WARN: wedding ${weddingId} still has ${final.length} people after dedup — review manually`)
    return
  }
  const sorted = [...final].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
  for (let i = 0; i < sorted.length; i++) {
    const wantRole = i === 0 ? 'partner1' : 'partner2'
    if (sorted[i].role !== wantRole) {
      console.log(`    set role ${sorted[i].id} ("${sorted[i].first_name}") ${sorted[i].role} -> ${wantRole}`)
      if (APPLY) await supabase.from('people').update({ role: wantRole }).eq('id', sorted[i].id)
    }
  }
}

async function deleteOrphanCoupleRow(weddingId: string): Promise<void> {
  const { data } = await supabase.from('couples').select('id').eq('source_wedding_id', weddingId)
  for (const c of (data ?? []) as Array<{ id: string }>) {
    console.log(`    delete orphan couples row ${c.id} (source_wedding_id=${weddingId})`)
    if (APPLY) await supabase.from('couples').delete().eq('id', c.id)
  }
}

async function main(): Promise<void> {
  // === Problem 1 — merge duplicate weddings ===
  console.log('--- Problem 1: merge duplicate weddings ---')
  const touchedWeddings = new Set<string>()
  for (const { canonical, duplicates } of MERGE_PLAN) {
    console.log(`  canonical ${canonical}  <-  ${duplicates.join(', ')}`)
    touchedWeddings.add(canonical)
    for (const dup of duplicates) {
      if (APPLY) {
        await mergeWeddings(canonical, dup, {
          supabase, reason: 'cleanup-booked-couples: cross-source duplicate couple',
        })
      }
      await deleteOrphanCoupleRow(dup)
    }
  }

  console.log('\n--- dedupe stacked people ---')
  for (const w of [...touchedWeddings, ...STANDALONE_DEDUP_WEDDINGS]) {
    console.log(`  wedding ${w}`)
    await dedupePeopleOnWedding(w)
  }

  // === Problem 2 — strip possessive 's from person names ===
  console.log('\n--- Problem 2: strip possessive names ---')
  const { data: allPeople } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', VENUE)
    .is('merged_into_id', null)
  const possessiveWeddings = new Set<string>()
  for (const p of (allPeople ?? []) as Array<{ id: string; wedding_id: string | null; first_name: string | null; last_name: string | null }>) {
    const fnBad = p.first_name && POSS.test(p.first_name)
    const lnBad = p.last_name && POSS.test(p.last_name)
    if (!fnBad && !lnBad) continue
    const updates: Record<string, string | null> = {}
    if (fnBad) updates.first_name = stripPoss(p.first_name)
    if (lnBad) updates.last_name = stripPoss(p.last_name)
    console.log(`  ${p.id}  "${p.first_name}"/"${p.last_name}" -> "${updates.first_name ?? p.first_name}"/"${updates.last_name ?? p.last_name}"`)
    if (p.wedding_id) possessiveWeddings.add(p.wedding_id)
    if (APPLY) await supabase.from('people').update(updates).eq('id', p.id)
  }

  // === Problem 3 — venue-address couples ===
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

  // === Re-mirror affected couples ===
  console.log('\n--- re-mirror couples ---')
  const remirror = new Set<string>([...touchedWeddings, ...STANDALONE_DEDUP_WEDDINGS, ...possessiveWeddings])
  for (const { wedding } of CLEAR_VENUE_EMAIL_PEOPLE) remirror.add(wedding)
  for (const w of remirror) {
    console.log(`  mirror ${w}`)
    if (APPLY) await mirrorCoupleFromWedding({ venueId: VENUE, weddingId: w, supabase })
  }

  console.log(`\n${tag} done.${APPLY ? '' : '  Re-run with --apply to write.'}\n`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
