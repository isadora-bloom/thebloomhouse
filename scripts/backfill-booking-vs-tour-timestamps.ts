// Corrective backfill — fixes the conflation between "when the
// booking happened" and "when the tour happened". Thin CLI wrapper —
// logic lives in
// src/lib/services/onboarding/cleanup/booking-vs-tour-timestamps.ts
// so the onboarding-project UI can run the identical check without a
// terminal.
//
// Idempotent.
//
// Usage:
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts --apply
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { backfillBookingVsTourTimestamps } from '../src/lib/services/onboarding/cleanup/booking-vs-tour-timestamps'

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
  console.log(`\n=== Booking vs tour timestamp correction — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  const result = await backfillBookingVsTourTimestamps(sb, venueId, apply)
  for (const [k, v] of Object.entries(result.counts)) {
    console.log(`${k.padEnd(28)} ${v}`)
  }
  if (result.samples.length > 0) {
    console.log(`\nfirst ${result.samples.length} drift samples:`)
    for (const s of result.samples) console.log(`  ${s}`)
  }
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (!apply) console.log(`\nDry-run complete. Re-run with --apply to write.`)
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
