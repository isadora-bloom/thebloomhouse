import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = { ...process.env }
try {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { data, error } = await sb
  .from('api_costs')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(3)
if (error) {
  console.log('error:', error)
  process.exit(1)
}
console.log('Most recent api_costs rows:')
for (const row of data ?? []) {
  console.log(JSON.stringify(row, null, 2))
  console.log('---')
}
