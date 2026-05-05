// Fail CI if any API route under a paid-tier directory ships without
// server-side plan_tier enforcement (PROJECT-AUDIT-V2 GAP-12 closure).
//
// Why this matters:
//   The UI gates Intelligence + Enterprise features via UpgradeGate.
//   Without API-layer enforcement, a starter-tier coordinator can hit
//   `curl /api/intel/nlq` and get tier-2 narrations they didn't pay
//   for. This script asserts every paid-tier route file imports AND
//   calls `requirePlan` so a new file landing in `/api/intel/*` (etc.)
//   without the guard fails CI rather than reaching production.
//
// What this script does:
//   For each route.ts under SCAN_DIRS, assert:
//     1. The file imports `requirePlan` from '@/lib/auth/require-plan'
//     2. The file calls `requirePlan(` somewhere inside an exported
//        HTTP handler (GET / POST / PUT / PATCH / DELETE).
//   Skips OPTIONS / HEAD handlers (CORS preflight, no body).
//
// What this script ALLOWS:
//   - Routes in EXPLICIT_ALLOWLIST (e.g. cron-only endpoints that
//     authenticate via a service-role secret instead of user auth).
//
// Run:
//   node scripts/check-plan-enforcement.mjs
//
// Wired into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Every route under these dirs must enforce a plan_tier minimum.
// The required tier is encoded in the call itself; this script only
// asserts that SOME requirePlan() call exists. The tier value
// (intelligence / enterprise) is enforced by code review.
const SCAN_DIRS = [
  'src/app/api/intel',
  'src/app/api/insights',
  'src/app/api/pulse',
  // Sage couple-portal chat — feature lives at intelligence tier
  // (see TIER_FEATURES['intelligence'] in src/lib/auth/plan-tiers.ts).
  'src/app/api/portal/sage',
]

// Routes whose paid-tier-ness is intentionally enforced elsewhere.
// Each entry MUST carry a justification comment so reviewers can
// audit the bypass list and reject anything fishy.
const EXPLICIT_ALLOWLIST = new Set([
  // No entries today. If a route legitimately bypasses requirePlan
  // (e.g. a cron-driven endpoint that authenticates via
  // CRON_SECRET / service-role header), add it here with a comment
  // explaining WHY user-tier enforcement doesn't apply.
])

// HTTP method exports we treat as user-facing handlers. OPTIONS and
// HEAD are CORS / health checks and don't need a tier guard.
const HANDLER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// Match `export async function METHOD(` or `export function METHOD(`.
function findHandlers(fileText) {
  const handlers = []
  for (const method of HANDLER_METHODS) {
    const re = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${method}\\b`, 'g')
    if (re.test(fileText)) handlers.push(method)
  }
  return handlers
}

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name === 'route.ts' || name === 'route.tsx') out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const normalized = file.replace(/\\/g, '/')
  if (EXPLICIT_ALLOWLIST.has(normalized)) continue

  const fileText = readFileSync(file, 'utf8')
  const handlers = findHandlers(fileText)

  // No handler = nothing to gate. Defensive — Next.js wouldn't even
  // route to such a file, but it's safe to skip.
  if (handlers.length === 0) continue

  const importsRequirePlan = /from\s+['"]@\/lib\/auth\/require-plan['"]/.test(fileText)
  const callsRequirePlan = /\brequirePlan\s*\(/.test(fileText)

  if (!importsRequirePlan || !callsRequirePlan) {
    violations.push({
      file: normalized,
      handlers,
      hasImport: importsRequirePlan,
      hasCall: callsRequirePlan,
    })
  }
}

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} paid-tier API route(s) missing requirePlan enforcement:\n`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}`)
    console.log(`    handlers: ${v.handlers.join(', ')}`)
    console.log(`    importsRequirePlan: ${v.hasImport}`)
    console.log(`    callsRequirePlan:   ${v.hasCall}`)
  }
  console.log('\nFix: add the guard at the top of every handler, BEFORE any DB reads.')
  console.log("  import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'")
  console.log('  const plan = await requirePlan(request, \'intelligence\')')
  console.log('  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })')
  console.log('\nWhy: PROJECT-AUDIT-V2 GAP-12. UI gating via UpgradeGate is bypassable')
  console.log('with a scripted fetch — server-side enforcement is the revenue protection.')
  console.log('Demo cookie path is handled INSIDE requirePlan; do not add a manual bypass.')
  process.exit(1)
}

console.log(
  `Plan-tier enforcement OK — every route under ${SCAN_DIRS.join(', ')} ` +
    `imports + calls requirePlan (${files.length} files scanned).`,
)
