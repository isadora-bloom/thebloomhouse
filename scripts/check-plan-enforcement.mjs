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
//     2. The file calls `requirePlan(...)` in the AST (not in a comment)
//        AND the call result is assigned to a variable (not discarded).
//   Skips OPTIONS / HEAD handlers (CORS preflight, no body).
//
// What changed vs the old regex version (Wave B Fix 1):
//   - Uses @typescript-eslint/parser AST walk instead of regex.
//   - Commented-out calls are invisible to the AST; they no longer
//     produce false-passing results.
//   - Asserts the call result is assigned, not silently discarded.
//   - SCAN_DIRS are walked dynamically — new routes are auto-covered
//     without editing this file.
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
import { parse } from '@typescript-eslint/parser'

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
const HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

// ---------------------------------------------------------------------------
// File discovery — recursive walk returning route.ts / route.tsx paths.
// Dynamic so new routes are covered automatically without editing this file.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

// Generic pre-order AST walk. Calls cb(node) for every non-null AST node.
function walkAST(node, cb) {
  if (!node || typeof node !== 'object') return
  cb(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue // avoid cycles if parent refs are set
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) walkAST(item, cb)
      }
    } else if (child && typeof child === 'object' && child.type) {
      walkAST(child, cb)
    }
  }
}

// Returns true if the file's AST contains an exported HTTP handler
// (export async function GET / POST / etc.).
function hasExportedHandler(ast) {
  let found = false
  walkAST(ast, (node) => {
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration &&
      node.declaration.type === 'FunctionDeclaration' &&
      node.declaration.id &&
      HANDLER_METHODS.has(node.declaration.id.name)
    ) {
      found = true
    }
  })
  return found
}

// Returns true if the file imports `requirePlan` from the canonical path.
function hasRequirePlanImport(ast) {
  let found = false
  walkAST(ast, (node) => {
    if (
      node.type === 'ImportDeclaration' &&
      typeof node.source.value === 'string' &&
      node.source.value === '@/lib/auth/require-plan'
    ) {
      const specifiers = node.specifiers || []
      if (
        specifiers.some(
          (s) =>
            s.type === 'ImportSpecifier' &&
            s.imported &&
            s.imported.name === 'requirePlan',
        )
      ) {
        found = true
      }
    }
  })
  return found
}

// Returns true if the file contains a requirePlan(...) CallExpression
// in the AST where the call result is assigned to a variable.
//
// Accepted patterns:
//   const plan        = await requirePlan(...)
//   const { ok }      = await requirePlan(...)
//   const plan        = requirePlan(...)          (sync — unlikely but valid)
//   const { ok }      = requirePlan(...)
//
// This is intentionally strict about assignment: a bare `await requirePlan(...)`
// with no assignment would be caught as a violation.
function hasAssignedRequirePlanCall(ast) {
  let found = false

  walkAST(ast, (node) => {
    if (node.type !== 'VariableDeclaration') return

    for (const decl of node.declarations) {
      if (!decl.init) continue

      // Unwrap optional AwaitExpression: `await requirePlan(...)` -> CallExpression
      const init =
        decl.init.type === 'AwaitExpression' ? decl.init.argument : decl.init

      if (
        init &&
        init.type === 'CallExpression' &&
        init.callee &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'requirePlan'
      ) {
        found = true
      }
    }
  })

  return found
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []
let passCount = 0

for (const file of files) {
  const normalized = file.replace(/\\/g, '/')
  if (EXPLICIT_ALLOWLIST.has(normalized)) {
    console.log(`SKIP: ${normalized} (explicit allowlist)`)
    continue
  }

  const fileText = readFileSync(file, 'utf8')

  // Parse with TypeScript support. Errors in individual files are surfaced
  // as violations rather than crashing the whole run.
  let ast
  try {
    ast = parse(fileText, {
      jsx: true, // support .tsx route files
      range: false,
      loc: false,
      tokens: false,
      comment: false, // we do NOT want comment nodes — that's the point
    })
  } catch (err) {
    violations.push({
      file: normalized,
      reason: `parse error: ${err.message}`,
      hasImport: false,
      hasCall: false,
    })
    console.log(`FAIL (parse error): ${normalized}`)
    continue
  }

  // No exported HTTP handler — nothing to gate.
  if (!hasExportedHandler(ast)) continue

  const hasImport = hasRequirePlanImport(ast)
  const hasCall = hasAssignedRequirePlanCall(ast)

  if (hasImport && hasCall) {
    console.log(`PASS: ${normalized}`)
    passCount++
  } else {
    violations.push({
      file: normalized,
      reason: !hasImport
        ? 'missing import of requirePlan from @/lib/auth/require-plan'
        : 'requirePlan called but result not assigned to a variable (or call missing entirely)',
      hasImport,
      hasCall,
    })
    console.log(`FAIL: ${normalized}`)
    console.log(`  reason: ${!hasImport ? 'no import' : 'call not assigned'}`)
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} paid-tier API route(s) missing requirePlan enforcement:\n`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}`)
    console.log(`    reason:      ${v.reason}`)
    console.log(`    hasImport:   ${v.hasImport}`)
    console.log(`    hasCall:     ${v.hasCall}`)
  }
  console.log('\nFix: add the guard at the top of every handler, BEFORE any DB reads.')
  console.log("  import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'")
  console.log("  const plan = await requirePlan(request, 'intelligence')")
  console.log('  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })')
  console.log('\nWhy: PROJECT-AUDIT-V2 GAP-12. UI gating via UpgradeGate is bypassable')
  console.log('with a scripted fetch — server-side enforcement is the revenue protection.')
  console.log('Demo cookie path is handled INSIDE requirePlan; do not add a manual bypass.')
  process.exit(1)
}

console.log(
  `\nPlan-tier enforcement OK — ${passCount} route(s) under [${SCAN_DIRS.join(', ')}] ` +
    `each import + call requirePlan with assigned result. ` +
    `(${files.length} files scanned, AST-based check, comment bypass closed)`,
)
