/**
 * Pure logic for scripts/deploy-preflight.mjs.
 *
 * Everything here takes strings or plain objects in and returns plain
 * objects out. No filesystem, no child_process, no network, no secret
 * values. That is what makes it unit-testable without a Vercel session
 * or a real production database, and it is also the part of the
 * preflight most likely to silently drift from the code it is meant to
 * be checking, so it earns the test coverage.
 *
 * Two incidents this file is the fix for:
 *
 *   1. isadoraandco: `.vercel/project.json` pointed at the wrong Vercel
 *      team. Every `vercel` command still ran and returned 0, just
 *      against the wrong project, so nothing looked broken until a
 *      production request did.
 *   2. bloom-house (2026-09-14): the same link drift, plus the drift it
 *      hid. Three required production secrets were absent, and
 *      CRON_SECRET was 12 characters shorter than src/lib/cron-auth.ts's
 *      own floor.
 *
 * See docs/DEPLOY.md, "Why the preflight exists", for the full account.
 */

// ---------------------------------------------------------------------------
// Required-secret derivation
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, minLength: number | null, reason: string }} RequiredSecret
 */

/**
 * Secrets with no length floor enforced anywhere in the code. Presence
 * in `vercel env ls production` is the only thing that can be checked.
 */
const FIXED_PRESENCE_ONLY = [
  { name: 'SUPABASE_SERVICE_ROLE_KEY', reason: 'Supabase service-role client (every server-side write)' },
  { name: 'NEXT_PUBLIC_SUPABASE_URL', reason: 'Supabase client base URL (browser and server)' },
  { name: 'ANTHROPIC_API_KEY', reason: 'Claude API, the whole Agent/Intel/Sage pipeline' },
  { name: 'RESEND_API_KEY', reason: 'outbound transactional + Sage email delivery' },
]

function fail(where, what) {
  throw new Error(
    `deploy-preflight: could not find ${what} in ${where}. The source this ` +
      'derivation reads has changed shape. Update scripts/deploy-preflight/lib.mjs ' +
      'to match, do not hand-list the secret instead.',
  )
}

/**
 * Derive the list of secrets production must carry, and the minimum
 * length required for the ones the code itself enforces a floor on, by
 * reading the source of the modules that enforce them. Never a hand
 * list: if a module's env var name or length rule changes, this throws
 * rather than silently checking the old name.
 *
 * @param {{
 *   cronAuthSrc: string,
 *   stripeRouteSrc: string,
 *   calendlyRouteSrc: string,
 *   oauthStateSrc: string,
 *   demoTokenSrc: string,
 * }} sources
 * @returns {RequiredSecret[]}
 */
export function deriveRequiredSecrets(sources) {
  const { cronAuthSrc, stripeRouteSrc, calendlyRouteSrc, oauthStateSrc, demoTokenSrc } = sources
  const out = []

  // --- src/lib/cron-auth.ts ---
  // Base secret: name (not followed by another underscore-joined
  // segment, so this does not also match CRON_SECRET_DESTRUCTIVE) plus
  // its production floor, MIN_SECRET_LENGTH.
  if (!/process\.env\.CRON_SECRET\b(?!_)/.test(cronAuthSrc)) {
    fail('src/lib/cron-auth.ts', 'a `process.env.CRON_SECRET` read')
  }
  const minLenMatch = cronAuthSrc.match(/MIN_SECRET_LENGTH\s*=\s*(\d+)/)
  if (!minLenMatch) fail('src/lib/cron-auth.ts', 'the `MIN_SECRET_LENGTH = <n>` constant')
  out.push({
    name: 'CRON_SECRET',
    minLength: Number(minLenMatch[1]),
    reason: 'every cron route and admin ops route (src/lib/cron-auth.ts)',
  })

  // Destructive tier: whatever CRON_SECRET_<SOMETHING> the file reads
  // besides the base secret. Presence-only: the code refuses an unset
  // value in production but does not enforce a length floor on it.
  const destructiveMatch = cronAuthSrc.match(/process\.env\.(CRON_SECRET_[A-Z0-9_]+)/)
  if (!destructiveMatch) fail('src/lib/cron-auth.ts', 'the destructive-tier `process.env.CRON_SECRET_*` read')
  out.push({
    name: destructiveMatch[1],
    minLength: null,
    reason: 'destructive cron jobs (DESTRUCTIVE_JOBS) refuse outright in production when unset (src/lib/cron-auth.ts)',
  })

  // --- src/app/api/webhooks/stripe/route.ts ---
  const stripeMatch = stripeRouteSrc.match(/process\.env\.(STRIPE_WEBHOOK_SECRET)/)
  if (!stripeMatch) fail('src/app/api/webhooks/stripe/route.ts', 'a `process.env.STRIPE_WEBHOOK_SECRET` read')
  out.push({
    name: stripeMatch[1],
    minLength: null,
    reason: 'Stripe webhook signature verification; unset answers 503 before parsing the body',
  })

  // --- src/app/api/webhooks/calendly/route.ts ---
  const calendlyMatch = calendlyRouteSrc.match(/process\.env\.(CALENDLY_WEBHOOK_SECRET)/)
  if (!calendlyMatch) fail('src/app/api/webhooks/calendly/route.ts', 'a `process.env.CALENDLY_WEBHOOK_SECRET` read')
  out.push({
    name: calendlyMatch[1],
    minLength: null,
    reason: 'Calendly webhook signature verification; unset answers 503 before parsing the body',
  })

  // --- src/lib/services/integrations/oauth-state.ts ---
  const stateMatch = oauthStateSrc.match(/process\.env\.(STATE_SIGNING_SECRET)/)
  if (!stateMatch) fail('src/lib/services/integrations/oauth-state.ts', 'a `process.env.STATE_SIGNING_SECRET` read')
  const stateLenMatch = oauthStateSrc.match(/secret\.length\s*<\s*(\d+)/)
  if (!stateLenMatch) fail('src/lib/services/integrations/oauth-state.ts', 'the `secret.length < <n>` floor')
  out.push({
    name: stateMatch[1],
    minLength: Number(stateLenMatch[1]),
    reason: 'OAuth callback state signing (throws rather than falling back, since a guessable key is worse than none)',
  })

  // --- src/lib/services/demo-token.ts ---
  const demoMatch = demoTokenSrc.match(/process\.env\.(DEMO_SIGNING_SECRET)/)
  if (!demoMatch) fail('src/lib/services/demo-token.ts', 'a `process.env.DEMO_SIGNING_SECRET` read')
  const demoLenMatch = demoTokenSrc.match(/secret\.length\s*<\s*(\d+)/)
  if (!demoLenMatch) fail('src/lib/services/demo-token.ts', 'the `secret.length < <n>` floor')
  out.push({
    name: demoMatch[1],
    minLength: Number(demoLenMatch[1]),
    reason: 'demo-mode signed tokens (no NODE_ENV backdoor by design)',
  })

  for (const fixed of FIXED_PRESENCE_ONLY) {
    out.push({ name: fixed.name, minLength: null, reason: fixed.reason })
  }

  return out
}

// ---------------------------------------------------------------------------
// `vercel project ls --scope <x>` table parsing
// ---------------------------------------------------------------------------

/**
 * Parse the table `vercel project ls` prints on stdout into rows. The
 * columns are whitespace-padded, not delimited, so rows are split on
 * runs of 2+ spaces rather than a fixed offset (the CLI's own column
 * widths shift with the longest value in each project list).
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, productionUrl: string | null }>}
 */
export function parseProjectLsTable(stdout) {
  const lines = stdout.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => /Project Name/.test(l))
  if (headerIdx === -1) return []
  const rows = []
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue
    const cells = line.trim().split(/ {2,}/)
    if (cells.length < 2) continue
    const [name, productionUrl] = cells
    rows.push({ name, productionUrl: productionUrl === '--' ? null : productionUrl })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Link-team comparison (pure)
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   projectJsonText: string | null,
 *   projectLsStdout: string | null,
 *   projectLsError: string | null,
 *   whoamiOk: boolean,
 *   expectedTeamSlug: string,
 *   expectedProjectName: string,
 *   expectedProductionHost: string,
 * }} input
 * @returns {{ pass: boolean, lines: Array<{ pass: boolean, detail: string }> }}
 */
export function evaluateVercelLink(input) {
  const {
    projectJsonText,
    projectLsStdout,
    projectLsError,
    whoamiOk,
    expectedTeamSlug,
    expectedProjectName,
    expectedProductionHost,
  } = input
  const lines = []

  if (!projectJsonText) {
    lines.push({
      pass: false,
      detail: '.vercel/project.json does not exist. Run `vercel link --scope ' +
        `${expectedTeamSlug} --project ${expectedProjectName}\` before deploying.`,
    })
    return { pass: false, lines }
  }

  let parsed
  try {
    parsed = JSON.parse(projectJsonText)
  } catch {
    lines.push({ pass: false, detail: '.vercel/project.json is not valid JSON.' })
    return { pass: false, lines }
  }

  const { orgId, projectId, projectName } = parsed
  if (!orgId || !projectId) {
    lines.push({ pass: false, detail: '.vercel/project.json is missing orgId or projectId.' })
    return { pass: false, lines }
  }

  if (projectName !== expectedProjectName) {
    lines.push({
      pass: false,
      detail: `.vercel/project.json projectName is "${projectName}", expected "${expectedProjectName}".`,
    })
  } else {
    lines.push({ pass: true, detail: `.vercel/project.json projectName is "${expectedProjectName}".` })
  }

  // The load-bearing check: ask Vercel what "orgId" actually resolves
  // to by listing that scope's projects (`vercel project ls --scope
  // <orgId>`, since the CLI accepts the raw id as a scope, not only the
  // slug), and confirm the expected project is in there fronting the
  // known production host. If the local orgId is a different team,
  // either the expected project is absent from that team's list, or it
  // is present but pointing at a different (or no) production URL. That
  // is exactly the isadoraandco / bloom-house failure mode, where the
  // link still "worked" and just talked to the wrong thing.
  if (projectLsError) {
    lines.push({
      pass: false,
      detail: `\`vercel project ls --scope <orgId>\` failed: ${projectLsError}`,
    })
  } else {
    const rows = parseProjectLsTable(projectLsStdout ?? '')
    const row = rows.find((r) => r.name === expectedProjectName)
    const expectedUrl = `https://${expectedProductionHost}`
    if (!row) {
      lines.push({
        pass: false,
        detail:
          `orgId ${orgId} does not host a project named "${expectedProjectName}", ` +
          `so this link is not the "${expectedTeamSlug}" team.`,
      })
    } else if (row.productionUrl !== expectedUrl) {
      lines.push({
        pass: false,
        detail:
          `orgId ${orgId}'s "${expectedProjectName}" project's production URL is ` +
          `${row.productionUrl ?? '(none)'}, expected ${expectedUrl}.`,
      })
    } else {
      lines.push({
        pass: true,
        detail: `orgId ${orgId} hosts "${expectedProjectName}" at ${expectedUrl}, matching the "${expectedTeamSlug}" team.`,
      })
    }
  }

  if (!whoamiOk) {
    lines.push({ pass: false, detail: '`vercel whoami` did not succeed. Not logged in, or the session expired.' })
  } else {
    lines.push({ pass: true, detail: '`vercel whoami` succeeded.' })
  }

  return { pass: lines.every((l) => l.pass), lines }
}

// ---------------------------------------------------------------------------
// `vercel env ls production` name parsing (presence only, never a value)
// ---------------------------------------------------------------------------

/**
 * @param {string} stdout
 * @returns {Set<string>}
 */
export function parseEnvLsNames(stdout) {
  const lines = stdout.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => /^\s*name\s+value\s+environments/i.test(l))
  const names = new Set()
  if (headerIdx === -1) return names
  for (const line of lines.slice(headerIdx + 1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([A-Za-z0-9_]+)\s+/)
    if (m) names.add(m[1])
  }
  return names
}

// ---------------------------------------------------------------------------
// `.env` pulled file: length only. The value is read into memory and
// never logged or returned.
// ---------------------------------------------------------------------------

/**
 * Parse one line of a Vercel-pulled `.env` file into a key and the
 * *length* of its value. The value itself never leaves this function.
 *
 * Handles both quoted (`KEY="value"`) and bare (`KEY=value`) forms.
 * `vercel env pull` quotes values that need it and leaves simple ones
 * bare.
 *
 * @param {string} line
 * @returns {{ key: string, length: number } | null}
 */
export function parseEnvLineLength(line) {
  if (!line || line.startsWith('#')) return null
  const eq = line.indexOf('=')
  if (eq === -1) return null
  const key = line.slice(0, eq)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = line.slice(eq + 1)
  if (value.endsWith('\r')) value = value.slice(0, -1)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return { key, length: value.length }
}

// ---------------------------------------------------------------------------
// `apply-pending-migrations.ts` dry-run parsing
// ---------------------------------------------------------------------------

/**
 * Parse the "Before:" table `apply-pending-migrations.ts` prints in dry
 * run mode. Each row ends `marker: <present|absent|not probeable>`.
 * Only "absent" is actionable. "not probeable" means the migration has
 * no marker query (comment-only DDL, say), not that it is missing.
 *
 * @param {string} stdout
 * @returns {{ absentFiles: string[], probedCount: number }}
 */
export function parsePendingMigrationsDryRun(stdout) {
  const absentFiles = []
  let probedCount = 0
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+\.sql)\s+\d+\s+stmts\s+marker:\s*(present|absent|not probeable)/)
    if (!m) continue
    const [, file, marker] = m
    if (marker === 'not probeable') continue
    probedCount++
    if (marker === 'absent') absentFiles.push(file)
  }
  return { absentFiles, probedCount }
}
