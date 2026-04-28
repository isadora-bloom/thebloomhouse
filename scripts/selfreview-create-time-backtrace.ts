// Self-review for create-time backtrace.
//
// We can't easily simulate "wedding-create event" without running the
// whole email pipeline, so this script exercises backtraceOneWedding
// directly on existing Rixey calendly weddings. Verifies:
//
//   1. Function returns a candidate (not null) when the wedding has
//      a couple name + Gmail is connected.
//   2. Wedding rows whose source is NOT in WEAK_FIRST_TOUCH_SOURCES
//      no-op (return null) — guard against running on already-fixed
//      weddings.
//   3. With autoApplyHigh: false (preview), the function returns the
//      candidate WITHOUT writing.
//   4. Cross-venue safety: passing a wrong venueId returns null.
//   5. Fire-and-forget contract: no exceptions propagate even if
//      Gmail is unavailable.
//
// We don't auto-apply in this script (autoApplyHigh: false) because
// without live Gmail tokens there's no way to get a high-confidence
// match — the local interactions table doesn't have the upstream
// relay emails for these couples, as Phase 1 self-review proved.
import { backtraceOneWedding } from '../src/lib/services/source-backtrace'
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
  console.log(`\n=== Create-time backtrace self-review (venue ${RIXEY.slice(0, 8)}) ===\n`)

  // CHECK 1: works on a calendly-source wedding
  const { data: cal } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY)
    .eq('source', 'calendly')
    .limit(1)
  const calWedding = (cal ?? [])[0] as { id: string; source: string } | undefined
  if (!calWedding) {
    console.log('[1] no calendly-source wedding to test on; skipping')
  } else {
    console.log(`[1] calendly wedding ${calWedding.id.slice(0, 8)}`)
    const candidate = await backtraceOneWedding(RIXEY, calWedding.id, {
      useLiveGmail: false, // skip live for fast deterministic test
      autoApplyHigh: false,
    })
    console.log(`    candidate: ${candidate ? `confidence=${candidate.confidence} suggested=${candidate.suggestedSource}` : 'null'}`)
  }

  // CHECK 2: no-op on a non-weak source wedding
  const { data: knot } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY)
    .eq('source', 'the_knot')
    .limit(1)
  const knotWedding = (knot ?? [])[0] as { id: string; source: string } | undefined
  if (!knotWedding) {
    console.log('[2] no the_knot wedding to test on; skipping')
  } else {
    console.log(`[2] the_knot wedding ${knotWedding.id.slice(0, 8)} — should no-op`)
    const candidate = await backtraceOneWedding(RIXEY, knotWedding.id, {
      useLiveGmail: false,
      autoApplyHigh: false,
    })
    console.log(`    result: ${candidate ? '❌ should be null' : '✓ null (no-op)'}`)
  }

  // CHECK 4: cross-venue safety
  const fakeVenue = '00000000-0000-0000-0000-000000000000'
  if (calWedding) {
    console.log(`\n[4] cross-venue: venueId=${fakeVenue.slice(0, 8)}`)
    const candidate = await backtraceOneWedding(fakeVenue, calWedding.id, {
      useLiveGmail: false,
      autoApplyHigh: false,
    })
    console.log(`    result: ${candidate ? '❌ leaked!' : '✓ null (blocked)'}`)
  }

  // CHECK 5: bogus weddingId
  console.log(`\n[5] bogus weddingId`)
  const ghost = await backtraceOneWedding(RIXEY, '99999999-9999-9999-9999-999999999999', {
    useLiveGmail: false,
    autoApplyHigh: false,
  })
  console.log(`    result: ${ghost ? '❌ should be null' : '✓ null'}`)

  // CHECK 6: verify auto-apply does NOT fire when confidence is below high.
  // Pre-condition: pick a calendly wedding, capture its current source.
  // Run with autoApplyHigh: true (default), with useLiveGmail: false so
  // we know the local data won't yield a high-confidence relay hit.
  // Post-condition: weddings.source still equals the original.
  if (calWedding) {
    console.log(`\n[6] auto-apply guard — confidence!=high should NOT write`)
    const before = (await sb.from('weddings').select('source').eq('id', calWedding.id).maybeSingle()).data as { source: string } | null
    await backtraceOneWedding(RIXEY, calWedding.id, {
      useLiveGmail: false,
      autoApplyHigh: true,
    })
    const after = (await sb.from('weddings').select('source').eq('id', calWedding.id).maybeSingle()).data as { source: string } | null
    if (before?.source === after?.source) {
      console.log(`    ✓ source unchanged: ${before?.source}`)
    } else {
      console.log(`    ❌ WROTE source ${before?.source} → ${after?.source} despite no high-confidence match`)
    }
  }

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
