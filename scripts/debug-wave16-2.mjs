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

// Pull the wedding for the FIRST classified AE and check what interactions exist
// Pick the most-recently classified Knot AE
const { data: pick } = await sb
  .from('attribution_events')
  .select('id')
  .eq('venue_id', venueId)
  .ilike('source_platform', '%knot%')
  .eq('intent_class', 'targeted')
  .not('intent_class_signals', 'is', null)
  .limit(1)
const aeId = pick?.[0]?.id
if (!aeId) {
  console.log('no classified knot AE found')
  process.exit(0)
}
const { data: ae } = await sb.from('attribution_events').select('*').eq('id', aeId).maybeSingle()
console.log('AE:', { id: ae.id, wedding_id: ae.wedding_id, source_platform: ae.source_platform, intent_class: ae.intent_class, intent_class_signals: ae.intent_class_signals })

// All interactions linked to that wedding (regardless of source)
const { data: allInts } = await sb
  .from('interactions')
  .select('id, direction, timestamp, subject, from_email, full_body')
  .eq('wedding_id', ae.wedding_id)
  .order('timestamp', { ascending: true })
  .limit(20)
console.log(`Total interactions on wedding: ${allInts?.length ?? 0}`)
for (const i of allInts ?? []) {
  console.log('-', i.direction, '|', i.timestamp, '|', i.from_email?.slice(0, 50), '|', (i.subject || '').slice(0, 60))
}

// Pick the inbound one closest to inquiry_date and show body
const inbound = (allInts ?? []).filter((i) => i.direction === 'inbound')
if (inbound.length > 0) {
  const first = inbound[0]
  console.log('\nINBOUND ANALYZED (first inbound):')
  console.log('from:', first.from_email)
  console.log('subj:', first.subject)
  console.log('body (first 1500):')
  console.log((first.full_body || '').slice(0, 1500))

  // Now manually test the pattern matcher
  console.log('\n=== MANUAL PATTERN CHECK ===')
  const body = (first.full_body || '').toLowerCase()
  const patterns = [
    'we saw your listing',
    'reaching out to several',
    'looking for',
    'pricing and any packages',
    'wanted to reach out for a quote',
    'send through information',
    'lots of details are still tbd',
    'can you share what options are available',
    'messages may be monitored for quality, safety, and security',
    'acceptable content policy',
    'interested in your services',
  ]
  for (const p of patterns) {
    if (body.includes(p)) console.log(`  ✓ ${p}`)
  }

  // Also check the body_preview separately
  const preview = (first.body_preview || '').toLowerCase()
  console.log('\n--- BODY_PREVIEW (first 400) ---')
  console.log(first.body_preview?.slice(0, 400))
  console.log('preview pattern matches:')
  for (const p of patterns) {
    if (preview.includes(p)) console.log(`  ✓ ${p}`)
  }
}
