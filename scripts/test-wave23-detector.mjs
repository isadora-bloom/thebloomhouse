// Wave 23 detector regression + new-platform tests.
//
// Smoke tests:
//   1. inferPlatformFromInteraction — from_email domain → canonical
//   2. detectListingBroadcast with platform='hctg' on a synthetic HCTG body
//   3. detectListingBroadcast with platform='the_knot' on a real Rixey AE
//      (regression: same templateScore as Wave 16 before generalisation)
//   4. Intent-class breakdown for Rixey AEs by platform × intent

// Run with: node --import tsx scripts/test-wave23-detector.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// tsx is loaded via the --import flag on the node command line.
const detectorMod = await import('../src/lib/services/attribution-roles/listing-platform-detector.ts')
const { detectListingBroadcast, inferPlatformFromInteraction } = detectorMod

console.log('=== Test 1: inferPlatformFromInteraction ===')
const inferenceCases = [
  { from_email: 'noreply@theknot.com', expected: 'the_knot' },
  { from_email: 'lead@member.theknot.com', expected: 'the_knot' },
  { from_email: 'foo@weddingwire.com', expected: 'weddingwire' },
  { from_email: 'lead@authsolic.com', expected: 'weddingwire' },
  { from_email: 'inquiry@herecomestheguide.com', expected: 'hctg' },
  { from_email: 'venue@brides.com', expected: 'brides_com' },
  { from_email: 'venues@zola.com', expected: 'zola' },
  { from_email: 'leads@junebugweddings.com', expected: 'junebug' },
  { from_email: 'team@caratsandcake.com', expected: 'carats_cake' },
  { from_email: 'inquiry@stylemepretty.com', expected: 'style_me_pretty' },
  { from_email: 'random@gmail.com', expected: 'unknown' },
  { from_email: null, expected: 'unknown' },
]
let inferenceFail = 0
for (const c of inferenceCases) {
  const got = inferPlatformFromInteraction({ from_email: c.from_email })
  const ok = got === c.expected
  if (!ok) inferenceFail++
  console.log(`  ${ok ? '✓' : '✗'} from_email='${c.from_email}' → ${got} (expected ${c.expected})`)
}
// Source platform tie-breaks
console.log('  -- source_platform precedence --')
const srcCases = [
  { sp: 'the_knot', from: 'random@gmail.com', expected: 'the_knot' },
  { sp: 'theknot.com', from: null, expected: 'the_knot' },
  { sp: 'hctg', from: null, expected: 'hctg' },
  { sp: 'web_form', from: 'inquiry@theknot.com', expected: 'the_knot' }, // unrecognised source_platform → falls back to domain
]
for (const c of srcCases) {
  const got = inferPlatformFromInteraction({ from_email: c.from }, c.sp)
  const ok = got === c.expected
  if (!ok) inferenceFail++
  console.log(`  ${ok ? '✓' : '✗'} sp='${c.sp}' from='${c.from}' → ${got} (expected ${c.expected})`)
}

console.log('\n=== Test 2: detectListingBroadcast on synthetic HCTG body ===')
// Plausible HCTG broadcast body — generic "interested + pricing" with
// no venue mention and no specifics. Should clear the 60 broadcast
// threshold.
const hctgBody = `Hello,

I'm interested in your venue for my wedding. Could you send me your pricing and availability?

I found you on Here Comes The Guide.

Thanks!`

// Need a real venueId — pull the first non-demo venue.
const { data: venueRow } = await sb
  .from('venues')
  .select('id, name')
  .or('is_demo.is.null,is_demo.eq.false')
  .limit(1)
  .maybeSingle()
const testVenueId = venueRow?.id
const testVenueName = venueRow?.name ?? null
console.log(`  using venue: ${testVenueName} (${testVenueId})`)

if (!testVenueId) {
  console.log('  ✗ no non-demo venue — skipping detector calls')
} else {
  const hctgResult = await detectListingBroadcast({
    venueId: testVenueId,
    platform: 'hctg',
    interaction: { body: hctgBody, subject: 'Wedding inquiry', venueName: testVenueName, from_email: 'inquiry@herecomestheguide.com' },
    supabase: sb,
  })
  console.log(`  HCTG synthetic body templateScore=${hctgResult.templateScore} isLikelyBroadcast=${hctgResult.isLikelyBroadcast}`)
  console.log(`    components: phrase=${hctgResult.components.phraseScore} regex=${hctgResult.components.regexScore} deficit=${hctgResult.components.personalisationDeficit}`)
  console.log(`    matched: ${hctgResult.matchedPatterns.slice(0, 5).join(' | ')}`)
  if (hctgResult.templateScore < 60) {
    console.log('  ✗ expected templateScore >= 60 for HCTG synthetic broadcast body')
    inferenceFail++
  } else {
    console.log('  ✓ HCTG broadcast detection fires')
  }

  // Test cross-platform isolation: a Knot pattern body run against
  // platform='hctg' should NOT fire on Knot phrases.
  const knotPhrasedBody = `we saw your listing and are interested in the prices and details — looking for pricing first`
  const isolationResult = await detectListingBroadcast({
    venueId: testVenueId,
    platform: 'hctg',
    interaction: { body: knotPhrasedBody, subject: '', venueName: testVenueName, from_email: 'inquiry@herecomestheguide.com' },
    supabase: sb,
  })
  console.log(`  cross-platform isolation: Knot body vs HCTG patterns templateScore=${isolationResult.templateScore} (should be <60, only personalisation deficit fires)`)
  console.log(`    matched: ${JSON.stringify(isolationResult.matchedPatterns)}`)
  if (isolationResult.matchedPatterns.length > 0) {
    console.log('  ✗ Knot patterns leaked into HCTG load')
    inferenceFail++
  } else {
    console.log('  ✓ Knot patterns DID NOT fire on platform=hctg load')
  }
}

console.log('\n=== Test 3: detectListingBroadcast regression on real Rixey Knot AE ===')
if (!testVenueId) {
  console.log('  (skipped — no venue)')
} else {
  // Find an attribution_event on Knot for Rixey with a linked inquiry interaction.
  const { data: ae } = await sb
    .from('attribution_events')
    .select('id, venue_id, wedding_id, source_platform, intent_class, intent_class_signals')
    .eq('venue_id', testVenueId)
    .ilike('source_platform', '%knot%')
    .not('intent_class', 'is', null)
    .neq('intent_class', 'unknown')
    .not('wedding_id', 'is', null)
    .limit(3)
  if (!ae || ae.length === 0) {
    console.log('  (no Knot AEs with classified intent found — skipping regression)')
  } else {
    for (const row of ae) {
      const previousScore = row.intent_class_signals?.templateScore ?? null
      const { data: interactions } = await sb
        .from('interactions')
        .select('id, wedding_id, direction, timestamp, subject, body_preview, full_body, from_email')
        .eq('wedding_id', row.wedding_id)
        .eq('direction', 'inbound')
        .ilike('from_email', '%theknot%')
        .order('timestamp', { ascending: true })
        .limit(1)
      const inq = interactions?.[0]
      if (!inq) {
        console.log(`  ae=${row.id}: no Knot inquiry interaction; skip`)
        continue
      }
      const detection = await detectListingBroadcast({
        venueId: row.venue_id,
        platform: 'the_knot',
        interaction: {
          body: inq.full_body,
          body_preview: inq.body_preview,
          subject: inq.subject,
          from_email: inq.from_email,
          venueName: testVenueName,
        },
        supabase: sb,
      })
      const matches = previousScore === null ? '(no prior score)' : detection.templateScore === previousScore ? '✓ match' : `✗ drift (prior=${previousScore})`
      console.log(`  ae=${row.id.slice(0, 8)} intent=${row.intent_class} prior=${previousScore} now=${detection.templateScore} ${matches}`)
    }
  }
}

console.log('\n=== Test 4: intent-class breakdown by source_platform for Rixey ===')
if (testVenueId) {
  const { data: rows } = await sb
    .from('attribution_events')
    .select('source_platform, intent_class')
    .eq('venue_id', testVenueId)
  if (!rows) {
    console.log('  no rows')
  } else {
    const counts = {}
    for (const r of rows) {
      const sp = r.source_platform ?? '(null)'
      const ic = r.intent_class ?? '(null)'
      counts[sp] = counts[sp] ?? {}
      counts[sp][ic] = (counts[sp][ic] ?? 0) + 1
    }
    for (const [sp, byIntent] of Object.entries(counts).sort()) {
      const total = Object.values(byIntent).reduce((a, b) => a + b, 0)
      const parts = Object.entries(byIntent)
        .sort()
        .map(([ic, n]) => `${ic}=${n}`)
        .join(' ')
      console.log(`  ${sp.padEnd(28)} total=${total.toString().padStart(4)}  ${parts}`)
    }
  }
}

console.log(`\nFAILURES: ${inferenceFail}`)
process.exit(inferenceFail > 0 ? 1 : 0)
