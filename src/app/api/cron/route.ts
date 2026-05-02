import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { fetchAllVenueTrends } from '@/lib/services/trends'
import { fetchWeatherForecast } from '@/lib/services/weather'
import { fetchAllDefaultFredSeries } from '@/lib/services/external-context/fred-fetch'
import { autoProposeFromTrendSpikes } from '@/lib/services/insights/cultural-moments-auto-propose'
import { runAllVenueAnomalies } from '@/lib/services/anomaly-detection'
import {
  generateWeeklyBriefing,
  generateMonthlyBriefing,
} from '@/lib/services/briefings'
import { generateWeeklyDigest } from '@/lib/services/weekly-digest'
import { measureInsightOutcomes } from '@/lib/services/insight-tracking'
import { sendAllDigests } from '@/lib/services/daily-digest'
import { processAllVenueFollowUps } from '@/lib/services/follow-up-sequences'
import { applyDailyDecay, recalculateHeatScore } from '@/lib/services/heat-mapping'
import { processAllNewEmails, flushPendingAutoSends } from '@/lib/services/email-pipeline'
import { runAllVenueIntelligence } from '@/lib/services/intelligence-engine'
import { createNotification } from '@/lib/services/admin-notifications'
import { learnFiltersForAllVenues } from '@/lib/services/inbox-filters'
import { computeAllVenueHealth } from '@/lib/services/venue-health-compute'
import { persistDropoffInsights } from '@/lib/services/quality-signals'
import { refreshAllCensusData } from '@/lib/services/census-ingest'
import { computeCorrelationsAllVenues } from '@/lib/services/correlation-engine'
import { mineTranscriptVoiceForAllVenues } from '@/lib/services/transcript-voice-learning'
import { findBacktraceCandidates } from '@/lib/services/source-backtrace'
import { reclusterVenue } from '@/lib/services/candidate-clusterer'
import { resolveVenueCandidates } from '@/lib/services/candidate-resolver'
import { syncMeetings as syncZoomMeetings } from '@/lib/services/zoom'
import { syncAllVenues as syncOpenPhoneAllVenues } from '@/lib/services/openphone'
import { runDataIntegritySweepAllVenues } from '@/lib/services/data-integrity'
import { sweepReEngagementConversions } from '@/lib/services/re-engagement'
import {
  enforceCeilingsAllVenues,
  clearStaleAutonomousPauses,
} from '@/lib/services/cost-ceiling'
import { runEssentialsSuggester } from '@/lib/services/essentials-suggester'

// ---------------------------------------------------------------------------
// Valid job names
// ---------------------------------------------------------------------------

const VALID_JOBS = [
  'email_poll',
  'heat_decay',
  'trends_refresh',
  'weather_forecast',
  // T5-ε.1 (2026-05-01): renamed from 'economic_indicators' which wrote
  // the legacy economic_indicators table (FRED series id mapped to a
  // friendly name). The correlation engine reads fred_indicators, so the
  // legacy writer left the macro channels permanently empty. The new
  // handler calls fetchAllDefaultFredSeries() against fred_indicators.
  // Old job name kept as alias below so already-deployed Vercel cron
  // entries keep working until vercel.json is fully migrated.
  'fred_daily_refresh',
  'economic_indicators',
  'cultural_moments_auto_propose',
  'anomaly_detection',
  'intelligence_analysis',
  'weekly_briefing',
  'weekly_digest',
  'monthly_briefing',
  'daily_digest',
  'follow_up_sequences',
  'attribution_refresh',
  'post_event_feedback_check',
  'outcome_measurement',
  'inbox_filter_learning',
  'venue_health_compute',
  'quality_signals_refresh',
  'census_refresh',
  'transcript_voice_mining',
  'correlation_analysis',
  'backtrace_scan',
  'zoom_poll',
  'openphone_poll',
  'phase_b_sweep',
  'data_integrity_sweep',
  're_engagement_attribution',
  // Cost-ceiling circuit breaker (Playbook OPS-21.4.3). cost_ceiling_check
  // runs hourly to flip autonomous_paused on venues at 100% and notify at
  // 80%. cost_ceiling_reset runs at the UTC day boundary to clear stale
  // pauses (separate jobs so vercel.json can give them different cadences).
  'cost_ceiling_check',
  'cost_ceiling_reset',
  // T5-delta.2 (2026-05-02). Drains weddings.heat_recompute_pending
  // set by the temporal-change trigger (migration 158) when a
  // coordinator corrects inquiry_date / wedding_date / guest_count.
  // Runs every 5 minutes — INV-2.5 derived-state recompute.
  'recompute_pending_temporal',
  // T5-γ.3 (2026-05-02). Essentials slider suggestion engine. Reads
  // essentials_action_log nightly and fires per-user notifications when
  // a coordinator has dismissed 5+ high-density cards on the same
  // surface in the last 30 days.
  'essentials_suggest',
] as const

type JobName = (typeof VALID_JOBS)[number]

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function runJob(job: JobName): Promise<unknown> {
  switch (job) {
    case 'email_poll':
      return pollEmailsAllVenues()

    case 'heat_decay':
      return applyDecayAllVenues()

    case 'trends_refresh':
      return fetchAllVenueTrends()

    case 'weather_forecast':
      return fetchWeatherForAllVenues()

    case 'fred_daily_refresh':
    case 'economic_indicators':
      // T5-ε.1 (2026-05-01): writes fred_indicators (the table the
      // correlation engine + ./external-context/fred.ts actually read).
      // Old key 'economic_indicators' kept as alias so the running
      // Vercel cron continues to fire while vercel.json migrates.
      // Sanity-asserts at the end that the writer actually landed rows
      // in the last hour — if zero, logs loudly so a silent FRED
      // outage doesn't drag the macro channels back to null.
      return runFredDailyRefresh()

    case 'cultural_moments_auto_propose':
      // T5-ε.2 (2026-05-01): nightly sweep of every venue with a
      // google_trends_metro set. Without this cron the propose-and-
      // confirm queue stays empty unless an org_admin clicks the
      // manual trigger at /api/intel/cultural-moments/auto-propose.
      // Audit yc-partner.md CRITICAL 3.
      return runCulturalMomentsAutoPropose()

    case 'anomaly_detection':
      return runAllVenueAnomalies()

    case 'intelligence_analysis':
      return runAllVenueIntelligence()

    case 'weekly_briefing':
      return generateBriefingsForAllVenues('weekly')

    case 'weekly_digest':
      return generateDigestsForAllVenues()

    case 'monthly_briefing':
      return generateBriefingsForAllVenues('monthly')

    case 'daily_digest':
      return sendAllDigests()

    case 'follow_up_sequences':
      return processAllVenueFollowUps()

    case 'attribution_refresh':
      return refreshAttributionAllVenues()

    case 'post_event_feedback_check':
      return checkPostEventFeedback()

    case 'outcome_measurement':
      return measureOutcomesAllVenues()

    case 'inbox_filter_learning':
      return learnFiltersForAllVenues()

    case 'venue_health_compute':
      return computeAllVenueHealth()

    case 'quality_signals_refresh':
      // Two-email drop-offs per venue. We iterate active venues and
      // fire-and-forget the insights upsert. Keep this cheap — runs
      // weekly, not daily.
      return refreshQualitySignalsAllVenues()

    case 'census_refresh':
      // Monthly pull of Census ACS5 demographics. Rolls county data up
      // to state + national rows in market_intelligence. Never throws —
      // per-state failures are logged inside the service.
      return refreshAllCensusData()

    case 'transcript_voice_mining':
      // Phase 7 Task 64. Mine vocabulary from tour transcripts of couples
      // who booked AND left a 5-star review. Per-venue data-gated — the
      // service returns { dataGated: true } and skips AI entirely for
      // venues with fewer than MIN_ELIGIBLE_TOURS eligible tours. Runs
      // weekly; cheap when gated, modest when not.
      return mineTranscriptVoiceForAllVenues()

    case 'correlation_analysis':
      // Phase 8 Step 6. Pearson correlation with lag search across every
      // pair of channels (inquiries, marketing_metric series, tangential
      // signals per platform). Writes named insights into
      // intelligence_insights where |r| >= 0.6 and both series have >= 20
      // non-zero days. Pure stats — no AI call. Runs weekly.
      return computeCorrelationsAllVenues(createServiceClient())

    case 'zoom_poll':
      // Daily Zoom recording sync per active connection. We poll once a
      // day because Zoom's cloud recording + transcript pipeline can take
      // tens of minutes to materialize after a meeting ends, and there's
      // no webhook fanout in our current Zoom app config — so a slow
      // daily cadence is plenty. The service handles dedup against
      // processed_zoom_meetings, so re-running is idempotent.
      return pollZoomAllVenues()

    case 'openphone_poll':
      // Every-15-minutes OpenPhone (Quo) sync. Pulls SMS, voicemails,
      // and call summaries for each active connection and dedups
      // through processed_sms_messages before mirroring into
      // interactions. The service already iterates active connections
      // and catches per-venue failures so we just call it.
      return syncOpenPhoneAllVenues()

    case 'backtrace_scan':
      // Daily re-scan of source-backtrace candidates per venue. The
      // initial scan happens on the onboarding Go Live step, but Gmail
      // polling continues to ingest emails for hours/days after that —
      // the high-confidence relay matches we couldn't see at T0 land
      // later. This job re-runs findBacktraceCandidates(useLiveGmail)
      // and notifies the coordinator when new high-confidence
      // candidates exist that they haven't already reviewed. Skips
      // venues without Gmail (no inbox = no point), uses unread
      // admin_notifications as the dedup mechanism (one open notif per
      // venue at a time; coordinator marks read and the next batch
      // creates a fresh one).
      return scanBacktraceAllVenues()

    case 'phase_b_sweep':
      // Phase B safety sweep (PB.8 — 2026-04-28). Daily catch-up that
      // re-clusters any tangential_signals still without a candidate
      // and re-resolves any candidate_identities still without a
      // wedding. Idempotent: signals already attached + candidates
      // already resolved are skipped. Catches edges where the
      // brain-dump-time clusterer/resolver chain failed (timeouts,
      // RLS race, transient service unavailable) and ensures no
      // signal silently sits unattributed. Does NOT call AI for
      // ambiguous cases on the sweep — that already happened at
      // import time; AI is too expensive to retry every night.
      return sweepPhaseBAllVenues()

    case 'data_integrity_sweep':
      // Phase 2 multi-venue rollout (2026-04-30). Runs the 8 data
      // integrity invariants on every venue and persists current
      // violations as 'data_anomaly' rows on intelligence_insights.
      // Self-healing: when an invariant returns clean on a venue
      // that previously had an open anomaly, the row is dismissed
      // with status='self_healed'. Coordinators see live anomaly
      // status on /intel/anomalies without having to re-run any
      // script. Cheap (~5-10s per venue) and idempotent.
      return sweepDataIntegrityAllVenues()

    case 're_engagement_attribution':
      // Phase D Tier 2 / Stage 3 (2026-04-30). Daily — for each
      // sent re_engagement_action whose 60-day window is still
      // open, look for a wedding that arrived within the window
      // whose primary person matches the candidate's first_name
      // + last_initial. Unique match → attribute. Ambiguous
      // (2+) → leave for coordinator. Closed window with no
      // match → counted, no attribution. Idempotent; rerun-safe.
      return sweepReEngagementAttribution()

    case 'cost_ceiling_check':
      // Hourly. Sums today's api_costs per venue, fires 80% notify
      // alert and 100% autonomous-pause + alert. Idempotent within
      // a day via cost_ceiling_warned_at and the autonomous_paused
      // flag itself. Playbook OPS-21.4.3.
      return enforceCeilingsAllVenues()

    case 'cost_ceiling_reset':
      // Hourly (cheap). Clears autonomous_paused for any venue
      // whose paused_at is in a prior UTC day AND whose current
      // spend is back under ceiling. Coordinators who can't wait
      // for the natural reset use POST /api/agent/cost-ceiling/resume.
      return clearStaleAutonomousPauses()

    case 'recompute_pending_temporal':
      // T5-delta.2 (2026-05-02). Every 5 minutes. Drains
      // weddings.heat_recompute_pending — the BEFORE-UPDATE trigger
      // installed by migration 158 stamps it true when a coordinator
      // corrects inquiry_date / wedding_date / guest_count. Heat
      // recompute is multi-table so it can't run inline in the trigger
      // without holding row locks; cron is the deferred path.
      return runRecomputePendingTemporal()
    case 'essentials_suggest':
      // T5-γ.3 (2026-05-02). Daily. Reads essentials_action_log and
      // fires a per-user 'essentials_suggestion' admin_notification
      // when a coordinator has dismissed 5+ high-density cards (level
      // 'expanded' or 'everything') on the same surface in the last
      // 30 days. Idempotent — the 30d suppression window prevents
      // re-firing the same suggestion every day. Closes the loop on
      // the slider learning telemetry that was being written but
      // never read (Pattern A).
      return runEssentialsSuggester(createServiceClient())
  }
}

/**
 * Daily re-scan for source-backtrace candidates. For each venue with a
 * live Gmail connection, walks weddings whose first-touch is a
 * scheduling tool and asks the source-backtrace service whether any
 * high-confidence relay matches now exist. Only emits a notification
 * when there's at least one open candidate AND the coordinator has
 * already cleared (read) the previous notification — so we don't keep
 * pushing the same alert at someone who's actively triaging.
 *
 * Returns per-venue stats so the cron log shows what changed.
 */
/**
 * Phase B safety sweep across every venue. Re-attaches any orphaned
 * signals (clusterer) and re-resolves any unmatched candidates
 * (resolver). Returns per-venue counts. AI adjudicator is NOT
 * triggered here — ambiguous cases stay queued for coordinator.
 */
async function sweepPhaseBAllVenues(): Promise<
  Record<string, {
    signals_processed: number
    new_clusters: number
    candidates_resolved: number
    deferred: number
    conflicts: number
    errors: number
  }>
> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id, name')
    .is('archived_at', null)
  const out: Record<string, {
    signals_processed: number
    new_clusters: number
    candidates_resolved: number
    deferred: number
    conflicts: number
    errors: number
  }> = {}

  for (const v of ((venues ?? []) as Array<{ id: string; name: string }>)) {
    try {
      const cluster = await reclusterVenue({ supabase, venueId: v.id })
      const resolve = await resolveVenueCandidates({ supabase, venueId: v.id, skipAI: true })
      out[v.name] = {
        signals_processed: cluster.signals_processed,
        new_clusters: cluster.signals_creating_new_cluster,
        candidates_resolved:
          resolve.resolved_tier_1_exact +
          resolve.resolved_tier_1_name_window +
          resolve.resolved_tier_1_full_name +
          resolve.resolved_tier_2_ai +
          resolve.resolved_tier_2_wide_ai,
        deferred: resolve.deferred_to_ai,
        conflicts: resolve.conflicts_flagged,
        errors: cluster.errors.length + resolve.errors.length,
      }
    } catch (err) {
      out[v.name] = {
        signals_processed: 0,
        new_clusters: 0,
        candidates_resolved: 0,
        deferred: 0,
        conflicts: 0,
        errors: 1,
      }
      console.error(`[phase_b_sweep] ${v.name}:`, err instanceof Error ? err.message : err)
    }
  }

  return out
}

/**
 * Daily data-integrity sweep wrapper. Runs the 8 invariants on
 * every venue, persists violations as data_anomaly insights, and
 * self-heals previously-open anomalies that now pass. Thin wrapper
 * over runDataIntegritySweepAllVenues — exists so the cron switch
 * stays consistent with the other named jobs.
 */
async function sweepDataIntegrityAllVenues() {
  const supabase = createServiceClient()
  return runDataIntegritySweepAllVenues(supabase)
}

async function sweepReEngagementAttribution() {
  const supabase = createServiceClient()
  return sweepReEngagementConversions(supabase)
}

/**
 * T5-delta.2 (2026-05-02). Drains weddings.heat_recompute_pending.
 *
 * The BEFORE-UPDATE trigger from migration 158 stamps the flag true
 * when inquiry_date / wedding_date / guest_count change. The AFTER
 * trigger nulls T3 cache signatures + stamps stale_since on journey
 * narratives + tour briefs in the same transaction. This cron does
 * the load-bearing heat-score recompute that has to be deferred —
 * recalculateHeatScore reads engagement_events + candidate_identities
 * + attribution_events, which is too expensive to run inline.
 *
 * Caps at 100 weddings per tick so a bulk back-fill correction (a
 * coordinator running an import-fix script that touches thousands of
 * rows) doesn't blow the function timeout. The next 5-min tick picks
 * up the rest.
 *
 * Per-wedding errors are logged + the flag is left true so the next
 * tick retries. Permanent failures will surface in cron_runs telemetry.
 */
async function runRecomputePendingTemporal(): Promise<{
  scanned: number
  recomputed: number
  failed: number
  remaining_estimate: number
}> {
  const supabase = createServiceClient()

  const { data: pending } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('heat_recompute_pending', true)
    .limit(100)

  const list = ((pending ?? []) as Array<{ id: string; venue_id: string }>)
  if (list.length === 0) {
    return { scanned: 0, recomputed: 0, failed: 0, remaining_estimate: 0 }
  }

  let recomputed = 0
  let failed = 0

  for (const w of list) {
    try {
      await recalculateHeatScore(w.venue_id, w.id)
      const { error } = await supabase
        .from('weddings')
        .update({ heat_recompute_pending: false })
        .eq('id', w.id)
        .eq('heat_recompute_pending', true)
      if (error) {
        console.error(`[recompute_pending_temporal] flag clear failed for ${w.id}:`, error.message)
        failed++
        continue
      }
      recomputed++
    } catch (err) {
      console.error(`[recompute_pending_temporal] recompute failed for ${w.id}:`, err)
      failed++
    }
  }

  // Cheap remaining-estimate so the cron telemetry shows pressure.
  // head:true skips the row payload — count-only.
  const { count: remaining } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('heat_recompute_pending', true)

  return {
    scanned: list.length,
    recomputed,
    failed,
    remaining_estimate: remaining ?? 0,
  }
}

/**
 * T5-ε.1 (2026-05-01). Daily FRED refresh writing fred_indicators
 * (the table read by correlation-engine.ts and external-context/fred.ts).
 *
 * Pre-fix the cron called fetchAllEconomicIndicators which writes the
 * legacy economic_indicators table — the correlation engine never
 * looked at that table, so the macro channels (CPI, mortgage rate,
 * S&P 500, unemployment, consumer sentiment) sat permanently empty
 * after onboarding's one-shot backfill.
 *
 * Sanity assertion: after the writer returns, count fred_indicators
 * rows whose fetched_at is in the last hour. If the writer claims
 * success but no rows landed (FRED outage, network blip, RLS quirk),
 * we log loudly so the failure doesn't go silent.
 */
async function runFredDailyRefresh(): Promise<{
  series: Array<{ series_id: string; observations_returned: number; rows_upserted: number; error?: string }>
  totalRowsUpserted: number
  rowsLandedLastHour: number | null
  freshnessOk: boolean
}> {
  const results = await fetchAllDefaultFredSeries()
  const totalRowsUpserted = results.reduce((sum, r) => sum + r.rows_upserted, 0)

  const supabase = createServiceClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await supabase
    .from('fred_indicators')
    .select('id', { count: 'exact', head: true })
    .gte('fetched_at', oneHourAgo)

  let rowsLandedLastHour: number | null = null
  if (countError) {
    console.error('[cron][fred_daily_refresh] sanity count failed:', countError.message)
  } else {
    rowsLandedLastHour = count ?? 0
  }

  const freshnessOk = rowsLandedLastHour !== null && rowsLandedLastHour > 0
  if (!freshnessOk) {
    console.error(
      `[cron][fred_daily_refresh] FRESHNESS ALERT — fetchAllDefaultFredSeries reported ${totalRowsUpserted} rows ` +
      `upserted across ${results.length} series, but fred_indicators has ${rowsLandedLastHour ?? 'unknown'} ` +
      `rows fetched in the last hour. ` +
      `Per-series detail: ${JSON.stringify(results)}. ` +
      `Likely causes: missing FRED_API_KEY, FRED outage, RLS blocking service-role write, network egress.`,
    )
  }

  return {
    series: results,
    totalRowsUpserted,
    rowsLandedLastHour,
    freshnessOk,
  }
}

/**
 * T5-ε.2 (2026-05-01). Nightly cultural-moments auto-propose sweep.
 *
 * Runs autoProposeFromTrendSpikes against every venue with a
 * google_trends_metro configured. Pre-fix the propose-and-confirm
 * queue stayed empty unless an org_admin clicked the manual trigger
 * at POST /api/intel/cultural-moments/auto-propose. Audit
 * yc-partner.md CRITICAL 3.
 *
 * Per-venue dedup is handled inside the service (fingerprint on
 * (term, weekStart) across all venues) — calling repeatedly is safe.
 */
async function runCulturalMomentsAutoPropose(): Promise<{
  venuesChecked: number
  spikesDetected: number
  proposed: number
  deduped: number
  errors: number
  perVenue: Array<{ venueId: string; spikesDetected: number; proposed: number; deduped: number; errors: number }>
}> {
  const supabase = createServiceClient()

  const { data: venueRows } = await supabase
    .from('venues')
    .select('id')
    .not('google_trends_metro', 'is', null)
    .is('archived_at', null)

  const venueIds = ((venueRows ?? []) as Array<{ id: string }>).map((v) => v.id)

  const summary = {
    venuesChecked: venueIds.length,
    spikesDetected: 0,
    proposed: 0,
    deduped: 0,
    errors: 0,
    perVenue: [] as Array<{
      venueId: string
      spikesDetected: number
      proposed: number
      deduped: number
      errors: number
    }>,
  }

  for (const venueId of venueIds) {
    try {
      const r = await autoProposeFromTrendSpikes(supabase, venueId)
      summary.spikesDetected += r.spikesDetected
      summary.proposed += r.proposed
      summary.deduped += r.deduped
      summary.errors += r.errors
      summary.perVenue.push({
        venueId,
        spikesDetected: r.spikesDetected,
        proposed: r.proposed,
        deduped: r.deduped,
        errors: r.errors,
      })
    } catch (err) {
      console.error(`[cron][cultural_moments_auto_propose] failed for venue ${venueId}:`, err)
      summary.errors += 1
      summary.perVenue.push({
        venueId,
        spikesDetected: 0,
        proposed: 0,
        deduped: 0,
        errors: 1,
      })
    }
  }

  return summary
}

async function scanBacktraceAllVenues(): Promise<
  Record<string, { highConfidence: number; mediumConfidence: number; notified: boolean }>
> {
  const supabase = createServiceClient()

  // Only scan venues that actually have a live Gmail connection — no
  // inbox = no findBacktraceCandidates work worth doing.
  const { data: connectedRows } = await supabase
    .from('gmail_connections')
    .select('venue_id')
    .eq('sync_enabled', true)
    .eq('status', 'active')
  const venueIds = new Set<string>()
  for (const row of connectedRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }
  if (venueIds.size === 0) return {}

  const out: Record<string, { highConfidence: number; mediumConfidence: number; notified: boolean }> = {}

  for (const venueId of venueIds) {
    try {
      const candidates = await findBacktraceCandidates(venueId, { useLiveGmail: true })
      const high = candidates.filter((c) => c.confidence === 'high').length
      const medium = candidates.filter((c) => c.confidence === 'medium').length

      let notified = false
      if (high > 0) {
        // Dedup window: at most one notification per 7 days per venue,
        // regardless of read state. This balances two pressures:
        //   - Don't spam: a coordinator who's seen the alert once
        //     this week shouldn't get pinged again every cron tick.
        //   - Don't fall silent: if new candidates land later (Gmail
        //     polling delivers more emails over time), we want them
        //     to surface within a week without needing a re-scan
        //     click.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const { data: recent } = await supabase
          .from('admin_notifications')
          .select('id')
          .eq('venue_id', venueId)
          .eq('type', 'source_backtrace_ready')
          .gte('created_at', sevenDaysAgo)
          .limit(1)
        if (!recent || recent.length === 0) {
          await createNotification({
            venueId,
            type: 'source_backtrace_ready',
            title: `Source attribution: ${high} ${high === 1 ? 'lead' : 'leads'} ready for re-attribution`,
            body:
              `We found ${high} high-confidence ${high === 1 ? 'match' : 'matches'} ` +
              `where the real first-touch source was misattributed to a scheduling ` +
              `tool. Review and apply at /settings/sources.`,
          })
          notified = true
        }
      }

      out[venueId] = { highConfidence: high, mediumConfidence: medium, notified }
    } catch (err) {
      console.error(`[cron] backtrace scan failed for venue ${venueId}:`, err)
      out[venueId] = { highConfidence: -1, mediumConfidence: -1, notified: false }
    }
  }
  return out
}

/**
 * Poll Zoom recordings for every venue with an active connection. The
 * service's syncMeetings handler dedups against processed_zoom_meetings, so
 * even if recordings land slowly we just keep picking up new ones each day.
 *
 * If a connection's refresh token is permanently dead, the service marks
 * it inactive and throws "reconnect needed" — we catch and continue so one
 * dead venue doesn't block the rest.
 */
async function pollZoomAllVenues(): Promise<
  Record<string, { fetched: number; newlyProcessed: number; matched: number; errors: number; reconnectNeeded?: boolean }>
> {
  const supabase = createServiceClient()

  const { data: rows } = await supabase
    .from('zoom_connections')
    .select('venue_id')
    .eq('is_active', true)

  const venueIds = new Set<string>()
  for (const row of rows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }
  if (venueIds.size === 0) return {}

  const out: Record<
    string,
    { fetched: number; newlyProcessed: number; matched: number; errors: number; reconnectNeeded?: boolean }
  > = {}

  for (const venueId of venueIds) {
    try {
      const result = await syncZoomMeetings(venueId, { sinceDays: 30 })
      out[venueId] = {
        fetched: result.fetched,
        newlyProcessed: result.newlyProcessed,
        matched: result.matched,
        errors: result.errors,
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'reconnect needed') {
        out[venueId] = { fetched: 0, newlyProcessed: 0, matched: 0, errors: 0, reconnectNeeded: true }
      } else {
        console.error(`[cron] zoom poll failed for venue ${venueId}:`, err)
        out[venueId] = { fetched: 0, newlyProcessed: 0, matched: 0, errors: 1 }
      }
    }
  }
  return out
}

async function refreshQualitySignalsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  const out: Record<string, number> = {}
  for (const v of venues ?? []) {
    try {
      out[v.id as string] = await persistDropoffInsights(v.id as string)
    } catch (err) {
      console.error(`[quality-signals] failed for ${v.id}:`, err)
      out[v.id as string] = -1
    }
  }
  return out
}

/**
 * Poll emails for all venues with Gmail connected.
 *
 * Gmail tokens live in two places:
 *   - venue_config.gmail_tokens (legacy single-inbox flow)
 *   - gmail_connections (multi-Gmail, current flow — sync_enabled + status='active')
 *
 * Union venue ids from both so a venue that only exists in gmail_connections
 * isn't silently skipped when the legacy column is null.
 */
async function pollEmailsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const venueIds = new Set<string>()

  const { data: legacyRows } = await supabase
    .from('venue_config')
    .select('venue_id')
    .not('gmail_tokens', 'is', null)

  for (const row of legacyRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  const { data: connectionRows } = await supabase
    .from('gmail_connections')
    .select('venue_id')
    .eq('sync_enabled', true)
    .eq('status', 'active')

  for (const row of connectionRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  if (venueIds.size === 0) return {}

  const results: Record<string, number> = {}
  for (const id of venueIds) {
    try {
      const result = await processAllNewEmails(id)
      // Flush any pending auto-sends whose 5-minute delay has elapsed
      const flushed = await flushPendingAutoSends(id)
      results[id] = result.processed + flushed
    } catch (err) {
      console.error(`[cron] Email poll failed for venue ${id}:`, err)
      results[id] = 0
    }
  }
  return results
}

/**
 * Apply heat score decay, graduated cooling warnings, and auto-mark-lost
 * to all venues in a single pass. applyDailyDecay now owns all three,
 * so one cron call covers lifecycle.
 */
async function applyDecayAllVenues(): Promise<
  Record<string, { decayed: number; warnings: number; autoLost: number }>
> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, { decayed: number; warnings: number; autoLost: number }> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      const summary = await applyDailyDecay(id)
      results[id] = {
        decayed: summary.decayedCount,
        warnings: summary.warningsFired,
        autoLost: summary.autoLostCount,
      }
    } catch (err) {
      console.error(`[cron] Heat decay failed for venue ${id}:`, err)
      results[id] = { decayed: 0, warnings: 0, autoLost: 0 }
    }
  }
  return results
}

/**
 * Refresh source attribution calculations for all venues.
 */
async function refreshAttributionAllVenues(): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, boolean> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      // Calculate source attribution from weddings + marketing_spend
      const { data: weddings } = await supabase
        .from('weddings')
        .select('source, status, booking_value, created_at')
        .eq('venue_id', id)

      const { data: spend } = await supabase
        .from('marketing_spend')
        .select('source, amount')
        .eq('venue_id', id)

      if (!weddings) { results[id] = false; continue }

      // Group by source
      const sources = new Map<string, { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }>()

      for (const w of weddings) {
        const src = w.source || 'unknown'
        const existing = sources.get(src) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
        existing.inquiries++
        if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status)) existing.tours++
        if (['booked', 'completed'].includes(w.status)) {
          existing.bookings++
          existing.revenue += Number(w.booking_value) || 0
        }
        sources.set(src, existing)
      }

      // Add spend data
      for (const s of (spend || [])) {
        const existing = sources.get(s.source) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
        existing.spend += Number(s.amount) || 0
        sources.set(s.source, existing)
      }

      // Upsert source_attribution records
      const now = new Date().toISOString()
      for (const [source, data] of sources) {
        const costPerInquiry = data.inquiries > 0 ? data.spend / data.inquiries : 0
        const costPerBooking = data.bookings > 0 ? data.spend / data.bookings : 0
        const conversionRate = data.inquiries > 0 ? data.bookings / data.inquiries : 0
        const roi = data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0

        await supabase.from('source_attribution').upsert({
          venue_id: id,
          source,
          period_start: new Date(new Date().getFullYear(), 0, 1).toISOString(),
          period_end: now,
          spend: data.spend,
          inquiries: data.inquiries,
          tours: data.tours,
          bookings: data.bookings,
          revenue: data.revenue,
          cost_per_inquiry: costPerInquiry,
          cost_per_booking: costPerBooking,
          conversion_rate: conversionRate,
          roi,
          calculated_at: now,
        }, { onConflict: 'venue_id,source,period_start' })
      }

      results[id] = true
    } catch (err) {
      console.error(`[cron] Attribution refresh failed for venue ${id}:`, err)
      results[id] = false
    }
  }
  return results
}

/**
 * Fetch weather forecasts for all venues that have lat/lng configured.
 */
async function fetchWeatherForAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No venues with lat/lng found for weather forecast')
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const records = await fetchWeatherForecast(id)
      results[id] = records.length
    } catch (err) {
      console.error(`[cron] Weather forecast failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate weekly intelligence digests for all active venues.
 * Runs on Mondays — checks day of week before generating.
 * Creates an admin notification when the digest is ready.
 */
async function generateDigestsForAllVenues(): Promise<Record<string, boolean>> {
  // Only generate on Mondays
  const dayOfWeek = new Date().getDay()
  if (dayOfWeek !== 1) {
    console.log('[cron] Weekly digest skipped — not Monday (day=' + dayOfWeek + ')')
    return {}
  }

  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No active venues found for weekly digest')
    return {}
  }

  // Cost-ceiling gate: weekly digests are LLM-narrated proactive
  // surfaces. Skip paused venues per Playbook 21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'weekly_digest',
  })
  if (skipped.length > 0) {
    console.log(`[cron] Weekly digest skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, boolean> = {}

  for (const id of active) {
    try {
      await generateWeeklyDigest(id)

      // Create notification that the digest is ready
      await createNotification({
        venueId: id,
        type: 'weekly_digest',
        title: 'Your weekly intelligence digest is ready',
        body: 'Review your leads, performance trends, and actionable insights for this week.',
      })

      results[id] = true
    } catch (err) {
      console.error(`[cron] Weekly digest failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Measure insight outcomes for all active venues.
 * Checks pending outcomes whose measurement window has elapsed.
 */
async function measureOutcomesAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const measured = await measureInsightOutcomes(id)
      results[id] = measured
    } catch (err) {
      console.error(`[cron] Outcome measurement failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate briefings for all venues that have a briefing_email configured.
 */
async function generateBriefingsForAllVenues(
  type: 'weekly' | 'monthly'
): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('briefing_email', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn(`[cron] No venues with briefing_email found for ${type} briefing`)
    return {}
  }

  // Cost-ceiling gate: weekly + monthly briefings call Sonnet for
  // narration. Skip paused venues per Playbook 21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: type === 'weekly' ? 'weekly_briefing' : 'monthly_briefing',
  })
  if (skipped.length > 0) {
    console.log(`[cron] ${type} briefing skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, boolean> = {}

  for (const id of active) {
    try {
      if (type === 'weekly') {
        await generateWeeklyBriefing(id)
      } else {
        await generateMonthlyBriefing(id)
      }
      results[id] = true
    } catch (err) {
      console.error(`[cron] ${type} briefing failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Check for weddings that happened 3 days ago and don't have feedback yet.
 * Creates a notification prompting the coordinator to submit feedback.
 */
async function checkPostEventFeedback(): Promise<{ notified: number }> {
  const supabase = createServiceClient()

  // Find weddings where wedding_date was 3 days ago, status is booked or completed,
  // and no event_feedback row exists yet
  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
  const dateStr = threeDaysAgo.toISOString().split('T')[0]

  const { data: weddings, error } = await supabase
    .from('weddings')
    .select(`
      id,
      venue_id,
      wedding_date,
      status
    `)
    .eq('wedding_date', dateStr)
    .in('status', ['booked', 'completed'])

  if (error || !weddings || weddings.length === 0) {
    return { notified: 0 }
  }

  // Filter out weddings that already have feedback
  const weddingIds = weddings.map((w) => w.id as string)
  const { data: existingFeedback } = await supabase
    .from('event_feedback')
    .select('wedding_id')
    .in('wedding_id', weddingIds)

  const feedbackWeddingIds = new Set(
    (existingFeedback ?? []).map((f) => f.wedding_id as string)
  )

  const needsFeedback = weddings.filter(
    (w) => !feedbackWeddingIds.has(w.id as string)
  )

  if (needsFeedback.length === 0) {
    return { notified: 0 }
  }

  let notified = 0

  for (const w of needsFeedback) {
    const weddingId = w.id as string
    const venueId = w.venue_id as string

    // Get couple names for the notification
    const { data: people } = await supabase
      .from('people')
      .select('first_name, role')
      .eq('wedding_id', weddingId)

    const coupleNames = (people ?? [])
      .filter((p) =>
        ['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role)
      )
      .map((p) => p.first_name)
      .join(' & ')

    const label = coupleNames || 'the couple'

    try {
      await createNotification({
        venueId,
        weddingId,
        type: 'post_event_feedback',
        title: `Time to share your feedback on ${label}'s wedding!`,
        body: `Your observations help Bloom House learn. Complete the post-event feedback while it's fresh.`,
      })
      notified++
    } catch (err) {
      console.error(`[cron] Feedback notification failed for wedding ${weddingId}:`, err)
    }
  }

  return { notified }
}

// ---------------------------------------------------------------------------
// GET — Vercel cron sends GET requests
//   Header: Authorization: Bearer <CRON_SECRET>
//   Query: ?job=JOB_NAME
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const job = searchParams.get('job') as JobName | null

  if (!job || !VALID_JOBS.includes(job)) {
    return NextResponse.json(
      { error: `Invalid job. Must be one of: ${VALID_JOBS.join(', ')}` },
      { status: 400 }
    )
  }

  // OPS-21.2.3: every cron tick gets a cron_runs row via trackCronRun.
  // Captures started_at / ended_at / duration_ms / status / error_class
  // so the pipeline-health page + alerts can detect stuck/failed crons.
  const { trackCronRun } = await import('@/lib/observability/metrics')
  try {
    console.log(`[cron] Starting job: ${job}`)
    const wrapped = await trackCronRun(job, async () => runJob(job))
    console.log(`[cron] Completed job: ${job} in ${wrapped.duration_ms}ms`)
    return NextResponse.json({ job, success: true, result: wrapped.result, duration_ms: wrapped.duration_ms })
  } catch (err) {
    console.error(`[cron] Job ${job} failed:`, err)
    return NextResponse.json(
      { job, success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
