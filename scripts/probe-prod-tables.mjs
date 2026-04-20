// Probe which recent-migration tables exist in prod Supabase.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const probes = [
  ['022', 'venue_groups'],
  ['022', 'venue_group_members'],
  ['049', 'team_invitations'],
  ['050', 'gmail_connections'],
  ['053', 'rate_limits'],
  ['054', 'stripe_events'],
]
// Use a real select (not head:true) — head+count returns OK with count=null
// even when PostgREST doesn't expose the table, which is a false positive.
for (const [mig, table] of probes) {
  const { error } = await sb.from(table).select('*').limit(1)
  if (error) console.log(`  ${mig.padEnd(4)} ${table.padEnd(22)} MISSING (${error.code || 'err'}: ${error.message.slice(0, 60)})`)
  else console.log(`  ${mig.padEnd(4)} ${table.padEnd(22)} present`)
}
