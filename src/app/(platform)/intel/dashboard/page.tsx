'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useScope } from '@/lib/hooks/use-scope'
import {
  AlertTriangle,
  Shield,
  CheckCircle,
  RefreshCw,
  BarChart3,
  TrendingUp,
  Lightbulb,
  Clock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import { VenueChip } from '@/components/intel/venue-chip'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AICause {
  cause: string
  likelihood: 'high' | 'medium' | 'low'
  action: string
}

interface AnomalyAlert {
  id: string
  venue_id: string
  alert_type: string
  metric_name: string
  current_value: number
  baseline_value: number
  change_percent: number
  severity: 'info' | 'warning' | 'critical'
  ai_explanation: string | null
  causes: AICause[] | null
  acknowledged: boolean
  created_at: string
  venues?: { name: string | null } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHoursMinutes(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '0 hrs 0 mins'
  const whole = Math.floor(hours)
  const mins = Math.round((hours - whole) * 60)
  // Handle rounding overflow (e.g., 6.999 → 7 hrs 0 mins instead of 6 hrs 60 mins)
  if (mins === 60) return `${whole + 1} hrs 0 mins`
  return `${whole} hrs ${mins} mins`
}

function formatMetricName(name: string): string {
  const map: Record<string, string> = {
    inquiry_volume: 'Inquiry Volume',
    weekly_inquiries: 'Weekly Inquiries',
    response_time: 'Average Response Time',
    response_time_hour: 'Average Response Time',
    response_time_hours: 'Average Response Time',
    tour_conversion: 'Tour Conversion',
    booking_rate: 'Booking Rate',
    avg_booking_value: 'Avg Booking Value',
    lost_deal_rate: 'Lost Deal Rate',
    pipeline_heat_avg: 'Pipeline Heat (Avg)',
    competitor_mentions: 'Competitor Mentions',
    instagram_referrals: 'Instagram Referrals',
  }
  return map[name] ?? name
}

function formatMetricValue(name: string, value: number): string {
  switch (name) {
    case 'inquiry_volume':
    case 'weekly_inquiries':
    case 'competitor_mentions':
    case 'instagram_referrals':
      return `${Math.round(value)}`
    case 'response_time':
      return `${Math.round(value)}m`
    case 'response_time_hour':
    case 'response_time_hours':
      return formatHoursMinutes(value)
    case 'tour_conversion':
    case 'booking_rate':
    case 'lost_deal_rate':
      return `${(value * 100).toFixed(1)}%`
    case 'avg_booking_value':
      return `$${Math.round(value).toLocaleString()}`
    case 'pipeline_heat_avg':
      return `${Math.round(value)}`
    default:
      return String(value)
  }
}

function formatChangePercent(value: number): string {
  const pct = (value * 100).toFixed(1)
  return value > 0 ? `+${pct}%` : `${pct}%`
}

function severityConfig(severity: 'info' | 'warning' | 'critical') {
  switch (severity) {
    case 'critical':
      return {
        badge: 'bg-red-50 text-red-700 border border-red-200',
        icon: AlertTriangle,
        accent: 'border-l-red-500',
        label: 'Critical',
      }
    case 'warning':
      return {
        badge: 'bg-amber-50 text-amber-700 border border-amber-200',
        icon: AlertTriangle,
        accent: 'border-l-amber-500',
        label: 'Warning',
      }
    case 'info':
      return {
        badge: 'bg-blue-50 text-blue-700 border border-blue-200',
        icon: Shield,
        accent: 'border-l-blue-500',
        label: 'Info',
      }
  }
}

function likelihoodBadge(likelihood: 'high' | 'medium' | 'low') {
  switch (likelihood) {
    case 'high':
      return 'bg-red-50 text-red-600'
    case 'medium':
      return 'bg-amber-50 text-amber-600'
    case 'low':
      return 'bg-sage-50 text-sage-600'
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Skeleton components
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-24 bg-sage-100 rounded" />
        <div className="h-8 w-16 bg-sage-100 rounded" />
        <div className="h-3 w-32 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

function AlertCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm border-l-4 border-l-sage-200">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-20 bg-sage-100 rounded-full" />
          <div className="h-5 w-40 bg-sage-100 rounded" />
        </div>
        <div className="h-4 w-full bg-sage-50 rounded" />
        <div className="h-4 w-3/4 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Alert Card Component
// ---------------------------------------------------------------------------

function AlertCard({
  alert,
  onAcknowledge,
  isAcknowledging,
  showVenue,
}: {
  alert: AnomalyAlert
  onAcknowledge: (id: string) => void
  isAcknowledging: boolean
  showVenue: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const config = severityConfig(alert.severity)
  const SeverityIcon = config.icon
  const isNegative = alert.change_percent < 0

  // For metrics where "down" is bad (inquiry_volume, tour_conversion, booking_rate, avg_booking_value)
  // and where "up" is bad (response_time, lost_deal_rate)
  const badDirection =
    ['response_time', 'lost_deal_rate'].includes(alert.metric_name)
      ? alert.change_percent > 0
      : alert.change_percent < 0

  return (
    <div
      className={`bg-surface border border-border rounded-xl shadow-sm border-l-4 ${config.accent} transition-all`}
    >
      <div className="p-6">
        {/* Header row */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <SeverityIcon className={`w-5 h-5 mt-0.5 shrink-0 ${
              alert.severity === 'critical' ? 'text-red-500' :
              alert.severity === 'warning' ? 'text-amber-500' : 'text-blue-500'
            }`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${config.badge}`}>
                  {config.label}
                </span>
                <h3 className="font-medium text-sage-900">
                  {formatMetricName(alert.metric_name)}
                </h3>
                {showVenue && <VenueChip venueName={alert.venues?.name} />}
                <span className="text-xs text-sage-500">{timeAgo(alert.created_at)}</span>
              </div>

              {/* Values row */}
              <div className="mt-2 flex items-center gap-4 text-sm">
                <span className="text-sage-600">
                  Current: <span className="font-medium text-sage-900">{formatMetricValue(alert.metric_name, alert.current_value)}</span>
                </span>
                <span className="text-sage-400">vs</span>
                <span className="text-sage-600">
                  Baseline: <span className="font-medium text-sage-900">{formatMetricValue(alert.metric_name, alert.baseline_value)}</span>
                </span>
                <span className={`font-semibold ${badDirection ? 'text-red-600' : 'text-emerald-600'}`}>
                  {formatChangePercent(alert.change_percent)}
                </span>
              </div>

              {/* AI Explanation */}
              {alert.ai_explanation && (
                <p className="mt-3 text-sm text-sage-700 leading-relaxed">
                  {alert.ai_explanation}
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {alert.causes && alert.causes.length > 0 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-sage-600 border border-sage-200 rounded-lg hover:bg-sage-50 transition-colors"
              >
                Causes
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
            <button
              onClick={() => onAcknowledge(alert.id)}
              disabled={isAcknowledging}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              Acknowledge
            </button>
          </div>
        </div>

        {/* Expandable causes */}
        {expanded && alert.causes && alert.causes.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Possible Causes
            </h4>
            <div className="space-y-3">
              {alert.causes.map((cause, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider mt-0.5 ${likelihoodBadge(cause.likelihood)}`}>
                    {cause.likelihood}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sage-800">{cause.cause}</p>
                    <p className="text-sage-500 mt-0.5 flex items-center gap-1">
                      <Lightbulb className="w-3 h-3 shrink-0" />
                      {cause.action}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Demand score calculation (mirrors economics.ts)
// ---------------------------------------------------------------------------

const AVERAGES: Record<string, number> = {
  consumer_sentiment: 70,
  personal_savings_rate: 7.5,
  consumer_confidence: 100,
  housing_starts: 1400,
  disposable_income_real: 15000,
}

function clampVal(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function calcDemandScore(indicators: Record<string, number>): {
  score: number
  outlook: 'positive' | 'neutral' | 'caution'
} {
  let score = 50
  if (indicators.consumer_sentiment != null) {
    const d = (indicators.consumer_sentiment - AVERAGES.consumer_sentiment) / AVERAGES.consumer_sentiment
    score += clampVal(d * 20, -10, 10)
  }
  if (indicators.personal_savings_rate != null) {
    const d = (indicators.personal_savings_rate - AVERAGES.personal_savings_rate) / AVERAGES.personal_savings_rate
    score += clampVal(-d * 10, -5, 5)
  }
  if (indicators.consumer_confidence != null) {
    const d = (indicators.consumer_confidence - AVERAGES.consumer_confidence) / AVERAGES.consumer_confidence
    score += clampVal(d * 16, -8, 8)
  }
  if (indicators.housing_starts != null) {
    const d = (indicators.housing_starts - AVERAGES.housing_starts) / AVERAGES.housing_starts
    score += clampVal(d * 10, -5, 5)
  }
  score = Math.round(clampVal(score, 0, 100))
  const outlook: 'positive' | 'neutral' | 'caution' =
    score >= 58 ? 'positive' : score >= 42 ? 'neutral' : 'caution'
  return { score, outlook }
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function IntelligenceDashboardPage() {
  const venueId = useVenueId()
  const scope = useScope()
  const supabase = useMemo(() => createClient(), [])

  const [alerts, setAlerts] = useState<AnomalyAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Real stat card state
  const [demandScore, setDemandScore] = useState<{ score: number; outlook: 'positive' | 'neutral' | 'caution' } | null>(null)
  const [pendingRecsCount, setPendingRecsCount] = useState<number | null>(null)

  // ---- Fetch alerts ----
  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/intel/anomalies')
      if (!res.ok) throw new Error('Failed to fetch alerts')
      const data = await res.json()
      setAlerts(data.alerts ?? [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch anomaly alerts:', err)
      setError('Failed to load anomaly alerts')
    } finally {
      setLoading(false)
    }
  }, [])

  // ---- Fetch real stat card data ----
  const fetchStatCards = useCallback(async () => {
    try {
      // 1. Demand score from economic_indicators
      const { data: indicatorRows } = await supabase
        .from('economic_indicators')
        .select('indicator_name, value')
        .order('date', { ascending: false })
        .limit(50)

      if (indicatorRows && indicatorRows.length > 0) {
        const latest: Record<string, number> = {}
        for (const row of indicatorRows) {
          const name = row.indicator_name as string
          if (!(name in latest)) {
            latest[name] = Number(row.value)
          }
        }
        setDemandScore(calcDemandScore(latest))
      }

      // 2. Pending recommendations count
      const { count } = await supabase
        .from('trend_recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('status', 'pending')

      setPendingRecsCount(count ?? 0)
    } catch (err) {
      console.error('[dashboard] Failed to fetch stat cards:', err)
    }
  }, [supabase, venueId])

  useEffect(() => {
    fetchAlerts()
    fetchStatCards()
  }, [fetchAlerts, fetchStatCards])

  // ---- Run detection ----
  const handleRunDetection = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/intel/anomalies', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to run detection')
      // Refresh after detection
      await fetchAlerts()
    } catch (err) {
      console.error('Failed to run anomaly detection:', err)
      setError('Failed to run anomaly detection')
    } finally {
      setRunning(false)
    }
  }

  // ---- Acknowledge ----
  const handleAcknowledge = async (alertId: string) => {
    setAcknowledgingId(alertId)
    try {
      const res = await fetch('/api/intel/anomalies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      })
      if (!res.ok) throw new Error('Failed to acknowledge alert')
      // Remove from local state
      setAlerts((prev) => prev.filter((a) => a.id !== alertId))
    } catch (err) {
      console.error('Failed to acknowledge alert:', err)
    } finally {
      setAcknowledgingId(null)
    }
  }

  // ---- Derived stats ----
  const criticalCount = alerts.filter((a) => a.severity === 'critical').length
  const warningCount = alerts.filter((a) => a.severity === 'warning').length
  const infoCount = alerts.filter((a) => a.severity === 'info').length

  // Sort: critical first, then warning, then info
  const sortedAlerts = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 }
    return order[a.severity] - order[b.severity]
  })

  // ---- Compute insights from alert data ----
  const dashboardInsights: InsightItem[] = (() => {
    const items: InsightItem[] = []
    if (criticalCount > 0) {
      items.push({
        icon: 'warning',
        text: `${criticalCount} critical alert${criticalCount !== 1 ? 's' : ''} need${criticalCount === 1 ? 's' : ''} immediate attention`,
        priority: 'high',
      })
    }
    if (warningCount > 0) {
      items.push({
        icon: 'warning',
        text: `${warningCount} warning-level anomal${warningCount !== 1 ? 'ies' : 'y'} detected — review before they escalate`,
        priority: 'medium',
      })
    }
    if (alerts.length > 0) {
      items.push({
        icon: 'action',
        text: `${alerts.length} active alert${alerts.length !== 1 ? 's' : ''} across your venue — acknowledge resolved items to keep this view clean`,
      })
    }
    if (alerts.length === 0 && !loading) {
      items.push({
        icon: 'trend_up',
        text: 'All metrics are within normal ranges — your venue is performing steadily',
      })
    }
    return items
  })()

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Intelligence Dashboard
          </h1>
          <p className="text-sage-600">
            Your daily command center — anomaly alerts, key metrics, and AI-generated insights at a glance. Start here each morning to see what needs attention and what's trending.
          </p>
        </div>
        <button
          onClick={handleRunDetection}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Running...' : 'Run Anomaly Detection'}
        </button>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchAlerts() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Quick Stats Row ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-red-50 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                </div>
                <span className="text-sm font-medium text-sage-600">Active Alerts</span>
              </div>
              <p className="text-3xl font-bold text-sage-900">{alerts.length}</p>
              <div className="mt-2 flex items-center gap-3 text-xs text-sage-500">
                {criticalCount > 0 && (
                  <span className="text-red-600">{criticalCount} critical</span>
                )}
                {warningCount > 0 && (
                  <span className="text-amber-600">{warningCount} warning</span>
                )}
                {infoCount > 0 && (
                  <span className="text-blue-600">{infoCount} info</span>
                )}
                {alerts.length === 0 && (
                  <span className="text-emerald-600">All clear</span>
                )}
              </div>
            </div>

            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-teal-50 rounded-lg">
                  <TrendingUp className="w-4 h-4 text-teal-600" />
                </div>
                <span className="text-sm font-medium text-sage-600">Latest Demand Score</span>
              </div>
              <p className="text-3xl font-bold text-sage-900">
                {demandScore != null ? demandScore.score : <span className="text-sage-300">--</span>}
              </p>
              <div className="mt-2 flex items-center gap-2">
                {demandScore != null ? (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border capitalize ${
                    demandScore.outlook === 'positive' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    demandScore.outlook === 'neutral' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                    'bg-red-50 text-red-700 border-red-200'
                  }`}>
                    {demandScore.outlook}
                  </span>
                ) : (
                  <span className="text-xs text-sage-500">Computed from economic data</span>
                )}
              </div>
            </div>

            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-amber-50 rounded-lg">
                  <Lightbulb className="w-4 h-4 text-amber-600" />
                </div>
                <span className="text-sm font-medium text-sage-600">Pending Recommendations</span>
              </div>
              <p className="text-3xl font-bold text-sage-900">
                {pendingRecsCount != null ? pendingRecsCount : <span className="text-sage-300">--</span>}
              </p>
              <p className="mt-2 text-xs text-sage-500">
                {pendingRecsCount != null && pendingRecsCount > 0
                  ? 'AI-generated action items awaiting review'
                  : 'AI-generated action items'}
              </p>
            </div>

          </>
        )}
      </div>

      {/* ---- AI Insights ---- */}
      {!loading && dashboardInsights.length > 0 && (
        <InsightPanel insights={dashboardInsights} />
      )}

      {/* ---- Active Anomaly Alerts ---- */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-sage-600" />
            Active Anomaly Alerts
          </h2>
          {!loading && alerts.length > 0 && (
            <span className="text-sm text-sage-500">
              {alerts.length} unacknowledged
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <AlertCardSkeleton />
            <AlertCardSkeleton />
            <AlertCardSkeleton />
          </div>
        ) : sortedAlerts.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
              No active alerts
            </h3>
            <p className="text-sm text-sage-600 max-w-md mx-auto">
              All venue metrics are within normal ranges. Run anomaly detection to check
              for new deviations against baseline performance.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAcknowledge={handleAcknowledge}
                isAcknowledging={acknowledgingId === alert.id}
                showVenue={scope.level !== 'venue'}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- Recent Activity ---- */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-sage-600" />
          Recent Activity
        </h2>

        <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
          {loading ? (
            <div className="p-6 space-y-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse flex items-center gap-3">
                  <div className="w-8 h-8 bg-sage-100 rounded-full shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-3/4 bg-sage-100 rounded" />
                    <div className="h-3 w-1/3 bg-sage-50 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : alerts.length > 0 ? (
            // Show recent alert events as activity
            sortedAlerts.slice(0, 8).map((alert) => {
              const config = severityConfig(alert.severity)
              const SeverityIcon = config.icon
              return (
                <div key={`activity-${alert.id}`} className="px-6 py-4 flex items-center gap-4">
                  <div className={`p-2 rounded-full shrink-0 ${
                    alert.severity === 'critical' ? 'bg-red-50' :
                    alert.severity === 'warning' ? 'bg-amber-50' : 'bg-blue-50'
                  }`}>
                    <SeverityIcon className={`w-4 h-4 ${
                      alert.severity === 'critical' ? 'text-red-500' :
                      alert.severity === 'warning' ? 'text-amber-500' : 'text-blue-500'
                    }`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-sage-800">
                      <span className="font-medium">{config.label}</span> anomaly detected in{' '}
                      <span className="font-medium">{formatMetricName(alert.metric_name)}</span>
                      {' '}&mdash;{' '}
                      {formatChangePercent(alert.change_percent)} change from baseline
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-xs text-sage-500">{timeAgo(alert.created_at)}</p>
                      {scope.level !== 'venue' && <VenueChip venueName={alert.venues?.name} />}
                    </div>
                  </div>
                  <BarChart3 className="w-4 h-4 text-sage-300 shrink-0" />
                </div>
              )
            })
          ) : (
            <div className="px-6 py-12 text-center">
              <BarChart3 className="w-8 h-8 text-sage-300 mx-auto mb-3" />
              <p className="text-sm text-sage-500">
                No recent activity. Anomaly alerts, briefings, and recommendations will appear here.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
