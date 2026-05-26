/**
 * scripts/verify-zoom-binding.ts
 * ===============================
 * Phase 1 Batch 2 — ZOOM Z5 VERIFICATION
 * (PHASE-1-BATCH-2.md §7 named verification script #4).
 *
 * WHAT IT VERIFIES
 * ----------------
 * Z5 is the Zoom transcript insert at `ingestion/zoom.ts:~679`. The
 * legacy write is `interactions` with `type='meeting'` and
 * `direction='inbound'`. The cascade equivalent (post-Pbatch2-5
 * channel rename) is a `touchpoints` row with `channel='zoom'`
 * (NOT `'meeting'` — that collides with the Calendly batch Tracer's
 * `interactions WHERE type='meeting'` scan at
 * `sources/calendly.ts:128`) and `action_type='meeting_completed'`.
 *
 * For each `type='meeting'` interaction with a Zoom signature, check:
 *   - is there a `touchpoints` row with `channel='zoom'` whose
 *     `external_id` matches the Zoom meetingId, OR
 *   - a `fragments` row with `channel='zoom'` for the same?
 *
 * Cohort: only includes `type='meeting'` rows that are clearly Zoom
 * (subject starts with 'Zoom:' or full_body looks like a transcript).
 * Calendly meetings ALSO carry `type='meeting'` via the email→Calendly
 * forward path; the verify-calendly-binding.ts script covers those.
 *
 * READ-ONLY. SELECTs only.
 *
 * JOIN MODEL
 * ----------
 * `zoom-to-signal.ts:110` sets `external_id = meetingId`. Legacy
 * `interactions` doesn't carry meetingId in a dedicated column, but the
 * Zoom adapter logs the meetingId in its dedup ledger
 * (`processed_zoom_meetings`) — we don't read that ledger here since
 * it's allowed to be wiped per the Phase 2 manifest. Fallback to
 * timestamp-proximity (±15 minutes — Zoom transcripts land minutes
 * after the meeting ends).
 *
 * RUN
 * ---
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-zoom-binding.ts [--venue=<uuid>] [--days=<N>]
 *
 * EXIT CODES
 * ----------
 *   0 PASS — touchpoint-OR-fragment coverage >= 95% for Zoom meetings.
 *   1 FAIL — coverage < 80%.
 *   2 WARN — between gates.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PAGE = 1000
const TIME_TOLERANCE_MS = 15 * 60 * 1000

interface InteractionRow {
  id: string
  venue_id: string
  type: string | null
  direction: string | null
  subject: string | null
  full_body: string | null
  timestamp: string | null
  created_at: string | null
}

interface TouchpointRow {
  id: string
  venue_id: string
  channel: string
  action_type: string
  external_id: string
  occurred_at: string
}

interface FragmentRow {
  id: string
  venue_id: string
  channel: string
  external_id: string
  occurred_at: string
}

function parseArgs(): { venue: string; days: number } {
  let venue = RIXEY_VENUE_ID
  let days = Number(process.env.ZOOM_WINDOW_DAYS ?? '60')
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--venue=')) venue = arg.slice('--venue='.length)
    else if (arg.startsWith('--days=')) days = Number(arg.slice('--days='.length))
  }
  if (!Number.isFinite(days) || days < 0) days = 60
  return { venue, days }
}

async function fetchAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

const pct = (n: number, d: number) =>
  d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`

function looksZoomy(it: InteractionRow): boolean {
  const subject = (it.subject ?? '').toLowerCase()
  if (subject.startsWith('zoom:') || subject.startsWith('zoom ')) return true
  // The Zoom adapter sets subject = `Zoom: <topic>` OR
  // `Zoom meeting (<date>)` (zoom-to-signal.ts:105-107). Both prefixed.
  if (subject.startsWith('zoom meeting')) return true
  return false
}

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/verify-zoom-binding.ts',
    )
    process.exit(1)
  }
  if (url.includes('jsxxgwprxuqgcauzlxcb')) {
    console.error('ERROR: BRANCH_URL points at the production project. Refusing.')
    process.exit(1)
  }

  const { venue, days } = parseArgs()
  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const sinceIso = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null
  const widenedSinceIso =
    days > 0 ? new Date(Date.now() - (days + 14) * 86_400_000).toISOString() : null

  console.log('='.repeat(78))
  console.log('ZOOM Z5 VERIFICATION — meeting interactions vs spine zoom touchpoints')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Venue       : ${venue}`)
  console.log(`Data window : ${sinceIso ? `last ${days} days (since ${sinceIso})` : 'ALL TIME'}`)
  console.log('')

  // ---------------------------------------------------------------------------
  // 1. Pull type='meeting' interactions and filter to Zoom-shaped ones.
  // ---------------------------------------------------------------------------
  const allMeetings = await fetchAll<InteractionRow>('interactions(meeting)', (from, to) => {
    let q = supabase
      .from('interactions')
      .select('id, venue_id, type, direction, subject, full_body, timestamp, created_at')
      .eq('venue_id', venue)
      .eq('type', 'meeting')
      .order('timestamp', { ascending: true })
      .range(from, to)
    if (sinceIso) q = q.gte('created_at', sinceIso)
    return q
  })

  const zoomMeetings = allMeetings.filter(looksZoomy)

  console.log(`[1] type='meeting' interactions in window     : ${allMeetings.length}`)
  console.log(`[1] of which Zoom-shaped (subject prefix)     : ${zoomMeetings.length}`)
  console.log('')

  if (zoomMeetings.length === 0) {
    console.log('No Zoom-shaped meeting interactions in window. Nothing to verify.')
    console.log('Per PHASE-1-BATCH-2.md §7: "If N=0, script run is logged and gate is')
    console.log("'verification deferred — re-run after 14 days live traffic.'\"")
    process.exit(0)
  }

  // ---------------------------------------------------------------------------
  // 2. Pull channel='zoom' touchpoints + fragments.
  // ---------------------------------------------------------------------------
  const touchpoints = await fetchAll<TouchpointRow>('touchpoints(zoom)', (from, to) => {
    let q = supabase
      .from('touchpoints')
      .select('id, venue_id, channel, action_type, external_id, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'zoom')
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
    return q
  })

  const fragments = await fetchAll<FragmentRow>('fragments(zoom)', (from, to) => {
    let q = supabase
      .from('fragments')
      .select('id, venue_id, channel, external_id, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'zoom')
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
    return q
  })

  console.log(`[2] channel='zoom' touchpoints (widened)      : ${touchpoints.length}`)
  console.log(`[2] channel='zoom' fragments  (widened)       : ${fragments.length}`)

  // Also check for legacy channel='meeting' touchpoints — should be
  // zero post-Pbatch2-5; non-zero here means the rename didn't fully
  // land.
  const legacyMeetingTps = await fetchAll<TouchpointRow>(
    "touchpoints(channel='meeting')",
    (from, to) => {
      let q = supabase
        .from('touchpoints')
        .select('id, venue_id, channel, action_type, external_id, occurred_at')
        .eq('venue_id', venue)
        .eq('channel', 'meeting')
        .range(from, to)
      if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
      return q
    },
  )
  console.log(`[2] channel='meeting' touchpoints (LEGACY)    : ${legacyMeetingTps.length}` +
    (legacyMeetingTps.length > 0
      ? ' ← Pbatch2-5 channel rename has unmigrated rows'
      : ''))
  console.log('')

  // ---------------------------------------------------------------------------
  // 3. Coverage classification.
  // ---------------------------------------------------------------------------
  const tpByTime = [...touchpoints]
    .filter((t) => t.occurred_at)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  const frByTime = [...fragments]
    .filter((f) => f.occurred_at)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  function nearestTime<T extends { occurred_at: string }>(arr: T[], targetMs: number): T | null {
    let best: T | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const item of arr) {
      const t = new Date(item.occurred_at).getTime()
      if (!Number.isFinite(t)) continue
      const delta = Math.abs(t - targetMs)
      if (delta > TIME_TOLERANCE_MS) continue
      if (delta < bestDelta) {
        bestDelta = delta
        best = item
      }
    }
    return best
  }

  let coveredTp = 0
  let coveredFragment = 0
  let uncovered = 0
  const samplesUncovered: string[] = []

  for (const it of zoomMeetings) {
    if (!it.timestamp) {
      uncovered++
      if (samplesUncovered.length < 12) samplesUncovered.push(it.id)
      continue
    }
    const targetMs = new Date(it.timestamp).getTime()
    if (!Number.isFinite(targetMs)) {
      uncovered++
      if (samplesUncovered.length < 12) samplesUncovered.push(it.id)
      continue
    }
    const tp = nearestTime(tpByTime, targetMs)
    const fr = tp ? null : nearestTime(frByTime, targetMs)
    if (tp) coveredTp++
    else if (fr) coveredFragment++
    else {
      uncovered++
      if (samplesUncovered.length < 12) samplesUncovered.push(it.id)
    }
  }

  const covered = coveredTp + coveredFragment
  const coverage = zoomMeetings.length > 0 ? covered / zoomMeetings.length : null

  console.log('-'.repeat(78))
  console.log('COVERAGE — Zoom meetings with a spine zoom touchpoint OR fragment')
  console.log('-'.repeat(78))
  console.log(`  total Zoom meetings (±15 min join window)    : ${zoomMeetings.length}`)
  console.log(`  covered by a touchpoint                     : ${coveredTp} (${pct(coveredTp, zoomMeetings.length)})`)
  console.log(`  covered by a fragment                       : ${coveredFragment} (${pct(coveredFragment, zoomMeetings.length)})`)
  console.log(`  uncovered                                   : ${uncovered} (${pct(uncovered, zoomMeetings.length)})`)
  console.log('')
  if (samplesUncovered.length) {
    console.log('SAMPLE — Zoom meeting interactions with NO touchpoint or fragment:')
    samplesUncovered.forEach((id) => console.log(`  interaction ${id}`))
    console.log('')
  }

  // ---------------------------------------------------------------------------
  // 4. Verdict.
  // ---------------------------------------------------------------------------
  const PASS_GATE = 0.95
  const WARN_GATE = 0.80

  let exitCode = 0
  console.log('='.repeat(78))
  console.log('ZOOM Z5 VERDICT')
  console.log('='.repeat(78))
  if (legacyMeetingTps.length > 0) {
    console.log(`  WARN: ${legacyMeetingTps.length} legacy channel='meeting' touchpoints found.`)
    console.log("  Pbatch2-5 channel-rename hasn't fully landed — check the Tracer adapter.")
    exitCode = Math.max(exitCode, 2)
  }
  if (coverage === null) {
    console.log('  COVERAGE: n/a.')
  } else if (coverage >= PASS_GATE) {
    console.log(`  COVERAGE: PASS (${pct(covered, zoomMeetings.length)}).`)
    console.log('  Z5 cascade routing is healthy.')
  } else if (coverage >= WARN_GATE) {
    console.log(`  COVERAGE: WARN (${pct(covered, zoomMeetings.length)}; gate is ${PASS_GATE * 100}%).`)
    exitCode = Math.max(exitCode, 2)
  } else {
    console.log(`  COVERAGE: FAIL (${pct(covered, zoomMeetings.length)}; gate is ${WARN_GATE * 100}%).`)
    console.log('  Z5 flip not landing — Zoom meetings invisible to the spine.')
    exitCode = 1
  }
  console.log('='.repeat(78))

  process.exit(exitCode)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
