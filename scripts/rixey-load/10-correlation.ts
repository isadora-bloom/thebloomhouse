// Phase 9: Correlation engine.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeCorrelationsForVenue } from '../../src/lib/services/intel/correlation-engine'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('Running correlation engine for Rixey...')
  const insights = await computeCorrelationsForVenue({ supabase: sb, venueId: RIXEY_ID, maxInsights: 8 })
  console.log()
  console.log(`Returned ${insights.length} correlation insights:`)
  for (const ins of insights) {
    console.log(`  [r=${ins.r.toFixed(3)} lag=${ins.lagDays}d] ${ins.headline}`)
  }

  console.log()
  console.log('Persisted intelligence_insights for Rixey:')
  const { data: persisted } = await sb
    .from('intelligence_insights')
    .select('insight_type, category, title, priority, confidence, created_at')
    .eq('venue_id', RIXEY_ID)
    .order('created_at', { ascending: false })
    .limit(20)
  for (const r of persisted ?? []) {
    console.log(`  [${r.insight_type}/${r.category} pri=${r.priority} conf=${(Number(r.confidence) ?? 0).toFixed(2)}] ${r.title}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
