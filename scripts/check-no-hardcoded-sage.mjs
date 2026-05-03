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
// T5-Rixey-FFF expansion: also flags hardcoded venue-identifying
// strings in prompt templates + brain services. Bug 4 root cause was
// not "Sage" leaking into UI but the SIGNATURE TEMPLATE in outbound
// drafts inventing "Digital Concierge to Isadora Martin-Dye" / "A
// Historic Virginia Wedding Venue for Modern Love" / "www.rixeymanor.com"
// / "540-212-4545" because the prompt let Claude IMPROVISE those lines.
// All five must come from venue_ai_config (migration 195) — never from
// a string literal in src/config/prompts/* or src/lib/services/*-brain.ts.
//
// What this script does: walk each scope dir for *.ts / *.tsx files,
// flag user-visible 'Sage' string literals, subtract the known-OK
// allowlist, then ALSO walk the prompt + brain dirs for the venue-
// identifying token list. Exit 1 if anything is left.
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

// T5-Rixey-FFF: separate scan for prompt templates + brain services.
// These files are the LAST place a venue-specific string can leak
// before reaching Claude — once a hardcoded "Rixey Manor" or "Isadora"
// lands in a system prompt, every venue using that brain produces
// drafts with that string in them. Same scan logic, different
// vocabulary.
const PROMPT_BRAIN_SCAN_DIRS = [
  'src/config/prompts',
  'src/lib/services',
]
// Venue-identifying tokens that MUST be templated through venue
// config. Word-boundary matched. Case-sensitive on the named-entity
// tokens (lowercase "isadora" can be a generic word in comments) but
// case-insensitive on phrases that are unambiguous as identifiers.
const PROMPT_FORBIDDEN_TOKENS = [
  { pattern: /\bDigital Concierge to\b/, label: 'Digital Concierge to <owner>' },
  { pattern: /\bIsadora Martin-Dye\b/, label: 'Isadora Martin-Dye' },
  { pattern: /\bRixey Manor\b/, label: 'Rixey Manor' },
  { pattern: /\bHistoric Virginia\b/i, label: 'Historic Virginia (tagline fragment)' },
  { pattern: /www\.rixeymanor\.com/i, label: 'www.rixeymanor.com' },
  { pattern: /540-212-4545/, label: 'Rixey phone (540-212-4545)' },
]
// Files in the prompt/brain scan whose literal use of a venue-
// identifying token is intentional (typically a parser test fixture
// or an admin-facing preset label). Updated narrowly when a
// legitimate case appears.
const PROMPT_BRAIN_ALLOWLIST = new Set([
  // crm-import/web-form.ts ships RIXEY_CALCULATOR_HINT as a
  // built-in form-mapping preset (label + description shown in the
  // admin onboarding picker, NOT routed through any prompt). The
  // string "Rixey Manor pricing calculator" is the literal name of
  // the export the hint maps. Other tenants pick a different hint
  // from the same picker — none of these labels reach a venue's
  // outbound draft.
  'src/lib/services/crm-import/web-form.ts',
])

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

// Defer the exit on UI violations so the prompt/brain scan also runs
// — both passes write their findings, then we exit at the bottom.
if (violations.length > 0) {
  console.log(`\nFound ${violations.length} hardcoded 'Sage' literal(s) in venue-facing UI:`)
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text.slice(0, 120)}`)
  }
  console.log('\nFix by routing through useCoupleContext().aiName (couple portal),')
  console.log('useAiName() (platform shell), or .replaceAll("Sage", aiName).')
  console.log('If this is legitimately a color name or similar, add to ALLOWLIST in scripts/check-no-hardcoded-sage.mjs.')
}

// ---------------------------------------------------------------------------
// T5-Rixey-FFF: second pass over prompt templates + brain services.
// ---------------------------------------------------------------------------
// Same comment / block-comment skipping as the UI pass above so the
// behaviour is consistent. The token list is the difference — instead
// of looking for 'Sage' (which is allowed in brains as the
// DEFAULT_AI_NAME fallback constant), we look for venue-identifying
// strings that should be loaded from venue_ai_config columns added
// in migration 195.

const promptBrainFiles = PROMPT_BRAIN_SCAN_DIRS.flatMap((d) => walk(d))
const promptViolations = []

for (const file of promptBrainFiles) {
  const normalized = file.replace(/\\/g, '/')
  if (PROMPT_BRAIN_ALLOWLIST.has(normalized)) continue

  const fileText = readFileSync(file, 'utf8')
  const lines = fileText.split(/\r?\n/)
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    const opensBlock = /\/\*/.test(line) && !/\/\*[\s\S]*\*\//.test(line)
    if (opensBlock) {
      inBlockComment = true
      continue
    }
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue
    if (/\/\*.*\*\//.test(line)) continue
    if (/console\.(log|warn|error|info|debug)/.test(line)) continue

    for (const token of PROMPT_FORBIDDEN_TOKENS) {
      if (token.pattern.test(line)) {
        promptViolations.push({ file, line: i + 1, text: line.trim(), label: token.label })
      }
    }
  }
}

if (promptViolations.length > 0) {
  console.log(`\nFound ${promptViolations.length} hardcoded venue-identifying string(s) in prompts/brains:`)
  for (const v of promptViolations) {
    console.log(`  ${v.file}:${v.line} (${v.label})`)
    console.log(`    ${v.text.slice(0, 120)}`)
  }
  console.log('\nFix by loading the value from venue_ai_config (migration 195: ai_role_title, signature_tagline,')
  console.log('signature_website, signature_phone, signature_text_capable) and templating it into the prompt')
  console.log('via the buildSignoffBlock() helper or the SIGN-OFF TEMPLATE block. Never inline a venue-specific')
  console.log('string in src/config/prompts/* or src/lib/services/*-brain.ts — every venue must speak in their own brand.')
}

if (violations.length === 0 && promptViolations.length === 0) {
  console.log('No hardcoded Sage literals found in venue-facing UI.')
  console.log('No hardcoded venue-identifying strings found in prompt templates or brain services.')
  process.exit(0)
}

process.exit(1)
