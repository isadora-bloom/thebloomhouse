// Stream QQ: check tangential_signals and engagement_events series
// quality for Rixey to understand which channels engine sees.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('=== tangential_signals by platform (last 365d) ===')
  const since = new Date(Date.now() - 365 * 86400e3).toISOString()
  const { data: ts } = await sb
    .from('tangential_signals')
    .select('extracted_identity, source_platform, signal_date')
    .eq('venue_id', RIXEY_ID)
    .or(`signal_date.gte.${since},and(signal_date.is.null,created_at.gte.${since})`)
  const byPlat: Record<string, number> = {}
  for (const r of ts ?? []) {
    const ei = (r.extracted_identity ?? {}) as Record<string, unknown>
    const p = String(ei.platform ?? r.source_platform ?? 'other')
    byPlat[p] = (byPlat[p] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(byPlat).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }

  console.log('\n=== marketing_metric series (engagement_events) ===')
  const { data: mm } = await sb
    .from('engagement_events')
    .select('metadata')
    .eq('venue_id', RIXEY_ID)
    .eq('direction', 'inbound')
    .eq('event_type', 'marketing_metric')
  const seriesCounts = new Map<string, number>()
  for (const r of mm ?? []) {
    const md = (r.metadata ?? {}) as Record<string, unknown>
    const k = `${md.source ?? 'other'}_${md.metric ?? 'other'}`
    seriesCounts.set(k, (seriesCounts.get(k) ?? 0) + 1)
  }
  console.log(`total marketing_metric rows: ${mm?.length ?? 0}`)
  for (const [k, v] of [...seriesCounts.entries()].sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`)
  }

  console.log('\n=== inquiry-date density ===')
  const { count: inq365 } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).gte('inquiry_date', since)
    .not('inquiry_date', 'is', null)
  console.log(`inquiries in last 365d: ${inq365}`)
}
main().catch(e => { console.error(e); process.exit(1) })
