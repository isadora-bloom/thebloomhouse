/**
 * Wave 13 smoke test on Rixey live data.
 *
 * Tests:
 *   1. generateTourPrepBrief on an upcoming Rixey tour (with wedding_id).
 *   2. generatePostTourFollowUp on a completed Rixey tour.
 *   3. solicitReview on a past Rixey wedding.
 *
 * Run with:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave13.ts
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(): Record<string, string> {
  const text = readFileSync('.env.local', 'utf-8')
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const env = loadEnv()
for (const k of Object.keys(env)) {
  if (!process.env[k]) process.env[k] = env[k]
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function testPrep(): Promise<void> {
  console.log('\n=== 1. Tour prep brief (upcoming Rixey tour) ===')
  const nowIso = new Date().toISOString()
  const { data } = await sb
    .from('tours')
    .select('id, wedding_id, scheduled_at')
    .eq('venue_id', RIXEY)
    .gte('scheduled_at', nowIso)
    .eq('outcome', 'pending')
    .not('wedding_id', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(1)
  if (!data || data.length === 0) {
    console.log('  no upcoming pending Rixey tour found')
    return
  }
  const tourId = (data[0] as { id: string }).id
  console.log('  Target tour:', tourId, 'scheduled', data[0].scheduled_at)

  const { generateTourPrepBrief } = await import('../src/lib/services/tour/prep-brief')
  try {
    const r = await generateTourPrepBrief({ tourId, supabase: sb })
    if (!r.ok) {
      console.log('  SKIPPED:', r.reason)
      return
    }
    console.log('  cost_cents:', r.costCents.toFixed(4))
    console.log('  prompt_version:', r.promptVersion)
    console.log('  input/output tokens:', r.inputTokens, '/', r.outputTokens)
    console.log('  persona_summary:', r.brief.persona_summary)
    console.log('  what_to_lead_with:', r.brief.what_to_lead_with.slice(0, 200))
    console.log('  key_facts:', r.brief.key_facts.length, 'items')
    if (r.brief.key_facts.length > 0) {
      console.log('    first:', r.brief.key_facts[0].fact)
    }
    console.log('  recommended_questions:', r.brief.recommended_questions.length)
    if (r.brief.sensitivity_flags.length > 0) {
      console.log('  sensitivity_flags:', r.brief.sensitivity_flags.length)
    }
  } catch (e) {
    console.log('  FAIL:', e instanceof Error ? e.message : String(e))
  }
}

async function testPostTour(): Promise<void> {
  console.log('\n=== 2. Post-tour Sage follow-up (completed Rixey tour) ===')
  const { data } = await sb
    .from('tours')
    .select('id, wedding_id, outcome')
    .eq('venue_id', RIXEY)
    .eq('outcome', 'completed')
    .not('wedding_id', 'is', null)
    .order('scheduled_at', { ascending: false })
    .limit(1)
  if (!data || data.length === 0) {
    console.log('  no completed Rixey tour found')
    return
  }
  const tourId = (data[0] as { id: string }).id
  console.log('  Target tour:', tourId)

  const { generatePostTourFollowUp } = await import('../src/lib/services/tour/post-tour-sage')
  try {
    const r = await generatePostTourFollowUp({ tourId, supabase: sb })
    if (!r.ok) {
      console.log('  SKIPPED:', r.reason)
      return
    }
    console.log('  cost_cents:', r.costCents.toFixed(4))
    console.log('  outcome routed:', r.outcome)
    console.log('  prompt_version:', r.promptVersion)
    console.log('  draft_id:', r.draftId)
    console.log('  subject:', r.draft.subject)
    console.log('  recommended_timing:', r.draft.recommended_timing)
    const firstSentence = r.draft.body.split(/[.!?]/)[0]
    console.log('  first sentence:', firstSentence)
  } catch (e) {
    console.log('  FAIL:', e instanceof Error ? e.message : String(e))
  }
}

async function testSolicit(): Promise<void> {
  console.log('\n=== 3. Review solicitation (past Rixey wedding) ===')
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await sb
    .from('weddings')
    .select('id, wedding_date, status')
    .eq('venue_id', RIXEY)
    .lt('wedding_date', today)
    .in('status', ['booked', 'completed'])
    .order('wedding_date', { ascending: false })
    .limit(20)
  if (!data || data.length === 0) {
    console.log('  no past Rixey wedding found')
    return
  }
  // Pick the first wedding that hasn't been solicited in the last 30d
  const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
  let target: { id: string; wedding_date: string } | null = null
  for (const w of data as Array<{ id: string; wedding_date: string }>) {
    const { data: prior } = await sb
      .from('review_solicit_requests')
      .select('id')
      .eq('wedding_id', w.id)
      .gte('generated_at', sinceIso)
      .limit(1)
    if (!prior || prior.length === 0) {
      target = w
      break
    }
  }
  if (!target) {
    console.log('  every recent past wedding already solicited within 30d')
    return
  }
  console.log('  Target wedding:', target.id, 'event', target.wedding_date)

  const { solicitReview } = await import('../src/lib/services/reviews/solicit')
  try {
    const r = await solicitReview({ weddingId: target.id, supabase: sb })
    if (!r.ok) {
      console.log('  SKIPPED:', r.reason)
      return
    }
    console.log('  cost_cents:', r.costCents.toFixed(4))
    console.log('  channel chosen:', r.targetChannel)
    console.log('  review_link_url:', r.reviewLinkUrl ?? '(none)')
    console.log('  prompt_version:', r.promptVersion)
    console.log('  request_id:', r.requestId)
    console.log('  draft_id:', r.draftId)
    console.log('  subject:', r.draft.subject)
    const firstSentence = r.draft.body.split(/[.!?]/)[0]
    console.log('  first sentence:', firstSentence)
  } catch (e) {
    console.log('  FAIL:', e instanceof Error ? e.message : String(e))
  }
}

async function main(): Promise<void> {
  await testPrep()
  await testPostTour()
  await testSolicit()
}

main().catch((err) => {
  console.error('top-level error:', err)
  process.exit(1)
})
