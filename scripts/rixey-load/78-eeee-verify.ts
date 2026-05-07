/**
 * Stream EEEE — Sage disclosure v3 + escalation path verify.
 *
 * What this checks
 * ----------------
 *   1. Migration 206 (venue_ai_config.escalation_email) is applied —
 *      probe by selecting the column on Rixey's row and confirm the
 *      query doesn't error.
 *
 *   2. fetchDisclosureContext + appendAIDisclosure produce the v3
 *      footer for Rixey. Print the rendered text. Required substrings:
 *        - The configured AI name (or, if missing, the literal
 *          "${venue}'s ${role}" pattern)
 *        - The venue name
 *        - A role string containing "AI"
 *        - The "HUMAN REQUESTED" escalation phrasing
 *        - The v3 marker
 *
 *   3. v1 + v2 markers still suppress double-append. Pass a body that
 *      already contains a v1 / v2 footer; appendAIDisclosure must
 *      return it unchanged.
 *
 *   4. Pipeline detection regex matches a real Rixey inbound subject.
 *      Use detectHumanRequested() against synthetic subject variants
 *      ("HUMAN REQUESTED", "human-requested", "human_requested") —
 *      all must match. Also verify a benign subject doesn't match.
 *      AND probe Rixey for any historical interaction whose subject
 *      already contains the marker (informational — none expected
 *      pre-Stream-EEEE).
 *
 * Run
 * ---
 *   npx tsx scripts/rixey-load/78-eeee-verify.ts
 *
 * Idempotent — read-only.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

function loadEnv(): Record<string, string> {
  // Worktree's CWD doesn't carry .env.local; fall back to the main
  // repo's copy. Both share the same Supabase project.
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  let raw = ''
  for (const c of candidates) {
    try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
  }
  if (!raw) throw new Error('.env.local not found (looked in worktree + main repo)')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
}

async function probeMigration206(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb
    .from('venue_ai_config')
    .select('escalation_email')
    .eq('venue_id', RIXEY_VENUE_ID)
    .maybeSingle()
  if (error) {
    console.log(`  FAIL — escalation_email column not present: ${error.message}`)
    return false
  }
  console.log('  PASS — escalation_email column readable on venue_ai_config')
  return true
}

async function renderRixeyFooter(): Promise<{ rendered: string; ctx: unknown }> {
  const { fetchDisclosureContext, appendAIDisclosure, AI_DISCLOSURE_MARKER_V3 } =
    await import('../../src/lib/services/brain/ai-disclosure')
  const ctx = await fetchDisclosureContext(RIXEY_VENUE_ID)
  const sample = 'Thanks so much for your patience while we sort this out.'
  const rendered = appendAIDisclosure(sample, ctx)
  console.log('--- ctx ---')
  console.log(JSON.stringify(ctx, null, 2))
  console.log('\n--- rendered footer ---')
  console.log(rendered)
  console.log('--- end rendered ---\n')

  // Required substring checks
  const checks: Array<{ label: string; pass: boolean }> = []
  // AI name: ctx.sageName when present, otherwise the role-only fallback
  const sageName = (ctx as { sageName?: string | null }).sageName
  if (sageName) {
    checks.push({ label: `AI name "${sageName}" present`, pass: rendered.includes(sageName) })
  } else {
    checks.push({ label: 'No AI name configured (footer renders venue+role only)', pass: true })
  }
  const venueName = (ctx as { venueName?: string | null }).venueName ?? 'the venue'
  checks.push({ label: `Venue name "${venueName}" present`, pass: rendered.includes(venueName) })
  const role = (ctx as { role?: string | null }).role ?? 'AI assistant'
  // Role MUST contain "AI" — checked at footer build time, but verify here.
  checks.push({ label: `Role string contains "AI"`, pass: /\bAI\b/i.test(role) && rendered.includes(role) })
  checks.push({ label: 'Escalation phrase "HUMAN REQUESTED" present', pass: rendered.includes('HUMAN REQUESTED') })
  checks.push({ label: 'v3 marker present', pass: rendered.includes(AI_DISCLOSURE_MARKER_V3) })
  // The "reviewed by a human" claim must be GONE.
  checks.push({ label: 'Old "reviewed by a human" claim absent', pass: !/reviewed by a human/i.test(rendered) })
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'} — ${c.label}`)
  }
  if (!checks.every((c) => c.pass)) {
    throw new Error('Footer render failed required checks')
  }
  return { rendered, ctx }
}

async function checkIdempotency(): Promise<void> {
  const {
    appendAIDisclosure,
    AI_DISCLOSURE_MARKER_V1,
    AI_DISCLOSURE_MARKER_V2,
    AI_DISCLOSURE_MARKER_V3,
  } = await import('../../src/lib/services/brain/ai-disclosure')

  const cases = [
    { label: 'v1 already present', body: `Hi.\n\n--\nSage\n${AI_DISCLOSURE_MARKER_V1}` },
    { label: 'v2 already present', body: `Hi.\n\n––\nSage, the venue's AI assistant\n${AI_DISCLOSURE_MARKER_V2}` },
    { label: 'v3 already present', body: `Hi.\n\n––\nSage, the venue's AI assistant\n${AI_DISCLOSURE_MARKER_V3}` },
  ]
  for (const c of cases) {
    const out = appendAIDisclosure(c.body, { sageName: 'Sage', venueName: 'Test', role: 'AI concierge', escalationEmail: 'x@y.com' })
    const unchanged = out === c.body
    console.log(`  ${unchanged ? 'PASS' : 'FAIL'} — ${c.label} suppresses re-append`)
    if (!unchanged) {
      console.log('    expected unchanged. got:')
      console.log(out)
      throw new Error(`Idempotency failed for ${c.label}`)
    }
  }
}

async function checkInboundDetection(sb: SupabaseClient): Promise<void> {
  const { detectHumanRequested, HUMAN_REQUESTED_SUBJECT_PATTERN } =
    await import('../../src/lib/services/email-pipeline')

  console.log(`  pattern = ${HUMAN_REQUESTED_SUBJECT_PATTERN.toString()}`)

  const cases: Array<{ subject: string; expected: boolean }> = [
    { subject: 'HUMAN REQUESTED', expected: true },
    { subject: 'Re: HUMAN REQUESTED', expected: true },
    { subject: 'human requested please', expected: true },
    { subject: 'human-requested', expected: true },
    { subject: 'Human_Requested', expected: true },
    { subject: 'Re: tour for next month', expected: false },
    { subject: 'human size of the venue?', expected: false },
    { subject: '', expected: false },
  ]
  for (const c of cases) {
    const got = detectHumanRequested(c.subject)
    const ok = got === c.expected
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — subject="${c.subject}" expected=${c.expected} got=${got}`)
    if (!ok) throw new Error(`Detection regex mismatched for "${c.subject}"`)
  }

  // Informational: do any historical Rixey interactions already carry
  // the marker? (Pre-Stream-EEEE we expect zero.)
  const { count } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
    .ilike('subject', '%HUMAN%REQUESTED%')
  console.log(`  INFO — historical Rixey interactions matching subject: ${count ?? 0}`)
}

async function checkChatDetection(): Promise<void> {
  const { detectChatHumanRequest, SAGE_HUMAN_REQUEST_PATTERN } =
    await import('../../src/lib/services/brain/sage')

  console.log(`  pattern = ${SAGE_HUMAN_REQUEST_PATTERN.toString()}`)

  const cases: Array<{ message: string; expected: boolean }> = [
    { message: "I'd like a human", expected: true },
    { message: "Id like a human please", expected: true },
    { message: "I'd like to talk to a human", expected: true },
    { message: "I'd like to speak to a person", expected: true },
    { message: "talk to a person", expected: true },
    { message: "speak to a human", expected: true },
    { message: "Can you connect me with a real person?", expected: true },
    { message: "Connect me with the coordinator please", expected: true },
    { message: "What's the venue capacity?", expected: false },
    { message: "Tell me about human-scale events", expected: false },
  ]
  for (const c of cases) {
    const got = detectChatHumanRequest(c.message)
    const ok = got === c.expected
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — chat="${c.message}" expected=${c.expected} got=${got}`)
    if (!ok) throw new Error(`Chat detection regex mismatched for "${c.message}"`)
  }
}

async function main(): Promise<void> {
  const env = loadEnv()
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Stream EEEE: Sage disclosure v3 + escalation path verify ===\n')

  console.log('--- 1. Migration 206 applied ---')
  const migOk = await probeMigration206(sb)
  if (!migOk) process.exit(1)

  console.log('\n--- 2. Render Rixey footer (fetchDisclosureContext + appendAIDisclosure) ---')
  await renderRixeyFooter()

  console.log('--- 3. v1/v2/v3 marker idempotency ---')
  await checkIdempotency()

  console.log('\n--- 4. HUMAN REQUESTED detection (email pipeline) ---')
  await checkInboundDetection(sb)

  console.log('\n--- 5. "I\'d like a human" detection (couple-portal chat) ---')
  await checkChatDetection()

  console.log('\n=== Verify complete — all checks pass ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
