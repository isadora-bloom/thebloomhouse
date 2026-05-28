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

// Inspect raw_import_row for the possessive weddings
const weddingIds = ['aac651a8-b3d5-4071-ae75-b072d4b50f20', '6be57c87-4b17-42fe-b630-b00e7cd2dba8', 'a9bb7ab3-99eb-4a92-84e3-38a25a44ff2b', '9b083539-9d24-4d91-8543-462c3ff18f4f', 'd845f9db-4a35-4019-9d2f-37e0e7114642', 'e8718840-68b2-45b3-8a54-f954ad657de0']
const { data: weds } = await supabase
  .from('weddings')
  .select('id, raw_import_row, notes, status')
  .in('id', weddingIds)
for (const w of weds ?? []) {
  console.log(`\n=== ${w.id} status=${w.status} ===`)
  console.log('raw_import_row:', JSON.stringify(w.raw_import_row))
  console.log('notes:', w.notes)
}

// Problem 3 venue weddings - inspect
console.log('\n\n=== PROBLEM 3 weddings ===')
const p3 = ['2aa6ceaf-ba14-429c-b588-2f465d5c2303', 'b34f8792-26b8-49f9-99ff-5ac2c92ed7cd', 'd501a3bc-b872-46d0-8f85-204446a21541']
const { data: p3w } = await supabase
  .from('weddings')
  .select('id, status, wedding_date, booking_value, raw_import_row, notes, source_provenance, created_at, non_couple_at, merged_into_id')
  .in('id', p3)
for (const w of p3w ?? []) {
  console.log(`\n--- ${w.id} status=${w.status} date=${w.wedding_date} val=${w.booking_value} prov=${w.source_provenance} ncAt=${w.non_couple_at} merged=${w.merged_into_id}`)
  console.log('  notes:', w.notes)
  console.log('  raw:', JSON.stringify(w.raw_import_row))
}
const { data: p3people } = await supabase
  .from('people')
  .select('id, wedding_id, role, first_name, last_name, email, phone, created_at')
  .in('wedding_id', p3)
for (const p of p3people ?? []) {
  console.log(`  person ${p.id} w=${p.wedding_id} role=${p.role} "${p.first_name} ${p.last_name}" email=${p.email} phone=${p.phone}`)
}
// interactions for p3
const { data: p3int } = await supabase
  .from('interactions')
  .select('id, wedding_id, direction, type, subject, from_email, to_email')
  .in('wedding_id', p3)
  .limit(40)
console.log('\n  interactions:')
for (const i of p3int ?? []) {
  console.log(`   ${i.wedding_id} ${i.direction}/${i.type} from=${i.from_email} to=${i.to_email} subj=${(i.subject ?? '').slice(0,60)}`)
}

process.exit(0)
