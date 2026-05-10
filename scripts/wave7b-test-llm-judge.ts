/**
 * Wave 7B verification: exercise the LLM judge path for one mixed-class
 * Rixey attribution_event, then probe the resulting role + reasoning.
 *
 * Usage:
 *   npx tsx scripts/wave7b-test-llm-judge.ts
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

async function main() {
  const env = loadEnv()
  for (const k of Object.keys(env)) process.env[k] = env[k]

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Prefer a pre-inquiry (attribution-bucket) mixed event so the LLM
  // judge has a meaningful question to answer (Knot signal that
  // happened pre-inquiry but nothing else recorded → likely validation).
  const { data: target } = await sb
    .from('attribution_events')
    .select('id, source_platform, role, role_reasoning, bucket')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('role', 'mixed')
    .eq('bucket', 'attribution')
    .is('reverted_at', null)
    .limit(1)
  console.log('mixed-class target:', target?.[0])
  if (!target?.[0]) {
    console.log('No mixed events available — bulk reclassify with noLLM=false first.')
    return
  }
  const eventId = (target[0] as { id: string }).id

  const { classifyAndPersistAttributionEvent } = await import(
    '../src/lib/services/attribution-roles/classify'
  )

  console.log('\nrunning LLM judge classify on event', eventId)
  const r = await classifyAndPersistAttributionEvent(
    { attributionEventId: eventId },
    { supabase: sb as never, noLLM: false },
  )
  console.log('  result.role:', r.role)
  console.log('  result.confidence:', r.role_confidence_0_100)
  console.log('  result.reasoning:', r.reasoning)
  console.log('  result.cost_cents:', r.cost_cents)
  console.log('  evidence.llm_judge:', r.evidence.llm_judge)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
