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
const { data } = await sb.from('gmail_connections')
  .select('id, email_address, status, last_sync_at, last_history_id, updated_at')
  .eq('venue_id', RIXEY)
console.log('=== GMAIL CONNECTION STATUS ===')
for (const c of data ?? []) {
  console.log(`  ${c.email_address}`)
  console.log(`  status:       ${c.status}`)
  console.log(`  last_sync:    ${c.last_sync_at}`)
  console.log(`  updated_at:   ${c.updated_at}`)
  console.log(`  history_id:   ${c.last_history_id}`)
}
