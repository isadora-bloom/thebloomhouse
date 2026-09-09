// Re-fetch Gmail labels for every venue interaction with a
// gmail_message_id and re-classify direction based on the SENT
// label. Thin CLI wrapper — the actual logic lives in
// src/lib/services/onboarding/cleanup/reclassify-direction.ts so the
// onboarding-project UI (POST /api/onboarding/project/cleanup) can run
// the identical check without a terminal.
//
// Idempotent. Already-correct rows skip silently.
//
// Usage:
//   npx tsx scripts/reclassify-direction-from-gmail.ts
//   npx tsx scripts/reclassify-direction-from-gmail.ts --apply
//   npx tsx scripts/reclassify-direction-from-gmail.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { reclassifyDirectionFromGmail } from '../src/lib/services/onboarding/cleanup/reclassify-direction'

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
  console.log(`\n=== Reclassify direction from Gmail labels — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  const result = await reclassifyDirectionFromGmail(sb, venueId, apply)
  if (result.skipped) {
    console.error(result.skipReason)
    process.exit(1)
  }
  for (const [k, v] of Object.entries(result.counts)) {
    console.log(`${k.padEnd(28)} ${v}`)
  }
  if (result.samples.length > 0) {
    console.log('\nsamples:')
    for (const s of result.samples) console.log(`  ${s}`)
  }
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (!apply && (result.counts.direction_flipped > 0 || result.counts.from_email_fixed > 0)) {
    console.log(`\nDry-run complete. Re-run with --apply to write.`)
  }
  if (!result.ok) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
