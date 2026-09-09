// Recompute heat for every wedding at the venue after the
// direction-reclassification deleted false-positive engagement
// events. Thin CLI wrapper — logic lives in
// src/lib/services/onboarding/cleanup/heat-recompute.ts so the
// onboarding-project UI can run the identical check without a
// terminal.
//
// Usage:
//   npx tsx scripts/recompute-heat-after-reclassify.ts [--venue <uuid>]
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recomputeHeatAfterCleanup } from '../src/lib/services/onboarding/cleanup/heat-recompute'

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
  const result = await recomputeHeatAfterCleanup(sb, venueId, apply)
  if (result.skipped) {
    console.log(result.skipReason)
    return
  }
  console.log(`weddings recomputed: ${result.counts.weddings_recomputed}`)
  console.log(`scores changed:      ${result.counts.scores_changed}`)
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
