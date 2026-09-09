// Repair wedding_touchpoints.source where the source was inherited
// from the wedding's legacy first-touch instead of the actual
// channel. Thin CLI wrapper — logic lives in
// src/lib/services/onboarding/cleanup/touchpoint-sources.ts so the
// onboarding-project UI can run the identical check without a
// terminal.
//
// Usage:
//   npx tsx scripts/backfill-touchpoint-sources.ts
//   npx tsx scripts/backfill-touchpoint-sources.ts --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { backfillTouchpointSources } from '../src/lib/services/onboarding/cleanup/touchpoint-sources'

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
  console.log(`\n=== Backfill touchpoint sources — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  const result = await backfillTouchpointSources(sb, venueId, apply)
  console.log(`scanned:    ${result.counts.scanned ?? 0}`)
  console.log(`fixed:      ${result.counts.fixed ?? 0}`)
  if (result.samples.length > 0) {
    console.log(`\nfirst ${result.samples.length} samples:`)
    for (const s of result.samples) console.log(`  ${s}`)
  }
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (!apply && (result.counts.fixed ?? 0) > 0) console.log(`\nDry-run complete. Re-run with --apply to write.`)
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
