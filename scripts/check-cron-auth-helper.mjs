#!/usr/bin/env node
/**
 * Guard: no inline CRON_SECRET comparison under src/app/api/**.
 *
 * The bug class, from the 2026-09-14 security audit (S2). Ninety-two
 * route files carried some variant of:
 *
 *   const cronAuth =
 *     req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
 *
 * Three things wrong with it:
 *
 *   1. With CRON_SECRET unset the right-hand side is the literal string
 *      `Bearer undefined`. Any caller who sends that header is admitted.
 *      One missing env var on one deploy opens ninety routes at once.
 *   2. `===` on a secret is a timing oracle. Small, but free to avoid.
 *   3. The comparison is inline, so the two-tier destructive gate in
 *      src/lib/cron-auth.ts never applies to it and a policy change has
 *      to be made ninety-two times.
 *
 * `verifyCronAuth` fixes all three in one place: it fails closed on an
 * unset or too-short secret, compares with crypto.timingSafeEqual, and
 * owns the destructive tier.
 *
 * Usage:
 *
 *   node scripts/check-cron-auth-helper.mjs
 *
 * Exit 0 = clean. Exit 1 = an inline comparison is back.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const API_DIR = join(REPO_ROOT, 'src', 'app', 'api')

/**
 * Any read of process.env.CRON_SECRET inside a comparison, a template
 * literal or a local binding in a route file. The helper is the only
 * place allowed to touch the variable, and the helper does not live
 * under src/app/api.
 *
 * Deliberately broad: `Bearer ${process.env.CRON_SECRET}` is the shape
 * that existed, but `const s = process.env.CRON_SECRET; if (h === s)`
 * is the same bug with more steps.
 */
const PATTERN = /process\.env\.CRON_SECRET\b/

/** Matches a line that only mentions the variable in prose. */
const COMMENT = /^\s*(\/\/|\*|\/\*)/

const OFFENDERS = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      walk(full)
    } else if (st.isFile() && /\.(ts|tsx)$/.test(entry)) {
      scan(full)
    }
  }
}

function scan(file) {
  const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (COMMENT.test(line)) return
    if (!PATTERN.test(line)) return
    OFFENDERS.push({ file: rel, line: i + 1, text: line.trim() })
  })
}

walk(API_DIR)

if (OFFENDERS.length === 0) {
  console.log('OK — no inline CRON_SECRET comparison under src/app/api.')
  process.exit(0)
}

console.error('\nFAIL — src/app/api reads process.env.CRON_SECRET directly:\n')
for (const o of OFFENDERS) {
  console.error(`  ${o.file}:${o.line}`)
  console.error(`    ${o.text}`)
}
console.error(
  '\nUse `verifyCronAuth` from `@/lib/cron-auth` instead:\n' +
    "  const cronAuth = verifyCronAuth(req).ok\n" +
    'or, when the route should answer with the reason:\n' +
    "  const result = verifyCronAuth(req, { alwaysDestructive: true })\n" +
    '  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })\n',
)
console.error(
  'It fails closed on an unset or short secret, compares in constant time,\n' +
    'and applies the CRON_SECRET_DESTRUCTIVE tier. An inline comparison does none of that.\n',
)
process.exit(1)
