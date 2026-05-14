// Operator-facing vocab guard. Anchor: Round 2 audit TIER 3 (2026-05-14).
//
// Pattern C: Engineering Console In Product. Operators should never see
// engineering vocabulary ("Wave 5C", "Phase B", "Gmail backfill",
// "legacy source", "tombstoned", etc.) on their surfaces. Six leaks
// shipped to production this quarter; the fixes are in place but
// without a guard the next refactor reintroduces them.
//
// What this script does: walk src/app/(platform)/** and src/components/**
// for *.ts / *.tsx files, skipping the admin / super-admin / engineering
// scopes. For each remaining file, scan non-comment lines for a tight
// list of banned phrases. Allowlist a small set of file:prefix
// combinations that are intentional (e.g. attribution-pipeline doc
// strings on the candidates page where "first-touch" is domain
// language, not engineering vocab).
//
// Run:
//   node scripts/check-operator-vocab.mjs
//
// Wire to .github/workflows/ci.yml after smoke-testing locally.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Scopes that ARE customer-facing. Walked recursively, excluding the
// engineering-only subroutes via SKIP_SUBPATHS.
const SCAN_DIRS = [
  'src/app/(platform)',
  'src/components',
]

// Subpaths under the scan dirs that house engineering surfaces. Vocab
// is allowed here because only platform-team / org-admin reach them
// (gated by /admin/layout.tsx + /super-admin/layout.tsx).
const SKIP_SUBPATHS = [
  'src/app/(platform)/admin/',
  'src/app/(platform)/super-admin/',
]

// Banned vocabulary. Each entry: pattern + plain-English suggestion.
// Patterns are RegExp, applied to non-comment lines.
const BANNED = [
  // Engineering scope labels — never user-visible
  { pattern: /\bWave\s+\d+[A-Z]?\b/, label: 'Wave-number reference', fix: 'Rename to plain-English feature name (e.g. "external signals", "candidate matching") or move surface to /admin.' },
  { pattern: /\bPhase\s+[A-Z]\b/, label: 'Phase letter reference', fix: 'Rename to plain-English (e.g. "candidate matching engine") or move surface to /admin.' },
  // Identifier-shaped strings that bleed into UI. Only flag the
  // *labeled* variants (tier_2_ai, tier_2_wide_ai, tier_2_exact) —
  // bare tier_1_hours / tier_2_days are real config column names
  // surfaced as form fields and are domain language, not engineering
  // leakage.
  { pattern: /\btier_[123]_(?:ai|wide|exact|name|window)\w*\b/, label: 'Tier label (tier_2_ai etc)', fix: 'Use plain-English ("exact email match", "name + date window", "AI review") or move to /admin.' },
  { pattern: /\btombston(?:e|ed|ing)\b/i, label: 'Tombstone (engineering term)', fix: 'Use "removed" / "soft-deleted" / "kept in audit trail".' },
  { pattern: /\bsignal_id\b/, label: 'Raw column reference', fix: 'Reference by the human noun (e.g. "this signal").' },
  { pattern: /\battribution_event(?:s)?\b/, label: 'Raw table reference', fix: 'Use "auto-attribution" / "first-touch row".' },
  { pattern: /\bcandidate_identit(?:y|ies)\b/, label: 'Raw table reference', fix: 'Use "person clue" / "candidate".' },
  { pattern: /\bmint(?:Wedding|Person)\b/, label: 'Internal function name', fix: 'Use "create a new wedding/person".' },
  { pattern: /\badjudicat(?:e|ed|or|ing)\b/i, label: 'Engineering verb', fix: 'Use "decide" / "AI review".' },
  // Operations-jargon phrases that appeared in real leaks
  { pattern: /\bGmail backfill\b/, label: 'Operations jargon', fix: 'Use "Gmail history import" / "Gmail history catch-up".' },
  { pattern: /\blegacy source\b/, label: 'Operations jargon', fix: 'Use "original source".' },
  { pattern: /\blegacy attribution\b/, label: 'Operations jargon', fix: 'Use "original attribution".' },
  // Database / infrastructure terms that should never reach an operator
  { pattern: /\bRLS\b/, label: 'Database internals (RLS)', fix: 'Rephrase to operator-relevant language ("permission") or move to /admin.' },
  { pattern: /\bexec_sql\b/, label: 'Internal RPC', fix: 'Never reference RPC names in user-facing strings.' },
  { pattern: /\bsnake_case\b/, label: 'Engineering vocabulary', fix: 'Describe the issue without naming the case convention.' },
]

// File:line-prefix combinations that are explicitly OK. Prefix-matched
// against `${file}:${trimmedLine.slice(0, 80)}`.
const ALLOWLIST = new Set([
  // The candidates page imports the AttributionEventRow type — the
  // word "attribution_event" appears in TypeScript interface bodies
  // and select() lists, NOT in rendered prose.
  // Add concrete allowlist entries here as legitimate cases appear.
])

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
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      out.push(...walk(full))
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

function isSkipped(file) {
  const norm = file.replace(/\\/g, '/')
  return SKIP_SUBPATHS.some((p) => norm.includes(p))
}

const files = SCAN_DIRS.flatMap((d) => walk(d)).filter((f) => !isSkipped(f))

const violations = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)

  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Block-comment tracking (matches the convention from
    // check-no-hardcoded-sage.mjs so behaviour is consistent).
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    const opensBlock = /\/\*/.test(line) && !/\/\*[\s\S]*\*\//.test(line)
    if (opensBlock) {
      inBlockComment = true
      continue
    }

    // Skip line comments and single-line block comments.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue
    if (/\/\*.*\*\//.test(line)) continue
    // Skip dev logs.
    if (/console\.(log|warn|error|info|debug)/.test(line)) continue
    // Skip import/export lines — symbol names can match patterns but
    // aren't rendered.
    if (/^\s*(?:import|export)\b/.test(line)) continue
    // Skip TypeScript type-only declarations (interface members,
    // type aliases) where snake_case identifiers are the real DB
    // column names. We look at the trimmed line — if it ends with
    // `,` or `;` and contains a `:` it's almost certainly a member
    // declaration, not rendered prose.
    const trimmed = line.trim()
    if (/^[a-z_][\w]*\??:\s/.test(trimmed)) continue
    // Skip Supabase ORM calls and similar query plumbing. The table
    // name appears in code, not in rendered text — RLS scopes data,
    // not vocabulary.
    if (/\.from\(['"][\w_]+['"]\)/.test(line)) continue
    if (/\.select\(['"][^'"]+['"]\)/.test(line)) continue
    if (/\.update\(/.test(line) && /\.from\(/.test(line)) continue
    // Skip TypeScript type unions and switch cases — these reference
    // discriminator strings, not rendered prose.
    if (/^\s*\|\s*['"][\w_]+['"]/.test(line)) continue
    if (/^\s*case\s+['"][\w_]+['"]\s*:/.test(line)) continue
    // Skip property-access expressions like `event.tier === 'tier_2_ai'`
    // — comparisons against discriminator literals, not user text.
    if (/===\s*['"][\w_]+['"]/.test(line) || /!==\s*['"][\w_]+['"]/.test(line)) continue
    // Skip object literal initializers where the value is a string
    // discriminator (e.g. `{ kind: 'attribution_event', label: 'Attribution' }`).
    // The flagged term is the discriminator key, not rendered prose.
    if (/\b\w+:\s*['"][\w_]+['"][,}]/.test(line)) continue
    // Skip property assignments where the value is a JS expression
    // (function call / number / variable), e.g.
    // `setOverride(platform, { tier_1_hours: Number(e.target.value) })`.
    // The flagged term is the field name, not rendered text.
    if (/\b\w+:\s*(?:Number|String|Boolean|\w+\(|\w+\.\w+|\d)/.test(line)) continue
    // Skip bare property-access expressions in JSX bindings — these
    // are state reads (`{eff.tier_1_hours}` etc). We still flag if the
    // line contains rendered text-host tags (<code>, <strong>, prose
    // strings in quotes).
    if (/\b[\w_]+\.[\w_]+\b/.test(line) && !/<code>|<strong>|<em>|>{?\s*['"][A-Z]/.test(line)) {
      // Drop the JSX-binding tokens before the second-pass content
      // check: if AFTER stripping `{eff.tier_1_hours}` the remaining
      // line is empty of the banned vocabulary, skip.
      const stripped = line.replace(/\{[^}]*\}/g, ' ')
      // Re-run the patterns over the stripped line; if none match the
      // stripped form, the only matches were inside JSX bindings.
      let strippedMatches = false
      for (const r of BANNED) {
        if (r.pattern.test(stripped)) {
          strippedMatches = true
          break
        }
      }
      if (!strippedMatches) continue
    }

    for (const rule of BANNED) {
      if (!rule.pattern.test(line)) continue

      const key = `${file.replace(/\\/g, '/')}:${trimmed.slice(0, 80)}`
      let allowed = false
      for (const prefix of ALLOWLIST) {
        if (key.startsWith(prefix)) {
          allowed = true
          break
        }
      }
      if (allowed) continue

      violations.push({
        file: file.replace(/\\/g, '/'),
        line: i + 1,
        text: trimmed,
        label: rule.label,
        fix: rule.fix,
      })
    }
  }
}

if (violations.length === 0) {
  console.log(`Scanned ${files.length} operator-facing file(s). No engineering vocabulary found.`)
  process.exit(0)
}

console.log(`Found ${violations.length} operator-facing vocab leak(s):\n`)
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  [${v.label}]`)
  console.log(`    ${v.text.slice(0, 160)}`)
  console.log(`    fix: ${v.fix}\n`)
}
console.log('If this leak is intentional (engineering surface mis-categorized), either:')
console.log('  1. Move the page under src/app/(platform)/admin/ or /super-admin/ (gated routes), or')
console.log('  2. Add an explicit ALLOWLIST entry in scripts/check-operator-vocab.mjs with a justification.')
process.exit(1)
