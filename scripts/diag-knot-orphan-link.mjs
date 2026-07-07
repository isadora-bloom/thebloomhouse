import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Get 2026 orphan Knot inbound interactions with the relay email
const { data: orphans } = await sb.from('interactions')
  .select('id, from_email, subject, timestamp, direction, extracted_identity')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%theknot%')
  .is('wedding_id', null)
  .eq('direction', 'inbound')
  .gte('timestamp', '2026-04-01')
  .order('timestamp')

console.log(`=== INBOUND KNOT ORPHANS SINCE APR 2026: ${orphans?.length} ===`)

for (const r of orphans ?? []) {
  // Extract name from relay address: paris.terrell.772357 -> paris terrell
  const localPart = r.from_email.split('@')[0]
  const nameFromRelay = localPart.replace(/\.\d+$/, '').replace(/\./g, ' ')
  const nameParts = nameFromRelay.split(' ')
  const firstName = nameParts[0] ?? ''
  const lastName = nameParts.slice(-1)[0] ?? ''

  // Look for a wedding with this person's name
  const { data: weds } = await sb.from('weddings')
    .select('id, status, inquiry_date, lead_source')
    .eq('venue_id', RIXEY)
    .ilike('primary_contact_name', `%${firstName}%`)
    .limit(3)

  const { data: weds2 } = await sb.from('people')
    .select('wedding_id, first_name, last_name, role')
    .ilike('first_name', `${firstName}`)
    .ilike('last_name', `${lastName}`)
    .limit(3)

  const matchedWeddings = weds?.length ? weds.map(w => w.id.slice(0,8)).join(',') : '(none)'
  const peopleMatch = weds2?.length ? weds2.map(p => `${p.first_name} ${p.last_name} [${p.wedding_id?.slice(0,8)}]`).join(',') : '(none)'

  console.log(`\n  ${r.timestamp?.slice(0,10)} ${r.direction} "${nameFromRelay}" | ${r.subject?.slice(0,40)}`)
  console.log(`    relay: ${r.from_email}`)
  console.log(`    wedding by contact name: ${matchedWeddings}`)
  console.log(`    people match: ${peopleMatch}`)
  console.log(`    extracted_identity: ${JSON.stringify(r.extracted_identity)?.slice(0,100)}`)
}
