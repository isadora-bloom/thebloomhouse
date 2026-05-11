/* Fresh capture probe to verify attribution_events fan-out works. */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { captureDiscoverySource } from '../src/lib/services/discovery-source/capture'

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

;(async () => {
const WEDDING_ID = '948b79a5-5954-4a07-bed4-4fdd3a7d2b95'
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const result = await captureDiscoverySource({
  venueId: VENUE_ID,
  weddingId: WEDDING_ID,
  personId: null,
  captureSource: 'calendly',
  questionText: 'How did you hear about us?',
  answerText: 'ChatGPT',
  captureRef: 'fresh-' + Date.now(),
  supabase: sb,
})
console.log('capture result:', result)

const { data: ae } = await sb
  .from('attribution_events')
  .select('id, source_platform, tier, decided_by, bucket, reasoning, referrer_name_text, referrer_relationship_text')
  .eq('wedding_id', WEDDING_ID)
  .like('reasoning', '%Wave 15 discovery_source%')
  .order('decided_at', { ascending: false })
console.log(`\nattribution_events Wave 15 rows: ${ae?.length ?? 0}`)
for (const r of ae ?? []) {
  console.log(`  - ${r.source_platform} [${r.tier}] (${r.bucket}) by ${r.decided_by}`)
  console.log(`    referrer_name_text=${r.referrer_name_text}`)
  console.log(`    referrer_relationship_text=${r.referrer_relationship_text}`)
  console.log(`    reasoning: ${(r.reasoning ?? '').slice(0, 200)}`)
}
})()
