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

// Check venue_email_filters for anything that might suppress Knot
const { data: filters } = await sb.from('venue_email_filters')
  .select('*')
  .eq('venue_id', RIXEY)
  .order('created_at', { ascending: false })

console.log(`=== VENUE EMAIL FILTERS (${filters?.length ?? 0} total) ===`)
for (const f of filters ?? []) {
  console.log(`  [${f.action}] ${f.filter_type}="${f.filter_value}" scope=${f.match_scope ?? 'all'} created=${f.created_at?.slice(0,10)} learned=${f.is_learned ? 'auto' : 'manual'}`)
}

// Check gmail_connections status
const { data: conns } = await sb.from('gmail_connections')
  .select('id, email_address, status, last_sync_at, last_history_id, created_at, updated_at')
  .eq('venue_id', RIXEY)
console.log(`\n=== GMAIL CONNECTIONS (${conns?.length ?? 0}) ===`)
for (const c of conns ?? []) {
  console.log(`  ${c.email_address} status=${c.status} last_sync=${c.last_sync_at?.slice(0,10)} history_id=${c.last_history_id} created=${c.created_at?.slice(0,10)}`)
}

// Check most recent Knot interaction with a wedding_id — when was it?
const { data: lastLinked } = await sb.from('interactions')
  .select('timestamp, created_at, subject, wedding_id')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%theknot%')
  .not('wedding_id', 'is', null)
  .order('created_at', { ascending: false })
  .limit(3)

console.log(`\n=== LAST KNOT INTERACTIONS WITH WEDDING_ID ===`)
for (const r of lastLinked ?? []) {
  console.log(`  email_time=${r.timestamp?.slice(0,10)} db_created=${r.created_at?.slice(0,10)} subject=${r.subject?.slice(0,40)}`)
}

// When exactly did the backfill run (what's the created_at window?)
const { data: bfSample } = await sb.from('interactions')
  .select('created_at, timestamp')
  .eq('venue_id', RIXEY)
  .gte('created_at', '2026-07-01')
  .lt('created_at', '2026-07-05')
  .order('created_at')
  .limit(5)
console.log(`\n=== BACKFILL CREATED_AT WINDOW (sample Jul 1-4) ===`)
for (const r of bfSample ?? []) {
  console.log(`  created=${r.created_at?.slice(0,16)} email_time=${r.timestamp?.slice(0,10)}`)
}
