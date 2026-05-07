// Verifies migration 196 (tour temporal layer) is applied, then runs the
// tour-outcome classifier against Rixey. Run AFTER pasting
// supabase/migrations/196_tour_temporal.sql into the Supabase SQL editor.
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

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // (1) Verify 196 applied: tours.couple_display_name column should exist.
  const { error: colErr } = await sb
    .from('tours')
    .select('id, couple_display_name, scheduled_at, outcome')
    .eq('venue_id', RIXEY)
    .limit(1)
  if (colErr) {
    console.error('❌ Migration 196 not applied:', colErr.message)
    console.error('   Paste supabase/migrations/196_tour_temporal.sql into the Supabase SQL editor first.')
    process.exit(1)
  }
  console.log('✓ Migration 196 applied (tours.couple_display_name present)')

  // (2) Verify 197 applied: cultural_moments score CHECK + sub-tabs.
  // Easiest probe: try inserting a row with influence_weight=999 (should fail).
  // But that's destructive; instead just check that the column exists at the expected scale.
  const { data: cmRow, error: cmErr } = await sb
    .from('cultural_moments')
    .select('id, influence_weight, confidence')
    .limit(1)
  if (cmErr) {
    console.error('? Cultural moments check failed:', cmErr.message)
  } else {
    console.log(`✓ cultural_moments table accessible (${cmRow?.length ?? 0} rows sampled)`)
  }

  // (3) Pre-classification snapshot: how many pending Rixey tours past due?
  const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString() // scheduled_at + 90min
  const { data: pendingTours, error: ptErr } = await sb
    .from('tours')
    .select('id, scheduled_at, outcome, couple_display_name')
    .eq('venue_id', RIXEY)
    .or('outcome.is.null,outcome.eq.pending')
    .lt('scheduled_at', cutoff)
  if (ptErr) { console.error('pending-tours fetch failed:', ptErr.message); process.exit(1) }
  console.log(`\nPre-classification: ${pendingTours?.length ?? 0} Rixey tours past-due with outcome IN (pending, NULL)`)
  if ((pendingTours?.length ?? 0) > 0) {
    console.log(`  sample first 5:`)
    for (const t of (pendingTours ?? []).slice(0, 5)) {
      console.log(`    ${(t.id as string).slice(0, 8)}… scheduled=${t.scheduled_at} couple=${t.couple_display_name ?? '—'}`)
    }
  }

  // (4) Run the classifier.
  console.log(`\nRunning classifier for Rixey…`)
  const { classifyTourOutcomes } = await import('../../src/lib/services/tour/outcome-classifier')
  const result = await classifyTourOutcomes(sb as Parameters<typeof classifyTourOutcomes>[0], RIXEY)
  console.log('\nClassifier result:')
  console.log(JSON.stringify(result, null, 2))

  // (5) Post-snapshot.
  const { data: postTours } = await sb
    .from('tours')
    .select('outcome', { count: 'exact' })
    .eq('venue_id', RIXEY)
    .or('outcome.is.null,outcome.eq.pending')
    .lt('scheduled_at', cutoff)
  console.log(`\nPost-classification: ${postTours?.length ?? 0} Rixey tours still pending past-due`)
}

main().catch((e) => { console.error(e); process.exit(1) })
