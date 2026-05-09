import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync('.env.local', 'utf8')
function getEnv(key) {
  const m = env.match(new RegExp('^' + key + '=(.+)$', 'm'))
  return m ? m[1].trim() : null
}

const url = getEnv('NEXT_PUBLIC_SUPABASE_URL')
const key = getEnv('SUPABASE_SERVICE_ROLE_KEY')
const sb = createClient(url, key)

console.log('=== Task 1: Rixey venue_ai_config ===')
const { data: vRixey, error: vErr } = await sb
  .from('venues')
  .select('id, name, slug')
  .ilike('name', '%rixey%')
console.log('venues:', vRixey, vErr)

if (vRixey?.length) {
  for (const v of vRixey) {
    const { data: cfg, error: cErr } = await sb
      .from('venue_ai_config')
      .select('*')
      .eq('venue_id', v.id)
    console.log('  venue_ai_config for', v.name, '(' + v.id + '):')
    console.log(JSON.stringify(cfg, null, 2), cErr)
  }
}

console.log('\n=== Task 2: tracked_sources for Rixey ===')
if (vRixey?.length) {
  for (const v of vRixey) {
    const { data: ts, error: tsErr } = await sb
      .from('tracked_sources')
      .select('*')
      .eq('venue_id', v.id)
    console.log('  tracked_sources for', v.name + ':')
    console.log(JSON.stringify(ts, null, 2), tsErr)
  }
}

console.log('\n=== Task 2: admin_notifications source_freshness_reminder ===')
const { data: notif, error: nErr } = await sb
  .from('admin_notifications')
  .select('id, venue_id, type, title, body, created_at')
  .eq('type', 'source_freshness_reminder')
  .order('created_at', { ascending: false })
  .limit(20)
console.log('notifications:', JSON.stringify(notif, null, 2), nErr)

console.log('\n=== Task 2: marketing_spend sample for Rixey ===')
if (vRixey?.length) {
  const v = vRixey[0]
  const { data: ms, error: msErr } = await sb
    .from('marketing_spend')
    .select('source, month, updated_at, created_at')
    .eq('venue_id', v.id)
    .order('updated_at', { ascending: false })
    .limit(40)
  console.log('  marketing_spend (' + v.name + '):')
  console.log(JSON.stringify(ms, null, 2), msErr)
}

console.log('\n=== Task 1 sanity: every venue_ai_config row ===')
const { data: allCfg, error: aErr } = await sb
  .from('venue_ai_config')
  .select('venue_id, ai_name, ai_role_title, ai_emoji')
console.log('all configs:', JSON.stringify(allCfg, null, 2), aErr)

console.log('\n=== Task 2: tracked_sources grand total ===')
const { data: allTs, error: allTsErr } = await sb
  .from('tracked_sources')
  .select('venue_id, source_key, expected_cadence_days, last_reminded_at, last_dismissed_at, graveyard, created_at')
console.log(JSON.stringify(allTs, null, 2), allTsErr)

console.log('\n=== Task 1 forensic: recent drafts for Rixey, look for Rixey Concierge in body ===')
const rixeyId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const { data: drafts, error: draftErr } = await sb
  .from('drafts')
  .select('id, venue_id, status, draft_body, created_at')
  .order('created_at', { ascending: false })
  .limit(50)
console.log('  drafts err:', draftErr)
console.log('  total recent drafts (any venue):', (drafts ?? []).length)
const rixeyDrafts = (drafts ?? []).filter(d => d.venue_id === rixeyId)
console.log('  rixey drafts:', rixeyDrafts.length)
let signedRixeyConcierge = 0
let signedSage = 0
const examples = { rixey: null, sage: null }
for (const d of rixeyDrafts) {
  if (typeof d.draft_body !== 'string') continue
  if (d.draft_body.includes('Rixey Concierge')) {
    signedRixeyConcierge += 1
    if (!examples.rixey) examples.rixey = { id: d.id, created_at: d.created_at, snippet: d.draft_body.slice(-400) }
  } else if (d.draft_body.includes('Sage')) {
    signedSage += 1
    if (!examples.sage) examples.sage = { id: d.id, created_at: d.created_at, snippet: d.draft_body.slice(-400) }
  }
}
console.log('  drafts scanned:', rixeyDrafts.length)
console.log('  signed "Rixey Concierge":', signedRixeyConcierge)
console.log('  signed "Sage":', signedSage)
console.log('  example Rixey Concierge draft:', examples.rixey)
console.log('  example Sage draft:', examples.sage)

// Also look at api_costs prompt_version log; useful for timeline.
console.log('\n=== Task 1 forensic: any api_costs log with prompt context recently? ===')
const { data: ac } = await sb
  .from('api_costs')
  .select('created_at, prompt_version, prompt_name, venue_id')
  .eq('venue_id', rixeyId)
  .order('created_at', { ascending: false })
  .limit(10)
console.log(JSON.stringify(ac, null, 2))
