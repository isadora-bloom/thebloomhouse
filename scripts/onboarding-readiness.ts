// Pre-Go-Live readiness report. Thin CLI wrapper — the 8 (now 14)
// structural invariants + 4 smoke tests live in
// src/lib/services/onboarding/readiness.ts (evaluateReadiness) so the
// onboarding-project UI can run + PERSIST the identical check from
// POST /api/onboarding/project/readiness with no terminal. This CLI
// stays available for the founder and does not persist anything by
// itself — pass --persist --project <uuid> to also write the verdict
// via recordReadinessEvaluation (matches what the API route does).
//
// Usage:
//   npx tsx scripts/onboarding-readiness.ts --venue <uuid>
//   npx tsx scripts/onboarding-readiness.ts --venue <uuid> --json
//   npx tsx scripts/onboarding-readiness.ts --venue <uuid> --persist --project <uuid>
//
// Exit codes:
//   0 — all invariants pass; smoke tests are advisory
//   1 — invariants violated (block Go Live)
//   2 — script error
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { evaluateReadiness } from '../src/lib/services/onboarding/readiness'
import { recordReadinessEvaluation } from '../src/lib/services/onboarding/project'

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
const persist = args.includes('--persist')
const projectIdx = args.indexOf('--project')
const projectId = projectIdx >= 0 ? args[projectIdx + 1] : null
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}
if (persist && !projectId) {
  console.error('--persist requires --project <uuid>')
  process.exit(2)
}

async function main() {
  if (!asJson) {
    console.log(`\n=== Onboarding readiness — venue ${venueId} ===\n`)
  }

  const report = await evaluateReadiness(sb, venueId!)

  if (persist && projectId) {
    await recordReadinessEvaluation(sb, projectId, {
      state: { invariants: report.invariants, smoke: report.smoke, evaluated_at: report.evaluatedAt },
      failures: report.invariants.filter((i) => i.count > 0),
      passed: report.readyForGoLive,
    })
  }

  if (asJson) {
    console.log(JSON.stringify({
      venueId,
      invariants_clean: report.invariantsClean,
      ready_for_go_live: report.readyForGoLive,
      invariants: report.invariants,
      smoke: report.smoke,
      persisted: persist,
    }, null, 2))
  } else {
    console.log('STRUCTURAL INVARIANTS (must all pass)')
    for (const i of report.invariants) {
      const status = i.count === 0 ? '✓' : '✗'
      console.log(`  ${status} ${i.count.toString().padStart(4)}  ${i.name}`)
    }
    console.log('\nSMOKE TESTS (advisory)')
    for (const s of report.smoke) {
      const sym = s.status === 'pass' ? '✓' : s.status === 'warn' ? '!' : '✗'
      console.log(`  ${sym}  ${s.name}`)
      console.log(`         ${s.message}`)
    }
    console.log()
    if (report.invariantsClean && report.smokeFails === 0 && report.smokeWarns === 0) {
      console.log('READY FOR GO LIVE — all invariants pass and all smoke tests are healthy.')
    } else if (report.invariantsClean && report.smokeFails === 0) {
      console.log(`READY FOR GO LIVE (with caveats) — invariants pass, but ${report.smokeWarns} smoke test${report.smokeWarns === 1 ? '' : 's'} flagged advisory warnings. Coordinator should review the messages above before activating.`)
    } else if (report.invariantsClean) {
      console.log(`READY FOR GO LIVE (invariants pass) but ${report.smokeFails} smoke test${report.smokeFails === 1 ? '' : 's'} indicate likely breakage. Investigate before Go Live even though the gate will accept it.`)
    } else {
      console.log('NOT READY — one or more invariants violated. Run scripts/onboard-data-cleanup.ts --apply to repair, then re-run this report.')
    }
    if (persist) {
      console.log(`\nPersisted to onboarding_projects.readiness_* for project ${projectId}.`)
    }
  }

  process.exit(report.invariantsClean ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(2) })
