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

const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Find a Knot inquiry interaction that's likely a "new lead" form-fill
const { data: ints } = await sb
  .from('interactions')
  .select('id, wedding_id, from_email, subject, body_preview, full_body, timestamp, direction')
  .eq('venue_id', venueId)
  .ilike('from_email', '%theknot%')
  .ilike('subject', '%new message%')
  .not('wedding_id', 'is', null)
  .eq('direction', 'inbound')
  .order('timestamp', { ascending: false })
  .limit(3)

for (const i of ints ?? []) {
  console.log('\n=== INQUIRY SAMPLE ===')
  console.log('subj:', i.subject)
  console.log('timestamp:', i.timestamp)
  console.log('wedding_id:', i.wedding_id)
  console.log('full_body (first 1500):')
  console.log((i.full_body || '').slice(0, 1500))
}
