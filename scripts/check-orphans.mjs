import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log('--- Check if the 17/12/6 rows belong to other venues (multi-tenant) ---')

// merge_reattachment_log: FK to weddings. Join to weddings to find venue.
const { data: mrl } = await sb.from('merge_reattachment_log')
  .select('id, loser_wedding_id, winner_wedding_id, loser:weddings!loser_wedding_id(venue_id), winner:weddings!winner_wedding_id(venue_id)')
  .limit(50)
console.log(`merge_reattachment_log rows (${mrl?.length ?? 0}):`)
let mrlRixeyOrphans = 0
for (const r of mrl ?? []) {
  const loserV = r.loser?.venue_id ?? '(deleted)'
  const winnerV = r.winner?.venue_id ?? '(deleted)'
  const isRixey = loserV === RIXEY_VENUE_ID || winnerV === RIXEY_VENUE_ID || loserV === '(deleted)' || winnerV === '(deleted)'
  if (isRixey && (loserV === '(deleted)' || winnerV === '(deleted)')) mrlRixeyOrphans++
  console.log(`  ${r.id.slice(0, 8)}  loser_venue=${loserV.slice(0, 8)}  winner_venue=${winnerV.slice(0, 8)}`)
}
console.log(`  → likely-Rixey-orphans (referencing deleted weddings): ${mrlRixeyOrphans}`)

// contacts: FK to people. Join to people to find venue.
const { data: c } = await sb.from('contacts')
  .select('id, person_id, people!inner(venue_id)')
  .limit(50)
console.log(`\ncontacts rows (${c?.length ?? 0}):`)
for (const r of c ?? []) {
  const venueId = r.people?.venue_id ?? '(deleted)'
  console.log(`  ${r.id.slice(0, 8)}  person_venue=${venueId.slice(0, 8)}`)
}

// contacts where the join FAILED (orphan via no people row)
const { count: orphanContacts } = await sb.from('contacts')
  .select('*', { count: 'exact', head: true })
  .is('person_id', null)
console.log(`  contacts with NULL person_id: ${orphanContacts ?? 0}`)

// guest_tag_assignments: FK to guest_list.
const { data: gta } = await sb.from('guest_tag_assignments')
  .select('id, guest_id, guest_list!inner(venue_id)')
  .limit(50)
console.log(`\nguest_tag_assignments rows (${gta?.length ?? 0}):`)
for (const r of gta ?? []) {
  const venueId = r.guest_list?.venue_id ?? '(deleted)'
  console.log(`  ${r.id.slice(0, 8)}  guest_venue=${venueId.slice(0, 8)}`)
}
