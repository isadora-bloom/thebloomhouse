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

// Get all non-standard lead sources
const { data } = await supabase
  .from('weddings')
  .select('lead_source')
  .eq('venue_id', VENUE_ID)
  .not('lead_source', 'is', null)

const KNOWN = new Set(['website','the_knot','google','direct','calendly','weddingwire',
  'herecomestheguide','zola','referral','planner_referral','facebook','chatgpt',
  'instagram','tiktok','weddingwire_ww','google_ads','social_media','other'])
const nonStandard = {}
for (const r of data ?? []) {
  if (!KNOWN.has(r.lead_source)) nonStandard[r.lead_source] = (nonStandard[r.lead_source] ?? 0) + 1
}
console.log('Non-standard lead_source values:')
for (const [k,v] of Object.entries(nonStandard).sort((a,b) => b[1]-a[1])) {
  console.log(`  "${k}": ${v}`)
}
