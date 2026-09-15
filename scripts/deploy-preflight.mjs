#!/usr/bin/env node
/**
 * Deploy preflight. `npm run preflight`.
 *
 * Run this before every master fast-forward, i.e. before any of:
 *
 *   git checkout master && git merge --ff-only consolidation && git push
 *
 * See docs/DEPLOY.md for the full runbook this is step 1 of, and "Why
 * the preflight exists" in that file for the two production incidents
 * (isadoraandco, then bloom-house on 2026-09-14) this script is the
 * class fix for. Short version: `.vercel/project.json` silently pointed
 * at the wrong Vercel team, `vercel env ls` ran fine and told nobody, and
 * production was missing three required secrets plus a CRON_SECRET 12
 * characters under its own 32-character floor.
 *
 * This script is READ ONLY. It never writes an env value anywhere but a
 * temp file it deletes in a `finally`, never prints a secret value, and
 * never pushes or links on your behalf. A FAIL means go fix the thing
 * and rerun. It does not fix anything for you.
 *
 * Usage:
 *   npm run preflight
 *
 * Exit 0 if every check is PASS or WARN. Exit 1 if any check is FAIL.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deriveRequiredSecrets,
  evaluateVercelLink,
  parseEnvLsNames,
  parseEnvLineLength,
  parsePendingMigrationsDryRun,
} from './deploy-preflight/lib.mjs'

const REPO_ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/').replace(/\/scripts\/?$/, '')

// ---------------------------------------------------------------------------
// Constants, the "known good" shape of the deploy target. Changing any
// of these is a real decision (a new team, a new production host); it
// should not happen as a drive-by edit.
// ---------------------------------------------------------------------------

/** Vercel team slug that owns the bloom-house project in production. */
const EXPECTED_TEAM_SLUG = 'the-bloom-house'
/** Vercel project name for this repo. */
const EXPECTED_PROJECT_NAME = 'bloom-house'
/** The production host this project actually serves traffic on. */
const EXPECTED_PRODUCTION_HOST = 'bloom-house-iota.vercel.app'
/** The one-file bundle named in DONE WHEN 1d for migrations still owed to production. */
const PENDING_MIGRATIONS_BUNDLE = 'supabase/PENDING-MIGRATIONS-2026-09-14.sql'

const VERCEL_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Tiny reporting harness
// ---------------------------------------------------------------------------

/** @type {Array<{ id: string, status: 'PASS' | 'FAIL' | 'WARN', detail: string }>} */
const RESULTS = []

function report(id, status, detail) {
  RESULTS.push({ id, status, detail })
  const tag = status.padEnd(4)
  console.log(`[${tag}] ${id}. ${detail}`)
}

/** Quote an argument for cmd.exe when shell:true joins argv into one string. */
function winQuote(arg) {
  return /[\s"^&|<>]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/** Run a command, never throwing. Captures stdout/stderr as text. */
function run(cmd, args, opts = {}) {
  const useShell = process.platform === 'win32'
  const result = spawnSync(cmd, useShell ? args.map(winQuote) : args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? VERCEL_TIMEOUT_MS,
    shell: useShell,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  }
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// a. Git
// ---------------------------------------------------------------------------

function checkGit() {
  const fetch = run('git', ['fetch', 'origin', 'master', 'consolidation', '--quiet'])
  if (fetch.status !== 0) {
    report(
      'a0',
      'WARN',
      `\`git fetch origin master consolidation\` failed (${fetch.stderr.trim() || fetch.error?.message || 'no output'}); ` +
        'checking against whatever remote refs are already local.',
    )
  }

  const masterRef = run('git', ['rev-parse', '--verify', 'master'])
  const consolidationRef = run('git', ['rev-parse', '--verify', 'consolidation'])
  if (masterRef.status !== 0 || consolidationRef.status !== 0) {
    report('a1', 'FAIL', 'master or consolidation is not a valid local ref. Cannot check ancestry.')
  } else {
    const ancestor = run('git', ['merge-base', '--is-ancestor', 'master', 'consolidation'])
    if (ancestor.status === 0) {
      report('a1', 'PASS', 'master is an ancestor of consolidation (clean fast-forward is possible).')
    } else {
      report(
        'a1',
        'FAIL',
        'master is NOT an ancestor of consolidation. Either master has commits consolidation lacks, or the branches have diverged. A fast-forward would fail or lose history.',
      )
    }
  }

  const status = run('git', ['status', '--porcelain'])
  if (status.status === 0 && status.stdout.trim() === '') {
    report('a2', 'PASS', 'working tree is clean.')
  } else {
    const lines = status.stdout.trim().split(/\r?\n/).filter(Boolean)
    report('a2', 'FAIL', `working tree is dirty (${lines.length} changed path(s)). Commit or discard before deploying.`)
  }

  const localHead = run('git', ['rev-parse', 'consolidation'])
  const remoteHead = run('git', ['rev-parse', 'origin/consolidation'])
  if (localHead.status !== 0 || remoteHead.status !== 0) {
    report('a3', 'FAIL', 'could not resolve consolidation and/or origin/consolidation.')
  } else if (localHead.stdout.trim() === remoteHead.stdout.trim()) {
    report('a3', 'PASS', 'origin/consolidation matches local consolidation.')
  } else {
    report(
      'a3',
      'FAIL',
      `origin/consolidation (${remoteHead.stdout.trim().slice(0, 12)}) differs from local consolidation (${localHead.stdout.trim().slice(0, 12)}). Push or pull before deploying.`,
    )
  }
}

// ---------------------------------------------------------------------------
// b. Vercel link
// ---------------------------------------------------------------------------

/** @returns {{ orgId: string | null }} */
function checkVercelLink() {
  const projectJsonPath = join(REPO_ROOT, '.vercel', 'project.json')
  const projectJsonText = readOrNull(projectJsonPath)

  const whoami = run('vercel', ['whoami'])
  const whoamiOk = whoami.status === 0

  let orgId = null
  if (projectJsonText) {
    try {
      orgId = JSON.parse(projectJsonText).orgId ?? null
    } catch {
      orgId = null
    }
  }

  let projectLsStdout = null
  let projectLsError = null
  if (orgId) {
    const ls = run('vercel', ['project', 'ls', '--scope', orgId])
    if (ls.status === 0) {
      // The CLI's human-formatted table lands on stderr in some CLI
      // versions and stdout in others (observed: v50.23.2 puts it on
      // stderr with an empty stdout). Concatenate both rather than
      // guess which this install uses.
      projectLsStdout = `${ls.stdout}\n${ls.stderr}`
    } else {
      projectLsError = (ls.stderr.trim() || ls.error?.message || `exit ${ls.status}`).slice(0, 300)
    }
  }

  const evaluation = evaluateVercelLink({
    projectJsonText,
    projectLsStdout,
    projectLsError,
    whoamiOk,
    expectedTeamSlug: EXPECTED_TEAM_SLUG,
    expectedProjectName: EXPECTED_PROJECT_NAME,
    expectedProductionHost: EXPECTED_PRODUCTION_HOST,
  })

  evaluation.lines.forEach((line, i) => {
    report(`b${i + 1}`, line.pass ? 'PASS' : 'FAIL', line.detail)
  })

  return { orgId: evaluation.pass ? orgId : null }
}

// ---------------------------------------------------------------------------
// c. Secrets. Presence via `vercel env ls`, length via one `env pull`
//    to a temp file that is measured in memory and deleted in `finally`.
//    No value is ever printed or written anywhere else.
// ---------------------------------------------------------------------------

function checkSecrets(linkOk) {
  if (!linkOk) {
    report('c0', 'FAIL', 'skipping secret checks: check b (Vercel link) did not pass, so `vercel env` would read the wrong project.')
    return
  }

  let required
  try {
    required = deriveRequiredSecrets({
      cronAuthSrc: readFileSync(join(REPO_ROOT, 'src/lib/cron-auth.ts'), 'utf8'),
      stripeRouteSrc: readFileSync(join(REPO_ROOT, 'src/app/api/webhooks/stripe/route.ts'), 'utf8'),
      calendlyRouteSrc: readFileSync(join(REPO_ROOT, 'src/app/api/webhooks/calendly/route.ts'), 'utf8'),
      oauthStateSrc: readFileSync(join(REPO_ROOT, 'src/lib/services/integrations/oauth-state.ts'), 'utf8'),
      demoTokenSrc: readFileSync(join(REPO_ROOT, 'src/lib/services/demo-token.ts'), 'utf8'),
    })
  } catch (err) {
    report('c0', 'FAIL', `could not derive the required-secret list: ${err.message}`)
    return
  }

  const lsResult = run('vercel', ['env', 'ls', 'production'])
  if (lsResult.status !== 0) {
    report('c0', 'FAIL', `\`vercel env ls production\` failed: ${(lsResult.stderr.trim() || lsResult.error?.message || 'no output').slice(0, 300)}`)
    return
  }
  // Same stdout/stderr inconsistency as `project ls`. Concatenate both.
  const present = parseEnvLsNames(`${lsResult.stdout}\n${lsResult.stderr}`)

  const missing = required.filter((s) => !present.has(s.name))
  const needsLength = required.filter((s) => s.minLength !== null && present.has(s.name))

  // Presence, one line per required secret.
  required.forEach((s, i) => {
    if (present.has(s.name)) {
      report(`c1.${i + 1}`, 'PASS', `${s.name} is present in production (${s.reason}).`)
    } else {
      report(`c1.${i + 1}`, 'FAIL', `${s.name} is MISSING from production (${s.reason}).`)
    }
  })

  if (needsLength.length === 0) return

  // Length: pull production's values to a temp file, measure, delete.
  const tmpDir = mkdtempSync(join(tmpdir(), 'bloom-house-preflight-'))
  const tmpFile = join(tmpDir, 'production.env')
  let lengthsByKey = null
  let pullError = null
  try {
    const pull = run('vercel', ['env', 'pull', '--environment=production', tmpFile, '--yes'], { timeout: 60_000 })
    if (pull.status !== 0) {
      pullError = (pull.stderr.trim() || pull.error?.message || 'no output').slice(0, 300)
    } else {
      const text = readFileSync(tmpFile, 'utf8')
      lengthsByKey = new Map()
      for (const line of text.split(/\r?\n/)) {
        const parsed = parseEnvLineLength(line)
        if (parsed) lengthsByKey.set(parsed.key, parsed.length)
      }
    }
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      // already gone, or never created
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  if (!lengthsByKey) {
    report('c2', 'FAIL', `could not pull production values to check length: ${pullError}`)
    return
  }

  needsLength.forEach((s, i) => {
    const length = lengthsByKey.get(s.name)
    if (length === undefined) {
      report(`c2.${i + 1}`, 'FAIL', `${s.name} was listed as present but did not come back from \`vercel env pull\`. Check manually.`)
    } else if (length < s.minLength) {
      report(`c2.${i + 1}`, 'FAIL', `${s.name} is ${length} characters, below the required minimum of ${s.minLength}.`)
    } else {
      report(`c2.${i + 1}`, 'PASS', `${s.name} is ${length} characters (>= ${s.minLength} required).`)
    }
  })
}

// ---------------------------------------------------------------------------
// d. Database. Pending migrations dry run
// ---------------------------------------------------------------------------

function checkMigrations() {
  const result = run('npx', ['tsx', 'scripts/apply-pending-migrations.ts'], { timeout: 60_000 })
  if (result.status !== 0) {
    const reason = (result.stderr.trim() || result.stdout.trim() || result.error?.message || `exit ${result.status}`).slice(0, 400)
    report(
      'd1',
      'FAIL',
      `\`npx tsx scripts/apply-pending-migrations.ts\` (dry run) could not run: ${reason}`,
    )
    return
  }

  const { absentFiles, probedCount } = parsePendingMigrationsDryRun(result.stdout)
  if (absentFiles.length === 0) {
    report('d1', 'PASS', `migrations dry run: zero absent markers across ${probedCount} probed migration(s).`)
  } else {
    report(
      'd1',
      'WARN',
      `${absentFiles.length} migration marker(s) absent on production: ${absentFiles.join(', ')}. ` +
        `Apply with \`npm run migrate:pending -- --apply --allow-prod\`, or via the SQL editor bundle ${PENDING_MIGRATIONS_BUNDLE}.`,
    )
  }
}

// d2. Schema drift: every table and column the migrations declare is live.
// d1 probes a hand-kept list of recent migrations; this one derives the
// expectation from the whole migration tree, so a project whose history
// skipped an older migration (the E2E project was 17 tables behind while
// d1 was green) cannot pass by accident.
function checkSchemaDrift() {
  const result = run('npx', ['tsx', 'scripts/schema-drift.ts', '--json'], { timeout: 120_000 })
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  if (!parsed) {
    const reason = (result.stderr.trim() || result.stdout.trim() || result.error?.message || `exit ${result.status}`).slice(0, 400)
    report('d2', 'FAIL', `\`npx tsx scripts/schema-drift.ts\` could not run: ${reason}`)
    return
  }
  const missing = parsed.missingTables.length + parsed.missingColumns.length
  if (missing === 0) {
    report('d2', 'PASS', `schema drift: every migration-declared table and column is live on ${parsed.project}.`)
  } else {
    report(
      'd2',
      'FAIL',
      `${parsed.missingTables.length} table(s) and ${parsed.missingColumns.length} column(s) declared by migrations are absent on ${parsed.project}. ` +
        `Apply, in order: ${parsed.migrationsToApply.join(', ')} (\`npm run check:schema-drift\` for the detail).`,
    )
  }
}

// ---------------------------------------------------------------------------
// e. Types freshness (informational)
// ---------------------------------------------------------------------------

function checkTypesFresh() {
  const result = run('node', ['scripts/check-types-fresh.mjs'])
  if (result.status === 0) {
    report('e1', 'PASS', 'types.generated.ts is current with the newest migration.')
  } else {
    report(
      'e1',
      'WARN',
      'types.generated.ts is stale or could not be checked. Regenerate with `npx supabase gen types typescript --linked > src/lib/supabase/types.generated.ts`.',
    )
  }
}

// ---------------------------------------------------------------------------
// f. Governance gate
// ---------------------------------------------------------------------------

function checkGovernance() {
  const result = run('npm', ['run', 'check:governance'], { timeout: 300_000 })
  if (result.status === 0) {
    report('f1', 'PASS', '`npm run check:governance` passed on this head.')
  } else {
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-15).join('\n    ')
    report('f1', 'FAIL', `\`npm run check:governance\` failed. Last lines:\n    ${tail}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('Deploy preflight, bloom-house\n')

checkGit()
const { orgId } = checkVercelLink()
checkSecrets(Boolean(orgId))
checkMigrations()
checkSchemaDrift()
checkTypesFresh()
checkGovernance()

const fails = RESULTS.filter((r) => r.status === 'FAIL')
const warns = RESULTS.filter((r) => r.status === 'WARN')

console.log(
  `\n${RESULTS.length} checks: ${RESULTS.length - fails.length - warns.length} PASS, ${warns.length} WARN, ${fails.length} FAIL.`,
)

if (fails.length > 0) {
  console.log('\nFAIL. Do not fast-forward master. Fix the above and rerun `npm run preflight`.')
  process.exit(1)
}
console.log('\nAll clear (WARNs are informational). Safe to proceed with the master fast-forward.')
