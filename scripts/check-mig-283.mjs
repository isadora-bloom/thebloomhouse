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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Force schema cache reload
await sb.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema';" })
await new Promise((r) => setTimeout(r, 2000))

// Verify column existence via information_schema
const { data: c1 } = await sb.rpc('exec_sql', {
  sql: `select column_name, data_type from information_schema.columns where table_name='attribution_events' and column_name like 'intent%' order by column_name;`,
})
console.log('intent columns query result:', c1)

const { data: tbl } = await sb.rpc('exec_sql', {
  sql: `select count(*) from public.knot_template_patterns;`,
})
console.log('pattern count via exec_sql:', tbl)

// Through PostgREST
const { count: pcount, error: pErr } = await sb
  .from('knot_template_patterns')
  .select('id', { count: 'exact', head: true })
console.log('pattern count via PostgREST:', pcount, 'err:', pErr?.message)

const { count: jcount, error: jErr } = await sb
  .from('attribution_intent_jobs')
  .select('id', { count: 'exact', head: true })
console.log('intent jobs count:', jcount, 'err:', jErr?.message)

const { data: aeSample, error: aeErr } = await sb
  .from('attribution_events')
  .select('id, intent_class, intent_classified_at')
  .limit(1)
console.log('attribution_events intent_class sample:', aeSample, 'err:', aeErr?.message)
