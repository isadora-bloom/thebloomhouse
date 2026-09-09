// Recompute attribution_events.bucket and is_first_touch for a venue.
// Thin CLI wrapper — logic lives in
// src/lib/services/onboarding/cleanup/attribution-buckets.ts so the
// onboarding-project UI can run the identical check without a
// terminal.
//
// Usage:
//   npx tsx scripts/recompute-attribution-buckets.ts --venue <uuid>
//   npx tsx scripts/recompute-attribution-buckets.ts --venue <uuid> --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recomputeAttributionBuckets } from '../src/lib/services/onboarding/cleanup/attribution-buckets'

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
  console.log(`\n=== Recompute attribution buckets — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  const result = await recomputeAttributionBuckets(sb, venueId, apply)
  if ((result.counts.attribution_events ?? 0) === 0) {
    console.log('No attribution events. Nothing to do.')
    return
  }
  console.log(`weddings scanned:       ${result.counts.weddings_scanned}`)
  console.log(`attribution events:     ${result.counts.attribution_events}`)
  console.log(`bucket flips queued:    ${result.counts.bucket_flips}`)
  console.log(`first-touch changes:    ${result.counts.first_touch_changes}`)
  if (apply) console.log(`rows written:           ${result.counts.rows_written}`)
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (!apply && result.counts.rows_written > 0) {
    console.log('\nDry-run complete. Re-run with --apply to write.')
    console.log('After --apply, the AI journey narratives should be force-regenerated.')
  }
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
