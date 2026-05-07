// Re-run the resolver against currently-unresolved candidates so the
// new Tier 2 wide-window path picks up matches the previous ±72h
// only path missed. Idempotent — already-resolved candidates skip.
//
// Usage: npx tsx scripts/rerun-resolver.ts [--venue <uuid>]
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolveVenueCandidates } from '../src/lib/services/identity/candidate-resolver'

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
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  console.log(`\n=== Re-running resolver for venue ${venueId} ===\n`)
  const result = await resolveVenueCandidates({ supabase: sb, venueId })
  const matched =
    result.resolved_tier_1_exact +
    result.resolved_tier_1_name_window +
    result.resolved_tier_1_full_name +
    result.resolved_tier_2_ai +
    result.resolved_tier_2_wide_ai
  console.log(`processed:           ${result.candidates_processed}`)
  console.log(`matched total:       ${matched}`)
  console.log(`  Tier 1 exact:      ${result.resolved_tier_1_exact}`)
  console.log(`  Tier 1 name+win:   ${result.resolved_tier_1_name_window}`)
  console.log(`  Tier 1 full name:  ${result.resolved_tier_1_full_name}`)
  console.log(`  Tier 2 AI (±72h):  ${result.resolved_tier_2_ai}`)
  console.log(`  Tier 2 wide (±30d):${result.resolved_tier_2_wide_ai}`)
  console.log(`deferred to coord:   ${result.deferred_to_ai}`)
  console.log(`no_match:            ${result.no_match}`)
  console.log(`conflicts flagged:   ${result.conflicts_flagged}`)
  if (result.errors.length > 0) {
    console.log(`\nerrors (${result.errors.length}):`)
    for (const e of result.errors.slice(0, 5)) console.log(`  - ${e}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
