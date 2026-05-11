import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: vc } = await sb.from('venue_config').select('venue_id').eq('venue_prefix', 'RM').single()
const venueId = vc.venue_id

// First, learn the actual schema of attribution_events
const { data: oneRow } = await sb.from('attribution_events').select('*').eq('venue_id', venueId).eq('source_platform', 'the_knot').limit(1).single()
console.log('Columns on attribution_events:', Object.keys(oneRow).sort().join(', '))
console.log()

// Now pull samples — get all relevant columns
const { data: ues } = await sb
  .from('attribution_events')
  .select('*')
  .eq('venue_id', venueId)
  .eq('source_platform', 'the_knot')
  .eq('intent_class', 'unknown')
  .limit(5)

console.log('\n--- 5 sample unknown-intent Knot AEs ---')
for (const ae of (ues ?? [])) {
  console.log('\n--- AE', ae.id?.slice(0, 8), '---')
  // Print all keys; truncate long values
  for (const [k, v] of Object.entries(ae)) {
    if (v == null) continue
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    console.log(`  ${k}: ${s.slice(0, 120)}${s.length > 120 ? '…' : ''}`)
  }
}
