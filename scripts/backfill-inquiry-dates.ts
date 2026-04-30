// Backfill weddings.inquiry_date from the most authoritative source
// available, in priority order:
//
//   1. wedding_touchpoints.occurred_at WHERE touch_type='inquiry'
//      — the touchpoint mapper has already identified this as the
//      inquiry event. Most reliable when present.
//
//   2. Earliest inbound interaction.timestamp where the linked
//      intelligence_extractions classification = 'new_inquiry'
//      — picks the actual inquiry email when there are also
//      Calendly notifications, follow-up replies, etc.
//
//   3. Earliest inbound interaction.timestamp (any classification)
//      — last-resort proxy for weddings without classification rows.
//
// 2026-04-30: previous version of this script used (3) only and
// regressed weddings whose earliest inbound was a Calendly tour-
// notification email. Ryan Schubert's wedding had inquiry_date set
// to Mar 29 22:40 (Calendly notification day) instead of Apr 23 16:20
// (real inquiry day) until this rewrite.
//
// Update threshold: > 48h drift between current inquiry_date and the
// chosen new value. Below that, leave the row alone (already accurate
// or close enough; not worth churning).
//
// Usage:
//   npx tsx scripts/backfill-inquiry-dates.ts                # dry-run
//   npx tsx scripts/backfill-inquiry-dates.ts --apply
//   npx tsx scripts/backfill-inquiry-dates.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const MIN_DRIFT_HOURS = 48

interface Wedding {
  id: string
  inquiry_date: string | null
}

type Source = 'inquiry_touchpoint' | 'classified_interaction' | 'earliest_interaction' | 'none'

async function pickInquiryDate(weddingId: string): Promise<{ value: string | null; source: Source }> {
  // Priority 1: inquiry touchpoint
  const { data: tp } = await sb
    .from('wedding_touchpoints')
    .select('occurred_at')
    .eq('wedding_id', weddingId)
    .eq('touch_type', 'inquiry')
    .order('occurred_at', { ascending: true })
    .limit(1)
  const tpRow = tp?.[0] as { occurred_at: string | null } | undefined
  if (tpRow?.occurred_at) return { value: tpRow.occurred_at, source: 'inquiry_touchpoint' }

  // Priority 2: earliest inbound interaction with new_inquiry
  // classification.
  const { data: classified } = await sb
    .from('interactions')
    .select('id, timestamp, intelligence_extractions(classification)')
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .not('timestamp', 'is', null)
    .order('timestamp', { ascending: true })
  type Row = { id: string; timestamp: string; intelligence_extractions?: Array<{ classification: string | null }> | { classification: string | null } | null }
  for (const r of (classified ?? []) as Row[]) {
    const ext = r.intelligence_extractions
    const cls = Array.isArray(ext) ? ext[0]?.classification : ext?.classification
    if (cls === 'new_inquiry' && r.timestamp) {
      return { value: r.timestamp, source: 'classified_interaction' }
    }
  }

  // Priority 3: earliest inbound, any classification
  const earliest = ((classified ?? []) as Row[])[0]
  if (earliest?.timestamp) return { value: earliest.timestamp, source: 'earliest_interaction' }

  return { value: null, source: 'none' }
}

async function main() {
  console.log(`\n=== Backfill inquiry_date — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  const PAGE = 500
  let offset = 0
  let scanned = 0
  let needsUpdate = 0
  let updated = 0
  let alreadyAccurate = 0
  let noSource = 0
  const sourceCounts: Record<Source, number> = {
    inquiry_touchpoint: 0,
    classified_interaction: 0,
    earliest_interaction: 0,
    none: 0,
  }
  const samples: Array<{ id: string; was: string; will: string; driftDays: number; source: Source }> = []

  for (;;) {
    const { data: weddings, error } = await sb
      .from('weddings')
      .select('id, inquiry_date')
      .eq('venue_id', venueId)
      .range(offset, offset + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) {
      console.error(`fetch weddings @${offset}: ${error.message}`)
      break
    }
    const page = (weddings ?? []) as Wedding[]
    if (page.length === 0) break

    for (const w of page) {
      scanned++
      const { value, source } = await pickInquiryDate(w.id)
      sourceCounts[source]++
      if (!value) {
        noSource++
        continue
      }

      const currentTs = w.inquiry_date ? new Date(w.inquiry_date).getTime() : null
      const newTs = new Date(value).getTime()
      if (isNaN(newTs)) continue

      // Skip if drift is below threshold (already accurate enough).
      if (currentTs !== null && Math.abs(newTs - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
        alreadyAccurate++
        continue
      }

      const driftDays = currentTs !== null
        ? Math.round(((newTs - currentTs) / 86_400_000) * 10) / 10
        : 0
      needsUpdate++
      if (samples.length < 8) {
        samples.push({
          id: w.id,
          was: w.inquiry_date ?? 'null',
          will: value,
          driftDays,
          source,
        })
      }

      if (apply) {
        const { error: updErr } = await sb
          .from('weddings')
          .update({ inquiry_date: value })
          .eq('id', w.id)
        if (updErr) {
          console.error(`  update ${w.id}: ${updErr.message}`)
        } else {
          updated++
        }
      }
    }

    if (page.length < PAGE) break
    offset += PAGE
  }

  console.log(`scanned:               ${scanned}`)
  console.log(`already accurate:      ${alreadyAccurate}`)
  console.log(`needs update:          ${needsUpdate}`)
  if (apply) console.log(`updated:               ${updated}`)
  console.log(`no source available:   ${noSource}`)
  console.log(`\nsource distribution (per wedding):`)
  console.log(`  inquiry_touchpoint:  ${sourceCounts.inquiry_touchpoint}`)
  console.log(`  classified inbound:  ${sourceCounts.classified_interaction}`)
  console.log(`  earliest inbound:    ${sourceCounts.earliest_interaction}`)
  console.log(`  none:                ${sourceCounts.none}`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} drift sample${samples.length === 1 ? '' : 's'}:`)
    for (const s of samples) {
      console.log(`  ${s.id} (source: ${s.source}, drift ${s.driftDays > 0 ? '+' : ''}${s.driftDays}d)`)
      console.log(`    was:  ${s.was}`)
      console.log(`    will: ${s.will}`)
    }
  }
  if (!apply && needsUpdate > 0) {
    console.log(`\nDry-run complete. Re-run with --apply to write updates.`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
