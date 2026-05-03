// Stream QQ step 4: narrate ONE correlation insight.
//
// Plan: temporarily mark all FRED-FRED only rows as 'snoozed' so the
// generateCorrelationNarrationsForVenue function (which fetches non-
// expired/dismissed rows and ranks by |r| then takes top 5) surfaces
// The Knot rows first. Run with MAX_NARRATIONS_PER_RUN = 1 effective by
// only reading 2 candidates and picking the highest-|r| Knot one.
//
// Brief: "only ONE narration call, only if engine produced ≥|r|=0.4
// insight". The Knot × FRED unemployment is r=-0.71, well above 0.4.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { generateCorrelationNarrationsForVenue } from '../../src/lib/services/insights/correlation-narration'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  // Push into process.env so any callAI / createServiceClient inside the
  // narration pipeline picks them up.
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v as string
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Temporarily snooze all FRED-only-pair rows so the headline-narration
  // pass surfaces The Knot rows. Restore after.
  console.log('Reading current correlation rows...')
  const { data: rows } = await sb
    .from('intelligence_insights')
    .select('id, status, data_points, title')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation')

  // Snooze every row except the highest-|r| The Knot one. Brief says
  // "only ONE narration call".
  const knotRows: Array<{ id: string; r: number; title: string }> = []
  const otherIds: string[] = []
  for (const r of rows ?? []) {
    const dp = r.data_points as { channel_a?: string; channel_b?: string; r?: number } | null
    const a = dp?.channel_a ?? ''
    const b = dp?.channel_b ?? ''
    const isKnot = /the_knot/.test(a) || /the_knot/.test(b)
    if (isKnot) {
      knotRows.push({ id: r.id as string, r: typeof dp?.r === 'number' ? dp.r : 0, title: r.title as string })
    } else {
      otherIds.push(r.id as string)
    }
  }
  knotRows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
  const keepId = knotRows[0]?.id ?? null
  const snoozeIds = [...otherIds, ...knotRows.slice(1).map(k => k.id)]
  console.log(`Knot rows: ${knotRows.length}, keeping id=${keepId} title="${knotRows[0]?.title ?? ''}"`)
  console.log(`Snoozing ${snoozeIds.length} rows so narration only fires once.`)

  if (snoozeIds.length > 0) {
    await sb.from('intelligence_insights')
      .update({ status: 'expired' })
      .in('id', snoozeIds)
  }

  try {
    console.log('\nRunning narration (will hit Sonnet for top remaining row)...')
    const narrations = await generateCorrelationNarrationsForVenue(sb, RIXEY_ID, true)
    console.log(`\nNarrated ${narrations.length} insight(s):`)
    for (const n of narrations) {
      console.log('  ─────────────')
      console.log(`  channels:  ${n.channelALabel} × ${n.channelBLabel}`)
      console.log(`  r=${n.r.toFixed(3)} lag=${n.lagDays}d weak=${n.weakSignal} conf=${n.confidence.toFixed(2)} cached=${n.cached}`)
      console.log(`  TITLE:  ${n.title}`)
      console.log(`  BODY:   ${n.body}`)
      if (n.action) console.log(`  ACTION: ${n.action}`)
    }
  } finally {
    if (snoozeIds.length > 0) {
      console.log('\nRestoring snoozed rows to status=new...')
      await sb.from('intelligence_insights')
        .update({ status: 'new' })
        .in('id', snoozeIds)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
