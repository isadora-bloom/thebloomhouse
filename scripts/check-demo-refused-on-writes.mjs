// S1 security remediation (2026-09-14 audit, item 4). CI guard.
//
// The demo identity is a real logged-in-shaped principal. getPlatformAuth()
// hands back a coordinator for the Crestwood demo venue whenever the signed
// bloom_demo_token cookie verifies, with no Supabase user behind it. Every
// read path that respects venue scope is fine with that. Every WRITE path
// that does not think about it is not: an anonymous visitor who clicked
// "see the demo" gets a mutating call against whatever venue id the route
// decided to trust.
//
// So the rule this guard encodes is narrow and mechanical:
//
//   A route.ts under src/app/api/** that exports POST, PATCH, PUT or DELETE
//   and calls getPlatformAuth() must mention at least one of
//       isDemo            (auth.isDemo — a hand-rolled refusal or branch)
//       refuseDemo        (the shared helper in auth-helpers.ts)
//       isDemoVenueAllowed(the Crestwood allowlist check)
//       assertCanAccessVenue (which already refuses non-allowlisted venues
//                             on the demo path, so it counts)
//
// It does not try to judge whether the check is in the right place, or
// whether it covers every verb in the file. A static scan cannot. What it
// can do is make "nobody thought about demo here" impossible to merge,
// which is the failure this whole class came from.
//
// What this deliberately does NOT cover
// -------------------------------------
//   - Routes with no getPlatformAuth call: cron-authed jobs, webhooks with
//     their own signature check, public endpoints. Those have separate
//     gates and a demo cookie means nothing to them.
//   - GET handlers. A demo read of a Crestwood venue is the point of the
//     demo.
//   - Server Actions. Different surface, different audit item.
//
// There is no allowlist and there should not be one. If a mutating route
// genuinely wants demo callers through, it says so in code by calling
// refuseDemo and branching, or by routing the venue id through
// assertCanAccessVenue — either of which satisfies this guard honestly.
//
// Run:
//   node scripts/check-demo-refused-on-writes.mjs
//
// Wired into .github/workflows/ci.yml and `npm run check:governance`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const API_ROOT = 'src/app/api'

/** Any one of these, appearing anywhere in the file, satisfies the guard. */
const DEMO_MARKERS = [
  'isDemo',
  'refuseDemo',
  'isDemoVenueAllowed',
  'assertCanAccessVenue',
]

const MUTATING_VERBS = ['POST', 'PATCH', 'PUT', 'DELETE']

// ---------------------------------------------------------------------------
// Handoff list, not an allowlist.
//
// These ten routes fail the rule. They are the /api/intel/agencies/[id]
// cluster, which the same 2026-09-14 audit assigned to workstream S5
// because it has a deeper problem than a missing demo check: none of them
// verify that the agency id in the path belongs to the caller's venue at
// all. S5's fix routes every one of them through assertCanAccessVenue,
// which satisfies this guard as a side effect. Editing them here would
// have collided with that work for a line each.
//
// The list is a ratchet, not an exemption:
//   - nothing may be added to it. A new mutating route with no demo check
//     fails the build, full stop.
//   - an entry that no longer violates the rule FAILS the build, so the
//     list cannot outlive the work it is waiting on. When S5 lands, this
//     block goes with it.
// ---------------------------------------------------------------------------
const AWAITING_S5 = [
  'src/app/api/intel/agencies/[id]/route.ts',
  'src/app/api/intel/agencies/[id]/activity/route.ts',
  'src/app/api/intel/agencies/[id]/activity/[activityId]/route.ts',
  'src/app/api/intel/agencies/[id]/contacts/route.ts',
  'src/app/api/intel/agencies/[id]/contacts/[contactId]/route.ts',
  'src/app/api/intel/agencies/[id]/documents/route.ts',
  'src/app/api/intel/agencies/[id]/documents/[documentId]/route.ts',
  'src/app/api/intel/agencies/[id]/engagements/[engagementId]/route.ts',
  'src/app/api/intel/agencies/[id]/kpis/route.ts',
  'src/app/api/intel/agencies/[id]/kpis/[kpiId]/route.ts',
]

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
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) out.push(...walk(full))
    else if (name === 'route.ts' || name === 'route.tsx') out.push(full)
  }
  return out
}

/**
 * Strip line and block comments so a verb named only in a doc header,
 * or a marker mentioned in a "we deliberately skip this" note, cannot
 * satisfy or trip the guard. Crude but sufficient: route files do not
 * carry regex or string literals that look like comment openers often
 * enough to matter, and a false negative here costs a re-read, not a
 * bypass.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Exported mutating handlers, by name. */
function exportedMutatingVerbs(code) {
  const found = []
  for (const verb of MUTATING_VERBS) {
    const patterns = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`),
      new RegExp(`export\\s+const\\s+${verb}\\s*[:=]`),
      new RegExp(`export\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}`),
    ]
    if (patterns.some((re) => re.test(code))) found.push(verb)
  }
  return found
}

const violations = []
const files = walk(API_ROOT)

for (const file of files) {
  const normalised = file.replace(/\\/g, '/')
  const code = stripComments(readFileSync(file, 'utf8'))

  if (!/\bgetPlatformAuth\s*\(/.test(code)) continue

  const verbs = exportedMutatingVerbs(code)
  if (verbs.length === 0) continue

  if (DEMO_MARKERS.some((marker) => new RegExp(`\\b${marker}\\b`).test(code))) {
    continue
  }

  violations.push({ file: normalised, verbs })
}

// Split the handoff list out of the violations, and check it has not gone
// stale. A pending entry that now passes is work that landed — the line
// has to go, or the list starts meaning nothing.
const pending = new Set(AWAITING_S5)
const stillPending = violations.filter((v) => pending.has(v.file))
const remaining = violations.filter((v) => !pending.has(v.file))
const stale = AWAITING_S5.filter((p) => !violations.some((v) => v.file === p))

if (stale.length > 0) {
  console.log(
    `\n${stale.length} route(s) in the S5 handoff list no longer violate the rule:\n`,
  )
  for (const f of stale) console.log(`  ${f}`)
  console.log(
    '\nThe work landed. Delete these lines from AWAITING_S5 in this script,\nand delete the whole block once the list is empty.',
  )
  process.exit(1)
}

if (stillPending.length > 0) {
  console.log(
    `\n${stillPending.length} route(s) still awaiting the S5 agency-cluster fix (see AWAITING_S5):`,
  )
  for (const v of stillPending) console.log(`  ${v.file}   (${v.verbs.join(', ')})`)
}

violations.length = 0
violations.push(...remaining)

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} mutating route(s) with platform auth and no demo refusal:\n`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}   (${v.verbs.join(', ')})`)
  }
  console.log(`
Fix: import refuseDemo from '@/lib/api/auth-helpers' and return it early —

    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    const demo = refuseDemo(auth)
    if (demo) return demo

— or, when the route already takes a venue id from the caller, route that
id through assertCanAccessVenue, which refuses any venue outside the
Crestwood demo set on the demo path.

A demo session is an anonymous visitor. It may look at the demo venues. It
may not write.`)
  process.exit(1)
}

console.log(
  stillPending.length > 0
    ? `Demo refusal on writes: ${files.length} API routes scanned, ${stillPending.length} awaiting S5 (listed above), everything else accounts for the demo identity.`
    : `Demo refusal on writes: ${files.length} API routes scanned, every mutating platform-auth route accounts for the demo identity.`,
)
