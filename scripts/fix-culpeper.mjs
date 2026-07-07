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

// Fetch all non-standard lead sources and fix in memory
const { data } = await supabase
  .from('weddings')
  .select('id, lead_source')
  .eq('venue_id', VENUE_ID)
  .not('lead_source', 'is', null)

const KNOWN = new Set(['website','the_knot','google','direct','calendly','weddingwire',
  'herecomestheguide','zola','referral','planner_referral','facebook','chatgpt',
  'instagram','tiktok','weddingwire_ww','google_ads','social_media','other'])

for (const r of data ?? []) {
  if (KNOWN.has(r.lead_source)) continue
  const lower = r.lead_source.toLowerCase()
  const isLocal = lower.includes('culpeper') || lower.includes('local')
  const newSource = isLocal ? 'direct' : null

  const { error } = await supabase.from('weddings')
    .update({ lead_source: newSource, ...(newSource ? {} : { lead_source_derivation_attempted_at: null }) })
    .eq('id', r.id)
  console.log(`  "${r.lead_source}" → "${newSource ?? 'null (re-derive)'}" on ${r.id}: ${error?.message ?? 'ok'}`)
}
console.log('done')
