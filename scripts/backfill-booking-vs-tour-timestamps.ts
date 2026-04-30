// Corrective backfill — fixes the conflation between "when the
// booking happened" and "when the tour happened" that was introduced
// in the a9b48ed sweep.
//
// The mistake: a9b48ed unified all scheduling-event-derived
// timestamps onto eventDatetime (the tour's scheduled time). That's
// right for tour_completed / tour_conducted (= when the tour
// actually happened) but wrong for tour_scheduled / tour_booked
// (= when the customer clicked Book in Calendly). Result: Ryan
// Schubert's wedding shows "Tour booked Apr 13" when the booking
// actually happened Mar 29 (the day Calendly emailed us). That's a
// 15-day error.
//
// Correct invariant per row:
//   wedding.inquiry_date           = earliest inbound interaction's timestamp
//                                    (≈ when the customer first contacted us;
//                                    for Calendly leads this is the Calendly
//                                    notification, ≈ when they filled the form)
//   wedding.tour_date              = scheduled tour datetime (eventDatetime)
//   tour_scheduled engagement      = booking moment (interaction.timestamp)
//   tour_completed engagement      = tour moment (eventDatetime — already right)
//   tour_booked touchpoint         = booking moment (interaction.timestamp)
//   tour_conducted touchpoint      = tour moment (eventDatetime — already right)
//   inquiry touchpoint             = wedding.inquiry_date
//
// This script targets these specific rows and rewrites them. Idempotent.
//
// Usage:
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts --apply
//   npx tsx scripts/backfill-booking-vs-tour-timestamps.ts --apply --venue <uuid>
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

const MIN_DRIFT_HOURS = 12

interface Wedding {
  id: string
  inquiry_date: string | null
}

async function main() {
  console.log(`\n=== Booking vs tour timestamp correction — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  let weddingsUpdated = 0
  let inquiryDatesFixed = 0
  let inquiryTouchpointsFixed = 0
  let bookingEventsFixed = 0
  let bookingTouchpointsFixed = 0
  const samples: string[] = []

  const { data: weddings } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: true })

  for (const w of (weddings ?? []) as Wedding[]) {
    weddingsUpdated++
    // Earliest inbound interaction is the most reliable inquiry-time
    // signal we have. Holds for Calendly-routed leads (the Calendly
    // notification IS the earliest inbound), website-form leads (the
    // form-relay email IS the earliest), and cold-email leads.
    const { data: firstInbound } = await sb
      .from('interactions')
      .select('id, timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .not('timestamp', 'is', null)
      .order('timestamp', { ascending: true })
      .limit(1)
    const fi = (firstInbound?.[0] as { id: string; timestamp: string } | undefined)
    if (!fi) continue
    const earliestInboundIso = new Date(fi.timestamp).toISOString()

    const driftHours = w.inquiry_date
      ? Math.abs(new Date(w.inquiry_date).getTime() - new Date(earliestInboundIso).getTime()) / 3_600_000
      : Infinity
    if (driftHours >= MIN_DRIFT_HOURS) {
      inquiryDatesFixed++
      if (samples.length < 5) {
        samples.push(`  ${w.id} inquiry_date: ${w.inquiry_date} → ${earliestInboundIso} (drift ${Math.round(driftHours / 24 * 10) / 10}d)`)
      }
      if (apply) {
        await sb.from('weddings').update({ inquiry_date: earliestInboundIso }).eq('id', w.id)
      }
    }

    // Inquiry touchpoint follows wedding.inquiry_date.
    const { data: inqTp } = await sb
      .from('wedding_touchpoints')
      .select('id, occurred_at')
      .eq('wedding_id', w.id)
      .eq('touch_type', 'inquiry')
      .limit(1)
    const inq = (inqTp?.[0] as { id: string; occurred_at: string | null } | undefined)
    if (inq) {
      const tpDriftH = inq.occurred_at
        ? Math.abs(new Date(inq.occurred_at).getTime() - new Date(earliestInboundIso).getTime()) / 3_600_000
        : Infinity
      if (tpDriftH >= MIN_DRIFT_HOURS) {
        inquiryTouchpointsFixed++
        if (apply) {
          await sb.from('wedding_touchpoints').update({ occurred_at: earliestInboundIso }).eq('id', inq.id)
        }
      }
    }

    // Booking events: tour_scheduled / contract_sent engagement_events
    // and tour_booked / calendly_booked touchpoints. occurred_at should
    // be the linked interaction's timestamp (when the booking action
    // happened), NOT eventDatetime (when the tour itself happens/ed).
    const { data: bookingEvents } = await sb
      .from('engagement_events')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .eq('wedding_id', w.id)
      .in('event_type', ['tour_scheduled', 'contract_sent'])
    for (const ee of (bookingEvents ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { interaction_id?: string | null } | null }>) {
      const iid = ee.metadata?.interaction_id
      if (!iid) continue
      const { data: ix } = await sb.from('interactions').select('timestamp').eq('id', iid).maybeSingle()
      const ts = (ix as { timestamp: string | null } | null)?.timestamp
      if (!ts) continue
      const correct = new Date(ts).toISOString()
      const drift = ee.occurred_at
        ? Math.abs(new Date(ee.occurred_at).getTime() - new Date(correct).getTime()) / 3_600_000
        : Infinity
      if (drift >= MIN_DRIFT_HOURS) {
        bookingEventsFixed++
        if (apply) {
          await sb.from('engagement_events').update({ occurred_at: correct }).eq('id', ee.id)
        }
      }
    }

    const { data: bookingTps } = await sb
      .from('wedding_touchpoints')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .eq('wedding_id', w.id)
      .in('touch_type', ['tour_booked', 'calendly_booked'])
    for (const tp of (bookingTps ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { interaction_id?: string | null } | null }>) {
      const iid = tp.metadata?.interaction_id
      if (!iid) continue
      const { data: ix } = await sb.from('interactions').select('timestamp').eq('id', iid).maybeSingle()
      const ts = (ix as { timestamp: string | null } | null)?.timestamp
      if (!ts) continue
      const correct = new Date(ts).toISOString()
      const drift = tp.occurred_at
        ? Math.abs(new Date(tp.occurred_at).getTime() - new Date(correct).getTime()) / 3_600_000
        : Infinity
      if (drift >= MIN_DRIFT_HOURS) {
        bookingTouchpointsFixed++
        if (apply) {
          await sb.from('wedding_touchpoints').update({ occurred_at: correct }).eq('id', tp.id)
        }
      }
    }
  }

  console.log(`weddings scanned:            ${weddingsUpdated}`)
  console.log(`inquiry_date fixed:          ${inquiryDatesFixed}`)
  console.log(`inquiry touchpoints fixed:   ${inquiryTouchpointsFixed}`)
  console.log(`booking events fixed:        ${bookingEventsFixed}  (tour_scheduled / contract_sent)`)
  console.log(`booking touchpoints fixed:   ${bookingTouchpointsFixed}  (tour_booked / calendly_booked)`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} drift samples:`)
    for (const s of samples) console.log(s)
  }
  if (!apply) console.log(`\nDry-run complete. Re-run with --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
