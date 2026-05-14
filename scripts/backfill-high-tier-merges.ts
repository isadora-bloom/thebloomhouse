// Re-evaluate every pending client_match_queue row for a venue against the
// current resolution rules. Auto-merge any pair that now scores high-tier
// (e.g. the 2026-05-14 full_name_plus_email_domain rule). Cleans up the
// noise that piled up before the rule existed.
//
// Usage:
//   npx tsx scripts/backfill-high-tier-merges.ts [--venue <uuid>] [--dry-run]
//
// Default venue is Rixey. Dry-run prints what would merge without writing.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { backfillHighTierMerges } from '../src/lib/services/identity/backfill-high-tier'

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
const dryRun = args.includes('--dry-run')

async function main() {
  console.log(
    `\n=== Backfill high-tier merges for venue ${venueId} ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===\n`,
  )
  const result = await backfillHighTierMerges(sb, venueId, { dryRun })
  console.log(`evaluated:              ${result.evaluated}`)
  console.log(`promoted to high tier:  ${result.promoted}`)
  console.log(`actually merged:        ${result.merged}`)
  console.log(`skipped (missing rows): ${result.skipped_missing_people}`)
  console.log(`errors:                 ${result.errors.length}`)
  if (result.errors.length > 0) {
    console.log('\nFirst 10 errors:')
    for (const e of result.errors.slice(0, 10)) {
      console.log(`  ${e.row_id}: ${e.error}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
