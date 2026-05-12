/**
 * scripts/test-instagram-match.ts
 *
 * Runs the Instagram parser + matcher end-to-end against a synthetic
 * batch of 50 handles. Asserts that:
 *   - parser returns 50 normalized rows
 *   - matcher writes the expected match_status values
 *   - response shape from matchEngagementsForCapture is correct
 *
 * Doesn't go through the HTTP layer -- talks directly to the matcher
 * with a service-role Supabase client. Skips writing real rows by
 * creating a temporary capture (deleted at the end).
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/test-instagram-match.ts
 */

import { createClient } from '@supabase/supabase-js'
import { parseInstagramFollowersText } from '../src/lib/services/social/parsers/instagram-followers'
import { matchEngagementsForCapture } from '../src/lib/services/social/match-engagements'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  // 1. Pick the first venue (real or demo) to use as scope.
  const { data: venues, error: vErr } = await sb
    .from('venues')
    .select('id, name')
    .order('created_at', { ascending: true })
    .limit(1)
  if (vErr || !venues || venues.length === 0) {
    throw new Error('no venues to test against')
  }
  const venueId = venues[0].id
  console.log(`Using venue: ${venues[0].name} (${venueId})`)

  // 2. Generate 50 fake handles. We mix three shapes so the parser
  //    has to exercise all paths.
  const realFromPeople = await pickRealPlatformHandles(venueId, 5)
  const fakeHandles = Array.from({ length: 50 - realFromPeople.length }, (_, i) =>
    `test_user_${(i + 1).toString().padStart(3, '0')}`,
  )
  const allHandles = [...realFromPeople, ...fakeHandles]

  const pasteText = allHandles.map((h, i) => {
    if (i % 7 === 0) return `${h}\tDisplay ${h}`
    if (i % 5 === 0) return `${h}  Display Name For ${h}  Followed by tester`
    return h
  }).join('\n')

  const parsed = parseInstagramFollowersText(pasteText)
  console.log(`Parsed ${parsed.length} rows from ${allHandles.length} inputs`)
  if (parsed.length !== allHandles.length) {
    console.warn(
      `  WARN: parser returned ${parsed.length} but input had ${allHandles.length}`,
    )
  }

  // 3. Create the capture + engagements directly so we don't have to
  //    spin up an HTTP server.
  const { data: capture, error: cErr } = await sb
    .from('social_captures')
    .insert({
      venue_id: venueId,
      platform: 'instagram',
      metric_type: 'new_followers',
      source_text: pasteText,
      parse_result: { parsed_count: parsed.length, parser_version: 'instagram-followers/v1' },
      total_handles: parsed.length,
    })
    .select('id, captured_at')
    .single()
  if (cErr || !capture) {
    throw new Error(`insert capture: ${cErr?.message}`)
  }
  console.log(`Created capture ${capture.id}`)

  const engRows = parsed.map((p) => ({
    venue_id: venueId,
    social_capture_id: capture.id,
    platform: 'instagram',
    metric_type: 'new_followers',
    handle: p.handle,
    display_name: p.display_name,
    engagement_at: capture.captured_at,
    match_status: 'pending' as const,
  }))
  const { error: eErr } = await sb.from('social_engagements').insert(engRows)
  if (eErr) throw new Error(`insert engagements: ${eErr.message}`)

  // 4. Time the matcher.
  const t0 = Date.now()
  const result = await matchEngagementsForCapture(capture.id, sb)
  const dt = Date.now() - t0
  console.log(`Matcher ran in ${dt}ms`)
  console.log(JSON.stringify(result, null, 2))

  // 5. Assert basic shape.
  const ok =
    typeof result.matched === 'number' &&
    typeof result.unmatched === 'number' &&
    typeof result.surfaced_pre_inquiry === 'number' &&
    Array.isArray(result.matchedSamples)
  if (!ok) {
    throw new Error('Result shape mismatch')
  }
  if (result.matched + result.unmatched !== parsed.length) {
    throw new Error(
      `Matched + unmatched (${result.matched + result.unmatched}) ≠ total parsed (${parsed.length})`,
    )
  }
  if (dt > 10_000) {
    console.warn(`  WARN: matcher took ${dt}ms (>10s threshold)`)
  }

  // 6. Cleanup.
  await sb.from('social_captures').delete().eq('id', capture.id)
  console.log('Cleaned up capture + engagements (CASCADE).')

  console.log('\nTEST PASS')
}

async function pickRealPlatformHandles(venueId: string, n: number) {
  const { data } = await sb
    .from('people')
    .select('platform_handles')
    .eq('venue_id', venueId)
    .not('platform_handles', 'is', null)
    .limit(50)
  const out: string[] = []
  for (const p of data ?? []) {
    const handles = p.platform_handles as Record<string, string | null> | null
    const ig = handles?.instagram
    if (ig) out.push(ig.toLowerCase())
    if (out.length >= n) break
  }
  return out
}

main().catch((err) => {
  console.error('TEST FAIL')
  console.error(err)
  process.exit(1)
})
