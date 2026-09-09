// Backfill engagement_events.occurred_at, wedding_touchpoints.occurred_at,
// and weddings.tour_date from `metadata.event_datetime`. Thin CLI
// wrapper — logic lives in
// src/lib/services/onboarding/cleanup/scheduling-event-dates.ts so the
// onboarding-project UI can run the identical check without a terminal.
//
// Idempotent. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-scheduling-event-dates.ts                 # dry-run
//   npx tsx scripts/backfill-scheduling-event-dates.ts --apply
//   npx tsx scripts/backfill-scheduling-event-dates.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { backfillSchedulingEventDates } from '../src/lib/services/onboarding/cleanup/scheduling-event-dates'

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
  console.log(`\n=== Backfill scheduling-event dates — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  const result = await backfillSchedulingEventDates(sb, venueId, apply)
  for (const [k, v] of Object.entries(result.counts)) {
    console.log(`${k.padEnd(36)} ${v}`)
  }
  for (const e of result.errors) console.error(`  error: ${e}`)
  const anyUpdated = Object.entries(result.counts).some(([k, v]) => k.endsWith('_updated') && v > 0)
  if (!apply && anyUpdated) {
    console.log(`\nDry-run complete. Re-run with --apply to write updates.`)
  }
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
