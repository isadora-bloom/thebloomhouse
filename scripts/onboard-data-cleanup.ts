// Multi-venue onboarding data-cleanup pipeline.
//
// Runs every Rixey-derived backfill in dependency order against any
// venue. Thin CLI wrapper — the six steps live in
// src/lib/services/onboarding/cleanup/ (runCleanupPipeline) so the
// onboarding-project UI can run the identical pipeline from
// POST /api/onboarding/project/cleanup with no terminal. Previously
// this script spawned each step as a child process; it now calls the
// library functions directly in-process, which also means a failure
// in one step no longer aborts the process — every step's counts are
// printed so a coordinator sees the whole picture.
//
// Usage:
//   npx tsx scripts/onboard-data-cleanup.ts --venue <uuid>             # dry-run
//   npx tsx scripts/onboard-data-cleanup.ts --venue <uuid> --apply
//
// Run on a fresh venue immediately after Gmail backfill and before
// "Go Live" is enabled. Run on existing venues whenever the team
// touches the email pipeline.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { CLEANUP_STEPS, runCleanupPipeline } from '../src/lib/services/onboarding/cleanup'

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
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}

async function main() {
  console.log(`\n=== Onboarding data cleanup — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  console.log(`Steps: ${CLEANUP_STEPS.length}.  Mode: ${apply ? 'WRITE' : 'READ-ONLY'}.`)
  console.log(`Each step is idempotent. Already-correct rows are no-ops.\n`)

  const startedAt = Date.now()
  const pipeline = await runCleanupPipeline(sb, venueId!, apply)
  const totalMs = Date.now() - startedAt

  for (const step of pipeline.steps) {
    console.log('\n' + '─'.repeat(72))
    console.log(step.name)
    const def = CLEANUP_STEPS.find((s) => s.id === step.id)
    if (def) console.log(`why: ${def.rationale}`)
    console.log('─'.repeat(72))
    if (step.skipped) {
      console.log(`  SKIPPED: ${step.skipReason ?? 'no reason given'}`)
      continue
    }
    for (const [k, v] of Object.entries(step.counts)) {
      console.log(`  ${k.padEnd(36)} ${v}`)
    }
    if (step.samples.length > 0) {
      console.log('  samples:')
      for (const s of step.samples) console.log(`    ${s}`)
    }
    for (const e of step.errors) console.error(`  error: ${e}`)
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`SUMMARY — ${apply ? 'applied' : 'dry-run'} in ${(totalMs / 1000).toFixed(1)}s`)
  console.log('═'.repeat(72))
  for (const step of pipeline.steps) {
    const status = step.skipped ? 'SKIP' : step.ok ? 'OK' : 'FAIL'
    console.log(`  [${status.padEnd(6)}] ${step.name}`)
  }

  if (!pipeline.allOk) {
    console.log('\nOne or more steps failed. Investigate before re-running with --apply.')
    process.exit(1)
  }

  if (!apply) {
    console.log('\nDry-run complete. Re-run with --apply to write.')
    console.log('After --apply, run scripts/onboarding-readiness.ts to verify all invariants pass.')
  } else {
    console.log('\nNext step: scripts/onboarding-readiness.ts --venue ' + venueId)
    console.log('Only enable Go Live for this venue if all invariants pass.')
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
