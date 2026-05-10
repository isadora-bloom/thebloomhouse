/**
 * Wave 6A smoke test: exercise recordSpend, summary, and persona overlay
 * against the live DB.
 *
 * Usage: npx tsx scripts/smoke-wave-6a.ts
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY. Cleans up its test rows at the end so the
 * script can be re-run.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

async function main() {
  const env = loadEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const { data: anyVenue, error: venueErr } = await sb
    .from('venues')
    .select('id, name')
    .limit(1)
    .maybeSingle()
  if (venueErr || !anyVenue) {
    console.error('No venue found to test against.', venueErr?.message)
    process.exit(1)
  }
  const venueId = (anyVenue as { id: string; name: string }).id
  const venueName = (anyVenue as { id: string; name: string }).name
  console.log(`\nUsing test venue: ${venueName} (${venueId})\n`)

  const { recordSpend } = await import('../src/lib/services/marketing-spend/ingest')

  // ---------- Test 1: insert a manual spend row ----------
  const TEST_DATE = '2026-05-09'
  const TEST_CHANNEL = 'google_ads'
  const TEST_CAMPAIGN_ID = 'wave6a-smoke-001'

  console.log('[1/5] insert a manual spend row')
  const r1 = await recordSpend({
    venueId,
    channel: TEST_CHANNEL,
    campaignId: TEST_CAMPAIGN_ID,
    campaignName: 'Wave 6A smoke test',
    spendDate: TEST_DATE,
    amountCents: 4250,
    currency: 'USD',
    sourcePayload: { test: true },
    ingestedBy: 'smoke_test',
  })
  console.log('  result:', r1)
  if (!r1.ok || !r1.inserted) throw new Error('expected insert')

  // ---------- Test 2: re-insert returns duplicate (idempotency) ----------
  console.log('[2/5] re-insert same row → duplicate')
  const r2 = await recordSpend({
    venueId,
    channel: TEST_CHANNEL,
    campaignId: TEST_CAMPAIGN_ID,
    campaignName: 'Wave 6A smoke test',
    spendDate: TEST_DATE,
    amountCents: 4250,
    currency: 'USD',
    ingestedBy: 'smoke_test',
  })
  console.log('  result:', r2)
  if (!r2.ok || r2.inserted) throw new Error('expected duplicate')

  // ---------- Test 3: summary endpoint logic — sum cents ----------
  console.log('[3/5] summary: sum amount_cents for venue')
  const { data: summaryRows } = await sb
    .from('marketing_spend_records')
    .select('amount_cents')
    .eq('venue_id', venueId)
  const total = (summaryRows ?? []).reduce(
    (acc, r) => acc + ((r as { amount_cents: number }).amount_cents || 0),
    0,
  )
  console.log(`  total cents: ${total}`)
  if (total < 4250) throw new Error('expected total >= 4250')

  // ---------- Test 4: persona-overlay attach ----------
  console.log('[4/5] persona-overlay attach (smoke)')
  const { data: attrRow } = await sb
    .from('attribution_events')
    .select('id, wedding_id, venue_id')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .limit(1)
    .maybeSingle()

  if (!attrRow) {
    console.log('  no attribution_events rows for this venue — skip overlay test')
  } else {
    const { data: intelRow } = await sb
      .from('couple_intel')
      .select('wedding_id, persona_label')
      .eq('wedding_id', (attrRow as { wedding_id: string }).wedding_id)
      .maybeSingle()
    if (!intelRow) {
      console.log('  no couple_intel for that wedding — skip overlay test')
    } else {
      const { attachPersonaToAttributionEvent } = await import(
        '../src/lib/services/marketing-spend/persona-overlay'
      )
      const r = await attachPersonaToAttributionEvent({
        attributionEventId: (attrRow as { id: string }).id,
      })
      console.log('  attach result:', r)
      const { data: refresh } = await sb
        .from('attribution_events')
        .select('id, persona_overlay')
        .eq('id', (attrRow as { id: string }).id)
        .maybeSingle()
      console.log('  persona_overlay after attach:', (refresh as { persona_overlay: unknown }).persona_overlay)
    }
  }

  // ---------- Test 5: cleanup ----------
  console.log('[5/5] cleanup')
  const { error: delErr, count: delCount } = await sb
    .from('marketing_spend_records')
    .delete({ count: 'exact' })
    .eq('venue_id', venueId)
    .eq('ingested_by', 'smoke_test')
  console.log(`  deleted ${delCount ?? '?'} smoke test row(s); err=${delErr?.message ?? '—'}`)

  console.log('\nWave 6A smoke test PASSED.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
