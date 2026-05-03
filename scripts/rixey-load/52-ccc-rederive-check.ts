/**
 * T5-Rixey-CCC follow-up: count NULL-lead_source weddings and re-run
 * derivation, force-bypassing the 30d reattempt cooldown so the new
 * attribution_events from CCC backtrack get picked up immediately.
 *
 * Run: npx tsx scripts/rixey-load/52-ccc-rederive-check.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { deriveLeadSourceForWedding } from '../../src/lib/services/lead-source-derivation'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  // Count distinct lead_source values pre-rederive.
  const { count: nullBefore } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
    .is('lead_source', null)
  console.log(`weddings with NULL lead_source: ${nullBefore}`)

  const { count: knotBefore } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
    .eq('lead_source', 'the_knot')
  console.log(`weddings with lead_source=the_knot: ${knotBefore}`)

  // Pull all NULL-lead_source weddings, BYPASSING the 30d reattempt
  // cooldown by clearing lead_source_derivation_attempted_at first.
  const { data: nullWeds } = await sb
    .from('weddings')
    .select('id, venue_id, inquiry_date, source_records, attribution_priority, source, source_detail')
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .order('inquiry_date', { ascending: false, nullsFirst: false })
    .limit(2000)
  console.log(`scanning ${(nullWeds ?? []).length} NULL-lead_source weddings`)

  let derived = 0
  let noSig = 0
  const perPriority: Record<number, number> = {}
  const perSource: Record<string, number> = {}
  for (const w of (nullWeds ?? []) as any[]) {
    const wedding = {
      id: String(w.id),
      venue_id: String(w.venue_id),
      inquiry_date: w.inquiry_date,
      source_records: Array.isArray(w.source_records) ? w.source_records : [],
      attribution_priority: w.attribution_priority,
      source: w.source ?? null,
      source_detail: w.source_detail ?? null,
    }
    try {
      const d = await deriveLeadSourceForWedding(sb as any, wedding as any)
      perPriority[d.priority] = (perPriority[d.priority] ?? 0) + 1
      const attemptedAt = new Date().toISOString()
      if (d.source) {
        await sb
          .from('weddings')
          .update({
            lead_source: d.source,
            lead_source_derivation_attempted_at: attemptedAt,
          })
          .eq('id', w.id)
          .is('lead_source', null)
        derived++
        perSource[d.source] = (perSource[d.source] ?? 0) + 1
      } else {
        await sb
          .from('weddings')
          .update({ lead_source_derivation_attempted_at: attemptedAt })
          .eq('id', w.id)
        noSig++
      }
      // Audit log row.
      await sb.from('lead_source_derivation_log').insert({
        venue_id: w.venue_id,
        wedding_id: w.id,
        derived_source: d.source,
        priority_used: d.priority,
        evidence: d.evidence,
        confidence: d.confidence,
        decided_by: 'auto',
      })
    } catch (e) {
      console.warn(`  derive failed for ${w.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`derived: ${derived}`)
  console.log(`no_signal: ${noSig}`)
  console.log(`per priority: ${JSON.stringify(perPriority)}`)
  console.log(`per source (newly derived):`)
  for (const [k, v] of Object.entries(perSource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  // After.
  const { count: nullAfter } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
    .is('lead_source', null)
  const { count: knotAfter } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .is('merged_into_id', null)
    .eq('lead_source', 'the_knot')

  console.log(`\nweddings with NULL lead_source AFTER:    ${nullAfter}`)
  console.log(`weddings with lead_source=the_knot AFTER: ${knotAfter}`)
  console.log(`Δ the_knot:  ${(knotAfter ?? 0) - (knotBefore ?? 0)}`)
  console.log(`Δ NULL:      ${(nullAfter ?? 0) - (nullBefore ?? 0)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
