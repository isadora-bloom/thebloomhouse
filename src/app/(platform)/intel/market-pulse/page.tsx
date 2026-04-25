'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Sun,
  CloudRain,
  Thermometer,
  Lightbulb,
  Check,
  X,
  RefreshCw,
  Sparkles,
  BarChart3,
  Leaf,
  AlertTriangle,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import { MeOrMarketCard } from '@/components/intel/MeOrMarketCard'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Area,
  Legend,
  Cell,
  ReferenceLine,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EconomicIndicator {
  id: string
  indicator_name: string
  date: string
  value: number
  source: string
}

interface TrendRecommendation {
  id: string
  venue_id: string
  recommendation_type: string
  title: string
  body: string | null
  data_source: string | null
  supporting_data: Record<string, unknown>
  priority: string | number
  status: 'pending' | 'applied' | 'dismissed'
  applied_at: string | null
  dismissed_at: string | null
  created_at: string
}

interface PositioningSuggestion {
  title: string
  rationale: string
  copy_example: string
}

interface SeasonalContent {
  id: string
  venue_id: string
  season: string
  imagery_phrases: string[] | null
  contextual_tip: string | null
  created_at: string
}

interface WeatherRow {
  id: string
  venue_id: string
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
  // Added in migration 035 — monthly climate-normal metrics
  year: number | null
  month: number | null
  avg_temp_4pm_f: number | null
  avg_humidity_pct: number | null
  avg_wind_mph: number | null
  sunny_days: number | null
  outdoor_event_score: number | null
}

interface MonthlyClimateRow {
  year: number
  month: number // 1-12
  avg_temp_4pm_f: number
  precipitation: number
  avg_humidity_pct: number
  avg_wind_mph: number
  sunny_days: number
  outdoor_event_score: number
}

interface OutdoorTrendPoint {
  month: string // Jan-Dec
  monthIdx: number // 1-12
  score_2024: number | null
  score_2025: number | null
  score_2026: number | null
}

interface SearchTrend {
  id: string
  venue_id: string
  term: string
  week: string
  interest: number
  created_at: string
}

interface DemandScore {
  score: number
  outlook: 'positive' | 'neutral' | 'caution'
}

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const AVERAGES: Record<string, number> = {
  consumer_sentiment: 70,
  personal_savings_rate: 7.5,
  consumer_confidence: 100,
  housing_starts: 1400,
  disposable_income_real: 15000,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function calculateDemandScore(indicators: Record<string, number>): DemandScore {
  let score = 50

  if (indicators.consumer_sentiment != null) {
    const deviation =
      (indicators.consumer_sentiment - AVERAGES.consumer_sentiment) /
      AVERAGES.consumer_sentiment
    score += clamp(deviation * 20, -10, 10)
  }

  if (indicators.personal_savings_rate != null) {
    const deviation =
      (indicators.personal_savings_rate - AVERAGES.personal_savings_rate) /
      AVERAGES.personal_savings_rate
    score += clamp(-deviation * 10, -5, 5)
  }

  if (indicators.consumer_confidence != null) {
    const deviation =
      (indicators.consumer_confidence - AVERAGES.consumer_confidence) /
      AVERAGES.consumer_confidence
    score += clamp(deviation * 16, -8, 8)
  }

  if (indicators.housing_starts != null) {
    const deviation =
      (indicators.housing_starts - AVERAGES.housing_starts) /
      AVERAGES.housing_starts
    score += clamp(deviation * 10, -5, 5)
  }

  score = Math.round(clamp(score, 0, 100))

  const outlook: DemandScore['outlook'] =
    score >= 58 ? 'positive' : score >= 42 ? 'neutral' : 'caution'

  return { score, outlook }
}

function outlookColor(outlook: 'positive' | 'neutral' | 'caution'): string {
  switch (outlook) {
    case 'positive':
      return 'text-emerald-600'
    case 'neutral':
      return 'text-amber-600'
    case 'caution':
      return 'text-red-600'
  }
}

function outlookBg(outlook: 'positive' | 'neutral' | 'caution'): string {
  switch (outlook) {
    case 'positive':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'neutral':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'caution':
      return 'bg-red-50 text-red-700 border-red-200'
  }
}

function priorityBadge(priority: string | number): {
  className: string
  label: string
} {
  const p = typeof priority === 'number' ? priority : priority
  if (p === 1 || p === 'high')
    return { className: 'bg-red-50 text-red-700 border-red-200', label: 'High' }
  if (p === 2 || p === 'medium')
    return {
      className: 'bg-amber-50 text-amber-700 border-amber-200',
      label: 'Medium',
    }
  return {
    className: 'bg-sage-50 text-sage-600 border-sage-200',
    label: 'Low',
  }
}

function typeBadge(type: string): string {
  switch (type) {
    case 'pricing':
      return 'bg-teal-50 text-teal-700'
    case 'marketing':
      return 'bg-blue-50 text-blue-700'
    case 'staffing':
      return 'bg-purple-50 text-purple-700'
    case 'content':
      return 'bg-gold-50 text-gold-700'
    case 'outreach':
      return 'bg-emerald-50 text-emerald-700'
    default:
      return 'bg-sage-50 text-sage-600'
  }
}

function getCurrentSeason(): string {
  const month = new Date().getMonth() // 0-11
  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month >= 8 && month <= 10) return 'fall'
  return 'winter'
}

function getMonthName(monthIdx: number): string {
  return [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][monthIdx]
}

function formatWeekLabel(week: string): string {
  const d = new Date(week + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------
// Outdoor event score: (ideal temp proximity + low precip) = 0-100
// ---------------------------------------------------------------------------

function computeOutdoorScore(
  avgTemp: number,
  totalPrecip: number,
  /** Per-venue "ideal" outdoor temp range. A beach venue in Florida is
   *  comfortable at 80°F+; a mountain venue stays comfortable below 65.
   *  Defaults work for the average US wedding venue but should pass
   *  through from venue_config when available. */
  idealMin = 65,
  idealMax = 78
): number {
  let tempScore: number
  if (avgTemp >= idealMin && avgTemp <= idealMax) {
    tempScore = 100
  } else if (avgTemp < idealMin) {
    tempScore = Math.max(0, 100 - (idealMin - avgTemp) * 3)
  } else {
    tempScore = Math.max(0, 100 - (avgTemp - idealMax) * 4)
  }

  // Precip penalty: 0 inches = full score, 4+ inches = 0
  const precipScore = Math.max(0, 100 - totalPrecip * 25)

  return Math.round(tempScore * 0.6 + precipScore * 0.4)
}

// Rain probability bucket from precip amount
function rainRiskLevel(
  precip: number
): 'low' | 'moderate' | 'high' {
  if (precip < 2) return 'low'
  if (precip < 4) return 'moderate'
  return 'high'
}

// Heat risk from avg temp
function heatRiskLevel(
  avgTemp: number
): 'low' | 'moderate' | 'high' {
  if (avgTemp < 80) return 'low'
  if (avgTemp < 90) return 'moderate'
  return 'high'
}

function riskColor(level: 'low' | 'moderate' | 'high'): string {
  switch (level) {
    case 'low':
      return 'bg-emerald-100 text-emerald-700'
    case 'moderate':
      return 'bg-amber-100 text-amber-700'
    case 'high':
      return 'bg-red-100 text-red-700'
  }
}

// ---------------------------------------------------------------------------
// Skeleton components
// ---------------------------------------------------------------------------

function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div
      className={cn(
        'bg-surface border border-border rounded-xl p-6 shadow-sm',
        className
      )}
    >
      <div className="animate-pulse space-y-4">
        <div className="h-4 bg-sage-100 rounded w-2/3" />
        <div className="h-24 bg-sage-100 rounded" />
        <div className="h-3 bg-sage-50 rounded w-1/2" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Demand Pulse Card
// ---------------------------------------------------------------------------

function DemandPulseCard({
  demandScore,
  indicators,
}: {
  demandScore: DemandScore | null
  indicators: Record<string, number>
}) {
  if (!demandScore)
    return (
      <SkeletonCard className="lg:col-span-2" />
    )

  const circumference = 2 * Math.PI * 54 // r=54
  const offset = circumference - (demandScore.score / 100) * circumference

  // Determine gauge stroke color
  const gaugeColor =
    demandScore.outlook === 'positive'
      ? '#059669'
      : demandScore.outlook === 'neutral'
        ? '#D97706'
        : '#DC2626'

  // Determine search demand trend
  const sentiment = indicators.consumer_sentiment
  const confidence = indicators.consumer_confidence
  const savingsRate = indicators.personal_savings_rate

  // Caution months: when savings rate is high or confidence is low
  const cautionIndicators: string[] = []
  if (savingsRate != null && savingsRate > 9)
    cautionIndicators.push('High savings rate')
  if (confidence != null && confidence < 85)
    cautionIndicators.push('Low consumer confidence')
  if (sentiment != null && sentiment < 60)
    cautionIndicators.push('Weak consumer sentiment')

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm lg:col-span-2">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-teal-50 rounded-lg">
          <Activity className="w-5 h-5 text-teal-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Demand Pulse
          </h2>
          <p className="text-xs text-sage-500">
            Composite economic demand signal (0-100)
          </p>
        </div>
      </div>

      <div className="flex items-center gap-8">
        {/* Gauge ring */}
        <div className="relative w-32 h-32 shrink-0">
          <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke="#E8E4DF"
              strokeWidth="10"
            />
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke={gaugeColor}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              className="transition-all duration-1000 ease-out"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold text-sage-900">
              {demandScore.score}
            </span>
            <span className="text-xs text-sage-500">/ 100</span>
          </div>
        </div>

        {/* Details */}
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-sage-700">Outlook:</span>
            <span
              className={cn(
                'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize',
                outlookBg(demandScore.outlook)
              )}
            >
              {demandScore.outlook}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            {sentiment != null && (
              <div>
                <span className="text-sage-500">Consumer Sentiment</span>
                <p className="font-semibold text-sage-900">
                  {sentiment.toFixed(1)}
                </p>
              </div>
            )}
            {confidence != null && (
              <div>
                <span className="text-sage-500">Consumer Confidence</span>
                <p className="font-semibold text-sage-900">
                  {confidence.toFixed(1)}
                </p>
              </div>
            )}
            {savingsRate != null && (
              <div>
                <span className="text-sage-500">Savings Rate</span>
                <p className="font-semibold text-sage-900">
                  {savingsRate.toFixed(1)}%
                </p>
              </div>
            )}
            {indicators.housing_starts != null && (
              <div>
                <span className="text-sage-500">Housing Starts</span>
                <p className="font-semibold text-sage-900">
                  {Math.round(indicators.housing_starts).toLocaleString()}k
                </p>
              </div>
            )}
          </div>

          {cautionIndicators.length > 0 && (
            <div className="flex items-start gap-2 mt-2 p-2 bg-amber-50 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700">
                <span className="font-medium">Caution signals: </span>
                {cautionIndicators.join(', ')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Actionable Recommendations Section
// ---------------------------------------------------------------------------

function OutcomeInput({ recId }: { recId: string }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    if (!note.trim()) return
    setSaving(true)
    try {
      // Read current supporting_data, merge outcome_notes, write back
      const res = await fetch(`/api/intel/recommendations`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recId, status: 'applied', outcome_notes: note.trim() }),
      })
      if (res.ok) setSaved(true)
    } catch {
      // silent fail
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3">
        <p className="text-xs font-medium text-emerald-700 mb-1">Outcome</p>
        <p className="text-sm text-emerald-800">{note}</p>
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        placeholder="What was the result? (e.g., 3 extra inquiries)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className="flex-1 px-3 py-1.5 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white"
      />
      <button
        onClick={save}
        disabled={saving || !note.trim()}
        className="px-3 py-1.5 text-xs font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function RecommendationsSection({
  recommendations,
  onApply,
  onDismiss,
  loading,
}: {
  recommendations: TrendRecommendation[]
  onApply: (id: string) => void
  onDismiss: (id: string) => void
  loading: boolean
}) {
  if (loading) {
    return (
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5 text-gold-500" />
          Actionable Recommendations
        </h2>
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    )
  }

  const pending = recommendations.filter((r) => r.status === 'pending')
  const resolved = recommendations.filter((r) => r.status !== 'pending')

  return (
    <section>
      <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2 mb-4">
        <Lightbulb className="w-5 h-5 text-gold-500" />
        Actionable Recommendations
        {pending.length > 0 && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gold-100 text-gold-700">
            {pending.length} pending
          </span>
        )}
      </h2>

      {recommendations.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
          <Lightbulb className="w-8 h-8 text-sage-300 mx-auto mb-3" />
          <p className="text-sm text-sage-500">
            No recommendations yet. Run trend analysis to generate actionable
            insights.
          </p>
          <p className="text-xs text-sage-400 mt-2 max-w-md mx-auto">
            Example: &ldquo;Garden wedding searches up 35% — update website copy
            and feature garden photos&rdquo;
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((rec) => (
            <div
              key={rec.id}
              className="bg-surface border border-border rounded-xl p-5 shadow-sm"
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gold-100 flex items-center justify-center">
                  <Lightbulb className="w-5 h-5 text-gold-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-heading text-base font-semibold text-sage-900 mb-1">
                    {rec.title}
                  </h4>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span
                      className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full border',
                        priorityBadge(rec.priority).className
                      )}
                    >
                      {priorityBadge(rec.priority).label}
                    </span>
                    {rec.recommendation_type && (
                      <span
                        className={cn(
                          'text-xs font-medium px-2 py-0.5 rounded-full capitalize',
                          typeBadge(rec.recommendation_type)
                        )}
                      >
                        {rec.recommendation_type}
                      </span>
                    )}
                  </div>
                  {rec.body && (
                    <p className="text-sm text-sage-600 leading-relaxed">
                      {rec.body}
                    </p>
                  )}
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => onApply(rec.id)}
                      className="inline-flex items-center gap-1.5 bg-sage-500 hover:bg-sage-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                    >
                      <Check className="w-4 h-4" />
                      Apply
                    </button>
                    <button
                      onClick={() => onDismiss(rec.id)}
                      className="inline-flex items-center gap-1.5 border border-sage-300 text-sage-700 hover:bg-sage-50 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                    >
                      <X className="w-4 h-4" />
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {resolved.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-sage-500 mt-6 mb-3">
                Previous recommendations
              </h3>
              <div className="space-y-3">
                {resolved.map((rec) => {
                  const outcomeNote = (rec.supporting_data as Record<string, unknown>)?.outcome_notes as string | undefined
                  const daysAgo = rec.applied_at
                    ? Math.floor((Date.now() - new Date(rec.applied_at).getTime()) / (1000 * 60 * 60 * 24))
                    : null

                  return (
                    <div
                      key={rec.id}
                      className={`bg-surface border rounded-xl p-5 shadow-sm ${
                        rec.status === 'applied' ? 'border-sage-200' : 'border-border opacity-60'
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                          rec.status === 'applied' ? 'bg-emerald-50' : 'bg-sage-100'
                        }`}>
                          {rec.status === 'applied' ? (
                            <Check className="w-5 h-5 text-emerald-500" />
                          ) : (
                            <X className="w-5 h-5 text-sage-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-heading text-base font-semibold text-sage-800">
                            {rec.title}
                          </h4>
                          {rec.body && (
                            <p className="text-sm text-sage-500 mt-1">
                              {rec.body}
                            </p>
                          )}
                          <p className="text-xs text-sage-400 mt-2">
                            {rec.status === 'applied'
                              ? `Applied ${rec.applied_at ? new Date(rec.applied_at).toLocaleDateString() : ''}`
                              : `Dismissed ${rec.dismissed_at ? new Date(rec.dismissed_at).toLocaleDateString() : ''}`}
                            {daysAgo !== null && ` · ${daysAgo}d ago`}
                          </p>

                          {/* Outcome tracking for applied recommendations */}
                          {rec.status === 'applied' && (
                            <div className="mt-3 pt-3 border-t border-sage-100">
                              {outcomeNote ? (
                                <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3">
                                  <p className="text-xs font-medium text-emerald-700 mb-1">Outcome</p>
                                  <p className="text-sm text-emerald-800">{outcomeNote}</p>
                                </div>
                              ) : (
                                <OutcomeInput recId={rec.id} />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 3. Suggested Positioning Section
// ---------------------------------------------------------------------------

function PositioningSection({
  suggestions,
  generating,
  onGenerate,
}: {
  suggestions: PositioningSuggestion[]
  generating: boolean
  onGenerate: () => void
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-teal-500" />
          Suggested Positioning
        </h2>
        <button
          onClick={onGenerate}
          disabled={generating}
          className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          <Sparkles
            className={cn('w-4 h-4', generating && 'animate-spin')}
          />
          {generating ? 'Generating...' : 'Generate Suggestions'}
        </button>
      </div>

      {suggestions.length === 0 && !generating ? (
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
          <Sparkles className="w-8 h-8 text-sage-300 mx-auto mb-3" />
          <p className="text-sm text-sage-500">
            Click &ldquo;Generate Suggestions&rdquo; to get AI-powered
            positioning ideas based on your reviews, trends, and performance
            data.
          </p>
        </div>
      ) : generating && suggestions.length === 0 ? (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <div className="space-y-4">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="bg-surface border border-border rounded-xl p-6 shadow-sm"
            >
              <h3 className="font-heading text-base font-semibold text-sage-900 mb-2">
                {s.title}
              </h3>
              <p className="text-sm text-sage-600 leading-relaxed mb-3">
                {s.rationale}
              </p>
              <div className="bg-sage-50 rounded-lg p-4 border border-sage-100">
                <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-1">
                  Copy Example
                </p>
                <p className="text-sm text-sage-800 italic leading-relaxed">
                  &ldquo;{s.copy_example}&rdquo;
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 4. Seasonal Context Section
// ---------------------------------------------------------------------------

function SeasonalContextSection({
  content,
  loading,
}: {
  content: SeasonalContent | null
  loading: boolean
}) {
  if (loading) return <SkeletonCard />

  const season = getCurrentSeason()
  const currentMonth = new Date().toLocaleDateString('en-US', { month: 'long' })

  // Default tip when no DB data
  const seasonalTips: Record<string, string> = {
    spring: `${currentMonth}: Couples booking fall weddings are looking now. Feature October imagery and harvest-season details.`,
    summer: `${currentMonth}: Peak wedding season is here. Focus on availability updates and showcase recent real weddings.`,
    fall: `${currentMonth}: Winter and spring booking inquiries are rising. Feature your indoor spaces and early-year availability.`,
    winter: `${currentMonth}: Engagement season is in full swing. New couples are actively venue shopping. Respond fast.`,
  }

  const defaultPhrases: Record<string, string[]> = {
    spring: [
      'cherry blossoms',
      'garden ceremonies',
      'fresh greenery',
      'golden hour',
    ],
    summer: [
      'sunset receptions',
      'outdoor elegance',
      'summer blooms',
      'twilight dining',
    ],
    fall: [
      'autumn foliage',
      'harvest tables',
      'candlelit barns',
      'golden leaves',
    ],
    winter: [
      'fireside warmth',
      'winter whites',
      'holiday sparkle',
      'cozy elegance',
    ],
  }

  const tip = content?.contextual_tip ?? seasonalTips[season]
  const phrases =
    content?.imagery_phrases && content.imagery_phrases.length > 0
      ? content.imagery_phrases
      : defaultPhrases[season]
  const displaySeason = content?.season ?? season

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-emerald-50 rounded-lg">
          <Leaf className="w-5 h-5 text-emerald-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900 capitalize">
            {displaySeason} Context
          </h2>
          <p className="text-xs text-sage-500">
            Seasonal positioning guidance
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Imagery phrases */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">
            Imagery Phrases
          </p>
          <div className="flex flex-wrap gap-2">
            {phrases.map((phrase, i) => (
              <span
                key={i}
                className="inline-flex items-center px-3 py-1.5 rounded-full text-sm bg-sage-50 text-sage-700 border border-sage-100"
              >
                {phrase}
              </span>
            ))}
          </div>
        </div>

        {/* Contextual tip */}
        <div className="bg-teal-50/50 rounded-lg p-4 border border-teal-100">
          <div className="flex items-start gap-2">
            <Lightbulb className="w-4 h-4 text-teal-600 mt-0.5 shrink-0" />
            <p className="text-sm text-teal-800 leading-relaxed">{tip}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. Outdoor Event Score Chart
// ---------------------------------------------------------------------------

function OutdoorScoreChart({
  monthlyData,
  loading,
}: {
  monthlyData: {
    month: string
    outdoorScore: number
    avgTemp: number
    totalPrecip: number
  }[]
  loading: boolean
}) {
  if (loading) return <SkeletonCard className="lg:col-span-2" />

  if (monthlyData.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center lg:col-span-2">
        <Sun className="w-8 h-8 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">
          No historical weather data available yet.
        </p>
      </div>
    )
  }

  // Mark ideal zone months (April-June, Sept-Oct)
  const idealMonths = ['Apr', 'May', 'Jun', 'Sep', 'Oct']

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm lg:col-span-2">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-amber-50 rounded-lg">
          <Sun className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Outdoor Event Score
          </h2>
          <p className="text-xs text-sage-500">
            Monthly suitability for outdoor events based on temperature +
            precipitation
          </p>
        </div>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={monthlyData}
            margin={{ top: 10, right: 10, bottom: 0, left: -10 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#E8E4DF"
              vertical={false}
            />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="score"
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
              label={{
                value: 'Score',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: '#9CA38F' },
              }}
            />
            <YAxis
              yAxisId="temp"
              orientation="right"
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              domain={[20, 100]}
              label={{
                value: 'Temp (F)',
                angle: 90,
                position: 'insideRight',
                style: { fontSize: 11, fill: '#9CA38F' },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E8E4DF',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              labelStyle={{ color: '#31342D', fontWeight: 600 }}
              formatter={(value, name) => {
                if (name === 'outdoorScore') return [`${value}`, 'Outdoor Score']
                if (name === 'avgTemp') return [`${value}°F`, 'Avg Temp']
                return [`${value}`, String(name)]
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              formatter={(value: string) => {
                if (value === 'outdoorScore') return 'Outdoor Score'
                if (value === 'avgTemp') return 'Avg Temperature'
                return value
              }}
            />

            {/* Ideal zone reference lines */}
            <ReferenceLine
              yAxisId="score"
              y={70}
              stroke="#059669"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
              label={{
                value: 'Ideal Zone',
                position: 'right',
                style: { fontSize: 10, fill: '#059669' },
              }}
            />

            <Bar
              yAxisId="score"
              dataKey="outdoorScore"
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
            >
              {monthlyData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={
                    idealMonths.includes(entry.month)
                      ? '#059669'
                      : entry.outdoorScore >= 70
                        ? '#7D8471'
                        : entry.outdoorScore >= 40
                          ? '#D97706'
                          : '#DC2626'
                  }
                  fillOpacity={0.75}
                />
              ))}
            </Bar>

            <Line
              yAxisId="temp"
              type="monotone"
              dataKey="avgTemp"
              stroke="#DC2626"
              strokeWidth={2}
              dot={{ fill: '#DC2626', r: 3 }}
              activeDot={{ r: 5 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5b. Outdoor Event Score — 3-Year Trend (multi-line with click-to-detail)
// ---------------------------------------------------------------------------

const TREND_YEAR_COLORS: Record<'2024' | '2025' | '2026', string> = {
  '2024': '#0D9488', // deep teal
  '2025': '#D97706', // warm amber
  '2026': '#7C3AED', // violet
}

interface TrendSelection {
  year: 2024 | 2025 | 2026
  month: number // 1-12
}

function OutdoorScoreTrendChart({
  trendData,
  climateRows,
  bestMonths,
  loading,
}: {
  trendData: OutdoorTrendPoint[]
  climateRows: MonthlyClimateRow[]
  bestMonths: { month: string; score: number }[]
  loading: boolean
}) {
  const [selected, setSelected] = useState<TrendSelection | null>(null)

  if (loading) return <SkeletonCard className="lg:col-span-3" />

  const hasData = climateRows.length > 0

  if (!hasData) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center lg:col-span-3">
        <Sun className="w-8 h-8 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">
          No 3-year outdoor event data yet. Run migration 035 and seed-weather.sql.
        </p>
      </div>
    )
  }

  // Find the detail row for the selected point
  const detail =
    selected != null
      ? climateRows.find(
          (r) => r.year === selected.year && r.month === selected.month
        )
      : null

  // Compute trend callout: July temperature change 2024 -> 2025
  const jul2024 = climateRows.find((r) => r.year === 2024 && r.month === 7)
  const jul2025 = climateRows.find((r) => r.year === 2025 && r.month === 7)
  const julyTempDelta =
    jul2024 && jul2025
      ? jul2025.avg_temp_4pm_f - jul2024.avg_temp_4pm_f
      : null

  // Spring rainfall increase: Mar+Apr+May precip 2024 vs 2025
  const springPrecip = (year: number) =>
    climateRows
      .filter((r) => r.year === year && [3, 4, 5].includes(r.month))
      .reduce((sum, r) => sum + r.precipitation, 0)
  const spring2024 = springPrecip(2024)
  const spring2025 = springPrecip(2025)
  const springRising = spring2025 > spring2024

  const callouts: {
    label: string
    color: string
  }[] = [
    {
      label: 'July–August: consistently too hot for outdoor ceremonies',
      color: 'bg-red-50 text-red-700 border-red-200',
    },
    {
      label: 'October: best month for outdoor events 3 years running',
      color: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    },
  ]
  if (julyTempDelta != null && julyTempDelta > 0) {
    callouts.push({
      label: `Average July temperature has risen ${julyTempDelta}°F since 2024`,
      color: 'bg-amber-50 text-amber-700 border-amber-200',
    })
  }
  if (springRising) {
    callouts.push({
      label: 'Spring rainfall increasing year on year',
      color: 'bg-blue-50 text-blue-700 border-blue-200',
    })
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm lg:col-span-3">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-amber-50 rounded-lg">
          <Sun className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Outdoor Event Score — 3 Year Trend
          </h2>
          <p className="text-xs text-sage-500">
            Monthly suitability for outdoor events across 2024, 2025, and 2026
            (projected). Click any month to inspect all metrics.
          </p>
        </div>
      </div>

      {/* Trend callouts */}
      <div className="flex flex-wrap gap-2 mb-5">
        {callouts.map((c, i) => (
          <div
            key={i}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium',
              c.color
            )}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            {c.label}
          </div>
        ))}
      </div>

      {/* Best months 2025 highlight */}
      {bestMonths.length > 0 && (
        <div className="mb-5 bg-emerald-50/50 border border-emerald-100 rounded-lg p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700 mb-2">
            Top 3 Months for Outdoor Events (2025)
          </p>
          <div className="flex flex-wrap gap-3">
            {bestMonths.map((m, i) => (
              <div
                key={m.month}
                className="flex items-center gap-2 bg-white border border-emerald-200 rounded-lg px-3 py-2"
              >
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold">
                  {i + 1}
                </span>
                <span className="font-semibold text-sage-900">{m.month}</span>
                <span className="text-sm text-emerald-700">{m.score}/100</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Multi-year line chart */}
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={trendData}
            margin={{ top: 10, right: 20, bottom: 0, left: -10 }}
            onClick={(e: unknown) => {
              // recharts passes an event object — narrow carefully
              const evt = e as {
                activePayload?: { payload?: OutdoorTrendPoint }[]
              }
              const point = evt?.activePayload?.[0]?.payload
              if (!point) return
              // Prefer most recent year with a score for that month
              const year =
                point.score_2026 != null
                  ? 2026
                  : point.score_2025 != null
                    ? 2025
                    : point.score_2024 != null
                      ? 2024
                      : null
              if (year == null) return
              setSelected({
                year: year as 2024 | 2025 | 2026,
                month: point.monthIdx,
              })
            }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#E8E4DF"
              vertical={false}
            />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              label={{
                value: 'Outdoor Score',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: '#9CA38F' },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E8E4DF',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              labelStyle={{ color: '#31342D', fontWeight: 600 }}
              formatter={(value, name) => {
                if (value == null) return ['—', String(name)]
                const labelMap: Record<string, string> = {
                  score_2024: '2024',
                  score_2025: '2025',
                  score_2026: '2026',
                }
                return [`${value}/100`, labelMap[String(name)] ?? String(name)]
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              formatter={(value: string) => {
                if (value === 'score_2024') return '2024'
                if (value === 'score_2025') return '2025'
                if (value === 'score_2026') return '2026 (Projected)'
                return value
              }}
            />

            {/* Ideal zone reference line at 70 */}
            <ReferenceLine
              y={70}
              stroke="#059669"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
              label={{
                value: 'Ideal Zone',
                position: 'right',
                style: { fontSize: 10, fill: '#059669' },
              }}
            />

            <Line
              type="monotone"
              dataKey="score_2024"
              stroke={TREND_YEAR_COLORS['2024']}
              strokeWidth={3}
              dot={{ fill: TREND_YEAR_COLORS['2024'], r: 4 }}
              activeDot={{ r: 7 }}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="score_2025"
              stroke={TREND_YEAR_COLORS['2025']}
              strokeWidth={3}
              dot={{ fill: TREND_YEAR_COLORS['2025'], r: 4 }}
              activeDot={{ r: 7 }}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="score_2026"
              stroke={TREND_YEAR_COLORS['2026']}
              strokeWidth={3}
              strokeDasharray="6 4"
              dot={{ fill: TREND_YEAR_COLORS['2026'], r: 4 }}
              activeDot={{ r: 7 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Click-to-detail panel */}
      {detail ? (
        <div className="mt-5 bg-sage-50/50 border border-sage-100 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                Detail
              </p>
              <p className="font-heading text-lg font-semibold text-sage-900">
                {getMonthName(detail.month - 1)} {detail.year}
              </p>
            </div>
            <div
              className="text-right"
              style={{
                color:
                  TREND_YEAR_COLORS[
                    String(detail.year) as '2024' | '2025' | '2026'
                  ],
              }}
            >
              <p className="text-xs font-semibold uppercase tracking-wider opacity-75">
                Outdoor Score
              </p>
              <p className="font-heading text-2xl font-bold">
                {detail.outdoor_event_score}/100
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-white rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Thermometer className="w-3.5 h-3.5 text-red-500" />
                <p className="text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  Temp @ 4pm
                </p>
              </div>
              <p className="font-heading text-lg font-bold text-sage-900">
                {detail.avg_temp_4pm_f}°F
              </p>
            </div>
            <div className="bg-white rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <CloudRain className="w-3.5 h-3.5 text-blue-500" />
                <p className="text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  Rainfall
                </p>
              </div>
              <p className="font-heading text-lg font-bold text-sage-900">
                {detail.precipitation}&quot;
              </p>
            </div>
            <div className="bg-white rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <CloudRain className="w-3.5 h-3.5 text-teal-500" />
                <p className="text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  Humidity
                </p>
              </div>
              <p className="font-heading text-lg font-bold text-sage-900">
                {detail.avg_humidity_pct}%
              </p>
            </div>
            <div className="bg-white rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Activity className="w-3.5 h-3.5 text-sage-500" />
                <p className="text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  Wind
                </p>
              </div>
              <p className="font-heading text-lg font-bold text-sage-900">
                {detail.avg_wind_mph} mph
              </p>
            </div>
            <div className="bg-white rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Sun className="w-3.5 h-3.5 text-amber-500" />
                <p className="text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  Sunny Days
                </p>
              </div>
              <p className="font-heading text-lg font-bold text-sage-900">
                {detail.sunny_days}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs text-sage-500 italic text-center">
          Click any month on the chart to see temperature, rainfall, humidity, wind, and sunny-day detail.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 6. Weather Risk Breakdown
// ---------------------------------------------------------------------------

function WeatherRiskGrid({
  monthlyData,
  loading,
}: {
  monthlyData: {
    month: string
    avgTemp: number
    totalPrecip: number
  }[]
  loading: boolean
}) {
  if (loading) return <SkeletonCard />

  if (monthlyData.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
        <CloudRain className="w-8 h-8 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">
          No weather data available for risk breakdown.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-blue-50 rounded-lg">
          <CloudRain className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Weather Risk Breakdown
          </h2>
          <p className="text-xs text-sage-500">
            Rain probability + heat risk per month
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-2 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Month
              </th>
              <th className="text-center py-2 px-2 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Rain Risk
              </th>
              <th className="text-center py-2 px-2 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Heat Risk
              </th>
              <th className="text-right py-2 px-2 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Precip (in)
              </th>
              <th className="text-right py-2 px-2 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Avg Temp
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {monthlyData.map((m) => {
              const rain = rainRiskLevel(m.totalPrecip)
              const heat = heatRiskLevel(m.avgTemp)
              return (
                <tr key={m.month} className="hover:bg-sage-50/50 transition-colors">
                  <td className="py-2.5 px-2 font-medium text-sage-800">
                    {m.month}
                  </td>
                  <td className="py-2.5 px-2 text-center">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize',
                        riskColor(rain)
                      )}
                    >
                      {rain}
                    </span>
                  </td>
                  <td className="py-2.5 px-2 text-center">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize',
                        riskColor(heat)
                      )}
                    >
                      {heat}
                    </span>
                  </td>
                  <td className="py-2.5 px-2 text-right text-sage-600">
                    {m.totalPrecip.toFixed(1)}
                  </td>
                  <td className="py-2.5 px-2 text-right text-sage-600">
                    {Math.round(m.avgTemp)}°F
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 7. Google Trends Chart
// ---------------------------------------------------------------------------

function GoogleTrendsChart({
  trends,
  loading,
}: {
  trends: SearchTrend[]
  loading: boolean
}) {
  if (loading) return <SkeletonCard className="lg:col-span-2" />

  if (trends.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center lg:col-span-2">
        <TrendingUp className="w-8 h-8 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">
          No search trend data available. Run a trend refresh from the Trends
          page.
        </p>
      </div>
    )
  }

  // Group by week, pivot terms into columns
  const termSet = new Set<string>()
  trends.forEach((t) => termSet.add(t.term))
  const terms = Array.from(termSet).slice(0, 5) // Max 5 lines for readability

  const weekMap = new Map<string, Record<string, number>>()
  for (const t of trends) {
    if (!terms.includes(t.term)) continue
    const week = t.week
    if (!weekMap.has(week)) weekMap.set(week, {})
    weekMap.get(week)![t.term] = t.interest
  }

  const chartData = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, values]) => ({
      week: formatWeekLabel(week),
      ...values,
    }))

  const COLORS = ['#7D8471', '#5D7A7A', '#A6894A', '#6A7060', '#B8908A']

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm lg:col-span-2">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-sage-50 rounded-lg">
          <TrendingUp className="w-5 h-5 text-sage-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Google Trends
          </h2>
          <p className="text-xs text-sage-500">
            Search interest for key terms over the past 6 months
          </p>
        </div>
      </div>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#E8E4DF"
              vertical={false}
            />
            <XAxis
              dataKey="week"
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E8E4DF',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              labelStyle={{ color: '#31342D', fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {terms.map((term, i) => (
              <Line
                key={term}
                type="monotone"
                dataKey={term}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={{ fill: COLORS[i % COLORS.length], r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 8. Consumer Confidence Chart
// ---------------------------------------------------------------------------

function ConsumerConfidenceChart({
  data,
  loading,
}: {
  data: { date: string; value: number }[]
  loading: boolean
}) {
  if (loading) return <SkeletonCard className="lg:col-span-2" />

  if (data.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center lg:col-span-2">
        <BarChart3 className="w-8 h-8 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">
          No consumer confidence data available. Run economic indicator fetch to
          populate.
        </p>
      </div>
    )
  }

  const chartData = data.map((d) => ({
    date: new Date(d.date).toLocaleDateString('en-US', {
      month: 'short',
      year: '2-digit',
    }),
    value: d.value,
  }))

  // Show average line
  const avg =
    data.reduce((sum, d) => sum + d.value, 0) / data.length

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm lg:col-span-2">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 bg-blue-50 rounded-lg">
          <BarChart3 className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Consumer Confidence (UMCSENT)
          </h2>
          <p className="text-xs text-sage-500">
            University of Michigan consumer sentiment over 24 months
          </p>
        </div>
      </div>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
          >
            <defs>
              <linearGradient
                id="confidenceGradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor="#5D7A7A" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#5D7A7A" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#E8E4DF"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E8E4DF',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              labelStyle={{ color: '#31342D', fontWeight: 600 }}
              formatter={(value) => [Number(value).toFixed(1), 'Sentiment']}
            />
            <ReferenceLine
              y={avg}
              stroke="#9CA38F"
              strokeDasharray="4 4"
              label={{
                value: `Avg: ${avg.toFixed(1)}`,
                position: 'right',
                style: { fontSize: 10, fill: '#9CA38F' },
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#5D7A7A"
              strokeWidth={2}
              fill="url(#confidenceGradient)"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function MarketPulsePage() {
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])

  // State
  const [loading, setLoading] = useState(true)
  const [indicators, setIndicators] = useState<Record<string, number>>({})
  const [demandScore, setDemandScore] = useState<DemandScore | null>(null)
  const [recommendations, setRecommendations] = useState<TrendRecommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(true)
  const [suggestions, setSuggestions] = useState<PositioningSuggestion[]>([])
  const [generating, setGenerating] = useState(false)
  const [seasonalContent, setSeasonalContent] = useState<SeasonalContent | null>(null)
  const [weatherData, setWeatherData] = useState<WeatherRow[]>([])
  const [searchTrends, setSearchTrends] = useState<SearchTrend[]>([])
  const [confidenceHistory, setConfidenceHistory] = useState<{ date: string; value: number }[]>([])
  // Venue's outdoor "ideal temp" config — used by computeOutdoorScore
  // so a beach venue scores Aug differently from a mountain venue.
  // Defaults match the 65/78 fallback when no row found.
  const [outdoorTempRange, setOutdoorTempRange] = useState<{ min: number; max: number }>({ min: 65, max: 78 })
  const [error, setError] = useState<string | null>(null)

  // ---- Fetch all data ----
  const fetchData = useCallback(async () => {
    setLoading(true)
    setRecsLoading(true)

    try {
      const now = new Date()
      const twoYearsAgo = new Date(now)
      twoYearsAgo.setMonth(twoYearsAgo.getMonth() - 24)
      const sixMonthsAgo = new Date(now)
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

      const season = getCurrentSeason()

      // Pull venue's outdoor temp config alongside everything else so the
      // outdoor-score memo below uses the right ranges — beach vs mountain.
      const venueConfigPromise = supabase
        .from('venue_config')
        .select('outdoor_ideal_temp_min, outdoor_ideal_temp_max')
        .eq('venue_id', venueId)
        .maybeSingle()
        .then((res) => {
          const row = res.data as { outdoor_ideal_temp_min?: number; outdoor_ideal_temp_max?: number } | null
          if (row) {
            setOutdoorTempRange({
              min: row.outdoor_ideal_temp_min ?? 65,
              max: row.outdoor_ideal_temp_max ?? 78,
            })
          }
        })

      const [
        indicatorsRes,
        recsRes,
        seasonalRes,
        weatherRes,
        trendsRes,
        confidenceRes,
      ] = await Promise.all([
        // Latest economic indicators (one per indicator)
        supabase
          .from('economic_indicators')
          .select('indicator_name, date, value, source')
          .order('date', { ascending: false })
          .limit(50),

        // Recommendations for this venue
        fetch('/api/intel/recommendations').then((r) =>
          r.ok ? r.json() : { recommendations: [] }
        ),

        // Seasonal content for current season
        supabase
          .from('venue_seasonal_content')
          .select('*')
          .eq('venue_id', venueId)
          .eq('season', season)
          .order('created_at', { ascending: false })
          .limit(1),

        // Historical weather data — includes daily rows + monthly climate
        // normal rows added in migration 035 (source = 'climate_norm').
        supabase
          .from('weather_data')
          .select('*')
          .eq('venue_id', venueId)
          .order('date', { ascending: true }),

        // Search trends (last 6 months)
        supabase
          .from('search_trends')
          .select('*')
          .eq('venue_id', venueId)
          .gte('week', sixMonthsAgo.toISOString().split('T')[0])
          .order('week', { ascending: true }),

        // Consumer confidence history (24 months of UMCSENT)
        supabase
          .from('economic_indicators')
          .select('date, value')
          .eq('indicator_name', 'consumer_sentiment')
          .gte('date', twoYearsAgo.toISOString().split('T')[0])
          .order('date', { ascending: true }),
      ])
      // Wait for venue config in parallel — UI shouldn't render with
      // wrong temp range and then flicker correct.
      await venueConfigPromise

      // Process economic indicators — deduplicate, take latest per name
      const latestIndicators: Record<string, number> = {}
      for (const row of indicatorsRes.data ?? []) {
        const name = row.indicator_name as string
        if (!(name in latestIndicators)) {
          latestIndicators[name] = Number(row.value)
        }
      }
      setIndicators(latestIndicators)
      setDemandScore(calculateDemandScore(latestIndicators))

      // Recommendations
      setRecommendations(
        Array.isArray(recsRes.recommendations) ? recsRes.recommendations : []
      )
      setRecsLoading(false)

      // Seasonal content
      const seasonalData = seasonalRes.data
      if (seasonalData && seasonalData.length > 0) {
        setSeasonalContent(seasonalData[0] as SeasonalContent)
      }

      // Weather
      setWeatherData((weatherRes.data ?? []) as WeatherRow[])

      // Search trends
      setSearchTrends((trendsRes.data ?? []) as SearchTrend[])

      // Confidence history
      setConfidenceHistory(
        (confidenceRes.data ?? []).map((d) => ({
          date: d.date as string,
          value: Number(d.value),
        }))
      )

      setError(null)
    } catch (err) {
      console.error('[market-pulse] Failed to fetch data:', err)
      setError('Failed to load market data')
    } finally {
      setLoading(false)
    }
  }, [supabase, venueId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Apply / Dismiss recommendation ----
  const updateRecommendation = async (
    id: string,
    status: 'applied' | 'dismissed'
  ) => {
    try {
      const res = await fetch('/api/intel/recommendations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recommendationId: id, status }),
      })
      if (!res.ok) throw new Error('Failed to update recommendation')
      // Optimistic update
      setRecommendations((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                status,
                applied_at:
                  status === 'applied'
                    ? new Date().toISOString()
                    : r.applied_at,
                dismissed_at:
                  status === 'dismissed'
                    ? new Date().toISOString()
                    : r.dismissed_at,
              }
            : r
        )
      )
    } catch {
      // Re-fetch on error
      const res = await fetch('/api/intel/recommendations')
      if (res.ok) {
        const json = await res.json()
        setRecommendations(json.recommendations ?? [])
      }
    }
  }

  // ---- Generate positioning suggestions ----
  const handleGenerateSuggestions = async () => {
    setGenerating(true)
    try {
      const res = await fetch('/api/intel/positioning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId }),
      })
      if (!res.ok) throw new Error('Failed to generate suggestions')
      const json = await res.json()
      setSuggestions(json.suggestions ?? [])
    } catch (err) {
      console.error('[market-pulse] Positioning error:', err)
      setError('Failed to generate positioning suggestions')
    } finally {
      setGenerating(false)
    }
  }

  // ---- Compute monthly weather aggregates ----
  const monthlyWeather = useMemo(() => {
    if (weatherData.length === 0) return []

    const byMonth = new Map<
      number,
      { temps: number[]; precips: number[] }
    >()

    for (const w of weatherData) {
      const d = new Date(w.date + 'T00:00:00')
      const monthIdx = d.getMonth()
      if (!byMonth.has(monthIdx)) {
        byMonth.set(monthIdx, { temps: [], precips: [] })
      }
      const bucket = byMonth.get(monthIdx)!
      if (w.high_temp != null && w.low_temp != null) {
        bucket.temps.push((w.high_temp + w.low_temp) / 2)
      }
      if (w.precipitation != null) {
        bucket.precips.push(w.precipitation)
      }
    }

    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a - b)
      .map(([monthIdx, data]) => {
        const avgTemp =
          data.temps.length > 0
            ? data.temps.reduce((s, v) => s + v, 0) / data.temps.length
            : 50
        const totalPrecip = data.precips.reduce((s, v) => s + v, 0)
        return {
          month: getMonthName(monthIdx),
          avgTemp: Math.round(avgTemp * 10) / 10,
          totalPrecip: Math.round(totalPrecip * 10) / 10,
          outdoorScore: computeOutdoorScore(avgTemp, totalPrecip, outdoorTempRange.min, outdoorTempRange.max),
        }
      })
  }, [weatherData, outdoorTempRange.min, outdoorTempRange.max])

  // ---- Compute 3-year monthly climate rows (from migration 035 data) ----
  // Rows where year/month/outdoor_event_score are populated are monthly
  // climate normals. We group by year+month and keep the latest value per
  // (year, month) in case multiple venues contributed.
  const climateRows = useMemo<MonthlyClimateRow[]>(() => {
    const rows: MonthlyClimateRow[] = []
    for (const w of weatherData) {
      if (
        w.year == null ||
        w.month == null ||
        w.outdoor_event_score == null ||
        w.avg_temp_4pm_f == null
      ) {
        continue
      }
      rows.push({
        year: w.year,
        month: w.month,
        avg_temp_4pm_f: w.avg_temp_4pm_f,
        precipitation: w.precipitation ?? 0,
        avg_humidity_pct: w.avg_humidity_pct ?? 0,
        avg_wind_mph: w.avg_wind_mph ?? 0,
        sunny_days: w.sunny_days ?? 0,
        outdoor_event_score: w.outdoor_event_score,
      })
    }
    return rows
  }, [weatherData])

  // ---- Pivot climate rows into the recharts multi-line dataset ----
  const outdoorTrendData = useMemo<OutdoorTrendPoint[]>(() => {
    const byMonth = new Map<number, OutdoorTrendPoint>()
    for (let m = 1; m <= 12; m++) {
      byMonth.set(m, {
        month: getMonthName(m - 1),
        monthIdx: m,
        score_2024: null,
        score_2025: null,
        score_2026: null,
      })
    }
    for (const r of climateRows) {
      const point = byMonth.get(r.month)
      if (!point) continue
      if (r.year === 2024) point.score_2024 = r.outdoor_event_score
      else if (r.year === 2025) point.score_2025 = r.outdoor_event_score
      else if (r.year === 2026) point.score_2026 = r.outdoor_event_score
    }
    return Array.from(byMonth.values())
  }, [climateRows])

  // ---- Top 3 months for 2025 (most recent complete year) ----
  const bestMonths2025 = useMemo(() => {
    return climateRows
      .filter((r) => r.year === 2025)
      .slice()
      .sort((a, b) => b.outdoor_event_score - a.outdoor_event_score)
      .slice(0, 3)
      .map((r) => ({
        month: getMonthName(r.month - 1),
        score: r.outdoor_event_score,
      }))
  }, [climateRows])

  // ---- Compute insights ----
  const insights: InsightItem[] = useMemo(() => {
    const items: InsightItem[] = []

    if (demandScore) {
      if (demandScore.outlook === 'positive') {
        items.push({
          icon: 'trend_up',
          text: `Economic demand score is ${demandScore.score}/100 — conditions are favorable for wedding spending. Lean into premium packages.`,
          priority: 'high',
        })
      } else if (demandScore.outlook === 'caution') {
        items.push({
          icon: 'warning',
          text: `Economic demand score is ${demandScore.score}/100 — caution indicators suggest tightening budgets. Emphasize value and flexible pricing.`,
          priority: 'high',
        })
      }
    }

    const pendingRecs = recommendations.filter((r) => r.status === 'pending')
    if (pendingRecs.length > 0) {
      items.push({
        icon: 'action',
        text: `${pendingRecs.length} recommendation${pendingRecs.length !== 1 ? 's' : ''} waiting for your review — apply or dismiss to keep your strategy current.`,
        priority: 'medium',
      })
    }

    const bestMonth = monthlyWeather.reduce(
      (best, m) =>
        m.outdoorScore > (best?.outdoorScore ?? 0) ? m : best,
      monthlyWeather[0]
    )
    if (bestMonth && bestMonth.outdoorScore > 0) {
      items.push({
        icon: 'tip',
        text: `${bestMonth.month} has the highest outdoor event score (${bestMonth.outdoorScore}/100). Feature outdoor ceremony photos from this season.`,
      })
    }

    return items
  }, [demandScore, recommendations, monthlyWeather])

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Market Pulse
          </h1>
          <p className="text-sage-600 text-sm">
            Real-time market intelligence — Google search trends, competitor activity, economic indicators, and seasonal demand signals. Know what's happening in your market before it hits your inbox.
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true)
            fetchData()
          }}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors shrink-0"
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          {loading ? 'Loading...' : 'Refresh Data'}
        </button>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              fetchData()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- AI Insights ---- */}
      {!loading && insights.length > 0 && (
        <InsightPanel insights={insights} title="Market Insights" />
      )}

      {/* ---- Me or Market diagnosis (Phase 6 Task 55) ---- */}
      <MeOrMarketCard />

      {/* ---- Row 1: Demand Pulse + Seasonal Context ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <DemandPulseCard
          demandScore={demandScore}
          indicators={indicators}
        />
        <SeasonalContextSection
          content={seasonalContent}
          loading={loading}
        />
      </div>

      {/* ---- Actionable Recommendations ---- */}
      <RecommendationsSection
        recommendations={recommendations}
        onApply={(id) => updateRecommendation(id, 'applied')}
        onDismiss={(id) => updateRecommendation(id, 'dismissed')}
        loading={recsLoading}
      />

      {/* ---- Suggested Positioning ---- */}
      <PositioningSection
        suggestions={suggestions}
        generating={generating}
        onGenerate={handleGenerateSuggestions}
      />

      {/* ---- Google Trends Chart ---- */}
      <GoogleTrendsChart trends={searchTrends} loading={loading} />

      {/* ---- Outdoor Event Score — 3 Year Trend ---- */}
      <OutdoorScoreTrendChart
        trendData={outdoorTrendData}
        climateRows={climateRows}
        bestMonths={bestMonths2025}
        loading={loading}
      />

      {/* ---- Outdoor Score + Weather Risk ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <OutdoorScoreChart monthlyData={monthlyWeather} loading={loading} />
        <WeatherRiskGrid monthlyData={monthlyWeather} loading={loading} />
      </div>

      {/* ---- Consumer Confidence Chart ---- */}
      <ConsumerConfidenceChart data={confidenceHistory} loading={loading} />
    </div>
  )
}
