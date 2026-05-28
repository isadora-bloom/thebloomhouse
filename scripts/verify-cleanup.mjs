import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2].trim(); if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1)
  env[m[1]] = v.split('\\')[0].trim()
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// tombstone check
const { data: tomb } = await supabase
  .from('weddings').select('id, non_couple_at, status')
  .in('id', ['2aa6ceaf-ba14-429c-b588-2f465d5c2303', 'b34f8792-26b8-49f9-99ff-5ac2c92ed7cd'])
console.log('=== tombstoned weddings ===')
for (const w of tomb ?? []) console.log(`  ${w.id} status=${w.status} non_couple_at=${w.non_couple_at}`)

// merged check
const { data: merged } = await supabase
  .from('weddings').select('id, merged_into_id')
  .in('id', ['0aa62f17-78ec-403d-b968-8b09cb3b73ba','53eedcdb-ee17-4fc8-ac3a-3c41ce1c4274','1dbad969-746c-467d-83d2-ffefab47ed87','bda40f99-6847-45ec-a687-690a343a2e3c','a726fc68-49dc-4d40-b9bf-0874de0bdb20','eb2ef010-1b23-4884-a35d-a4d76c055d22','91a6628f-0c89-4cdd-9f8d-ea62b25acf20'])
console.log('\n=== merged duplicate weddings ===')
for (const w of merged ?? []) console.log(`  ${w.id} merged_into=${w.merged_into_id}`)

// Valerie/Christian canonical people
const { data: vc } = await supabase
  .from('people').select('id, role, first_name, last_name, email')
  .eq('wedding_id', 'ca342d9e-e6f6-417f-8372-0e807268710e')
  .is('merged_into_id', null).order('role')
console.log('\n=== Valerie/Christian canonical (ca342d9e) people ===')
for (const p of vc ?? []) console.log(`  ${p.role} "${p.first_name} ${p.last_name}" email=${p.email}`)

// Maximillian wedding
const { data: max } = await supabase
  .from('people').select('id, role, first_name, last_name, email')
  .eq('wedding_id', 'a4f62e5a-5902-4807-be2d-151e888752cf')
  .is('merged_into_id', null).order('role')
console.log('\n=== a4f62e5a people ===')
for (const p of max ?? []) console.log(`  ${p.role} "${p.first_name} ${p.last_name}" email=${p.email}`)

// hello@ person
const { data: hp } = await supabase
  .from('people').select('id, first_name, last_name, email, phone')
  .eq('id', '3933a8e0-2b4c-4fc7-ba4d-12c92f63a7c2').maybeSingle()
console.log('\n=== Allison Gleason person (was hello@) ===')
console.log(`  "${hp?.first_name} ${hp?.last_name}" email=${hp?.email} phone=${hp?.phone}`)

// booked couples count from couples table (the portal read surface)
const { data: bookedCouples } = await supabase
  .from('couples').select('id, primary_contact_name, partner_contact_name, lifecycle_state, source_wedding_id')
  .eq('venue_id', VENUE).eq('lifecycle_state', 'booked')
console.log(`\n=== couples table: ${bookedCouples?.length ?? 0} booked couples ===`)
// dup-name check in couples table
const seen = new Map()
for (const c of bookedCouples ?? []) {
  const fset = [c.primary_contact_name, c.partner_contact_name].filter(Boolean).map(n => (n.split(/\s+/)[0] ?? '').toLowerCase()).sort().join('|')
  const arr = seen.get(fset) ?? []
  arr.push(c)
  seen.set(fset, arr)
}
let dups = 0
for (const [k, arr] of seen) {
  if (arr.length > 1) { dups++; console.log(`  DUP couples-row name-set "${k}": ${arr.map(c => c.source_wedding_id).join(', ')}`) }
}
console.log(`couples-table dup name-sets: ${dups}`)

// possessive in couples table
let possC = 0
for (const c of bookedCouples ?? []) {
  if (/['’]s?\b/.test(c.primary_contact_name ?? '') || /['’]s?\b/.test(c.partner_contact_name ?? '')) {
    // ignore legit O'Brien etc — only flag trailing 's
    if (/['’][sS]?$/.test((c.primary_contact_name ?? '').split(/\s+/).pop() ?? '') || /['’][sS]?$/.test((c.partner_contact_name ?? '').split(/\s+/).pop() ?? '')) {
      possC++; console.log(`  POSSESSIVE couples row: "${c.primary_contact_name}" + "${c.partner_contact_name}"`)
    }
  }
}
console.log(`couples-table possessive names: ${possC}`)

process.exit(0)
