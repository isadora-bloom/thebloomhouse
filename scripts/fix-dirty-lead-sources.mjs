import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// "former:" is a parsing artifact — clear it so re-derivation can run
const { data: formerRows } = await supabase
  .from('weddings')
  .select('id, source, source_detail')
  .eq('venue_id', VENUE_ID)
  .eq('lead_source', 'former:')

console.log('"former:" rows:', JSON.stringify(formerRows, null, 2))

for (const r of formerRows ?? []) {
  const { error } = await supabase.from('weddings')
    .update({ lead_source: null, lead_source_derivation_attempted_at: null })
    .eq('id', r.id)
  console.log(`  Cleared former: on ${r.id}: ${error?.message ?? 'ok'}`)
}

// "i'm a culpeper local" = word-of-mouth / knew about it locally = direct
const { data: localRows } = await supabase
  .from('weddings')
  .select('id, source, source_detail')
  .eq('venue_id', VENUE_ID)
  .eq('lead_source', "i'm a culpeper local")

console.log('"i\'m a culpeper local" rows:', JSON.stringify(localRows, null, 2))

for (const r of localRows ?? []) {
  const { error } = await supabase.from('weddings')
    .update({ lead_source: 'direct' })
    .eq('id', r.id)
  console.log(`  Fixed → direct on ${r.id}: ${error?.message ?? 'ok'}`)
}
