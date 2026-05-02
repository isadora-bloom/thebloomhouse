// Fail if a new user-visible 'Sage' literal appears anywhere in the
// venue-facing UI (couple portal + platform admin shell + shared
// components) without going through the aiName parameterization.
//
// NOT a full ESLint rule because:
//  - 'Sage' is a valid color name (sage-green swatch)
//  - 'Sage' is the fallback AI name when venue_ai_config.ai_name is unset
//  - Comments are fine
//
// T5-β.2 expansion: scope grew from couple-portal-only to also cover
//   - src/app/(platform)            (admin shell)
//   - src/components                (shared agent / couple / shell components)
// White-label leaks were equally bad in coordinator-facing pages.
//
// What this script does: walk each scope dir for *.ts / *.tsx files,
// flag user-visible 'Sage' string literals, subtract the known-OK
// allowlist, exit 1 if anything is left.
//
// Run:
//   node scripts/check-no-hardcoded-sage.mjs
//
// Included in .github/workflows/ci.yml.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIRS = [
  'src/app/_couple-pages',
  'src/app/(platform)',
  'src/components',
]

// Specific file+line combinations that are explicitly OK. Update this
// list if you add a legitimate literal 'Sage' (e.g. a color swatch).
// Prefix-matched against `${file}:${trimmedLine.slice(0, 60)}`.
const ALLOWLIST = new Set([
  // Color swatches in tables/website pages
  "src/app/_couple-pages/tables/page.tsx:{ name: 'Sage',",
  "src/app/_couple-pages/website/page.tsx:{ value: '#7D8471', label: 'Sage Green' },",
  // Settings personality form: example AI names listed as a placeholder.
  // Per T5-β.4 the comparable "e.g. Hawthorne Manor" placeholder is also
  // explicitly allowed.
  "src/app/(platform)/settings/personality/page.tsx:placeholder=\"e.g. Sage, Ivy, Aria\"",
  // Static nav-config strings — re-branded at the consumer in
  // sidebar-v2 / mode-strip via brandedLabel(text, aiName). Keeping the
  // canonical "Sage" here means the demo seed (Hawthorne) renders the
  // expected label without an extra round-trip.
  "src/components/shell/nav-config.ts:subtitle: 'What Sage learns from',",
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
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(tsx|ts)$/.test(name)) out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const fileText = readFileSync(file, 'utf8')
  const fileUsesAiName = /aiName/.test(fileText)
  const lines = fileText.split(/\r?\n/)

  // Track multi-line block comment state so a "Sage" inside the body
  // of a /* ... */ or JSX {/* ... */} comment doesn't get flagged.
  // Both styles end on the same `*/` so we treat them uniformly.
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Block-comment tracking: if we entered one on a previous line, stay
    // inside until we hit `*/`; if we open one on this line and don't
    // close it, flip the flag and skip the rest of this line.
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    const opensBlock = /\/\*/.test(line) && !/\/\*[\s\S]*\*\//.test(line)
    if (opensBlock) {
      inBlockComment = true
      // The opening line itself is treated as comment content too — a
      // legitimate piece of code is unlikely to share a line with the
      // start of a multi-line comment that mentions "Sage".
      continue
    }

    // Skip line comments and same-line block / JSX block comments.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue
    if (/\/\*.*\*\//.test(line)) continue
    if (/\{\/\*.*Sage.*\*\/\}/.test(line)) continue
    // console.* dev logs — not user-visible
    if (/console\.(log|warn|error|info|debug)/.test(line)) continue

    if (!/\bSage\b/.test(line)) continue
    // Variable / identifier usages (onAskSage, handleAskSage, isSageActive, etc)
    if (/(?:on|handle|is)Sage\w*/.test(line)) continue
    // Same-line aiName reference (explicit render-time swap)
    if (/aiName/.test(line)) continue
    // DEFAULT_AI_NAME = 'Sage' fallback definition
    if (/DEFAULT_AI_NAME/.test(line)) continue
    // If the file as a whole uses aiName, assume the author wired this
    // literal through .replaceAll('Sage', aiName) or similar — don't
    // over-flag. Fall back to allowlist for files that genuinely need
    // literal 'Sage' (color swatches).
    if (fileUsesAiName) continue

    const displayLine = line.trim()
    const key = `${file.replace(/\\/g, '/')}:${displayLine.slice(0, 60)}`
    let allowed = false
    for (const prefix of ALLOWLIST) {
      if (key.startsWith(prefix)) {
        allowed = true
        break
      }
    }
    if (allowed) continue

    violations.push({ file, line: i + 1, text: displayLine })
  }
}

if (violations.length > 0) {
  console.log(`\nFound ${violations.length} hardcoded 'Sage' literal(s) in venue-facing UI:`)
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 120)}`)
  }
  console.log('\nFix by routing through useCoupleContext().aiName (couple portal),')
  console.log('useAiName() (platform shell), or .replaceAll("Sage", aiName).')
  console.log('If this is legitimately a color name or similar, add to ALLOWLIST in scripts/check-no-hardcoded-sage.mjs.')
  process.exit(1)
}
console.log('No hardcoded Sage literals found in venue-facing UI.')
