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
// What this script flags:
//   - `console.(warn|error|log)` lines in src/lib/services/insights/
//     that mention `err.message` or the bare `err` identifier as an
//     argument, EXCEPT when the same line also calls redactError.
//
// What this script ALLOWS:
//   - `console.warn('[x] something:', redactError(err))`
//   - `console.error('[x] db:', redact(error.message))`
//   - Comments mentioning err.message (lines starting with //, /*, *)
//
// Run:
//   node scripts/check-no-raw-err-logs-in-t3.mjs
//
// Wired into .github/workflows/ci.yml.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const T3_DIR = 'src/lib/services/insights'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(T3_DIR)
const violations = []

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

for (const file of files) {
  const fileText = readFileSync(file, 'utf8')
  const lines = fileText.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip pure comment lines.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue

    if (!CONSOLE_PATTERN.test(line)) continue
    if (!RAW_ERR_PATTERN.test(line)) continue
    // If the line already routes through redact*, it's fine.
    if (REDACT_PATTERN.test(line)) continue

    violations.push({
      file: file.replace(/\\/g, '/'),
      line: i + 1,
      text: line.trim(),
    })
  }
}

if (violations.length > 0) {
  console.log(`\nFound ${violations.length} raw err log(s) in T3 insights:\n`)
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 140)}`)
  }
  console.log('\nWrap with redactError(err) (or redact(error.message) for extracted strings):')
  console.log("  import { redactError } from '@/lib/observability/redact'")
  console.log("  console.warn('[X] failed:', redactError(err))")
  console.log('\nWhy: T3 prompts contain couple PII. Anthropic 4xx errors echo prompt content into err.message. OPS-21.3.3.')
  process.exit(1)
}
console.log(`No raw err logs found in T3 insights (${files.length} files scanned).`)
