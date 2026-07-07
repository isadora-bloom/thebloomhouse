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

const canonicalRelay = (e) => e.replace(/\.reminder(@member\.theknot\.com)$/i, '$1')

// Get remaining .reminder orphans
const { data: orphans } = await sb
  .from('interactions')
  .select('id, from_email')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%.reminder@member.theknot.com')
  .is('wedding_id', null)
  .eq('direction', 'inbound')

console.log(`Remaining .reminder orphans: ${orphans?.length}`)
for (const row of orphans ?? []) {
  const canonical = canonicalRelay(row.from_email)
  const { data: person } = await sb.from('people')
    .select('wedding_id')
    .eq('venue_id', RIXEY)
    .ilike('email', canonical)
    .maybeSingle()

  if (!person?.wedding_id) {
    console.log(`  ${row.from_email} — no canonical person found, skip`)
    continue
  }
  const { error } = await sb.from('interactions').update({ wedding_id: person.wedding_id }).eq('id', row.id)
  console.log(`  ${row.from_email} → ${error ? 'FAIL: ' + error.message : 'linked to ' + person.wedding_id.slice(0,8)}`)
}
