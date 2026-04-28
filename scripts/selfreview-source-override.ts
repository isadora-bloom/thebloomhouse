// Self-review for the inline source override:
//   1. POST with a valid canonical source flips weddings.source AND
//      the inquiry touchpoint source.
//   2. Audit trail (backtraced_from / backtraced_to / backtraced_at /
//      backtraced_by) is recorded.
//   3. POST with a bogus source is rejected by the API contract
//      (we exercise applyBacktrace direct here; the API layer is
//      tested by typecheck + the canonical-source whitelist).
//   4. Cross-venue safety: applyBacktrace with a wedding that does
//      not belong to the asserted venueId returns ok: false.
//   5. Round-trip: restore the original source so this script is
//      idempotent.
import { applyBacktrace } from '../src/lib/services/source-backtrace'
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
  console.log(`\n=== Source override self-review (venue ${RIXEY.slice(0, 8)}) ===\n`)

  const { data: candidate } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY)
    .eq('source', 'calendly')
    .limit(1)
  const target = (candidate ?? [])[0] as { id: string; source: string } | undefined
  if (!target) {
    console.log('No calendly-source wedding to test on; aborting.')
    return
  }
  const original = target.source
  console.log(`target wedding: ${target.id.slice(0, 8)} (currently ${original})`)

  // CHECK 1+2: apply override
  const override = 'website'
  console.log(`\n[1+2] applying override: ${original} → ${override}`)
  const r = await applyBacktrace(RIXEY, target.id, override, 'selfreview-override')
  console.log(`  result: ok=${r.ok} oldSource=${r.oldSource}`)

  const { data: w } = await sb.from('weddings').select('source').eq('id', target.id).maybeSingle()
  const { data: tp } = await sb
    .from('wedding_touchpoints')
    .select('source, metadata')
    .eq('wedding_id', target.id)
    .eq('touch_type', 'inquiry')
    .maybeSingle()
  const tpRow = tp as { source: string; metadata: Record<string, unknown> } | null
  const meta = tpRow?.metadata ?? {}
  console.log(`  weddings.source         = ${(w as { source: string } | null)?.source}`)
  console.log(`  inquiry-tp.source       = ${tpRow?.source}`)
  console.log(`  metadata.backtraced_from= ${meta.backtraced_from}`)
  console.log(`  metadata.backtraced_to  = ${meta.backtraced_to}`)
  console.log(`  metadata.backtraced_by  = ${meta.backtraced_by}`)
  console.log(`  metadata.backtraced_at  = ${meta.backtraced_at}`)

  // CHECK 4: cross-venue safety — assert from a fake venue
  console.log(`\n[4] cross-venue safety`)
  const fakeVenue = '00000000-0000-0000-0000-000000000000'
  const cross = await applyBacktrace(fakeVenue, target.id, 'the_knot', 'selfreview-cross')
  console.log(`  result: ok=${cross.ok} (expect false)`)

  // CHECK 5: restore
  console.log(`\n[5] restoring original source: ${original}`)
  await applyBacktrace(RIXEY, target.id, original, 'selfreview-restore')
  const { data: w2 } = await sb.from('weddings').select('source').eq('id', target.id).maybeSingle()
  console.log(`  weddings.source = ${(w2 as { source: string } | null)?.source}`)

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
