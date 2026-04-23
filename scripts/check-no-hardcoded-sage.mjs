// Fail if a new user-visible 'Sage' literal appears in couple-portal
// JSX without going through the aiName parameterization.
//
// NOT a full ESLint rule because:
//  - 'Sage' is a valid color name (sage-green swatch)
//  - 'Sage' is the fallback AI name when venue_ai_config.ai_name is unset
//  - Comments are fine
//
// What this script does: grep src/app/_couple-pages/ for user-visible
// 'Sage' string literals, subtract the known-OK allowlist, exit 1 if
// anything is left.
//
// Run:
//   node scripts/check-no-hardcoded-sage.mjs
//
// Included in .github/workflows/ci.yml.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const COUPLE_DIR = 'src/app/_couple-pages'

// Specific file+line combinations that are explicitly OK. Update this
// list if you add a legitimate literal 'Sage' (e.g. a color swatch).
const ALLOWLIST = new Set([
  // Color swatches in tables/website pages
  "src/app/_couple-pages/tables/page.tsx:{ name: 'Sage',",
  "src/app/_couple-pages/website/page.tsx:{ value: '#7D8471', label: 'Sage Green' },",
])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(tsx|ts)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(COUPLE_DIR)
const violations = []

for (const file of files) {
  const fileText = readFileSync(file, 'utf8')
  const fileUsesAiName = /aiName/.test(fileText)
  const lines = fileText.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip comments: //, /* */, and JSX {/* */}
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue
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
  console.log(`\n❌ Found ${violations.length} hardcoded 'Sage' literal(s) in couple portal:`)
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 120)}`)
  }
  console.log('\nFix by routing through useCoupleContext().aiName or .replaceAll("Sage", aiName).')
  console.log('If this is legitimately a color name or similar, add to ALLOWLIST in scripts/check-no-hardcoded-sage.mjs.')
  process.exit(1)
}
console.log('No hardcoded Sage literals found in couple portal.')
