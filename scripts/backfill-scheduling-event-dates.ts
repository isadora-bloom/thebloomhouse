// Backfill engagement_events.occurred_at, wedding_touchpoints.occurred_at,
// and weddings.tour_date from `metadata.event_datetime` for rows
// originating from scheduling-tool emails.
//
// 2026-04-30: email-pipeline used to pass `email.date` (notification
// arrival) as occurredAt for tour_scheduled / tour_completed events.
// The schedulingEvent.eventDatetime (the actual tour time) was only
// stored in metadata.event_datetime, never used as the row's
// occurred_at. Result: a Calendly notification arriving Mar 29 about
// a tour scheduled for Apr 13 produced a wedding_touchpoints row
// dated Mar 29 — wrong on the journey UI and wrong for ±72h matching.
//
// This script reads metadata.event_datetime from existing rows and
// rewrites occurred_at to that value when:
//   - metadata.event_datetime parses cleanly
//   - it differs from the current occurred_at by > 24h
//
// Idempotent. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-scheduling-event-dates.ts                 # dry-run
//   npx tsx scripts/backfill-scheduling-event-dates.ts --apply
//   npx tsx scripts/backfill-scheduling-event-dates.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { parseCalendlyDatetime } from '../src/lib/services/scheduling-tool-parsers'

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

const MIN_DRIFT_HOURS = 24

function parseEventTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  // Direct parse first (handles ISO).
  const direct = new Date(value)
  if (!isNaN(direct.getTime())) return direct.toISOString()
  // Calendly stores eventDatetime in human form like
  // "10:45am - Wednesday, April 29, 2026 (Eastern Time - US & Canada)".
  // The shared scheduling parser handles the dash-separated, no-space-
  // before-am/pm, weekday-prefix variant — reuse it.
  const ts = parseCalendlyDatetime(value)
  if (ts !== null) return new Date(ts).toISOString()
  return null
}

/**
 * Some pre-fix Calendly emails wrote junk into metadata.event_datetime
 * (e.g. "</strong>") because the parser regex captured an HTML
 * fragment. Their metadata.subject still contains the correct human
 * datetime — Calendly subjects look like:
 *   "New Event: Ryan Schubert - 06:00pm Mon, Apr 13, 2026 - Rixey Manor Venue Tour"
 *   "Canceled: 10:45am - Wednesday, April 29, 2026 - <Event Type>"
 * Pull the time/day from the subject as a last-tier fallback.
 */
function parseFromSubject(subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject) return null
  // Match either "HH:MMam Day, Mon DD, YYYY" or "HH:MMam DayName,
  // Month DD, YYYY". Both shapes appear in real Rixey data.
  const m = subject.match(/(\d{1,2}:\d{2}\s*(?:am|pm))\s+(?:[A-Za-z]+,?\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i)
  if (!m) return null
  const time = m[1].replace(/(\d)(am|pm)/i, '$1 $2').toUpperCase()
  const date = m[2]
  const t = Date.parse(`${date} ${time}`)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

function pickEventTime(metadata: { event_datetime?: string | null; subject?: string | null } | null): string | null {
  if (!metadata) return null
  return parseEventTime(metadata.event_datetime) ?? parseFromSubject(metadata.subject)
}

interface Stats {
  scanned: number
  updated: number
  skippedNoMetadata: number
  skippedAlreadyAccurate: number
  skippedUnparseable: number
}

function newStats(): Stats {
  return { scanned: 0, updated: 0, skippedNoMetadata: 0, skippedAlreadyAccurate: 0, skippedUnparseable: 0 }
}

async function backfillEngagementEvents(): Promise<Stats> {
  const stats = newStats()
  const PAGE = 500
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('engagement_events')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .in('event_type', ['tour_scheduled', 'tour_completed', 'tour_cancelled', 'contract_signed'])
      .range(from, from + PAGE - 1)
    if (error) { console.error(`engagement_events @${from}: ${error.message}`); break }
    const rows = (data ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      stats.scanned++
      const correct = pickEventTime(r.metadata)
      if (!correct) {
        if (!r.metadata?.event_datetime && !r.metadata?.subject) stats.skippedNoMetadata++
        else stats.skippedUnparseable++
        continue
      }
      const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
      if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
        stats.skippedAlreadyAccurate++
        continue
      }
      if (apply) {
        const { error: updErr } = await sb
          .from('engagement_events')
          .update({ occurred_at: correct })
          .eq('id', r.id)
        if (!updErr) stats.updated++
        else console.error(`  ee ${r.id}: ${updErr.message}`)
      } else {
        stats.updated++
      }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  return stats
}

/**
 * Propagate from sibling: when a tour_conducted / contract_signed
 * touchpoint has no parseable metadata, look for a tour_scheduled
 * engagement_event on the same wedding with the same interaction_id
 * and copy its (already-corrected) occurred_at. Catches the rare
 * case where the live pipeline wrote one row's metadata cleanly but
 * not its sibling — typically because Calendly's HTML body parsing
 * picked up a tag boundary on one extraction pass and not the other.
 */
async function backfillTouchpointsFromSiblings(): Promise<Stats> {
  const stats = newStats()
  const { data } = await sb
    .from('wedding_touchpoints')
    .select('id, wedding_id, occurred_at, metadata, touch_type')
    .eq('venue_id', venueId)
    .in('touch_type', ['tour_conducted', 'contract_signed', 'tour_booked', 'calendly_booked'])
  const rows = (data ?? []) as Array<{ id: string; wedding_id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null; interaction_id?: string | null } | null; touch_type: string }>
  for (const r of rows) {
    stats.scanned++
    if (pickEventTime(r.metadata)) continue // already covered by main backfill
    const interactionId = r.metadata?.interaction_id ?? null
    if (!interactionId) { stats.skippedNoMetadata++; continue }
    const { data: sibling } = await sb
      .from('engagement_events')
      .select('occurred_at, metadata')
      .eq('wedding_id', r.wedding_id)
      .contains('metadata', { interaction_id: interactionId })
      .limit(10)
    const sibs = (sibling ?? []) as Array<{ occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
    // Prefer a sibling whose own metadata parses cleanly (subject or
    // event_datetime). Falls back to the LATEST sibling occurred_at —
    // earliest is often the still-corrupted row that hasn't been
    // backfilled yet, so picking that defeats the purpose.
    let correct: string | null = null
    for (const sib of sibs) {
      const fromMeta = pickEventTime(sib.metadata)
      if (fromMeta) { correct = fromMeta; break }
    }
    if (!correct && sibs.length > 0) {
      const latest = sibs
        .map((s) => s.occurred_at)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1)
      correct = latest ?? null
    }
    if (!correct) { stats.skippedUnparseable++; continue }
    const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
    if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
      stats.skippedAlreadyAccurate++
      continue
    }
    if (apply) {
      const { error: updErr } = await sb
        .from('wedding_touchpoints')
        .update({ occurred_at: correct })
        .eq('id', r.id)
      if (!updErr) stats.updated++
      else console.error(`  tp-sibling ${r.id}: ${updErr.message}`)
    } else {
      stats.updated++
    }
  }
  return stats
}

async function backfillTouchpoints(): Promise<Stats> {
  const stats = newStats()
  const PAGE = 500
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('wedding_touchpoints')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .in('touch_type', ['tour_booked', 'calendly_booked', 'tour_conducted', 'contract_signed'])
      .range(from, from + PAGE - 1)
    if (error) { console.error(`wedding_touchpoints @${from}: ${error.message}`); break }
    const rows = (data ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      stats.scanned++
      const correct = pickEventTime(r.metadata)
      if (!correct) {
        if (!r.metadata?.event_datetime && !r.metadata?.subject) stats.skippedNoMetadata++
        else stats.skippedUnparseable++
        continue
      }
      const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
      if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
        stats.skippedAlreadyAccurate++
        continue
      }
      if (apply) {
        const { error: updErr } = await sb
          .from('wedding_touchpoints')
          .update({ occurred_at: correct })
          .eq('id', r.id)
        if (!updErr) stats.updated++
        else console.error(`  tp ${r.id}: ${updErr.message}`)
      } else {
        stats.updated++
      }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  return stats
}

async function backfillWeddingTourDates(): Promise<Stats> {
  // For each wedding without a tour_date, look at its tour_scheduled
  // engagement_event. If metadata.event_datetime has a value, write
  // it to weddings.tour_date.
  const stats = newStats()
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, tour_date')
    .eq('venue_id', venueId)
    .is('tour_date', null)
  for (const w of (weddings ?? []) as Array<{ id: string; tour_date: string | null }>) {
    stats.scanned++
    const { data: events } = await sb
      .from('engagement_events')
      .select('metadata, occurred_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', w.id)
      .eq('event_type', 'tour_scheduled')
      .order('occurred_at', { ascending: true })
      .limit(1)
    const ev = (events ?? [])[0] as { metadata: { event_datetime?: string | null; subject?: string | null } | null; occurred_at: string | null } | undefined
    const correct = pickEventTime(ev?.metadata ?? null)
    if (!correct) {
      if (!ev?.metadata?.event_datetime && !ev?.metadata?.subject) stats.skippedNoMetadata++
      else stats.skippedUnparseable++
      continue
    }
    if (apply) {
      const { error: updErr } = await sb
        .from('weddings')
        .update({ tour_date: correct })
        .eq('id', w.id)
      if (!updErr) stats.updated++
      else console.error(`  wedding ${w.id}: ${updErr.message}`)
    } else {
      stats.updated++
    }
  }
  return stats
}

async function main() {
  console.log(`\n=== Backfill scheduling-event dates — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  console.log('[engagement_events]')
  const ee = await backfillEngagementEvents()
  console.log(`  scanned: ${ee.scanned}  ${apply ? 'updated' : 'would update'}: ${ee.updated}  no_metadata: ${ee.skippedNoMetadata}  already_accurate: ${ee.skippedAlreadyAccurate}  unparseable: ${ee.skippedUnparseable}`)

  console.log('\n[wedding_touchpoints]')
  const tp = await backfillTouchpoints()
  console.log(`  scanned: ${tp.scanned}  ${apply ? 'updated' : 'would update'}: ${tp.updated}  no_metadata: ${tp.skippedNoMetadata}  already_accurate: ${tp.skippedAlreadyAccurate}  unparseable: ${tp.skippedUnparseable}`)

  console.log('\n[wedding_touchpoints from siblings]')
  const sibs = await backfillTouchpointsFromSiblings()
  console.log(`  scanned: ${sibs.scanned}  ${apply ? 'updated' : 'would update'}: ${sibs.updated}  no_metadata: ${sibs.skippedNoMetadata}  already_accurate: ${sibs.skippedAlreadyAccurate}  unparseable: ${sibs.skippedUnparseable}`)

  console.log('\n[weddings.tour_date]')
  const wd = await backfillWeddingTourDates()
  console.log(`  scanned: ${wd.scanned}  ${apply ? 'updated' : 'would update'}: ${wd.updated}  no_metadata: ${wd.skippedNoMetadata}  already_accurate: ${wd.skippedAlreadyAccurate}  unparseable: ${wd.skippedUnparseable}`)

  if (!apply && (ee.updated > 0 || tp.updated > 0 || sibs.updated > 0 || wd.updated > 0)) {
    console.log(`\nDry-run complete. Re-run with --apply to write updates.`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
