// Stream QQ: confirm what correlation_narration rows persisted.
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

  const { data: nar } = await sb
    .from('intelligence_insights')
    .select('id, title, body, action, data_points, status, created_at')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation_narration')
    .order('created_at', { ascending: false })
    .limit(20)
  console.log(`correlation_narration rows: ${nar?.length ?? 0}\n`)
  for (const r of nar ?? []) {
    const dp = r.data_points as { channel_a?: string; channel_b?: string; r?: number } | null
    console.log(`---\n${r.created_at} status=${r.status}`)
    console.log(`title: ${r.title}`)
    console.log(`body:  ${r.body}`)
    if (r.action) console.log(`action: ${r.action}`)
    console.log(`channels: ${dp?.channel_a} × ${dp?.channel_b}  r=${dp?.r}`)
  }

  const { data: corr } = await sb
    .from('intelligence_insights')
    .select('id, title, status, data_points')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation')
    .order('created_at', { ascending: false })
  console.log(`\ncorrelation rows: ${corr?.length ?? 0}`)
  const byStatus: Record<string, number> = {}
  for (const r of corr ?? []) {
    const s = r.status as string
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }
  console.log('by status:', byStatus)
}
main().catch(e => { console.error(e); process.exit(1) })
