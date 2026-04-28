// Reproduce the voice page's anon query path.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

async function main() {
  const orgId = '11111111-1111-1111-1111-111111111111'

  console.log('1) Anon query: from venues with org_id filter (limit 1, single)')
  const { data, error } = await sb
    .from('venues').select('id, name, is_demo, org_id').eq('org_id', orgId).limit(1).single()
  console.log('   error:', error?.message ?? null)
  console.log('   data: ', data)

  console.log('\n2) Anon query: same but without single() — what RLS actually returns')
  const all = await sb.from('venues').select('id, name, is_demo, org_id').eq('org_id', orgId).limit(5)
  console.log('   error:', all.error?.message ?? null)
  console.log('   count:', (all.data ?? []).length)
  for (const v of all.data ?? []) console.log('    -', v.name, 'is_demo=', v.is_demo)

  console.log('\n3) Anon query: voice_training_sessions for hawthorne (expect RLS-filtered empty)')
  const sessions = await sb.from('voice_training_sessions')
    .select('id, completed_at, started_at')
    .eq('venue_id', '22222222-2222-2222-2222-222222222201')
    .order('started_at', { ascending: false })
  console.log('   error:', sessions.error?.message ?? null)
  console.log('   count:', (sessions.data ?? []).length)

  console.log('\n4) Anon query: voice_preferences for hawthorne')
  const prefs = await sb.from('voice_preferences')
    .select('preference_type, content, score, sample_count')
    .eq('venue_id', '22222222-2222-2222-2222-222222222201')
  console.log('   error:', prefs.error?.message ?? null)
  console.log('   count:', (prefs.data ?? []).length)
}

main().catch((err) => { console.error(err); process.exit(1) })
