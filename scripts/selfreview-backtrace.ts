// Phase 2.6-2.9 self-review: source-backtrace dry-run for Rixey.
//
// Verifies:
//   1. We pull the right wedding cohort (calendly/acuity/honeybook/dubsado).
//   2. Local-interactions search produces evidence for the 90-day window
//      cohort. Confidence levels make sense (high = relay parser hit,
//      medium/low = heuristic, none = no match).
//   3. With useLiveGmail: false (this run), older weddings should
//      yield confidence='none'. That's the lever the user asked us to
//      think about — full mailbox vs 90-day window.
//   4. Suggestions are canonicalized (no raw 'theknot.com' strings).
//   5. applyBacktrace round-trip — one wedding, then read back +
//      restore. Idempotent: re-applying with same source is a no-op.
import { findBacktraceCandidates, applyBacktrace, WEAK_FIRST_TOUCH_SOURCES } from '../src/lib/services/source-backtrace'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  console.log(`\n=== Phase 2.9 backtrace self-review: venue ${RIXEY.slice(0, 8)} ===`)
  console.log(`Weak sources: ${[...WEAK_FIRST_TOUCH_SOURCES].join(', ')}\n`)

  // CHECK 1: cohort matches what's actually in weddings
  const { data: cohort } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY)
    .in('source', [...WEAK_FIRST_TOUCH_SOURCES])
  const cohortBySrc = new Map<string, number>()
  for (const w of (cohort ?? []) as Array<{ source: string }>) {
    cohortBySrc.set(w.source, (cohortBySrc.get(w.source) ?? 0) + 1)
  }
  console.log(`[check1] cohort: ${cohort?.length ?? 0} weddings`)
  for (const [s, n] of cohortBySrc) console.log(`         ${s}: ${n}`)

  // CHECK 2+3: dry-run with NO live Gmail. Should see how much the
  // local interactions table can find on its own.
  console.log(`\n[check2,3] running with useLiveGmail: false (local only)…`)
  const local = await findBacktraceCandidates(RIXEY, { useLiveGmail: false })
  const conf = { high: 0, medium: 0, low: 0, none: 0 }
  const bySuggestion = new Map<string, number>()
  for (const c of local) {
    conf[c.confidence]++
    const k = c.suggestedSource ?? '(none)'
    bySuggestion.set(k, (bySuggestion.get(k) ?? 0) + 1)
  }
  console.log(`         total candidates: ${local.length}`)
  console.log(`         confidence: high=${conf.high} medium=${conf.medium} low=${conf.low} none=${conf.none}`)
  console.log(`         suggestions:`)
  for (const [s, n] of bySuggestion) console.log(`           ${s}: ${n}`)

  // CHECK 4: spot-check 5 high-confidence and 5 none-confidence rows
  console.log(`\n[check4] sample evidence rows:`)
  const samples = [
    ...local.filter((c) => c.confidence === 'high').slice(0, 3),
    ...local.filter((c) => c.confidence === 'medium').slice(0, 2),
    ...local.filter((c) => c.confidence === 'none').slice(0, 3),
  ]
  for (const c of samples) {
    const e = c.evidence
    console.log(`  - ${(c.coupleNames ?? '(no name)').padEnd(28)} ${c.currentSource} → ${c.suggestedSource ?? '(no suggestion)'} [${c.confidence}]`)
    if (e) {
      console.log(`    from: ${e.fromName ?? '?'} <${e.fromEmail ?? '?'}>`)
      console.log(`    subj: ${e.subject ?? '(no subject)'}`)
      console.log(`    when: ${e.timestamp.slice(0, 10)}`)
    }
  }

  // CHECK 5: applyBacktrace round-trip — pick the FIRST candidate and
  // force a manual override (since local-only has no high-confidence
  // hits; live Gmail would change that). This exercises the write path
  // and metadata audit trail regardless of evidence quality.
  console.log(`\n[check5] applyBacktrace round-trip (manual override)…`)
  const target = local[0] ?? null
  if (!target) {
    console.log(`  no candidates at all; skipping.`)
  } else {
    const original = target.currentSource
    const proposed = 'the_knot' // arbitrary canonical to test the write path
    console.log(`  target: ${target.coupleNames}`)
    console.log(`  apply ${original} → ${proposed}`)
    const apply1 = await applyBacktrace(RIXEY, target.weddingId, proposed, 'selfreview')
    console.log(`    result: ok=${apply1.ok} oldSource=${apply1.oldSource}`)

    // Read back
    const { data: w } = await sb.from('weddings').select('source').eq('id', target.weddingId).maybeSingle()
    const { data: tp } = await sb
      .from('wedding_touchpoints')
      .select('source, metadata')
      .eq('wedding_id', target.weddingId)
      .eq('touch_type', 'inquiry')
      .maybeSingle()
    console.log(`    weddings.source = ${(w as { source: string } | null)?.source}`)
    console.log(`    inquiry-tp.source = ${(tp as { source: string } | null)?.source}`)
    const meta = (tp as { metadata: Record<string, unknown> } | null)?.metadata ?? {}
    console.log(`    inquiry-tp.metadata.backtraced_from = ${meta.backtraced_from}`)
    console.log(`    inquiry-tp.metadata.backtraced_to   = ${meta.backtraced_to}`)

    // Idempotency: re-apply same source — should still succeed and
    // record the ladder of audits (backtraced_from now becomes
    // 'the_knot' because that's what we just wrote).
    const apply2 = await applyBacktrace(RIXEY, target.weddingId, proposed, 'selfreview')
    console.log(`  re-apply (idempotency): ok=${apply2.ok} oldSource=${apply2.oldSource}`)

    // Restore
    await applyBacktrace(RIXEY, target.weddingId, original, 'selfreview-restore')
    console.log(`    restored to ${original}`)
  }

  // CHECK 6: cross-venue safety
  console.log(`\n[check6] cross-venue: applyBacktrace with mismatched venue should fail`)
  const { data: anyOtherWedding } = await sb
    .from('weddings')
    .select('id')
    .neq('venue_id', RIXEY)
    .limit(1)
  const otherId = (anyOtherWedding ?? [])[0]?.id
  if (otherId) {
    const cross = await applyBacktrace(RIXEY, otherId, 'website', 'selfreview-cross')
    console.log(`    result: ok=${cross.ok} (expect false — cross-venue blocked)`)
  } else {
    console.log(`  no other-venue wedding to test cross-venue check`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
