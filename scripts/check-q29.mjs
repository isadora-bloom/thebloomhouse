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

const { count: total } = await supabase.from('candidate_identities').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID)
const { count: resolved } = await supabase.from('candidate_identities').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('resolved_wedding_id', 'is', null)
const { count: needsReview } = await supabase.from('candidate_identities').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).eq('review_status', 'needs_review')

const { data: highConf } = await supabase.from('candidate_identities').select('id, first_name, last_name, source_platform, resolved_confidence, review_status, signal_count').eq('venue_id', VENUE_ID).not('resolved_confidence', 'is', null).order('resolved_confidence', { ascending: false }).limit(5)
const { data: lowConf } = await supabase.from('candidate_identities').select('id, first_name, last_name, source_platform, resolved_confidence, review_status, signal_count').eq('venue_id', VENUE_ID).not('resolved_confidence', 'is', null).order('resolved_confidence', { ascending: true }).limit(5)

console.log(`=== Q29 — CANDIDATE IDENTITIES ===`)
console.log(`  Total: ${total}`)
console.log(`  Resolved to wedding: ${resolved}`)
console.log(`  Needs review: ${needsReview}`)
console.log(`  With resolved_confidence set: ${(highConf?.length ?? 0) > 0 ? 'yes' : 'none'}`)
if (highConf?.length) {
  console.log('\n  Top 5 by confidence:')
  for (const r of highConf) console.log(`    ${r.first_name} ${r.last_name ?? ''} [${r.source_platform}] conf=${r.resolved_confidence} signals=${r.signal_count} status=${r.review_status}`)
  console.log('\n  Lowest 5 by confidence:')
  for (const r of lowConf ?? []) console.log(`    ${r.first_name} ${r.last_name ?? ''} [${r.source_platform}] conf=${r.resolved_confidence} signals=${r.signal_count} status=${r.review_status}`)
}
