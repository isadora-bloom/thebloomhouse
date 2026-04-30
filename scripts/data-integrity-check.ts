// Data integrity invariants — pass-or-fail gate before "Go Live".
//
// Thin CLI wrapper over src/lib/services/data-integrity.ts. The
// daily cron sweep uses the same module, so script and cron always
// agree on what "data-integrity-clean" means.
//
// Usage:
//   npx tsx scripts/data-integrity-check.ts --venue <uuid>
//   npx tsx scripts/data-integrity-check.ts --venue <uuid> --json   # machine-readable
//   npx tsx scripts/data-integrity-check.ts --venue <uuid> --details  # show first 10 violations per check
//
// Exit codes:
//   0 — all invariants pass
//   1 — one or more invariants violated
//   2 — script error
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runDataIntegrityChecks } from '../src/lib/services/data-integrity'

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
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null
const asJson = args.includes('--json')
const showDetails = args.includes('--details')
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}

async function main() {
  if (!asJson) {
    console.log(`\n=== Data integrity check — venue ${venueId} ===\n`)
  }

  let results
  try {
    results = await runDataIntegrityChecks(sb, venueId!)
  } catch (err) {
    console.error('Failed to run invariants:', err instanceof Error ? err.message : err)
    process.exit(2)
  }

  if (asJson) {
    console.log(JSON.stringify({ venueId, results }, null, 2))
  } else {
    console.log(`${results.length} invariants. Each returns rows when violated.\n`)
    let allClean = true
    for (const r of results) {
      const status = r.count === 0 ? '✓' : '✗'
      console.log(`  ${status} ${r.count.toString().padStart(4)}  ${r.name}`)
      if (r.count > 0) allClean = false
      if (showDetails && r.count > 0) {
        console.log(`         meaning: ${r.meaning}`)
        console.log(`         first ${Math.min(10, r.count)} violations:`)
        for (const s of r.sample) console.log(`           ${JSON.stringify(s)}`)
      }
    }
    console.log()
    if (allClean) {
      console.log('All invariants pass. Venue is data-integrity-clean.')
    } else {
      console.log('One or more invariants violated. Run scripts/onboard-data-cleanup.ts --apply to repair.')
      console.log('Re-run this check after; venue should not be enabled for Go Live until clean.')
    }
  }

  const anyViolations = results.some((r) => r.count > 0)
  process.exit(anyViolations ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(2) })
