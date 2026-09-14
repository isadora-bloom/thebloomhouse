// Fail CI if a T3 insight service catches an `err` and logs its raw
// `.message` (or the err itself) without going through redactError /
// redact from `@/lib/observability/redact`.
//
// Why this matters (T5-α.3 / engineer.md CRITICAL #4):
//   The T3 generators thread couple PII through Claude prompts —
//   names, emails, interaction body fragments, sage_context_notes.
//   When Anthropic returns a 4xx (e.g. input length exceeded), the
//   error message echoes the prompt content. A naive
//   `console.warn('[X] failed:', err.message)` lands the PII in
//   Vercel logs verbatim. OPS-21.3.3 says tier-1 content NEVER
//   appears in logs.
//
// The fix: every T3 catch must call `redactError(err)` (for caught
// values) or `redact(text)` (for already-extracted strings).
//
// W67 (2026-09-14 verification): the 2026-09-14 pass found the exact same
// mistake outside T3 — API route handlers logging the raw `err` object to
// console AND echoing `err.message` / `error.message` straight into the
// JSON body sent back to the client (a Postgres/Supabase/Anthropic error
// message reaching a browser). Widened scope to `src/app/api/**` and added
// a second rule for the response-body leak. Both fixes route through
// `apiError()` (src/lib/api/api-error.ts), which logs via redactError and
// returns a generic message + correlation id instead.
//
// What this script flags:
//   - `console.(warn|error|log)` lines that mention `err.message` or the
//     bare `err`/`error` identifier as an argument, EXCEPT when the same
//     line also calls redactError (checked in both scan dirs).
//   - `NextResponse.json(...)` calls whose body includes `err.message` or
//     `error.message` (api routes only) — the response-body leak.
//
// What this script ALLOWS:
//   - `console.warn('[x] something:', redactError(err))`
//   - `console.error('[x] db:', redact(error.message))`
//   - `return apiError(err)` / `return apiError(error, undefined, 422)`
//   - Comments mentioning err.message (lines starting with //, /*, *)
//
// Run:
//   node scripts/check-no-raw-err-logs-in-t3.mjs
//
// Wired into .github/workflows/ci.yml.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIRS = ['src/lib/services/insights', 'src/app/api']

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
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []
const responseLeaks = []

// Match `console.warn(...)` / `console.error(...)` / `console.log(...)`
// lines. We look at lines that ALSO contain a raw err reference
// (`err.message`, `error.message`, or the bare `err` identifier as
// part of a ternary / argument list).
const CONSOLE_PATTERN = /\bconsole\.(warn|error|log)\b/

// "bare err" patterns that DO NOT go through redactError. The
// shape we want to catch is exactly what the audit flagged:
//   `err instanceof Error ? err.message : err`
//   `err.message`
//   `error.message`
//   trailing argument `, err)` or `, error)` (rare but possible)
const RAW_ERR_PATTERN = /(?:\berr\.message\b|\berror\.message\b|err instanceof Error \? err\.message : err|err instanceof Error \? error\.message : error|,\s*err\s*\)|,\s*error\s*\))/

const REDACT_PATTERN = /\bredact(?:Error|Object)?\s*\(/

// Response-body leak: a `NextResponse.json(...)` call whose argument
// includes a raw `err.message` / `error.message` reference. The call can
// span multiple lines (`{\n  error: error.message,\n}, { status: 500 })`),
// so this walks forward from the `NextResponse.json(` line tracking paren
// depth instead of matching on one line.
const NEXT_RESPONSE_JSON_OPEN = /NextResponse\.json\s*\(/
const RAW_MESSAGE_REF = /\b(?:err|error)\.message\b/
const API_ERROR_CALL = /\bapiError\s*\(/

for (const file of files) {
  const fileText = readFileSync(file, 'utf8')
  const lines = fileText.split(/\r?\n/)
  const isApiRoute = file.replace(/\\/g, '/').includes('src/app/api/')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip pure comment lines.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue

    if (CONSOLE_PATTERN.test(line) && RAW_ERR_PATTERN.test(line) && !REDACT_PATTERN.test(line)) {
      violations.push({
        file: file.replace(/\\/g, '/'),
        line: i + 1,
        text: line.trim(),
      })
    }

    // Response-body leak rule — api routes only.
    if (isApiRoute && NEXT_RESPONSE_JSON_OPEN.test(line) && !API_ERROR_CALL.test(line)) {
      // Walk forward, tracking paren depth from the `(` that opens the
      // NextResponse.json(...) call, up to a generous cap so an
      // unrelated later call in the same file can't be swept in.
      const startIdx = line.search(NEXT_RESPONSE_JSON_OPEN)
      let depth = 0
      let started = false
      let sawMessage = false
      let sawApiError = false
      outer: for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        const scanLine = j === i ? line.slice(startIdx) : lines[j]
        // Check for the leak / the opt-out BEFORE the paren-depth walk
        // below can `break outer` — a call that opens and closes on the
        // SAME line (the common single-line shape) would otherwise hit
        // depth 0 mid-line and exit before this line's own content was
        // ever inspected.
        if (RAW_MESSAGE_REF.test(scanLine)) sawMessage = true
        if (API_ERROR_CALL.test(scanLine)) sawApiError = true
        for (const ch of scanLine) {
          if (ch === '(') {
            depth++
            started = true
          } else if (ch === ')') {
            depth--
            if (started && depth === 0) break outer
          }
        }
      }
      if (sawMessage && !sawApiError) {
        responseLeaks.push({
          file: file.replace(/\\/g, '/'),
          line: i + 1,
          text: line.trim(),
        })
      }
    }
  }
}

if (violations.length > 0) {
  console.log(`\nFound ${violations.length} raw err log(s):\n`)
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 140)}`)
  }
  console.log('\nWrap with redactError(err) (or redact(error.message) for extracted strings):')
  console.log("  import { redactError } from '@/lib/observability/redact'")
  console.log("  console.warn('[X] failed:', redactError(err))")
  console.log('\nOr, in an API route, replace the whole catch/response with apiError(err):')
  console.log("  import { apiError } from '@/lib/api/api-error'")
  console.log('  return apiError(err)')
  console.log('\nWhy: T3 prompts contain couple PII; API routes surface Postgres/Anthropic error text. OPS-21.3.3.')
}

if (responseLeaks.length > 0) {
  console.log(`\nFound ${responseLeaks.length} err.message/error.message leak(s) in a NextResponse.json body:\n`)
  for (const v of responseLeaks) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 140)}`)
  }
  console.log('\nFix: route the response through the shared helper, which logs the detail')
  console.log('server-side and returns a generic message + correlation id instead:')
  console.log("  import { apiError } from '@/lib/api/api-error'")
  console.log('  if (error) return apiError(error)')
  console.log('  // ...')
  console.log('  } catch (err) {')
  console.log('    return apiError(err)')
  console.log('  }')
  console.log('\nKeep the original status code: apiError(err, undefined, 422).')
}

if (violations.length > 0 || responseLeaks.length > 0) {
  process.exit(1)
}

console.log(`No raw err logs found (${files.length} files scanned).`)
console.log('No err.message/error.message leaks found in NextResponse.json bodies.')
