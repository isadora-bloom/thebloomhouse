import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Use a raw SQL select via exec_sql to confirm the column is at the DB layer.
const probeSql = `
SELECT json_agg(column_name)::text as cols
FROM information_schema.columns
WHERE table_name = 'knowledge_gaps' AND table_schema = 'public'
  AND column_name IN ('captured_at','captured_id','dismissed_at','dismissed_reason')`

const { data, error } = await sb.rpc('exec_sql', { sql: probeSql })
console.log('exec_sql data:', JSON.stringify(data))
console.log('exec_sql error:', error)

// Notify pgrst and wait
await sb.rpc('exec_sql', { sql: `SELECT pg_notify('pgrst','reload schema');` })
console.log('sent reload notify, waiting 5s')
await new Promise((r) => setTimeout(r, 5000))

// Retry update
const { data: existing } = await sb.from('knowledge_gaps').select('id').limit(1).maybeSingle()
if (existing?.id) {
  const { error: updErr } = await sb
    .from('knowledge_gaps')
    .update({ captured_at: new Date().toISOString() })
    .eq('id', existing.id)
  console.log('update captured_at:', updErr ? updErr.message : 'OK')
  if (!updErr) {
    await sb.from('knowledge_gaps').update({ captured_at: null }).eq('id', existing.id)
  }
}
