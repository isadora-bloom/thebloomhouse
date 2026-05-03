// Phase 10a: NLQ tests for the loaded Rixey data.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { answerNaturalLanguageQuery } from '../../src/lib/services/intel-brain'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  // Mirror env onto process.env so service.ts createServiceClient() reads them.
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v as string
  }

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Find a real user_id to attribute the queries to
  const { data: profiles } = await sb.from('user_profiles').select('id').eq('venue_id', RIXEY_ID).limit(1)
  const USER_ID = profiles?.[0]?.id ?? 'a2ab53b8-a02b-409d-b32d-4add75852d33'

  const QUERIES = [
    'What was my Google Ads ROI in 2025?',
    'Did dropping WeddingWire affect my lead volume?',
    'How did my conversion rate change after I cancelled WeddingWire?',
    "What's my busiest tour month?",
  ]

  for (const q of QUERIES) {
    console.log()
    console.log('===========================================================')
    console.log(`Q: ${q}`)
    console.log('===========================================================')
    try {
      const r = await answerNaturalLanguageQuery(RIXEY_ID, USER_ID, q)
      console.log(r.response)
      console.log()
      console.log(`(tokens=${r.tokensUsed} cost=$${r.cost.toFixed(4)} queryId=${r.queryId.slice(0, 8)})`)
    } catch (e: any) {
      console.error('ERR:', e?.message ?? e)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
