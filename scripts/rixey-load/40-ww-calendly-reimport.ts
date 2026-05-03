// Stream WW: backfill `interactions.extracted_identity.hear_source`
// (+ utm_*) on the existing Calendly meeting interactions.
//
// Why a backfill, not a re-import:
//   The historical Calendly load (06-calendly.ts via Stream MM) ran
//   BEFORE Stream TT updated the tour-scheduler adapter to write
//   extracted_identity on each per-row interaction. As a result:
//     * 417 Calendly events landed as interactions
//     * 0 of them carry interactions.extracted_identity
//     * Q7 ("where did you hear about us?") answers are sitting in
//       full_body but the lead-source-derivation Priority 2 path
//       reads extracted_identity.hear_source first (then falls back
//       to a body regex). The body fallback only triggers when the
//       phrasing matches a tight regex; Calendly's structured
//       "Question 7 / Response 7" pattern doesn't.
//
//   Re-running 06-calendly.ts would create a second wedding + tour
//   set per couple (the adapter dedups by groupKey within a single
//   parse, but has no cross-run idempotency). So we re-PARSE the
//   CSV to extract the per-row extracted_identity that the new
//   adapter would emit, then UPDATE the existing interaction rows
//   in-place. Match key: body LIKE '%event_uuid:<UUID>%' (the
//   original adapter writes Calendly's Event UUID on the last line
//   of every interaction body — see src/lib/services/crm-import/
//   tour-scheduler.ts L787).
//
// Idempotent:
//   Re-running this script is safe — UPDATE on the same rows
//   produces the same extracted_identity. A row that already has
//   extracted_identity gets the SAME jsonb (overwritten verbatim),
//   not duplicated.
//
// Output:
//   Pre/post counts of interactions with extracted_identity ?
//   'hear_source'. Per-source rough tally. Per-event-uuid match
//   rate (how many CSV rows found a matching interaction).

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { findAdapter, type NormalisedInteractionRow } from '../../src/lib/services/crm-import'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const CSV_PATH = 'C:/Users/Ismar/Downloads/event-data-from-20250504-to-20260503/event-data-from-20250504-to-20260503.csv'

  console.log('=== Stream WW: Calendly extracted_identity backfill ===\n')

  // --------------------------------------------------------------
  // Pre-snapshot
  // --------------------------------------------------------------
  const { count: preCount } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .filter('extracted_identity', 'cs', '{"hear_source":""}') // any hear_source key
  // The cs filter above doesn't match arbitrary values; use a presence check instead:
  const { data: preSampleRows } = await sb
    .from('interactions')
    .select('id, extracted_identity')
    .eq('venue_id', RIXEY_ID)
    .not('extracted_identity', 'is', null)
    .limit(1000)
  const preWithHear = (preSampleRows ?? []).filter((r) => {
    const ei = r.extracted_identity as Record<string, unknown> | null
    return ei && typeof ei === 'object' && ei.hear_source != null
  }).length
  console.log(`Pre: interactions with any extracted_identity (sampled <=1000): ${preSampleRows?.length ?? 0}`)
  console.log(`Pre: of those, with hear_source: ${preWithHear}`)
  void preCount // silenced; the sampled snapshot above is what we report

  // --------------------------------------------------------------
  // Parse the CSV through the new adapter to get per-row
  // extracted_identity payloads.
  // --------------------------------------------------------------
  const adapter = findAdapter('tour_scheduler')
  if (!adapter) throw new Error('tour_scheduler adapter missing')
  const csvText = readFileSync(CSV_PATH, 'utf8')
  const parsed = await adapter.parse({ csvText, provider: 'calendly' })
  if (!parsed.ok) {
    console.error('Parse failed:')
    for (const e of parsed.errors.slice(0, 5)) console.error(' ', e)
    process.exit(1)
  }
  const totalCouples = parsed.rows.length
  let totalEvents = 0
  for (const r of parsed.rows) totalEvents += (r.interactions?.length ?? 0)
  console.log(`\nParsed: ${totalCouples} couples / ${totalEvents} per-row interactions`)

  // --------------------------------------------------------------
  // Walk per-row interactions; pull the event_uuid from the body
  // (last line of body is `event_uuid:<UUID>`) and the
  // extracted_identity the adapter built.
  // --------------------------------------------------------------
  type Update = {
    eventUuid: string
    extractedIdentity: Record<string, unknown>
  }
  const updates: Update[] = []
  let withHearSource = 0
  let noEventUuid = 0
  for (const lead of parsed.rows) {
    for (const i of (lead.interactions ?? []) as NormalisedInteractionRow[]) {
      const body = String(i.body ?? '')
      const m = body.match(/event_uuid:([a-f0-9-]{8,})/i)
      if (!m) {
        noEventUuid++
        continue
      }
      const ei = (i.extracted_identity ?? null) as Record<string, unknown> | null
      if (!ei || typeof ei !== 'object') continue
      if (ei.hear_source) withHearSource++
      updates.push({ eventUuid: m[1], extractedIdentity: ei })
    }
  }
  console.log(`Updates planned: ${updates.length}`)
  console.log(`  with extracted_identity.hear_source: ${withHearSource}`)
  console.log(`  skipped (no event_uuid in body): ${noEventUuid}`)

  // --------------------------------------------------------------
  // Apply updates. Match on full_body LIKE '%event_uuid:<UUID>%'
  // scoped to (venue, type='meeting', crm_source='generic_csv').
  // --------------------------------------------------------------
  let matched = 0
  let unmatched = 0
  let multiMatched = 0
  let updated = 0
  let errors = 0

  for (const u of updates) {
    // Lookup matching interaction(s).
    const { data: rows, error: findErr } = await sb
      .from('interactions')
      .select('id, extracted_identity')
      .eq('venue_id', RIXEY_ID)
      .eq('type', 'meeting')
      .eq('crm_source', 'generic_csv')
      .like('full_body', `%event_uuid:${u.eventUuid}%`)
    if (findErr) {
      console.warn(`find ${u.eventUuid}: ${findErr.message}`)
      errors++
      continue
    }
    if (!rows || rows.length === 0) {
      unmatched++
      continue
    }
    if (rows.length > 1) multiMatched++
    matched++

    // Merge with any existing extracted_identity (preserve other
    // keys; overwrite with our new values for the keys we own).
    for (const r of rows) {
      const existing = (r.extracted_identity ?? {}) as Record<string, unknown>
      const merged = { ...existing, ...u.extractedIdentity }
      const { error: updErr } = await sb
        .from('interactions')
        .update({ extracted_identity: merged })
        .eq('id', r.id)
      if (updErr) {
        console.warn(`update ${r.id}: ${updErr.message}`)
        errors++
      } else {
        updated++
      }
    }
  }

  console.log()
  console.log(`Match results:`)
  console.log(`  matched event_uuid → interaction:    ${matched}`)
  console.log(`  unmatched (csv row had no DB row):   ${unmatched}`)
  console.log(`  multi-matched (>1 DB row per uuid):  ${multiMatched}`)
  console.log(`  rows updated:                        ${updated}`)
  console.log(`  errors:                              ${errors}`)

  // --------------------------------------------------------------
  // Post-snapshot
  // --------------------------------------------------------------
  const { data: postSampleRows } = await sb
    .from('interactions')
    .select('id, extracted_identity')
    .eq('venue_id', RIXEY_ID)
    .eq('type', 'meeting')
    .eq('crm_source', 'generic_csv')
    .not('extracted_identity', 'is', null)
    .limit(2000)
  const postWithHear = (postSampleRows ?? []).filter((r) => {
    const ei = r.extracted_identity as Record<string, unknown> | null
    return ei && typeof ei === 'object' && ei.hear_source != null
  })
  console.log()
  console.log(`Post: meeting/generic_csv interactions with extracted_identity (sampled <=2000): ${postSampleRows?.length ?? 0}`)
  console.log(`Post: of those, with hear_source:                                                ${postWithHear.length}`)

  // Distribution of hear_source values
  const tally = new Map<string, number>()
  for (const r of postWithHear) {
    const ei = r.extracted_identity as Record<string, unknown>
    const k = String(ei.hear_source)
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  console.log()
  console.log('hear_source distribution (post):')
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${String(v).padStart(4)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
