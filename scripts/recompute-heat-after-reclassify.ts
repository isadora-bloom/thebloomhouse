// Recompute heat for every wedding at the venue after the
// direction-reclassification deleted false-positive engagement
// events. The 72 deleted tour_requested / high_specificity / etc.
// events were inflating heat by up to +15 each.
//
// Usage:
//   npx tsx scripts/recompute-heat-after-reclassify.ts [--venue <uuid>]
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

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

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  console.log(`\n=== Recompute heat — venue ${venueId} ${apply ? '(apply)' : '(dry-run, skipped)'} ===\n`)
  if (!apply) {
    console.log('Heat recompute is not run in dry-run because recalculateHeatScore is')
    console.log('inherently mutating (it writes the recomputed score back). Re-run with --apply.')
    return
  }
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, heat_score, temperature_tier')
    .eq('venue_id', venueId)
  let updated = 0
  let total = 0
  for (const w of (weddings ?? []) as Array<{ id: string; heat_score: number; temperature_tier: string }>) {
    total++
    try {
      const result = await recalculateHeatScore(venueId, w.id)
      if (result.newScore !== w.heat_score) updated++
    } catch (err) {
      console.error(`  ${w.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`weddings recomputed: ${total}`)
  console.log(`scores changed:      ${updated}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
