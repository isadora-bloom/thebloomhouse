// T5-Rixey-NN: backfill lead_source for the 13 web-form weddings whose
// derivation produced '</strong>'. After bug #7 fix, the chain rejects
// HTML fragments and falls through to lower-priority strategies.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { deriveLeadSourceForWedding } from '../../src/lib/services/attribution/lead-source-derivation'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      })
  )

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // 1. Find the affected rows. After the first pass HTML rows became
  // garbage Calendly-footer strings — match those too.
  const { data: bad1 } = await sb
    .from('weddings')
    .select('id, venue_id, source, source_records, attribution_priority, source_detail, inquiry_date, lead_source')
    .eq('venue_id', RIXEY)
    .like('lead_source', '%<%')
  const { data: bad2 } = await sb
    .from('weddings')
    .select('id, venue_id, source, source_records, attribution_priority, source_detail, inquiry_date, lead_source')
    .eq('venue_id', RIXEY)
    .or('lead_source.ilike.%calendly%,lead_source.ilike.%pro tip%,lead_source.ilike.%view event%')
  const seen = new Set<string>()
  const bad = [...(bad1 ?? []), ...(bad2 ?? [])].filter((w: any) => {
    if (seen.has(w.id)) return false
    seen.add(w.id)
    return true
  })

  console.log(`weddings with HTML in lead_source: ${bad?.length ?? 0}`)
  for (const w of (bad ?? []).slice(0, 5)) {
    console.log(`  ${w.id}  lead_source=${JSON.stringify(w.lead_source)}`)
  }

  if (!bad || bad.length === 0) {
    console.log('nothing to backfill')
    return
  }

  // 2. Clear lead_source so the priority chain re-runs cleanly.
  const ids = bad.map((w: any) => w.id)
  const { error: clearErr } = await sb.from('weddings').update({ lead_source: null }).in('id', ids)
  if (clearErr) {
    console.error('clear error', clearErr)
    process.exit(1)
  }
  console.log(`cleared lead_source on ${ids.length} weddings`)

  // 3. Re-run derivation per wedding.
  let stamped = 0
  let stillNoSignal = 0
  let stillHtml = 0
  const stampedSources: Record<string, number> = {}
  for (const w of bad as any[]) {
    const derived = await deriveLeadSourceForWedding(sb as any, {
      id: w.id,
      venue_id: w.venue_id,
      inquiry_date: w.inquiry_date,
      source_records: Array.isArray(w.source_records) ? w.source_records : [],
      attribution_priority: w.attribution_priority,
      source: w.source,
      source_detail: w.source_detail,
    })
    if (derived.source && /[<>]/.test(derived.source)) {
      stillHtml++
      console.log(`  STILL HTML: ${w.id} → ${derived.source} (priority=${derived.priority})`)
      continue
    }
    if (!derived.source) {
      stillNoSignal++
      continue
    }
    await sb.from('weddings').update({ lead_source: derived.source }).eq('id', w.id)
    stamped++
    stampedSources[derived.source] = (stampedSources[derived.source] ?? 0) + 1
  }

  console.log()
  console.log('post-derivation summary:')
  console.log(`  stamped with real source: ${stamped}`, stampedSources)
  console.log(`  no_signal (NULL)        : ${stillNoSignal}`)
  console.log(`  STILL HTML (BUG)        : ${stillHtml}`)

  // Re-verify.
  const { data: after } = await sb
    .from('weddings')
    .select('id, lead_source')
    .eq('venue_id', RIXEY)
    .like('lead_source', '%<%')
  console.log(`weddings with HTML in lead_source AFTER fix: ${after?.length ?? 0}`)

  const { data: afterGarbage } = await sb
    .from('weddings')
    .select('id, lead_source')
    .eq('venue_id', RIXEY)
    .or('lead_source.ilike.%calendly%,lead_source.ilike.%pro tip%,lead_source.ilike.%view event%')
  console.log(`weddings with calendly-footer noise in lead_source AFTER fix: ${afterGarbage?.length ?? 0}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
