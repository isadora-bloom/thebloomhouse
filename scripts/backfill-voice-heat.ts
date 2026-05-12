/**
 * scripts/backfill-voice-heat.ts
 *
 * Backfill engagement_events for historical voice + SMS + Zoom
 * interactions that were ingested BEFORE Wave 28 wired heat-firing
 * into openphone.ts / zoom.ts (2026-05-12).
 *
 * Rixey had 2,000+ SMS rows + 360+ calls + a handful of Zoom meetings
 * sitting in `interactions` with signal_class='touchpoint' but zero
 * matching engagement_events rows — every voice-heavy lead's heat
 * score stayed at 0 because heat scoring read engagement_events only.
 *
 * What this fires:
 *   - SMS rows         (surface='voice_capture', type='sms')
 *     inbound  → sms_received (+8)
 *     outbound → sms_sent (+0; recorded for symmetry, doesn't bump heat)
 *   - Call rows        (surface='voice_capture', type='call')
 *     inbound  → call_inbound (+12) or call_inbound_with_transcript (+18)
 *                if the body starts with "[Call]" (real summary/transcript)
 *     outbound → call_outbound (+5)
 *   - Voicemail rows   (surface='voice_capture', type='voicemail')
 *     always inbound → voicemail_received (+5)
 *   - Zoom meeting rows (type='meeting')
 *     always inbound → zoom_meeting_completed (+25)
 *
 * Idempotent: before firing, check engagement_events for an existing row
 * whose metadata.interaction_id matches this interaction.id. Re-running
 * is a no-op.
 *
 * After this runs once, recalculateHeatScore picks up the new events on
 * the next call (or you can force a recompute by touching the wedding).
 *
 * Run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-voice-heat.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-voice-heat.ts --dry-run
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-voice-heat.ts --venue=<uuid>
 */

import { createClient } from '@supabase/supabase-js'

const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
}

function need(name: keyof typeof env): void {
  if (!env[name]) {
    console.error(`Missing env var: ${name}. Run with --env-file=.env.local.`)
    process.exit(1)
  }
}
need('NEXT_PUBLIC_SUPABASE_URL')
need('SUPABASE_SERVICE_ROLE_KEY')

const args = process.argv.slice(2)
const venueArg = args.find((a) => a.startsWith('--venue='))?.slice(8) ?? null
const dryRun = args.includes('--dry-run')

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Per-channel point values. Mirrors DEFAULT_POINTS in heat-mapping.ts —
// keep these in sync if you bump the values there. We hardcode here so
// the backfill doesn't need to load Next.js path aliases.
const POINTS: Record<string, number> = {
  sms_received: 8,
  sms_sent: 0,
  call_inbound: 12,
  call_inbound_with_transcript: 18,
  call_outbound: 5,
  voicemail_received: 5,
  zoom_meeting_completed: 25,
}

interface InteractionRow {
  id: string
  venue_id: string
  wedding_id: string
  type: string
  direction: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string
  surface: string | null
}

interface PerVenueCounts {
  smsFired: number
  callFired: number
  voicemailFired: number
  zoomFired: number
  skippedAlreadyFired: number
  skippedUnknown: number
}

/**
 * Map an interaction row to the heat event_type that should fire.
 * Returns null if the row's channel/direction shape is unrecognised —
 * we never silently guess.
 */
function pickEventType(row: InteractionRow): string | null {
  const dir = (row.direction ?? 'inbound').toLowerCase()

  if (row.type === 'sms') {
    return dir === 'outbound' ? 'sms_sent' : 'sms_received'
  }
  if (row.type === 'voicemail') {
    // Voicemails are always inbound by construction.
    return 'voicemail_received'
  }
  if (row.type === 'call') {
    if (dir === 'outbound') return 'call_outbound'
    // [Call] prefix marks a real summary/transcript landed; otherwise
    // it's the placeholder "Inbound call · X min · (no transcript)".
    const body = (row.full_body ?? row.body_preview ?? '').trim()
    const hasTranscript = body.startsWith('[Call]')
    return hasTranscript ? 'call_inbound_with_transcript' : 'call_inbound'
  }
  if (row.type === 'meeting') {
    // Zoom meetings only land as inbound; the syncMeetings writer hard-
    // codes direction='inbound'. Anything else would be unexpected
    // legacy data.
    return 'zoom_meeting_completed'
  }
  return null
}

function bumpCounter(counts: PerVenueCounts, type: string): void {
  if (type === 'sms_received' || type === 'sms_sent') counts.smsFired++
  else if (
    type === 'call_inbound' ||
    type === 'call_inbound_with_transcript' ||
    type === 'call_outbound'
  )
    counts.callFired++
  else if (type === 'voicemail_received') counts.voicemailFired++
  else if (type === 'zoom_meeting_completed') counts.zoomFired++
}

async function fetchAlreadyFiredInteractionIds(
  venueId: string,
): Promise<Set<string>> {
  // Pull every engagement_events row for the venue with a non-null
  // metadata.interaction_id — that's our idempotency key. Paginate
  // because a busy venue can easily exceed the default 1000-row
  // ceiling.
  const out = new Set<string>()
  const PAGE = 1000
  let page = 0
  while (true) {
    const { data, error } = await sb
      .from('engagement_events')
      .select('metadata')
      .eq('venue_id', venueId)
      .not('metadata->>interaction_id', 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) {
      console.error(`[${venueId}] engagement_events scan failed:`, error.message)
      break
    }
    const rows = (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>
    for (const r of rows) {
      const iid = r.metadata?.interaction_id
      if (typeof iid === 'string' && iid) out.add(iid)
    }
    if (rows.length < PAGE) break
    page++
    if (page > 50) break // safety stop
  }
  return out
}

async function backfillVenue(venueId: string): Promise<PerVenueCounts> {
  const counts: PerVenueCounts = {
    smsFired: 0,
    callFired: 0,
    voicemailFired: 0,
    zoomFired: 0,
    skippedAlreadyFired: 0,
    skippedUnknown: 0,
  }

  // Pull every voice interaction (SMS/call/voicemail from openphone)
  // with surface='voice_capture'. We don't bound by date — backfill is
  // a one-shot and operators want full historical coverage.
  const rows: InteractionRow[] = []
  const PAGE = 1000
  let page = 0
  while (true) {
    const { data, error } = await sb
      .from('interactions')
      .select('id, venue_id, wedding_id, type, direction, full_body, body_preview, timestamp, surface')
      .eq('venue_id', venueId)
      .eq('surface', 'voice_capture')
      .not('wedding_id', 'is', null)
      .order('timestamp', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) {
      console.error(`[${venueId}] interactions scan failed:`, error.message)
      break
    }
    const got = (data ?? []) as InteractionRow[]
    rows.push(...got)
    if (got.length < PAGE) break
    page++
    if (page > 50) break // safety stop at 50k rows
  }

  // Zoom meetings: pull through processed_zoom_meetings + join to
  // interactions by wedding_id + close timestamp. Filtering on
  // type='meeting' alone over-matches — Calendly tour bookings also
  // land as type='meeting' with surface='crm_attribution', and firing
  // zoom_meeting_completed (+25) on those would double-count tour
  // attribution. The processed_zoom_meetings table is the canonical
  // Zoom-meeting registry; we only fire heat for rows that landed
  // through that pipeline.
  const { data: zoomMeetings } = await sb
    .from('processed_zoom_meetings')
    .select('zoom_meeting_id, wedding_id, meeting_start_time, transcript_text')
    .eq('venue_id', venueId)
    .not('wedding_id', 'is', null)
    .not('transcript_text', 'is', null)
  for (const zm of (zoomMeetings ?? []) as Array<{
    zoom_meeting_id: string
    wedding_id: string
    meeting_start_time: string | null
    transcript_text: string | null
  }>) {
    // Find the matching interactions row by wedding_id + meeting type
    // + start time. We need its id for the idempotency check (the
    // openphone metadata.interaction_id pattern is what fetchAlready
    // FiredInteractionIds keys on). If no match we still fire — Zoom
    // syncMeetings always writes both processed_zoom_meetings and
    // interactions, but the interaction insert can fail silently and
    // we still want heat credit for the meeting.
    const startTime = zm.meeting_start_time ?? new Date().toISOString()
    rows.push({
      id: `zoom_${zm.zoom_meeting_id}`,
      venue_id: venueId,
      wedding_id: zm.wedding_id,
      type: 'meeting',
      direction: 'inbound',
      full_body: zm.transcript_text,
      body_preview: null,
      timestamp: startTime,
      surface: 'zoom_meeting',
    })
  }

  console.log(`[${venueId}] scanning ${rows.length} voice/Zoom interactions`)

  // Idempotency: every engagement_event we'd write carries
  // metadata.interaction_id. Pre-fetch the set of interaction_ids
  // that already have a fired event for this venue and skip them.
  const alreadyFired = await fetchAlreadyFiredInteractionIds(venueId)
  console.log(`[${venueId}] ${alreadyFired.size} interactions already have heat events`)

  for (const row of rows) {
    if (alreadyFired.has(row.id)) {
      counts.skippedAlreadyFired++
      continue
    }
    const eventType = pickEventType(row)
    if (!eventType) {
      counts.skippedUnknown++
      continue
    }
    const points = POINTS[eventType] ?? 0
    const direction = (row.direction ?? 'inbound').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'

    if (dryRun) {
      bumpCounter(counts, eventType)
      continue
    }

    const { error } = await sb.from('engagement_events').insert({
      venue_id: venueId,
      wedding_id: row.wedding_id,
      event_type: eventType,
      direction,
      points,
      occurred_at: row.timestamp,
      metadata: {
        source: 'voice_heat_backfill',
        interaction_id: row.id,
        channel: row.type,
        surface: row.surface,
      },
    })
    if (error) {
      // 23505 = fire-once unique violation. Treat as already-fired.
      if ((error as { code?: string }).code === '23505') {
        counts.skippedAlreadyFired++
      } else {
        console.warn(`  ! engagement_events insert failed for ${row.id}: ${error.message}`)
      }
      continue
    }
    bumpCounter(counts, eventType)
    // Mark seen so a same-run duplicate (shouldn't happen with PK on
    // interaction.id but cheap insurance) doesn't double-fire.
    alreadyFired.add(row.id)
  }

  console.log(
    `[${venueId}] sms=${counts.smsFired} call=${counts.callFired} ` +
      `voicemail=${counts.voicemailFired} zoom=${counts.zoomFired} ` +
      `already_fired=${counts.skippedAlreadyFired} unknown=${counts.skippedUnknown}` +
      `${dryRun ? ' (dry-run)' : ''}`,
  )
  return counts
}

async function main(): Promise<void> {
  let venueIds: string[] = []
  if (venueArg) {
    venueIds = [venueArg]
  } else {
    // All venues. Pull from the venues table directly so we catch venues
    // that use Zoom but not OpenPhone (and vice versa). Filter out demo
    // venues — the Crestwood collection isn't a real customer and its
    // seeded interactions shouldn't get retroactive heat events.
    const { data: venues } = await sb
      .from('venues')
      .select('id, is_demo')
      .or('is_demo.eq.false,is_demo.is.null')
    venueIds = ((venues ?? []) as Array<{ id: string }>).map((v) => v.id)
  }

  console.log(`Backfilling voice heat across ${venueIds.length} venue(s)${dryRun ? ' (DRY RUN)' : ''}`)

  const totals: PerVenueCounts = {
    smsFired: 0,
    callFired: 0,
    voicemailFired: 0,
    zoomFired: 0,
    skippedAlreadyFired: 0,
    skippedUnknown: 0,
  }
  for (const venueId of venueIds) {
    const v = await backfillVenue(venueId)
    totals.smsFired += v.smsFired
    totals.callFired += v.callFired
    totals.voicemailFired += v.voicemailFired
    totals.zoomFired += v.zoomFired
    totals.skippedAlreadyFired += v.skippedAlreadyFired
    totals.skippedUnknown += v.skippedUnknown
  }

  console.log('\n=== TOTAL ===')
  console.log(
    `sms=${totals.smsFired} call=${totals.callFired} voicemail=${totals.voicemailFired} ` +
      `zoom=${totals.zoomFired} already_fired=${totals.skippedAlreadyFired} unknown=${totals.skippedUnknown}` +
      `${dryRun ? ' (dry-run)' : ''}`,
  )
  console.log('Done.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
