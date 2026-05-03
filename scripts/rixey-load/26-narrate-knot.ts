// Stream QQ step 4 (re-do): narrate ONLY the Knot × FRED unemployment row.
// Mark all other correlation rows status='expired' so the narration
// function can't pick them up. (Earlier 'snoozed' attempt failed silently
// because 'snoozed' is not a valid status.) Capture text for the report.
//
// NOTE: prior run already burnt 5 LLM calls because the snooze didn't
// take effect. This run cleans up the FRED rows properly and generates
// exactly one Knot narration.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { generateCorrelationNarrationsForVenue } from '../../src/lib/services/insights/correlation-narration'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v as string
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  const { data: rows } = await sb
    .from('intelligence_insights')
    .select('id, status, data_points, title')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation')
  if (!rows) { console.error('no rows'); process.exit(1) }

  const knotRows: Array<{ id: string; r: number; title: string }> = []
  const otherIds: string[] = []
  for (const r of rows) {
    const dp = r.data_points as { channel_a?: string; channel_b?: string; r?: number } | null
    const a = dp?.channel_a ?? ''
    const b = dp?.channel_b ?? ''
    const isKnot = /the_knot/.test(a) || /the_knot/.test(b)
    if (isKnot) knotRows.push({ id: r.id as string, r: typeof dp?.r === 'number' ? dp.r : 0, title: r.title as string })
    else otherIds.push(r.id as string)
  }
  knotRows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
  const keepRow = knotRows[0]
  const expireIds = [...otherIds, ...knotRows.slice(1).map(k => k.id)]
  console.log(`Keeping: ${keepRow?.title}`)
  console.log(`Expiring ${expireIds.length} other rows so narration only fires once.`)

  const { error: expErr } = await sb.from('intelligence_insights')
    .update({ status: 'expired' }).in('id', expireIds)
  if (expErr) { console.error('expire failed:', expErr); process.exit(1) }

  let narrationOut: { title: string; body: string; action: string | null; r: number; pValue: number; weak: boolean } | null = null
  try {
    console.log('\nRunning narration (1 LLM call expected)...')
    const narrations = await generateCorrelationNarrationsForVenue(sb, RIXEY_ID, true)
    console.log(`Narrated ${narrations.length} insight(s).`)
    for (const n of narrations) {
      console.log('  ─────────────')
      console.log(`  channels:  ${n.channelALabel} × ${n.channelBLabel}`)
      console.log(`  r=${n.r.toFixed(3)} lag=${n.lagDays}d weak=${n.weakSignal} conf=${n.confidence.toFixed(2)}`)
      console.log(`  TITLE:  ${n.title}`)
      console.log(`  BODY:   ${n.body}`)
      if (n.action) console.log(`  ACTION: ${n.action}`)
      // Capture the Knot one
      if (/the_knot|the knot/i.test(n.channelALabel) || /the_knot|the knot/i.test(n.channelBLabel)) {
        narrationOut = { title: n.title, body: n.body, action: n.action, r: n.r, pValue: n.pValue, weak: n.weakSignal }
      }
    }
  } finally {
    console.log('\nRestoring expired rows to status=new...')
    const { error: restErr } = await sb.from('intelligence_insights')
      .update({ status: 'new' }).in('id', expireIds)
    if (restErr) console.warn('restore failed:', restErr)
  }

  if (narrationOut) {
    console.log('\n=== CAPTURED KNOT NARRATION ===')
    console.log(JSON.stringify(narrationOut, null, 2))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
