/**
 * Plain-English display labels for anomaly metric keys.
 *
 * Anchor: Round 2 audit OBS-027/Pattern C (Engineering Console In
 * Product, 2026-05-14). Before this map, briefings/page.tsx +
 * anomalies/page.tsx rendered raw snake_case keys via
 * `a.metric.replace(/_/g, ' ')`. Operators saw "auto link rate"
 * instead of "Auto-link rate", "candidate volume" instead of
 * "Platform signal volume", etc.
 *
 * Add a new entry whenever a new metric_name lands in
 * intel/anomaly-detection.ts METRICS or in the agent-side anomaly
 * surfaces. Fall back to humanize() for keys that haven't been
 * mapped yet — readable but not branded.
 */

export interface AnomalyDisplay {
  title: string
  description: string
  /** Optional canonical action route for the recommendation card. */
  cta?: {
    href: string
    label: string
  }
}

export const ANOMALY_LABELS: Record<string, AnomalyDisplay> = {
  // ----- Intel funnel metrics (anomaly-detection.ts METRICS) -----
  inquiry_volume: {
    title: 'New inquiries',
    description: 'Count of fresh couples reaching out this period.',
    cta: { href: '/intel/dashboard', label: 'See dashboard' },
  },
  response_time: {
    title: 'Time to first reply',
    description: 'Average minutes between an inquiry landing and your first response.',
    cta: { href: '/agent/inbox?folder=responding', label: 'Open inbox' },
  },
  tour_conversion: {
    title: 'Tour conversion',
    description: 'Share of inquiries that booked a tour.',
    cta: { href: '/intel/tours', label: 'See tours' },
  },
  booking_rate: {
    title: 'Booking rate',
    description: 'Share of toured couples who signed.',
    cta: { href: '/intel/health-score', label: 'See health score' },
  },
  avg_booking_value: {
    title: 'Average booking value',
    description: 'Mean signed-contract amount across recent bookings.',
  },
  lost_deal_rate: {
    title: 'Lost deal rate',
    description: 'Share of inquiries marked as lost without booking.',
    cta: { href: '/intel/lost-deals', label: 'Review lost deals' },
  },
  engagement_rate: {
    title: 'Engagement per inquiry',
    description: 'How active each couple is across the funnel (replies, tours, follow-ups).',
  },
  candidate_volume: {
    title: 'Platform signal volume',
    description: 'New people browsing your Knot / Instagram / WeddingWire listings.',
    cta: { href: '/intel/candidates', label: 'See candidates' },
  },
  attribution_conflict_rate: {
    title: 'Source conflicts',
    description: "When the listed source disagrees with what we computed from couple journeys.",
    cta: { href: '/intel/candidates?tab=conflicts', label: 'Clear conflicts' },
  },
  auto_link_rate: {
    title: 'Auto-link rate',
    description: 'Share of new platform signals that linked to a wedding without operator review.',
  },
  availability_fill_rate: {
    title: 'Availability fill rate',
    description: 'Share of available dates that booked this period.',
  },

  // ----- Agent (email pipeline) metrics -----
  // These fire on /agent/classification-health, /agent/notifications,
  // and the operator anomaly feed. Adding entries here lifts them
  // out of snake_case in any surface that reads the label map.
  auto_send_rate_drop: {
    title: "Auto-send rate dropped",
    description: 'Sage sent fewer replies on her own than usual. Could mean confidence dropped or routing changed.',
    cta: { href: '/agent/drafts?tab=pending', label: 'Review drafts' },
  },
  draft_pending_age_spike: {
    title: 'Drafts piling up',
    description: 'Pending drafts are waiting longer than usual for review.',
    cta: { href: '/agent/drafts?tab=pending', label: 'Review drafts' },
  },
  classifier_null_rate_high: {
    title: 'Unclassified inbound spike',
    description: "Recent emails Sage couldn't confidently classify. Usually means a new sender pattern.",
    cta: { href: '/agent/classification-health', label: 'See classification health' },
  },
  inbound_volume_drop: {
    title: 'Fewer inbound emails',
    description: 'Inbox volume is below the usual baseline. Could be deliverability or a quiet week.',
  },
}

/**
 * Resolve a metric key to display copy. Returns a humanized fallback
 * for keys not yet mapped — readable but no CTA.
 */
export function getAnomalyDisplay(metricKey: string): AnomalyDisplay {
  return (
    ANOMALY_LABELS[metricKey] ?? {
      title: humanize(metricKey),
      description: '',
    }
  )
}

function humanize(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
