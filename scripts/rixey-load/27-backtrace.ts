// Stream QQ step 6: trigger source-backtrace for Rixey.
// findBacktraceCandidates → applyBacktrace for each high/medium-confidence
// candidate. This is what the "Re-attribute scheduling-tool bookings" link
// fires off when a coordinator clicks Apply All on /settings/sources.
//
// useLiveGmail=false to avoid Gmail API quota burn (local interactions
// already cover the venue's ingested email history). Coordinator may
// re-run with live=true later if they want to scan unindexed messages.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { findBacktraceCandidates, applyBacktrace } from '../../src/lib/services/source-backtrace'

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

  // Pre-snapshot lead_source distribution
  const { data: pre } = await sb
    .from('weddings')
    .select('source, lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const preSrc: Record<string, number> = {}, preLead: Record<string, number> = {}
  for (const w of pre ?? []) {
    const s = (w.source as string | null) ?? '(null)'
    const l = (w.lead_source as string | null) ?? '(null)'
    preSrc[s] = (preSrc[s] ?? 0) + 1
    preLead[l] = (preLead[l] ?? 0) + 1
  }

  console.log('Finding backtrace candidates (local interactions only)...')
  const cands = await findBacktraceCandidates(RIXEY_ID, { useLiveGmail: false })
  console.log(`Candidates: ${cands.length}`)
  const byConf: Record<string, number> = {}
  for (const c of cands) {
    byConf[c.confidence] = (byConf[c.confidence] ?? 0) + 1
  }
  console.log('by confidence:', byConf)
  console.log('sample 5:')
  for (const c of cands.slice(0, 5)) {
    console.log(`  ${c.weddingId.slice(0,8)} ${c.coupleNames ?? '?'} ${c.currentSource} → ${c.suggestedSource ?? '(no suggestion)'} [${c.confidence}]`)
  }

  // Apply each high+medium-confidence candidate where suggestedSource is set
  // and differs from currentSource.
  let applied = 0, skipped = 0, failed = 0
  for (const c of cands) {
    if (!c.suggestedSource || c.suggestedSource === c.currentSource) { skipped++; continue }
    if (c.confidence === 'low' || c.confidence === 'none') { skipped++; continue }
    try {
      const r = await applyBacktrace(RIXEY_ID, c.weddingId, c.suggestedSource, null)
      if (r.ok) applied++
      else failed++
    } catch (e) {
      failed++
    }
  }
  console.log(`\nApplied: ${applied}  Skipped: ${skipped}  Failed: ${failed}`)

  // Post snapshot — note backtrace writes weddings.source, NOT lead_source
  const { data: post } = await sb
    .from('weddings')
    .select('source, lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const postSrc: Record<string, number> = {}, postLead: Record<string, number> = {}
  for (const w of post ?? []) {
    const s = (w.source as string | null) ?? '(null)'
    const l = (w.lead_source as string | null) ?? '(null)'
    postSrc[s] = (postSrc[s] ?? 0) + 1
    postLead[l] = (postLead[l] ?? 0) + 1
  }

  console.log('\n=== weddings.source DELTA ===')
  const allSrc = new Set([...Object.keys(preSrc), ...Object.keys(postSrc)])
  console.log('source                        | before -> after  delta')
  for (const k of [...allSrc].sort()) {
    const b = preSrc[k] ?? 0, a = postSrc[k] ?? 0
    if (b !== a) console.log(`${k.padEnd(30)} | ${String(b).padStart(6)} -> ${String(a).padStart(6)}  ${a-b > 0 ? '+' : ''}${a-b}`)
  }

  console.log('\n=== weddings.lead_source DELTA ===')
  const allLead = new Set([...Object.keys(preLead), ...Object.keys(postLead)])
  for (const k of [...allLead].sort()) {
    const b = preLead[k] ?? 0, a = postLead[k] ?? 0
    if (b !== a) console.log(`${k.padEnd(30)} | ${String(b).padStart(6)} -> ${String(a).padStart(6)}  ${a-b > 0 ? '+' : ''}${a-b}`)
  }
  if (preLead === postLead) console.log('(no change — backtrace updates source, not lead_source)')
}
main().catch(e => { console.error(e); process.exit(1) })
