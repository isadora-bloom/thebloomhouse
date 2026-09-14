// Stream EEEE: CI guard — every outbound Sage email path MUST go
// through appendAIDisclosure before reaching sendEmail / sendTransactional.
// Footer is the single non-bypassable disclosure surface; if a future
// path adds a new outbound site without it, the guard fails the build.
//
// What it scans
// -------------
//
// 1. Every `await sendEmail(...)` call in src/. The arg list MUST
//    contain a call to `appendAIDisclosure` (most callers wrap the body
//    inline; some assemble `bodyWithDisclosure` ahead of time and pass
//    it through). The guard accepts both shapes.
//
//    Outbound SAGE paths fail without the wrapper. Transactional /
//    operational paths (welcome emails, team invites, briefings,
//    digests) are NOT Sage-authored — those send through
//    `sendTransactionalEmail` (./email module) which is a separate
//    call and not flagged.
//
// 2. Every direct `.from('drafts').update(...)` or `.insert(...)` that
//    writes a `draft_body` field MUST either route through a function
//    that ultimately appends the disclosure (e.g. one of the email-
//    pipeline send fns) OR carry the same `disclosure-justified:`
//    marker as the signal-class guard.
//
// 3. CHAT. Added 2026-09-14 (security review, item 4). Email was the only
//    surface this guard covered, and chat had the same class of hole: the
//    sign-off was appended inside generateSageResponse, so the four route
//    branches that never call the generator -- human requested, forbidden
//    topic, provider outage, low-confidence rewrite -- returned unsigned
//    text, and the public preview returned bare model output.
//
//    The rule: in any API route that answers a couple through the
//    couple-facing prompt assembler (it imports buildCouplePrompt) or sits
//    under a sage path, every `NextResponse.json({ ... response: X ... })`
//    must have X come from the sign-off chokepoint. X qualifies when the
//    file assigns it from `appendChatSignoff(` or `withChatSignoff(`.
//
//    Deliberately narrow, so it cannot weaken checks 1 and 2: a route with
//    no `response:` key is out of scope, and so is a route that does not
//    reach the couple prompt. Same `disclosure-justified:` opt-out.
//
// Opt-out marker: `// disclosure-justified: <reason>` on the same line
// as the call OR within the 6 lines immediately above it. Use sparingly
// — this is reserved for cases like dedupe-interactions which only
// updates `interaction_id` (no body, no send), or coordinator-paste
// drafts that haven't been sent yet.
//
// Run:
//   node scripts/check-sage-disclosure-enforced.mjs
//
// Wired into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src']
const JUSTIFICATION_MARKER = /\/\/\s*disclosure-justified\s*:/i
const JUSTIFICATION_LOOKBACK = 6
const FORWARD_SCAN_LINES = 80

// Files that legitimately do not need the disclosure wrapper.
//
//  - sendEmail itself (the Gmail sender — every caller wraps before
//    calling, but the function definition is the entrypoint, not a
//    caller).
//  - email.ts — transactional sender for non-Sage system emails
//    (welcome, password reset, team invite). These are not AI-drafted.
//  - briefings.ts / daily-digest.ts — sendTransactionalEmail callers
//    sending coordinator-only / system content; not Sage's voice.
//  - team/invite + portal/invite-couple — operational system mail.
//  - ai-disclosure.ts — defines the wrapper.
const ALLOWLIST_FILES = new Set([
  'src/lib/services/gmail.ts',
  'src/lib/services/email.ts',
  'src/lib/services/briefings.ts',
  'src/lib/services/daily-digest.ts',
  'src/app/api/team/invite/route.ts',
  'src/app/api/portal/invite-couple/route.ts',
  'src/lib/services/ai-disclosure.ts',
])

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

function hasJustificationNear(lines, idx) {
  if (JUSTIFICATION_MARKER.test(lines[idx] || '')) return true
  for (let k = 1; k <= JUSTIFICATION_LOOKBACK; k++) {
    const j = idx - k
    if (j < 0) break
    if (JUSTIFICATION_MARKER.test(lines[j])) return true
  }
  return false
}

// Walk forward from a starting line until we either find the closing
// paren of the call or hit the forward-scan cap. Used to capture the
// arg list of `await sendEmail(` that may span multiple lines.
function captureCallArgs(lines, startIdx) {
  let depth = 0
  let started = false
  const captured = []
  for (let i = startIdx; i < Math.min(lines.length, startIdx + FORWARD_SCAN_LINES); i++) {
    captured.push(lines[i])
    for (const ch of lines[i]) {
      if (ch === '(') { depth++; started = true }
      else if (ch === ')') {
        depth--
        if (started && depth === 0) return captured.join('\n')
      }
    }
  }
  return captured.join('\n')
}

// ---------------------------------------------------------------------------
// Check 3 helpers - chat sign-off at the route boundary
// ---------------------------------------------------------------------------

// A file is in chat scope when it is an API route that answers a couple:
// either it builds the couple-facing prompt, or it sits under a sage path.
function isChatSurface(normalized, text) {
  if (!normalized.startsWith('src/app/api/')) return false
  if (/\bsage\b/.test(normalized)) return true
  return /buildCouplePrompt/.test(text)
}

// The identifiers this file has run through the sign-off chokepoint. Covers
// `const x = await appendChatSignoff(`, `const x = withChatSignoff(`, and the
// reassignment form the portal route uses after its confidence rewrites.
function signedIdentifiers(text) {
  const out = new Set()
  const re = /(?:const|let|var)?\s*\b(\w+)\b\s*=\s*(?:await\s+)?(?:appendChatSignoff|withChatSignoff)\s*\(/g
  for (const m of text.matchAll(re)) out.add(m[1])
  return out
}

const files = ROOTS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const normalized = file.replace(/\\/g, '/')
  if (ALLOWLIST_FILES.has(normalized)) continue

  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const chatSurface = isChatSurface(normalized, text)
  const signed = chatSurface ? signedIdentifiers(text) : new Set()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // skip comment + console lines
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue

    // 1. sendEmail invocations from gmail. Match the named import shape
    //    used in the codebase: `await sendEmail(` with the bare name
    //    (transactional callers use `sendTransactionalEmail` and are
    //    excluded by the function-name discriminator).
    if (/\bsendEmail\s*\(/.test(line) && !/function\s+sendEmail\b/.test(line) && !/import\s/.test(line)) {
      const callBlock = captureCallArgs(lines, i)
      // Two valid shapes:
      //   (a) inline: sendEmail(..., appendAIDisclosure(body, ctx), ...)
      //   (b) hoisted: const bodyWithDisclosure = appendAIDisclosure(...)
      //                ...later... sendEmail(..., bodyWithDisclosure, ...)
      // For (b) we look at the 20 lines preceding this call site for an
      // appendAIDisclosure invocation in the same function scope.
      const inlineWrapped = /appendAIDisclosure\s*\(/.test(callBlock)
      const lookbackStart = Math.max(0, i - 20)
      const lookback = lines.slice(lookbackStart, i + 1).join('\n')
      const hoistedWrapped = /appendAIDisclosure\s*\(/.test(lookback)
      const wrapped = inlineWrapped || hoistedWrapped
      if (!wrapped && !hasJustificationNear(lines, i)) {
        violations.push({ file, line: i + 1, kind: 'sendEmail', text: line.trim() })
      }
    }

    // 2. drafts table writes. Flag only inserts/updates that write a
    //    draft_body. Many other update sites (status only, attempts
    //    counter, sent_at) don't introduce new body content and don't
    //    need re-disclosure — they're updating an already-disclosed
    //    payload.
    const draftsCallStart =
      /\.from\(['"]drafts['"]\)/.test(line) &&
      i + 1 < lines.length &&
      /\.(insert|update)\s*\(/.test(lines[i + 1] || line)
    if (draftsCallStart) {
      const callBlock = captureCallArgs(lines, i)
      const writesBody = /\bdraft_body\s*:/.test(callBlock)
      if (writesBody) {
        // The pipeline DOES NOT pre-disclose the draft_body in storage —
        // disclosure is enforced at the SEND boundary (sendApprovedDraft
        // + flushPendingAutoSends). So an insert/update of draft_body is
        // legitimate as long as the path ultimately routes through
        // sendEmail with appendAIDisclosure (validated by check #1
        // above). Flag only if the file ALSO sends without the wrapper —
        // a file that writes draft_body and never reaches sendEmail
        // would suppress disclosure entirely.
        const fileSendsRaw = /\bsendEmail\s*\(/.test(text) && !/appendAIDisclosure/.test(text)
        if (fileSendsRaw && !hasJustificationNear(lines, i)) {
          violations.push({ file, line: i + 1, kind: 'drafts.draft_body', text: line.trim() })
        }
      }
    }

    // 3. Chat replies. Every NextResponse.json(...) that hands a couple a
    //    `response` must hand them one that went through the sign-off
    //    chokepoint. A string literal and bare model text both fail here;
    //    only an identifier the file assigned from appendChatSignoff or
    //    withChatSignoff passes.
    if (chatSurface && /NextResponse\.json\s*\(/.test(line)) {
      const callBlock = captureCallArgs(lines, i)
      const hasResponseKey = /(?:^|[{,\s])response\s*[:,}]/.test(callBlock)
      if (hasResponseKey && !hasJustificationNear(lines, i)) {
        const named = callBlock.match(/(?:^|[{,\s])response\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/)
        const shorthand = /(?:^|[{,\s])response\s*[,}]/.test(callBlock)
        const name = named ? named[1] : shorthand ? 'response' : null
        if (!name || !signed.has(name)) {
          violations.push({
            file,
            line: i + 1,
            kind: 'chat.response',
            text: name ? `response: ${name}` : line.trim(),
          })
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log('Sage disclosure guard: no violations.')
  console.log('  Every outbound sendEmail call wraps its body via appendAIDisclosure (or is in the')
  console.log('  transactional-mail allowlist).')
  process.exit(0)
}

console.log(`\nSage disclosure guard: ${violations.length} violation(s)`)
console.log('Every outbound Sage send must wrap the body via appendAIDisclosure(body, ctx).')
console.log('Use fetchDisclosureContext(venueId) to load the per-venue ctx.')
console.log('Every couple-facing chat reply must go through appendChatSignoff(text, venueId).\n')
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  [${v.kind}]`)
  console.log(`    ${v.text.slice(0, 140)}`)
}
console.log('\nFix:')
console.log('  - Email: wrap the body with appendAIDisclosure(body, await fetchDisclosureContext(venueId))')
console.log('  - Chat [chat.response]: assign the reply from appendChatSignoff(text, venueId)')
console.log('    (or withChatSignoff(text, signoff)) and return THAT identifier.')
console.log('  - Or, if the path is genuinely not Sage-authored (system email, internal',)
console.log('    notification, etc.), add it to ALLOWLIST_FILES in this script with a')
console.log('    one-line justification comment, OR mark the call site with')
console.log('    "// disclosure-justified: <reason>" on the same line or within 6 lines above.')
process.exit(1)
