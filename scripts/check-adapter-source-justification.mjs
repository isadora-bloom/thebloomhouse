// T5-Rixey-TT: CI guard — fail when a CRM-import adapter writes to
// `weddings.source` without an explicit justification marker.
//
// Why this exists: pre-Stream-TT, several adapters wrote scheduling-
// tool / CRM provenance values (calendly / honeybook / web_form /
// 'other') into weddings.source. That short-circuited the lead-source-
// derivation chain — the canonical first-touch should be derived from
// Q7 / web-form / email-domain / UTM in priority order, NOT stamped
// at import time by an adapter that has no acquisition-channel signal.
//
// The guard scans every .ts file under src/lib/services/crm-import/
// for any `source` write that targets the weddings table. A line is
// considered legit if it (or one of the 6 lines immediately above)
// contains the marker:
//
//     // adapter-source-justified: <reason>
//
// The marker exists for the rare adapter that GENUINELY captures
// first-touch context — e.g. a paid-platform integration that knows
// which campaign drove the lead. Today the only justified writers
// are:
//   - generic-csv (coordinator EXPLICITLY mapped a column to source)
//   - the shared commitNormalisedRows fall-through (passes through
//     whatever the per-adapter parse() returned)
//   - applyBacktrace in source-backtrace.ts (the SANCTIONED writer
//     for coordinator-confirmed corrections)
//
// Run:
//   node scripts/check-adapter-source-justification.mjs
//
// Wired into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ADAPTER_DIRS = ['src/lib/services/crm-import']

// Patterns that indicate a write to weddings.source. The guard flags
// any line matching these UNLESS the surrounding ±6 lines carry the
// justification marker. False-positives on read-only references
// (typeof, jsdoc, etc.) are fine — coordinators add the marker to
// silence them.
const FLAG_PATTERNS = [
  /\bweddings\.source\b/,                        // direct ref
  /^\s*source\s*[:=]\s*['"`][^'"`]+['"`]/,      // object literal: source: 'x'
  /\.from\s*\(\s*['"]weddings['"]\s*\)\s*\.update\s*\(\s*\{[^}]*\bsource\b/, // .from('weddings').update({ source: ... })
]

const JUSTIFICATION_MARKER = /\/\/\s*adapter-source-justified\s*:/i
const JUSTIFICATION_LOOKBACK = 6

// Lines that obviously don't write anything (comment markers, type
// annotations, jsdoc) — skip without false-flagging.
const SKIP_LINE_PATTERNS = [
  /^\s*\*/,                  // jsdoc
  /^\s*\/\//,                // line comment
  /^\s*\/\*/,                // block comment open
  /^\s*\*\//,                // block comment close
  /^\s*export type\b/,       // type alias
  /^\s*export interface\b/,  // interface declaration
  /^\s*type\s+\w+\s*=/,      // local type alias
]

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

const violations = []

for (const dir of ADAPTER_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip obviously non-write lines.
      if (SKIP_LINE_PATTERNS.some((re) => re.test(line))) continue

      // Skip lines that ARE the justification marker itself (so the
      // guard doesn't false-flag the marker comment as a write).
      if (JUSTIFICATION_MARKER.test(line)) continue

      const flagged = FLAG_PATTERNS.some((re) => re.test(line))
      if (!flagged) continue

      // Check the line itself + the JUSTIFICATION_LOOKBACK lines
      // above for a justification marker.
      let justified = false
      const start = Math.max(0, i - JUSTIFICATION_LOOKBACK)
      for (let j = start; j <= i; j++) {
        if (JUSTIFICATION_MARKER.test(lines[j])) {
          justified = true
          break
        }
      }
      if (!justified) {
        violations.push({
          file,
          line: i + 1,
          text: line.trim().slice(0, 120),
        })
      }
    }
  }
}

if (violations.length > 0) {
  console.error('\nadapter-source-justification: violations found')
  console.error('==============================================')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
  }
  console.error(
    `\n${violations.length} adapter file(s) write to weddings.source without justification.\n` +
    `\n` +
    `Per Stream-TT adapter-as-facts contract: CRM-import adapters MUST NOT\n` +
    `write attribution decisions to weddings.source. Write factual provenance\n` +
    `to crm_source / source_detail / source_provenance / interactions.\n` +
    `extracted_identity instead, and let the lead-source-derivation cron\n` +
    `decide the real first-touch from Q7 / web-form / email-domain / UTM.\n` +
    `\n` +
    `If the write is genuinely justified (rare — paid-platform integration\n` +
    `with first-touch campaign data, or the shared commit helper), add the\n` +
    `marker on the same line or within 6 lines above:\n` +
    `\n` +
    `    // adapter-source-justified: <reason>\n`,
  )
  process.exit(1)
}

console.log(`adapter-source-justification: clean (${ADAPTER_DIRS.join(', ')})`)
