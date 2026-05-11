/**
 * Wave 14 resolver smoke test — confirms attribution_event write when
 * a referrer name matches a real Rixey couple.
 *
 * Run with:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave-14-resolve.ts
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(): Record<string, string> {
  try {
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
  } catch {
    return {}
  }
}

const fileEnv = loadEnv()
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(url, serviceKey)
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  // Find two real booked weddings at Rixey: one to be "the new couple",
  // one to be "the referrer past couple".
  const { data: peopleData } = await supabase
    .from('people')
    .select('wedding_id, first_name, last_name, role, weddings!inner(venue_id, merged_into_id, booked_at)')
    .eq('venue_id', RIXEY)
    .eq('role', 'partner1')
    .is('merged_into_id', null)
    .not('first_name', 'is', null)
    .not('last_name', 'is', null)
    .limit(50)

  const people = (peopleData ?? []) as unknown as Array<{
    wedding_id: string
    first_name: string
    last_name: string
    weddings:
      | { venue_id: string; merged_into_id: string | null; booked_at: string | null }
      | Array<{ venue_id: string; merged_into_id: string | null; booked_at: string | null }>
  }>
  const normalized = people.map((p) => {
    const w = Array.isArray(p.weddings) ? p.weddings[0] : p.weddings
    return { ...p, weddings: w }
  }).filter((p) => !!p.weddings)
  const filtered = normalized.filter(
    (p) =>
      !p.weddings!.merged_into_id
      && p.weddings!.booked_at !== null
      && p.first_name
      && p.last_name
      && p.first_name.length >= 3
      && p.last_name.length >= 3,
  )
  if (filtered.length < 2) {
    console.error('Need at least 2 booked Rixey couples with full names — got', filtered.length)
    process.exit(1)
  }
  const referrer = filtered[0]
  const newCouple = filtered.find((p) => p.wedding_id !== referrer.wedding_id)!

  console.log(`Referrer (past couple): ${referrer.first_name} ${referrer.last_name} (wedding ${referrer.wedding_id})`)
  console.log(`New couple: wedding ${newCouple.wedding_id}`)

  // Synthesize a referrer mention against the new couple, naming the
  // referrer.
  const { resolveReferrer } = await import('../src/lib/services/intel/referrals/resolve')
  const result = await resolveReferrer({
    newWeddingId: newCouple.wedding_id,
    venueId: RIXEY,
    mention: {
      referrer_name: `${referrer.first_name} ${referrer.last_name}`,
      relationship_to_couple: 'past_couple',
      evidence_quote: `${referrer.first_name} ${referrer.last_name} recommended you to us`,
      confidence_0_100: 90,
    },
  })
  console.log('Resolution result:', result)

  if (result.kind === 'matched') {
    // Read back the attribution_event row to confirm
    const { data: row } = await supabase
      .from('attribution_events')
      .select('id, wedding_id, referrer_wedding_id, referrer_name_text, referrer_relationship_text, referrer_evidence_quote, referrer_confidence_0_100, referral_resolved_at, tier, decided_by, confidence, bucket, reasoning')
      .eq('id', result.attributionEventId)
      .maybeSingle()
    console.log('Stored attribution_event row:', JSON.stringify(row, null, 2))
    if (row && (row as any).referrer_wedding_id === referrer.wedding_id) {
      console.log('SUCCESS — attribution_event linked new couple to referrer wedding')
    } else {
      console.error('FAILURE — referrer_wedding_id mismatch')
    }
    // Cleanup: delete the synthetic attribution_event row so the test is non-destructive.
    await supabase.from('attribution_events').delete().eq('id', result.attributionEventId)
    console.log('Cleaned up synthetic attribution_event row')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
