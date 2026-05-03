// T5-Rixey-BBB: CI guard — fail when a writer inserts/upserts into one
// of the signal-class-bearing tables without declaring `signal_class`.
//
// Why this exists: migration 191 added a NOT NULL signal_class column
// (with no DB-level DEFAULT after backfill) to interactions, tours,
// tangential_signals, lost_deals, and attribution_events. Every writer
// MUST declare a class so the cluster-compute service can find the
// earliest source-class signal in each lead's identity cluster. A
// writer that forgets the field will get a Postgres NOT NULL violation
// at runtime — but a CI guard catches it earlier and surfaces a
// human-readable error instead.
//
// Algorithm: scan every .ts file under src/ for `.from('TABLE')` chained
// to `.insert(` or `.upsert(`. For each match, walk forward until the
// matching paren (best-effort — handles object literals + array
// literals) and search for `signal_class:`. If absent, flag.
//
// Opt-out marker (use sparingly):
//
//     // signal-class-justified: <reason>
//
// Add the marker on the same line as the .insert call OR within the 6
// lines immediately above. Use for legitimate cases where class is
// genuinely unclear (e.g. brain-dump CSV with no provenance) AND the
// writer intentionally lands an 'unclassified' or other value via the
// inferred default.
//
// Run:
//   node scripts/check-signal-class-declared.mjs
//
// Wire into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src']

const TABLES_REQUIRING_CLASS = new Set([
  'interactions',
  'tours',
  'tangential_signals',
  'lost_deals',
  'attribution_events',
])

const JUSTIFICATION_MARKER = /\/\/\s*signal-class-justified\s*:/i
const JUSTIFICATION_LOOKBACK = 6
const FORWARD_SCAN_LINES = 80

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

const violations = []

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Look for `.from('TABLE')` patterns. Quote can be ' or ".
      const fromMatch = line.match(/\.from\s*\(\s*['"]([a-z_]+)['"]\s*\)/)
      if (!fromMatch) continue
      const table = fromMatch[1]
      if (!TABLES_REQUIRING_CLASS.has(table)) continue

      // The .insert/.upsert MUST be on the same expression as the
      // .from(TABLE) call. Concat lines forward until a statement
      // terminator (semicolon, blank line, or another `.from(`),
      // then look for the op on that joined string. This prevents
      // false-positives where a .from('TABLE') (used for a SELECT)
      // is followed many lines later by an unrelated .insert on a
      // different table.
      let opLine = -1
      let opAt = -1
      let joined = lines[i].slice(fromMatch.index ?? 0)
      // Find op on the same line first.
      let m = joined.match(/\.(insert|upsert)\s*\(/)
      if (m) {
        opLine = i
        // Find the col on the original line.
        const origLine = lines[i]
        const colMatch = origLine.match(/\.(insert|upsert)\s*\(/)
        opAt = colMatch ? (colMatch.index ?? 0) : 0
      } else {
        const scanEnd = Math.min(lines.length, i + FORWARD_SCAN_LINES)
        for (let j = i + 1; j < scanEnd; j++) {
          const trimmed = lines[j].trim()
          // Statement terminator on the previous line: bail.
          if (lines[j - 1].trim().endsWith(';')) break
          // Hit a new .from on this line — bail (the prior .from was a SELECT chain that ended).
          if (/\.from\s*\(/.test(trimmed)) break
          // Blank line — bail.
          if (trimmed === '') break
          const opMatch = trimmed.match(/^\.(insert|upsert)\s*\(/)
          if (opMatch) {
            opLine = j
            const colMatch = lines[j].match(/\.(insert|upsert)\s*\(/)
            opAt = colMatch ? (colMatch.index ?? 0) : 0
            break
          }
          // Allow chain methods like .select / .single / .eq / .order
          // before insert (rare but valid).
          if (!/^\.[a-z]/.test(trimmed)) break
        }
      }
      if (opLine < 0) continue

      // From opLine, balance parens forward to find the end of the
      // .insert(...) / .upsert(...) call. Handle multi-line payloads.
      let depth = 0
      let endLine = opLine
      let started = false
      outer: for (let j = opLine; j < lines.length && j < opLine + FORWARD_SCAN_LINES; j++) {
        const startCol = j === opLine ? opAt : 0
        for (let k = startCol; k < lines[j].length; k++) {
          const c = lines[j][k]
          if (c === '(') { depth++; started = true }
          else if (c === ')') {
            depth--
            if (started && depth === 0) { endLine = j; break outer }
          }
        }
      }

      // Concat the payload text and check for signal_class:.
      const payload = lines.slice(opLine, endLine + 1).join('\n')
      if (/\bsignal_class\s*:/.test(payload)) continue

      // Also accept spread of an object that's been declared with
      // signal_class earlier in the file — too noisy to track exactly,
      // so as a heuristic, accept any `...identifier` inside the
      // payload only if the same identifier carries a signal_class
      // declaration anywhere in the file.
      const spreadMatch = payload.match(/\.\.\.([a-zA-Z_$][\w$]*)/g)
      if (spreadMatch) {
        let any = false
        for (const sm of spreadMatch) {
          const ident = sm.slice(3)
          const re = new RegExp(`\\b${ident}\\b[\\s\\S]{0,2000}signal_class\\s*:`, 'm')
          if (re.test(text)) { any = true; break }
        }
        if (any) continue
      }

      // Or — payload is a bare identifier (e.g.
      // `.insert(outboundPayload)`). Check if that identifier carries
      // signal_class in the same file. Match `.insert(IDENT)` or
      // `.insert(IDENT,` after the open paren.
      const bareIdentMatch = payload.match(/\.(insert|upsert)\s*\(\s*([a-zA-Z_$][\w$]*)\s*[,)\s]/)
      if (bareIdentMatch) {
        const ident = bareIdentMatch[2]
        const re = new RegExp(`\\b${ident}\\b[\\s\\S]{0,5000}signal_class\\s*:`, 'm')
        if (re.test(text)) continue
      }

      // Check justification marker on the .from line / .insert line /
      // 6 lines above either.
      let justified = false
      const start = Math.max(0, Math.min(i, opLine) - JUSTIFICATION_LOOKBACK)
      const end = Math.max(i, opLine)
      for (let j = start; j <= end; j++) {
        if (JUSTIFICATION_MARKER.test(lines[j])) { justified = true; break }
      }
      if (justified) continue

      violations.push({
        file,
        line: opLine + 1,
        table,
        snippet: lines[opLine].trim().slice(0, 120),
      })
    }
  }
}

if (violations.length > 0) {
  console.error('\nsignal-class-declared: violations found')
  console.error('=======================================')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (table: ${v.table})`)
    console.error(`    ${v.snippet}`)
  }
  console.error(
    `\n${violations.length} writer(s) insert into a signal-class-bearing\n` +
    `table without declaring signal_class.\n` +
    `\n` +
    `Per migration 191 (T5-Rixey-BBB), every row in interactions / tours /\n` +
    `tangential_signals / lost_deals / attribution_events MUST carry a\n` +
    `signal_class value (one of: 'source', 'touchpoint', 'crm', 'outcome',\n` +
    `'unclassified'). The cluster-compute service reads this column to find\n` +
    `the earliest source-class signal in each lead's identity cluster.\n` +
    `\n` +
    `Add a signal_class field to the insert payload:\n` +
    `\n` +
    `    .insert({\n` +
    `      ...rest,\n` +
    `      signal_class: 'source',  // or touchpoint / crm / outcome\n` +
    `    })\n` +
    `\n` +
    `If the class is genuinely ambiguous (e.g. brain-dump CSV with no\n` +
    `provenance), pass 'unclassified' AND add the marker on the same line\n` +
    `or within 6 lines above:\n` +
    `\n` +
    `    // signal-class-justified: <reason>\n`,
  )
  process.exit(1)
}

console.log(`signal-class-declared: clean (${ROOTS.join(', ')})`)
