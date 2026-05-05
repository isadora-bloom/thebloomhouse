/**
 * Bloom House: Daily Digest Service
 *
 * Generates a morning summary email for venue coordinators.
 * Aggregates the last 24 hours of venue activity — inquiries, drafts,
 * tours, weddings, engagement events, anomaly alerts, approval stats,
 * and AI cost — into a structured digest with an AI-generated summary.
 *
 * Sending prefers the venue's authenticated Gmail (so the digest arrives
 * from their own inbox). If Gmail isn't connected, falls back to Resend
 * via the transactional `sendEmail` helper. If Resend isn't configured
 * either, the helper logs to console so dev keeps working.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import { callAI } from '@/lib/ai/client'
import { withAiCache } from '@/lib/ai/cache'
import { sendEmail as sendGmail } from '@/lib/services/gmail'
import { sendEmail as sendTransactionalEmail } from '@/lib/services/email'
import {
  enabledCategories,
  type DigestPreferences,
} from '@/lib/services/digest-preferences'

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * Bump when the system prompt changes so withAiCache invalidates on prompt updates.
 * See PROMPTS-CHANGELOG.md for version history.
 */
export const DAILY_DIGEST_PROMPT_VERSION = 'daily-digest.prompt.v1.0'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestSections {
  action_needed: {
    pending_drafts: number
    unanswered_inquiries: number
    stale_leads: number
  }
  yesterday: {
    new_inquiries: number
    emails_sent: number
    auto_sent: number
    tours_completed: number
  }
  upcoming: {
    tours: Array<{ couple: string; date: string }>
    weddings: Array<{ couple: string; date: string; days_away: number }>
  }
  performance: {
    approval_rate: number
    avg_response_time: number
    ai_cost: number
  }
  alerts: string[]
  briefing_highlight?: string
}

export interface Digest {
  venue_name: string
  coordinator_name: string
  date: string
  sections: DigestSections
  summary_text: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursAgo(hours: number): string {
  const d = new Date()
  d.setTime(d.getTime() - hours * 60 * 60 * 1000)
  return d.toISOString()
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function daysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function daysBetween(dateStr: string): number {
  const target = new Date(dateStr)
  const now = new Date()
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// ---------------------------------------------------------------------------
// 1. generateDigest
// ---------------------------------------------------------------------------

/**
 * Gathers the last 24 hours of venue activity and generates a structured
 * digest with an AI-written summary paragraph.
 *
 * Per-user category filtering (T5-γ.5): when `categoryFilter` is provided,
 * sections that map to opted-out categories are suppressed:
 *   - alerts             → 'anomaly'
 *   - briefing_highlight → 'correlation' / 'market' (macro context)
 * Sections that are always-on (action_needed, yesterday, upcoming,
 * performance) reflect operational reality every coordinator should see
 * regardless of category prefs.
 *
 * `coordinatorNameOverride` lets the per-user dispatcher personalise the
 * greeting with the recipient's first name instead of the venue-level
 * coordinator_name fallback.
 */
export async function generateDigest(
  venueId: string,
  options?: { categoryFilter?: Set<string>; coordinatorNameOverride?: string },
): Promise<Digest> {
  const supabase = createServiceClient()
  const since = hoursAgo(24)
  const todayStr = today()
  const categoryFilter = options?.categoryFilter

  // ---- Venue + coordinator info ----
  const { data: venue } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .single()

  const { data: config } = await supabase
    .from('venue_config')
    .select('coordinator_name, business_name')
    .eq('venue_id', venueId)
    .single()

  const venueName = (venue?.name as string) ?? 'Your Venue'
  const coordinatorName =
    options?.coordinatorNameOverride ??
    (config?.coordinator_name as string) ??
    'Team'

  // ---- Gather all data in parallel ----
  const [
    newInquiriesResult,
    pendingDraftsResult,
    autoSentResult,
    sentDraftsResult,
    upcomingToursResult,
    upcomingWeddingsResult,
    engagementResult,
    alertsResult,
    approvalStatsResult,
    aiCostResult,
    staleLeadsResult,
    unansweredResult,
  ] = await Promise.all([
    // New inquiries in last 24 hours.
    // T5-Rixey-LL: window on inquiry_date (real arrival time) not
    // created_at (import time). A venue importing 12 months of historical
    // leads on Day 0 would otherwise see "0 new inquiries yesterday"
    // even though hundreds of historical inquiry rows just landed —
    // their inquiry_date stretched back a year but their created_at
    // collapsed to the import day.
    supabase
      .from('weddings')
      .select('id, people!people_wedding_id_fkey(role, first_name, last_name)')
      .eq('venue_id', venueId)
      .gte('inquiry_date', since),

    // Pending drafts awaiting approval
    supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'pending'),

    // Drafts auto-sent in last 24 hours
    supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('auto_sent', true)
      .gte('created_at', since),

    // All drafts sent (manual + auto) in last 24 hours
    supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'sent')
      .gte('created_at', since),

    // Upcoming tours (next 7 days)
    supabase
      .from('weddings')
      .select('tour_date, people!people_wedding_id_fkey(role, first_name, last_name)')
      .eq('venue_id', venueId)
      .not('tour_date', 'is', null)
      .gte('tour_date', todayStr)
      .lte('tour_date', daysFromNow(7))
      .order('tour_date', { ascending: true }),

    // Upcoming weddings (next 30 days)
    supabase
      .from('weddings')
      .select('wedding_date, people!people_wedding_id_fkey(role, first_name, last_name)')
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .not('wedding_date', 'is', null)
      .gte('wedding_date', todayStr)
      .lte('wedding_date', daysFromNow(30))
      .order('wedding_date', { ascending: true }),

    // New engagement events in last 24 hours. Use occurred_at (event time)
    // not created_at (processing time) — see ANTI-2.6.4 / migration 089.
    // Filter inbound per INV-16: the digest reports "what couples did",
    // not "what we sent them".
    supabase
      .from('engagement_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .gte('occurred_at', since),

    // Active anomaly alerts
    supabase
      .from('anomaly_alerts')
      .select('alert_type, metric_name, ai_explanation')
      .eq('venue_id', venueId)
      .eq('resolved', false),

    // Approval stats for last 24 hours (approved, edited, rejected)
    supabase
      .from('drafts')
      .select('status')
      .eq('venue_id', venueId)
      .in('status', ['approved', 'sent', 'edited', 'rejected'])
      .gte('updated_at', since),

    // AI cost for last 24 hours
    supabase
      .from('api_costs')
      .select('cost')
      .eq('venue_id', venueId)
      .gte('created_at', since),

    // Stale leads: inquiry status, no interaction in 5+ days
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'inquiry')
      .lt('updated_at', hoursAgo(120)),

    // Unanswered inquiries: inquiry status, ARRIVED > 2 hours ago with
    // no outbound interaction. T5-Rixey-LL: window on inquiry_date
    // (real arrival time) not created_at (import time). Pre-fix every
    // historical inquiry would count as "unanswered for >2h" the moment
    // it landed in the import — false alarm for venues that responded
    // to those leads months ago.
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'inquiry')
      .lt('inquiry_date', hoursAgo(2)),
  ])

  // ---- Helper: extract couple names from people join ----
  // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name so Knot
  // proxy + real-Gmail rows don't render as repeats in the digest.
  function getCoupleNames(row: any): string {
    const people = row.people ?? []
    const partners = people.filter((p: any) => p.role === 'partner1' || p.role === 'partner2')
    const deduped = dedupePeopleByName(partners)
    const names = deduped.map((p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean)
    return names.length > 0 ? names.join(' & ') : 'Unknown'
  }

  // ---- Compute sections ----

  const newInquiries = newInquiriesResult.data ?? []

  // Tours — map to { couple, date }
  const tours = (upcomingToursResult.data ?? []).map((t: any) => ({
    couple: getCoupleNames(t),
    date: t.tour_date as string,
  }))

  // Weddings — map to { couple, date, days_away }
  const weddings = (upcomingWeddingsResult.data ?? []).map((w: any) => ({
    couple: getCoupleNames(w),
    date: w.wedding_date as string,
    days_away: daysBetween(w.wedding_date as string),
  }))

  // Approval stats
  const approvalRows = approvalStatsResult.data ?? []
  const approved = approvalRows.filter(
    (d) => d.status === 'approved' || d.status === 'sent'
  ).length
  const edited = approvalRows.filter((d) => d.status === 'edited').length
  const rejected = approvalRows.filter((d) => d.status === 'rejected').length
  const totalReviewed = approved + edited + rejected
  const approvalRate = totalReviewed > 0
    ? Math.round((approved / totalReviewed) * 100)
    : 0

  // AI cost total
  const aiCost = (aiCostResult.data ?? []).reduce(
    (sum, row) => sum + (Number(row.cost) || 0),
    0
  )

  // Avg response time (rough: time between wedding created_at and first outbound interaction)
  // For v1, we leave this as 0 — would need a join or separate query
  const avgResponseTime = 0

  // Alerts. Per-user category filter: anomaly alerts only surface when
  // the recipient opted into 'anomaly' / 'data_anomaly'. When no filter
  // is provided (legacy venue-broadcast path), alerts are always
  // included.
  const includeAnomalyAlerts =
    !categoryFilter || categoryFilter.has('anomaly') || categoryFilter.has('data_anomaly')
  const alerts = includeAnomalyAlerts
    ? (alertsResult.data ?? []).map(
        (a) =>
          `[${a.alert_type}] ${a.metric_name}: ${(a.ai_explanation as string) ?? 'No details'}`
      )
    : []

  const sections: DigestSections = {
    action_needed: {
      pending_drafts: pendingDraftsResult.count ?? 0,
      unanswered_inquiries: unansweredResult.count ?? 0,
      stale_leads: staleLeadsResult.count ?? 0,
    },
    yesterday: {
      new_inquiries: newInquiries.length,
      emails_sent: sentDraftsResult.count ?? 0,
      auto_sent: autoSentResult.count ?? 0,
      tours_completed: 0, // Would need tour completion tracking
    },
    upcoming: {
      tours,
      weddings,
    },
    performance: {
      approval_rate: approvalRate,
      avg_response_time: avgResponseTime,
      ai_cost: Math.round(aiCost * 100) / 100,
    },
    alerts,
  }

  // ---- Briefing highlight: pull 1-2 recommendations from the latest weekly briefing ----
  // Per-user category filter: macro/correlation context is only surfaced
  // when the recipient opted into 'correlation' / 'market'. Pricing-only
  // recipients still see operational sections above; this enrichment
  // requires explicit opt-in via include_macro_correlations.
  const includeBriefingHighlight =
    !categoryFilter ||
    categoryFilter.has('correlation') ||
    categoryFilter.has('market') ||
    categoryFilter.has('weather') ||
    categoryFilter.has('seasonal')
  if (includeBriefingHighlight) {
    try {
    const sevenDaysAgo = hoursAgo(7 * 24)
    const { data: briefing } = await supabase
      .from('ai_briefings')
      .select('content')
      .eq('venue_id', venueId)
      .eq('briefing_type', 'weekly')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (briefing?.content) {
      // Content is stored as JSON — extract recommendations if present
      const content =
        typeof briefing.content === 'string'
          ? JSON.parse(briefing.content as string)
          : briefing.content

      const recommendations: string[] = []

      if (Array.isArray(content?.recommendations)) {
        for (const rec of content.recommendations.slice(0, 2)) {
          if (typeof rec === 'string') {
            recommendations.push(rec)
          } else if (rec?.text) {
            recommendations.push(rec.text as string)
          }
        }
      } else if (content?.summary) {
        // Fall back to summary if no structured recommendations
        recommendations.push(
          typeof content.summary === 'string'
            ? (content.summary as string).slice(0, 200)
            : String(content.summary).slice(0, 200)
        )
      }

      if (recommendations.length > 0) {
        sections.briefing_highlight = recommendations.join(' | ')
      }
    }
    } catch {
      // Briefing highlight is enrichment — don't block the digest
    }
  }

  // ---- AI summary ----
  // withAiCache de-dupes concurrent per-user digest calls that hit the
  // same venue on the same day (two coordinators clicking Send at once,
  // legacy + per-user path both firing). Cache key is venue + date +
  // prompt version; 5-min default TTL from withAiCache covers the window.
  // Only the LLM call is cached; all DB queries above run fresh every time.
  const digestSystemPrompt =
    'You are a concise morning briefing assistant for a wedding venue coordinator. ' +
    'Write a 2-3 sentence summary of their day. Be warm, direct, and actionable. ' +
    'If there are items needing attention, lead with those. No markdown.'
  const digestUserPrompt = `Venue: ${venueName}
Coordinator: ${coordinatorName}
Date: ${todayStr}

Action needed: ${sections.action_needed.pending_drafts} pending drafts, ${sections.action_needed.unanswered_inquiries} unanswered inquiries, ${sections.action_needed.stale_leads} stale leads
Yesterday: ${sections.yesterday.new_inquiries} new inquiries, ${sections.yesterday.emails_sent} emails sent (${sections.yesterday.auto_sent} auto-sent)
Upcoming: ${tours.length} tours this week, ${weddings.length} weddings in 30 days
Performance: ${approvalRate}% approval rate, $${sections.performance.ai_cost} AI cost
Alerts: ${alerts.length > 0 ? alerts.join('; ') : 'None'}
New engagement events: ${engagementResult.count ?? 0}
${sections.briefing_highlight ? `Weekly briefing insight: ${sections.briefing_highlight}` : ''}

Write the morning summary.`

  const summaryResult = await withAiCache(
    `digest:${venueId}:${todayStr}:${DAILY_DIGEST_PROMPT_VERSION}`,
    () => callAI({
      systemPrompt: digestSystemPrompt,
      userPrompt: digestUserPrompt,
      maxTokens: 200,
      temperature: 0.4,
      venueId,
      taskType: 'daily_digest',
      promptVersion: DAILY_DIGEST_PROMPT_VERSION,
    }),
  )

  return {
    venue_name: venueName,
    coordinator_name: coordinatorName,
    date: todayStr,
    sections,
    summary_text: summaryResult.text,
  }
}

// ---------------------------------------------------------------------------
// 2. formatDigestHtml
// ---------------------------------------------------------------------------

/**
 * Converts a structured digest into an HTML email string.
 * Uses inline CSS for email-client compatibility.
 */
export function formatDigestHtml(digest: Digest): string {
  const { venue_name, coordinator_name, date, sections, summary_text } = digest

  const brandColor = '#7D8471' // sage-500
  const accentColor = '#A6894A' // gold-500
  const bgColor = '#FDFAF6'
  const textColor = '#2D2D2D'
  const mutedColor = '#6B7280'

  const actionCount =
    sections.action_needed.pending_drafts +
    sections.action_needed.unanswered_inquiries +
    sections.action_needed.stale_leads

  // Format upcoming tours list
  const toursHtml =
    sections.upcoming.tours.length > 0
      ? sections.upcoming.tours
          .map(
            (t) =>
              `<tr><td style="padding:4px 12px 4px 0;color:${textColor};">${t.couple}</td><td style="padding:4px 0;color:${mutedColor};">${t.date}</td></tr>`
          )
          .join('')
      : `<tr><td style="padding:4px 0;color:${mutedColor};">No tours scheduled</td></tr>`

  // Format upcoming weddings list
  const weddingsHtml =
    sections.upcoming.weddings.length > 0
      ? sections.upcoming.weddings
          .map(
            (w) =>
              `<tr><td style="padding:4px 12px 4px 0;color:${textColor};">${w.couple}</td><td style="padding:4px 12px 4px 0;color:${mutedColor};">${w.date}</td><td style="padding:4px 0;color:${mutedColor};">${w.days_away}d</td></tr>`
          )
          .join('')
      : `<tr><td style="padding:4px 0;color:${mutedColor};">No weddings in the next 30 days</td></tr>`

  // Format alerts
  const alertsHtml =
    sections.alerts.length > 0
      ? sections.alerts
          .map(
            (a) =>
              `<div style="padding:6px 10px;margin-bottom:4px;background:#FEF3C7;border-left:3px solid ${accentColor};border-radius:4px;font-size:13px;color:${textColor};">${a}</div>`
          )
          .join('')
      : `<div style="color:${mutedColor};font-size:13px;">No active alerts</div>`

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bgColor};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${textColor};">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">

  <!-- Header -->
  <tr>
    <td style="background:${brandColor};padding:24px 28px;">
      <h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:'Georgia',serif;">
        Good morning, ${coordinator_name}
      </h1>
      <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
        ${venue_name} &middot; ${date}
      </p>
    </td>
  </tr>

  <!-- Summary -->
  <tr>
    <td style="padding:24px 28px 16px;">
      <p style="margin:0;font-size:15px;line-height:1.55;color:${textColor};">
        ${summary_text}
      </p>
    </td>
  </tr>

  <!-- Action Needed -->
  ${actionCount > 0 ? `
  <tr>
    <td style="padding:0 28px 16px;">
      <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;">
        <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:#DC2626;">
          Action Needed
        </h2>
        <table cellpadding="0" cellspacing="0" style="font-size:14px;">
          ${sections.action_needed.pending_drafts > 0 ? `<tr><td style="padding:2px 0;">&#9679; <strong>${sections.action_needed.pending_drafts}</strong> draft${sections.action_needed.pending_drafts !== 1 ? 's' : ''} awaiting approval</td></tr>` : ''}
          ${sections.action_needed.unanswered_inquiries > 0 ? `<tr><td style="padding:2px 0;">&#9679; <strong>${sections.action_needed.unanswered_inquiries}</strong> unanswered inquir${sections.action_needed.unanswered_inquiries !== 1 ? 'ies' : 'y'}</td></tr>` : ''}
          ${sections.action_needed.stale_leads > 0 ? `<tr><td style="padding:2px 0;">&#9679; <strong>${sections.action_needed.stale_leads}</strong> stale lead${sections.action_needed.stale_leads !== 1 ? 's' : ''} (5+ days quiet)</td></tr>` : ''}
        </table>
      </div>
    </td>
  </tr>` : ''}

  <!-- Yesterday -->
  <tr>
    <td style="padding:0 28px 16px;">
      <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${brandColor};">
        Yesterday
      </h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;">
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">New inquiries</td>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;">${sections.yesterday.new_inquiries}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">Emails sent</td>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;">${sections.yesterday.emails_sent}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">Auto-sent</td>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;">${sections.yesterday.auto_sent}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;">Tours completed</td>
          <td style="padding:6px 0;text-align:right;font-weight:600;">${sections.yesterday.tours_completed}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Upcoming Tours -->
  <tr>
    <td style="padding:0 28px 16px;">
      <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${brandColor};">
        Upcoming Tours (7 days)
      </h2>
      <table cellpadding="0" cellspacing="0" style="font-size:14px;">${toursHtml}</table>
    </td>
  </tr>

  <!-- Upcoming Weddings -->
  <tr>
    <td style="padding:0 28px 16px;">
      <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${brandColor};">
        Upcoming Weddings (30 days)
      </h2>
      <table cellpadding="0" cellspacing="0" style="font-size:14px;">${weddingsHtml}</table>
    </td>
  </tr>

  <!-- Performance -->
  <tr>
    <td style="padding:0 28px 16px;">
      <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${brandColor};">
        Performance
      </h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;">
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">Approval rate</td>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;">${sections.performance.approval_rate}%</td>
        </tr>
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">Avg response time</td>
          <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;">${sections.performance.avg_response_time > 0 ? `${sections.performance.avg_response_time} min` : '—'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;">AI cost (24h)</td>
          <td style="padding:6px 0;text-align:right;font-weight:600;">$${sections.performance.ai_cost.toFixed(2)}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Briefing Highlight -->
  ${sections.briefing_highlight ? `
  <tr>
    <td style="padding:0 28px 16px;">
      <div style="background:#F0F5F1;border:1px solid #D1DDD3;border-radius:8px;padding:16px;">
        <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${brandColor};">
          Weekly Briefing Insight
        </h2>
        <p style="margin:0;font-size:14px;line-height:1.5;color:${textColor};">
          ${sections.briefing_highlight}
        </p>
      </div>
    </td>
  </tr>` : ''}

  <!-- Alerts -->
  ${sections.alerts.length > 0 ? `
  <tr>
    <td style="padding:0 28px 16px;">
      <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:${accentColor};">
        Alerts
      </h2>
      ${alertsHtml}
    </td>
  </tr>` : ''}

  <!-- Footer -->
  <tr>
    <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
      <p style="margin:0;font-size:12px;color:${mutedColor};text-align:center;">
        Bloom House &middot; Daily Digest &middot; ${date}
      </p>
    </td>
  </tr>

</table>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 3. sendDigestEmail (legacy venue-broadcast path)
// ---------------------------------------------------------------------------

/**
 * Legacy venue-broadcast send. Generates a single digest with no
 * per-user category filter and ships it to `venues.briefing_email`.
 * Kept for venues that have NOT yet created a digest_preferences row
 * (rollout fallback) so dropping the per-user shape doesn't silently
 * regress their morning email.
 *
 * For preference-aware per-user dispatch see sendDigestEmailForUser.
 */
export async function sendDigestEmail(
  venueId: string
): Promise<{ sent: boolean; to: string }> {
  const supabase = createServiceClient()

  // Get the briefing email
  const { data: venue } = await supabase
    .from('venues')
    .select('briefing_email, name')
    .eq('id', venueId)
    .single()

  const briefingEmail = (venue?.briefing_email as string) ?? null
  if (!briefingEmail) {
    console.warn(`[daily-digest] No briefing_email for venue ${venueId}`)
    return { sent: false, to: '' }
  }

  try {
    const digest = await generateDigest(venueId)
    const html = formatDigestHtml(digest)
    const subject = `${digest.venue_name} — Daily Digest for ${digest.date}`

    // Send via the venue's authenticated Gmail
    const messageId = await sendGmail(venueId, briefingEmail, subject, html)

    if (messageId) {
      console.log(`[daily-digest] Sent via Gmail to ${briefingEmail} (messageId: ${messageId})`)
      return { sent: true, to: briefingEmail }
    }

    // Gmail not connected — fall back to transactional (Resend)
    console.warn(
      `[daily-digest] Gmail not connected for venue ${venueId}, falling back to transactional email`
    )
    const fallback = await sendTransactionalEmail({
      to: briefingEmail,
      subject,
      html,
    })

    if (fallback.ok) {
      console.log(
        `[daily-digest] Sent via Resend to ${briefingEmail} (id: ${fallback.id ?? 'n/a'})`
      )
      return { sent: true, to: briefingEmail }
    }

    console.error(
      `[daily-digest] Transactional fallback failed for venue ${venueId}: ${fallback.error}`
    )
    return { sent: false, to: briefingEmail }
  } catch (err) {
    console.error(`[daily-digest] Failed for venue ${venueId}:`, err)
    return { sent: false, to: briefingEmail }
  }
}

// ---------------------------------------------------------------------------
// 3b. sendDigestEmailForUser — per-user, category-aware (T5-γ.5)
// ---------------------------------------------------------------------------

/**
 * Per-user dispatch (T5-γ.5). Honors enabledCategories from the
 * coordinator's digest_preferences row and sends to THAT coordinator's
 * email (auth.users.email), not the venue-level briefing_email.
 *
 * Two coordinators on the same venue with different category prefs
 * (e.g. one wants self_knowledge, the other doesn't) end up receiving
 * different digests rather than a single venue-broadcast.
 *
 * Sender priority: venue-authenticated Gmail (so the digest arrives
 * from the venue's own inbox) → Resend transactional fallback. This
 * mirrors the legacy sendDigestEmail flow.
 */
export async function sendDigestEmailForUser(
  prefs: DigestPreferences,
  recipientEmail: string,
  recipientName?: string,
): Promise<{ sent: boolean; to: string }> {
  const venueId = prefs.venue_id
  if (!recipientEmail) {
    console.warn(
      `[daily-digest] No recipient email for user ${prefs.user_id} on venue ${venueId}`,
    )
    return { sent: false, to: '' }
  }

  try {
    const categoryFilter = enabledCategories(prefs)
    const digest = await generateDigest(venueId, {
      categoryFilter,
      coordinatorNameOverride: recipientName,
    })
    const html = formatDigestHtml(digest)
    const subject = `${digest.venue_name} — Daily Digest for ${digest.date}`

    // Email channel must be on. If a coordinator turned off email but
    // left in_app on, we still build the digest above (so /pulse-style
    // surfaces could read it) but we don't ship it via mail.
    if (!prefs.channel_email) {
      console.log(
        `[daily-digest] channel_email=off for user ${prefs.user_id}, skipping email send`,
      )
      return { sent: false, to: recipientEmail }
    }

    // Try venue-authenticated Gmail first.
    const messageId = await sendGmail(venueId, recipientEmail, subject, html)
    if (messageId) {
      console.log(
        `[daily-digest] Sent via Gmail to ${recipientEmail} (user ${prefs.user_id}, messageId: ${messageId})`,
      )
      return { sent: true, to: recipientEmail }
    }

    // Resend fallback.
    console.warn(
      `[daily-digest] Gmail not connected for venue ${venueId}, falling back to transactional email for ${recipientEmail}`,
    )
    const fallback = await sendTransactionalEmail({
      to: recipientEmail,
      subject,
      html,
    })

    if (fallback.ok) {
      console.log(
        `[daily-digest] Sent via Resend to ${recipientEmail} (user ${prefs.user_id}, id: ${fallback.id ?? 'n/a'})`,
      )
      return { sent: true, to: recipientEmail }
    }

    console.error(
      `[daily-digest] Transactional fallback failed for user ${prefs.user_id} on venue ${venueId}: ${fallback.error}`,
    )
    return { sent: false, to: recipientEmail }
  } catch (err) {
    console.error(
      `[daily-digest] Per-user dispatch failed for user ${prefs.user_id} on venue ${venueId}:`,
      err,
    )
    return { sent: false, to: recipientEmail }
  }
}

// ---------------------------------------------------------------------------
// 4. sendAllDigests
// ---------------------------------------------------------------------------

/**
 * Sends a daily digest to active venues. PREFERENCE-AWARE + per-user
 * since T5-γ.5:
 *   1. eligibleVenuesToday returns the digest_preferences rows whose
 *      cadence + send_dow + 23h-gate fire today.
 *   2. For each eligible preference row, we resolve the coordinator's
 *      auth email and dispatch a category-filtered digest to THAT
 *      coordinator (not the venue's briefing_email).
 *   3. Two coordinators on the same venue with different category
 *      prefs receive different digests — the include_self_knowledge
 *      opt-out is honored per-recipient.
 *
 * Legacy venue-broadcast fallback: venues with briefing_email but NO
 * digest_preferences row keep getting one venue-level digest so the
 * rollout doesn't silently drop coordinators. They migrate naturally
 * the first time anyone on the team visits /settings/digest-preferences
 * (defaults are weekly Mon).
 *
 * Cost-ceiling gate still applies — paused venues are skipped.
 *
 * Returned shape: keyed by `${venueId}:${userId}` for per-user sends and
 * by `${venueId}` for legacy venue-broadcast sends. Mixing the two keeps
 * the caller's logging path simple (one map per cron run).
 */
export async function sendAllDigests(): Promise<
  Record<string, { sent: boolean; to: string }>
> {
  const supabase = createServiceClient()

  const { eligibleVenuesToday, markPreferencesSent } = await import('@/lib/services/digest-dispatch')
  const { venueIds: prefVenueIds, userPrefs } = await eligibleVenuesToday()

  // Legacy backfill — venues with briefing_email but no preferences row.
  const { data: fallbackVenues } = await supabase
    .from('venues')
    .select('id')
    .not('briefing_email', 'is', null)
  const fallbackIds = ((fallbackVenues ?? []) as Array<{ id: string }>).map((v) => v.id)
  const { data: hasAnyPrefs } = await supabase
    .from('digest_preferences')
    .select('venue_id')
  const venuesWithPrefs = new Set(((hasAnyPrefs ?? []) as Array<{ venue_id: string }>).map((r) => r.venue_id))
  const legacyVenues = fallbackIds.filter((id) => !venuesWithPrefs.has(id))

  const targetVenueIds = Array.from(new Set([...prefVenueIds, ...legacyVenues]))
  if (targetVenueIds.length === 0) {
    console.log('[daily-digest] No venues eligible today (cadence + dow + cost-ceiling gates)')
    return {}
  }

  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(targetVenueIds, {
    workType: 'daily_digest',
  })
  if (skipped.length > 0) {
    console.log(`[daily-digest] Skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }
  const activeSet = new Set(active)

  const results: Record<string, { sent: boolean; to: string }> = {}

  // ---- Per-user dispatch path ----
  // Resolve auth emails for every user with an eligible preference row.
  // We listUsers() once and build a userId → { email, firstName? } map.
  const userIdsToResolve = Array.from(new Set(userPrefs.map((p) => p.user_id)))
  const userInfoMap = new Map<string, { email: string | null; firstName: string | null }>()
  if (userIdsToResolve.length > 0) {
    try {
      // Pull names from user_profiles (auth.users doesn't store first_name).
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, first_name')
        .in('id', userIdsToResolve)
      const nameById = new Map<string, string | null>()
      for (const p of (profiles ?? []) as Array<{ id: string; first_name: string | null }>) {
        nameById.set(p.id, p.first_name)
      }

      // auth.users.email lives on the auth schema and isn't directly
      // queryable from PostgREST — the admin API is the supported route.
      // listUsers paginates at 50/page; we walk through all pages until
      // we have everyone we need or run out.
      const wanted = new Set(userIdsToResolve)
      let page = 1
      const PER_PAGE = 200
      while (wanted.size > 0 && page < 50) {
        const { data: pageData, error } = await supabase.auth.admin.listUsers({
          page,
          perPage: PER_PAGE,
        })
        if (error) {
          console.warn('[daily-digest] auth.admin.listUsers failed:', error.message)
          break
        }
        const users = pageData?.users ?? []
        if (users.length === 0) break
        for (const u of users) {
          if (wanted.has(u.id)) {
            userInfoMap.set(u.id, {
              email: u.email ?? null,
              firstName: nameById.get(u.id) ?? null,
            })
            wanted.delete(u.id)
          }
        }
        if (users.length < PER_PAGE) break
        page += 1
      }
    } catch (err) {
      console.error('[daily-digest] Failed to resolve user emails:', err)
    }
  }

  const sentPrefs: DigestPreferences[] = []
  for (const prefs of userPrefs) {
    if (!activeSet.has(prefs.venue_id)) continue  // cost-ceiling skipped
    const info = userInfoMap.get(prefs.user_id)
    if (!info?.email) {
      console.warn(
        `[daily-digest] No auth email resolved for user ${prefs.user_id} on venue ${prefs.venue_id}; skipping per-user dispatch`,
      )
      continue
    }
    const key = `${prefs.venue_id}:${prefs.user_id}`
    try {
      const result = await sendDigestEmailForUser(prefs, info.email, info.firstName ?? undefined)
      results[key] = result
      if (result.sent) sentPrefs.push(prefs)
    } catch (err) {
      console.error(`[daily-digest] Per-user dispatch failed for ${key}:`, err)
      results[key] = { sent: false, to: info.email }
    }
  }

  // ---- Legacy venue-broadcast path ----
  for (const id of active) {
    if (!legacyVenues.includes(id)) continue
    try {
      results[id] = await sendDigestEmail(id)
    } catch (err) {
      console.error(`[daily-digest] Failed for venue ${id}:`, err)
      results[id] = { sent: false, to: '' }
    }
  }

  // Stamp last_sent_at on the preferences rows whose user-dispatch
  // succeeded. Legacy venues have no row to stamp.
  if (sentPrefs.length > 0) {
    await markPreferencesSent(sentPrefs)
  }

  return results
}
