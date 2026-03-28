/**
 * Bloom House: Daily Digest Service
 *
 * Generates a morning summary email for venue coordinators.
 * Aggregates the last 24 hours of venue activity — inquiries, drafts,
 * tours, weddings, engagement events, anomaly alerts, approval stats,
 * and AI cost — into a structured digest with an AI-generated summary.
 *
 * For now, "sending" logs the HTML to console (swap for Resend/SES later).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'

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
 */
export async function generateDigest(venueId: string): Promise<Digest> {
  const supabase = createServiceClient()
  const since = hoursAgo(24)
  const todayStr = today()

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
  const coordinatorName = (config?.coordinator_name as string) ?? 'Team'

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
    // New inquiries in last 24 hours
    supabase
      .from('weddings')
      .select('id, people!people_wedding_id_fkey(role, first_name, last_name)')
      .eq('venue_id', venueId)
      .gte('created_at', since),

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

    // New engagement events in last 24 hours
    supabase
      .from('engagement_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('created_at', since),

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

    // Unanswered inquiries: inquiry status, created > 2 hours ago with no outbound interaction
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'inquiry')
      .lt('created_at', hoursAgo(2)),
  ])

  // ---- Helper: extract couple names from people join ----
  function getCoupleNames(row: any): string {
    const people = row.people ?? []
    const partners = people.filter((p: any) => p.role === 'partner1' || p.role === 'partner2')
    const names = partners.map((p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean)
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

  // Alerts
  const alerts = (alertsResult.data ?? []).map(
    (a) =>
      `[${a.alert_type}] ${a.metric_name}: ${(a.ai_explanation as string) ?? 'No details'}`
  )

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
  try {
    const sevenDaysAgo = hoursAgo(7 * 24)
    const { data: briefing } = await supabase
      .from('briefings')
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

  // ---- AI summary ----
  const summaryResult = await callAI({
    systemPrompt:
      'You are a concise morning briefing assistant for a wedding venue coordinator. ' +
      'Write a 2-3 sentence summary of their day. Be warm, direct, and actionable. ' +
      'If there are items needing attention, lead with those. No markdown.',
    userPrompt: `Venue: ${venueName}
Coordinator: ${coordinatorName}
Date: ${todayStr}

Action needed: ${sections.action_needed.pending_drafts} pending drafts, ${sections.action_needed.unanswered_inquiries} unanswered inquiries, ${sections.action_needed.stale_leads} stale leads
Yesterday: ${sections.yesterday.new_inquiries} new inquiries, ${sections.yesterday.emails_sent} emails sent (${sections.yesterday.auto_sent} auto-sent)
Upcoming: ${tours.length} tours this week, ${weddings.length} weddings in 30 days
Performance: ${approvalRate}% approval rate, $${sections.performance.ai_cost} AI cost
Alerts: ${alerts.length > 0 ? alerts.join('; ') : 'None'}
New engagement events: ${engagementResult.count ?? 0}
${sections.briefing_highlight ? `Weekly briefing insight: ${sections.briefing_highlight}` : ''}

Write the morning summary.`,
    maxTokens: 200,
    temperature: 0.4,
    venueId,
    taskType: 'daily_digest',
  })

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
// 3. sendDigestEmail
// ---------------------------------------------------------------------------

/**
 * Generates the digest, formats to HTML, and "sends" via the venue's
 * briefing_email. For now, logs the output (swap for Resend/SES later).
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

    // TODO: Replace with Resend or SES in production
    console.log(`[daily-digest] Digest ready for ${briefingEmail}`)
    console.log(`[daily-digest] Subject: ${digest.venue_name} — Daily Digest for ${digest.date}`)
    console.log(`[daily-digest] HTML length: ${html.length} chars`)

    return { sent: true, to: briefingEmail }
  } catch (err) {
    console.error(`[daily-digest] Failed for venue ${venueId}:`, err)
    return { sent: false, to: briefingEmail }
  }
}

// ---------------------------------------------------------------------------
// 4. sendAllDigests
// ---------------------------------------------------------------------------

/**
 * Sends a daily digest to all active venues that have a briefing_email
 * configured. Designed to be called from the cron route.
 */
export async function sendAllDigests(): Promise<
  Record<string, { sent: boolean; to: string }>
> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('briefing_email', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn('[daily-digest] No venues with briefing_email found')
    return {}
  }

  const results: Record<string, { sent: boolean; to: string }> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      results[id] = await sendDigestEmail(id)
    } catch (err) {
      console.error(`[daily-digest] Failed for venue ${id}:`, err)
      results[id] = { sent: false, to: '' }
    }
  }

  return results
}
