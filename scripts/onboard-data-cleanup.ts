// Multi-venue onboarding data-cleanup pipeline.
//
// Runs every Rixey-derived backfill in dependency order against any
// venue. After each step, prints a summary so a coordinator can spot
// anomalies before letting the next step run. Idempotent — already-
// correct rows are no-ops.
//
// Step order matters:
//   1. Direction reclassification first (everything else depends on
//      direction + from_email being right).
//   2. Recover scheduling-event datetimes from metadata (tour timestamps).
//   3. Re-align booking vs tour timestamps (uses interactions, requires
//      step 1).
//   4. Repair touchpoint sources (uses interaction.from_email, requires
//      step 1).
//   5. Recompute heat scores (after every other correction).
//
// Usage:
//   npx tsx scripts/onboard-data-cleanup.ts --venue <uuid>             # dry-run
//   npx tsx scripts/onboard-data-cleanup.ts --venue <uuid> --apply
//
// Run on a fresh venue immediately after Gmail backfill and before
// "Go Live" is enabled. Run on existing venues whenever the team
// touches the email pipeline.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}

interface Step {
  /** Display name. */
  name: string
  /** Path to the underlying script (relative to repo root). */
  script: string
  /** Why this step is in this position — surfaced in the log. */
  rationale: string
}

const STEPS: Step[] = [
  {
    name: '1. Reclassify direction from Gmail labels',
    script: 'scripts/reclassify-direction-from-gmail.ts',
    rationale: 'Direction + from_email must be correct before any downstream step can trust them.',
  },
  {
    name: '2. Recover scheduling-event datetimes from metadata',
    script: 'scripts/backfill-scheduling-event-dates.ts',
    rationale: 'Tour event timestamps recovered from metadata.event_datetime / subject / sibling rows.',
  },
  {
    name: '3. Re-align booking vs tour timestamps',
    script: 'scripts/backfill-booking-vs-tour-timestamps.ts',
    rationale: 'Inquiry / tour_booked land at the booking moment (email arrival), tour_conducted lands at the tour itself.',
  },
  {
    name: '4. Repair touchpoint sources',
    script: 'scripts/backfill-touchpoint-sources.ts',
    rationale: 'Touchpoint source matches the actual channel (inferred from interaction.from_email), not the wedding\'s legacy first-touch.',
  },
  {
    name: '5. Recompute heat scores',
    script: 'scripts/recompute-heat-after-reclassify.ts',
    rationale: 'Heat may be inflated from now-deleted false-positive engagement events. Reset everything.',
  },
]

function ensureScriptExists(path: string): boolean {
  try {
    readFileSync(path, 'utf8')
    return true
  } catch {
    return false
  }
}

function runStep(step: Step): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const stepArgs = ['tsx', step.script, '--venue', venueId!]
    if (apply) stepArgs.push('--apply')
    const child = spawn('npx', stepArgs, { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      output += s
      process.stdout.write(s)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      output += s
      process.stderr.write(s)
    })
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, output })
    })
  })
}

async function main() {
  console.log(`\n=== Onboarding data cleanup — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)
  console.log(`Steps: ${STEPS.length}.  Mode: ${apply ? 'WRITE' : 'READ-ONLY'}.`)
  console.log(`Each step is idempotent. Already-correct rows are no-ops.\n`)

  const startedAt = Date.now()
  const stepResults: Array<{ step: Step; exitCode: number; durationMs: number }> = []
  for (const step of STEPS) {
    if (!ensureScriptExists(step.script)) {
      console.error(`\n  MISSING: ${step.script} not found. Aborting.`)
      process.exit(2)
    }
    console.log('\n' + '─'.repeat(72))
    console.log(step.name)
    console.log(`why: ${step.rationale}`)
    console.log('─'.repeat(72))
    const stepStart = Date.now()
    const { exitCode } = await runStep(step)
    const durationMs = Date.now() - stepStart
    stepResults.push({ step, exitCode, durationMs })
    if (exitCode !== 0) {
      console.error(`\n  FAILED: step exited with code ${exitCode}. Aborting subsequent steps.`)
      break
    }
  }

  const totalMs = Date.now() - startedAt
  console.log('\n' + '═'.repeat(72))
  console.log(`SUMMARY — ${apply ? 'applied' : 'dry-run'} in ${(totalMs / 1000).toFixed(1)}s`)
  console.log('═'.repeat(72))
  for (const r of stepResults) {
    const status = r.exitCode === 0 ? 'OK' : `FAIL(${r.exitCode})`
    console.log(`  [${status.padEnd(7)}] ${(r.durationMs / 1000).toFixed(1)}s  ${r.step.name}`)
  }

  const failed = stepResults.find((r) => r.exitCode !== 0)
  if (failed) {
    console.log('\nOne or more steps failed. Investigate before re-running with --apply.')
    process.exit(1)
  }

  if (!apply) {
    console.log('\nDry-run complete. Re-run with --apply to write.')
    console.log('After --apply, run scripts/data-integrity-check.ts to verify all invariants pass.')
  } else {
    console.log('\nNext step: scripts/data-integrity-check.ts --venue ' + venueId)
    console.log('Only enable Go Live for this venue if all invariants pass.')
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
