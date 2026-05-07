// Phase 7: Identity reconciliation. After loading 4 sources, dedupe.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { reconcileVenue } from '../../src/lib/services/identity/reconciliation'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('Running reconcileVenue...')
  const result = await reconcileVenue(sb, RIXEY_ID)

  console.log()
  console.log('=== Result ===')
  console.log(`venueId: ${result.venueId}`)
  console.log(`activeBefore: ${result.activeBefore}`)
  console.log(`activeAfter:  ${result.activeAfter}`)
  console.log(`clustersFound: ${result.clustersFound}`)
  console.log(`autoMerged:    ${result.autoMerged}`)
  console.log(`surfacedForReview: ${result.surfacedForReview}`)
  console.log()
  console.log('Fields backfilled:')
  for (const [k, v] of Object.entries(result.fieldsBackfilled)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }
  console.log()
  console.log(`errors: ${result.errors.length}`)
  for (const e of result.errors.slice(0, 5)) console.log(`  ${e}`)

  console.log()
  console.log('Sample auto-merged clusters (first 5):')
  const auto = result.clusters.filter((c) => c.status === 'auto_merged')
  for (const c of auto.slice(0, 5)) {
    console.log(`  email=${c.email} winner=${c.winnerId?.slice(0, 8) ?? '(none)'} losers=${c.loserIds.length} backfilled=${c.backfillPlan.map((p) => p.field).join(',')}`)
  }
  console.log()
  console.log('Sample surfaced clusters (first 5):')
  const surfaced = result.clusters.filter((c) => c.status === 'surfaced_for_review')
  for (const c of surfaced.slice(0, 5)) {
    console.log(`  email=${c.email} winner=${c.winnerId?.slice(0, 8)} losers=${c.loserIds.length} conflicts=${c.conflicts.join(',')}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
