import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

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
const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Direct check: how many interactions match the footer pattern?
const { count: footerCount } = await sb
  .from('interactions')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
  .ilike('full_body', '%your messages may be monitored for quality%')
console.log(`"your messages may be monitored" matches: ${footerCount}`)

const { count: footerKnot } = await sb
  .from('interactions')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
  .ilike('full_body', '%messages may be monitored%')
  .ilike('from_email', '%theknot%')
console.log(`Knot footer matches: ${footerKnot}`)

// Pick the wedding for one of the "score=0" attribution_events to debug
const { data: oneAe } = await sb
  .from('attribution_events')
  .select('id, wedding_id, source_platform, decided_at')
  .eq('id', 'add9e4eb-1ee9-462d-92cf-9ca97e7d3d5c')
  .maybeSingle()

if (!oneAe) {
  // Pick any
  const { data: aes } = await sb
    .from('attribution_events')
    .select('id, wedding_id, source_platform, decided_at')
    .eq('venue_id', venueId)
    .ilike('source_platform', '%knot%')
    .is('reverted_at', null)
    .not('wedding_id', 'is', null)
    .limit(5)

  for (const ae of aes ?? []) {
    const { data: w } = await sb.from('weddings').select('id, inquiry_date').eq('id', ae.wedding_id).maybeSingle()
    const { data: ints } = await sb
      .from('interactions')
      .select('id, direction, timestamp, subject, body_preview, full_body, from_email')
      .eq('wedding_id', ae.wedding_id)
      .eq('direction', 'inbound')
      .ilike('from_email', '%theknot%')
      .order('timestamp', { ascending: true })
      .limit(2)
    console.log('\n=== ae', ae.id.slice(0,8), '===')
    console.log('inquiry_date:', w?.inquiry_date)
    for (const i of ints ?? []) {
      console.log('inbound:', i.timestamp)
      console.log('subject:', i.subject)
      console.log('full_body (300 chars):', (i.full_body || '').slice(0, 600))
      // Look for our seed patterns
      const body = (i.full_body || '').toLowerCase()
      const checks = [
        'messages may be monitored',
        'acceptable content policy',
        'looking for',
        'we saw your listing',
        'reaching out to several',
      ]
      console.log('pattern hits:')
      for (const c of checks) {
        if (body.includes(c.toLowerCase())) console.log(`  HIT: ${c}`)
      }
    }
  }
}
