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

// stacked-people wedding
const { data: stacked } = await supabase
  .from('people')
  .select('id, wedding_id, role, first_name, last_name, email, phone, created_at, name_confidence')
  .eq('wedding_id', 'a4f62e5a-5902-4807-be2d-151e888752cf')
  .order('created_at', { ascending: true })
console.log('=== a4f62e5a people ===')
for (const p of stacked ?? []) console.log(`  ${p.id} role=${p.role} "${p.first_name} ${p.last_name}" email=${p.email} created=${p.created_at} conf=${p.name_confidence} merged_into=${p.merged_into_id}`)

// couples table for the duplicate weddings
const allDup = ['292a6c4b-9d58-447a-beaa-387e834d9c1d','0aa62f17-78ec-403d-b968-8b09cb3b73ba','cdbc10ff-1094-452b-b09b-c1a32ff5a556','53eedcdb-ee17-4fc8-ac3a-3c41ce1c4274','ca342d9e-e6f6-417f-8372-0e807268710e','1dbad969-746c-467d-83d2-ffefab47ed87','bda40f99-6847-45ec-a687-690a343a2e3c','d8230318-a2d6-403d-ab18-dc169259d33e','a726fc68-49dc-4d40-b9bf-0874de0bdb20','8861ba5e-b0d1-4600-aca7-433711ed88f8','eb2ef010-1b23-4884-a35d-a4d76c055d22','4ec28b39-ce99-417b-88f1-8382ae4f2986','91a6628f-0c89-4cdd-9f8d-ea62b25acf20']
const { data: couples } = await supabase
  .from('couples')
  .select('id, source_wedding_id, primary_contact_name, partner_contact_name, lifecycle_state')
  .in('source_wedding_id', allDup)
console.log('\n=== couples rows for dup weddings ===')
for (const c of couples ?? []) console.log(`  couple=${c.id} wedding=${c.source_wedding_id} "${c.primary_contact_name}" + "${c.partner_contact_name}" state=${c.lifecycle_state}`)

// confirm non_couple_at column exists
const { error: ncErr } = await supabase.from('weddings').select('non_couple_at').eq('venue_id', VENUE).limit(1)
console.log('\nnon_couple_at column ok:', !ncErr, ncErr?.message ?? '')

// people on the 3 valerie/christian weddings
console.log('\n=== Valerie/Christian people ===')
const { data: vc } = await supabase
  .from('people')
  .select('id, wedding_id, role, first_name, last_name, email, phone, created_at')
  .in('wedding_id', ['ca342d9e-e6f6-417f-8372-0e807268710e','1dbad969-746c-467d-83d2-ffefab47ed87','bda40f99-6847-45ec-a687-690a343a2e3c'])
  .order('created_at', { ascending: true })
for (const p of vc ?? []) console.log(`  w=${p.wedding_id} ${p.id} role=${p.role} "${p.first_name} ${p.last_name}" email=${p.email} created=${p.created_at}`)

process.exit(0)
