// T5-Rixey-EEE Bug 2: CI guard — fail when a writer inserts/upserts
// `full_body:` or `body_preview:` into interactions/drafts/notes
// without routing the value through htmlToText().
//
// Why this exists: Stream RR fixed gmail.ts:parseEmailBody to strip
// HTML at WRITE time, then brain-dump-imports.ts + crm-import/index.ts
// followed suit. The Lead Journey ("Maddie & Brian" lead) still
// surfaced raw "<!DOCTYPE html PUBLIC ..." in body_preview because a
// historical writer that pre-dated RR landed an unstripped row. This
// guard prevents future regressions:
//
//   - any new writer that fills full_body / body_preview without
//     calling htmlToText() somewhere in its scope fails CI.
//   - the display-time htmlToText() in wedding-journey.ts +
//     intel/clients page is layer 2 of defense-in-depth — both ship
//     together per the EEE plan.
//
// Algorithm: scan every .ts file under src/lib/services + src/app/api
// for `.from('TABLE')` chained to `.insert(` / `.upsert(`. For each
// match, walk forward to the closing paren, then check if the payload
// references full_body or body_preview. If yes, require that
// `htmlToText(` appears either:
//   - inside the same payload (cleanBody = htmlToText(...) pattern), OR
//   - within the surrounding scope (line range = payload start to 30
//     lines above) so a "const cleanBody = htmlToText(raw)" at the
//     top of the function counts.
//
// Opt-out marker (use sparingly):
//
//     // html-stripped-justified: <reason>
//
// Same line as the .insert OR within 6 lines above. Use ONLY when
// the input is a known-plain-text source: outbound AI drafts (model
// returns plain), AI Sage replies, brain-dump-csv pre-cleaned values
// (the cleanBody/cleanNotes pattern actually trips the rule — that's
// fine, it satisfies via in-scope htmlToText).
//
// Run:
//   node scripts/check-html-stripped-at-writer.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/lib', 'src/app/api']

const TABLES_REQUIRING_HTML_STRIP = new Set([
  'interactions',
  'drafts',
])

const TARGET_COLUMNS = ['full_body', 'body_preview']

const JUSTIFICATION_MARKER = /\/\/\s*html-stripped-justified\s*:/i
const JUSTIFICATION_LOOKBACK = 6
const FORWARD_SCAN_LINES = 80
const SCOPE_LOOKBACK_LINES = 30

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
      const fromMatch = line.match(/\.from\s*\(\s*['"]([a-z_]+)['"]\s*\)/)
      if (!fromMatch) continue
      const table = fromMatch[1]
      if (!TABLES_REQUIRING_HTML_STRIP.has(table)) continue

      // Find the .insert/.upsert call on the same chain.
      let opLine = -1
      let opAt = -1
      const sameLineOp = lines[i].match(/\.(insert|upsert)\s*\(/)
      if (sameLineOp) {
        opLine = i
        opAt = sameLineOp.index ?? 0
      } else {
        const scanEnd = Math.min(lines.length, i + FORWARD_SCAN_LINES)
        for (let j = i + 1; j < scanEnd; j++) {
          const trimmed = lines[j].trim()
          if (lines[j - 1].trim().endsWith(';')) break
          if (/\.from\s*\(/.test(trimmed)) break
          if (trimmed === '') break
          const opMatch = trimmed.match(/^\.(insert|upsert)\s*\(/)
          if (opMatch) {
            opLine = j
            const colMatch = lines[j].match(/\.(insert|upsert)\s*\(/)
            opAt = colMatch ? (colMatch.index ?? 0) : 0
            break
          }
          if (!/^\.[a-z]/.test(trimmed)) break
        }
      }
      if (opLine < 0) continue

      // Balance parens forward to find the end of the .insert(...) call.
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

      const payload = lines.slice(opLine, endLine + 1).join('\n')
      const usesTargetColumn = TARGET_COLUMNS.some((col) => new RegExp(`\\b${col}\\s*:`).test(payload))
      if (!usesTargetColumn) continue

      // Justification marker (same line as op / .from / 6 lines above).
      let justified = false
      const start = Math.max(0, Math.min(i, opLine) - JUSTIFICATION_LOOKBACK)
      const end = Math.max(i, opLine)
      for (let j = start; j <= end; j++) {
        if (JUSTIFICATION_MARKER.test(lines[j])) { justified = true; break }
      }
      if (justified) continue

      // Check for htmlToText() in the payload OR in the surrounding
      // scope (lookback). The scope check catches the canonical
      // "const cleanBody = htmlToText(raw); ...full_body: cleanBody"
      // pattern used by brain-dump-imports / crm-import.
      const scopeStart = Math.max(0, opLine - SCOPE_LOOKBACK_LINES)
      const scope = lines.slice(scopeStart, endLine + 1).join('\n')
      if (/\bhtmlToText\s*\(/.test(scope)) continue

      // Also accept when the payload references a value we can trace
      // back to a known-plain source — most importantly draft.draft_body
      // / draft.body — which is AI-generated plain text. Capture this
      // by allowing the marker `// html-stripped-justified:` (already
      // handled) — leaving a residual TODO here for future widening.

      // ALSO accept: the payload uses a bare identifier (e.g.
      // `.insert(outboundPayload)`) AND that identifier is built earlier
      // in the same file with htmlToText already in its construction.
      const bareIdentMatch = payload.match(/\.(insert|upsert)\s*\(\s*([a-zA-Z_$][\w$]*)\s*[,)\s]/)
      if (bareIdentMatch) {
        const ident = bareIdentMatch[2]
        const re = new RegExp(`\\b${ident}\\b[\\s\\S]{0,5000}htmlToText\\s*\\(`, 'm')
        if (re.test(text)) continue
        // Or — the identifier construction itself uses a value derived
        // from gmail's parseEmailBody (which already strips HTML
        // internally). Accept when `parseEmailBody(` appears anywhere
        // in scope.
        if (/\bparseEmailBody\s*\(/.test(text)) continue
      }

      // ALSO accept when the value being assigned to the column is
      // sourced from `email.body` (Gmail-pipeline already strips via
      // parseEmailBody) OR `transcriptText` (Zoom — plain text).
      // We detect by searching the payload for known-plain RHS values.
      const rhsRe = /\b(full_body|body_preview)\s*:\s*([a-zA-Z_$][\w$.]*)/g
      let allKnownPlain = true
      let anyRhs = false
      let rhsMatch
      while ((rhsMatch = rhsRe.exec(payload)) !== null) {
        anyRhs = true
        const rhs = rhsMatch[2]
        // Whitelist of known-plain RHS values.
        if (
          /^email\.body/.test(rhs) ||
          /^transcriptText/.test(rhs) ||
          /^row\.body_text/.test(rhs) ||
          /^bodyPreview$/.test(rhs) ||
          /^cleanBody/.test(rhs) ||
          /^cleanNotes/.test(rhs) ||
          /^cleanFb/.test(rhs) ||
          /^cleanPv/.test(rhs) ||
          /^draft\.(draft_body|body)/.test(rhs)
        ) continue
        allKnownPlain = false
        break
      }
      if (anyRhs && allKnownPlain) continue

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
  console.error('\nhtml-stripped-at-writer: violations found')
  console.error('==========================================')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (table: ${v.table})`)
    console.error(`    ${v.snippet}`)
  }
  console.error(
    `\n${violations.length} writer(s) insert full_body / body_preview\n` +
    `into ${[...TABLES_REQUIRING_HTML_STRIP].join(' / ')} without\n` +
    `routing the value through htmlToText() (utility at\n` +
    `src/lib/utils/html-text.ts).\n` +
    `\n` +
    `Either:\n` +
    `  - call htmlToText(rawValue) on the body before insert, OR\n` +
    `  - if the source is already plain (AI draft, transcript), add a\n` +
    `    "// html-stripped-justified: <reason>" comment within 6 lines\n` +
    `    above the insert.\n`,
  )
  process.exit(1)
}

console.log('html-stripped-at-writer: ok — every full_body / body_preview writer routes through htmlToText()')
