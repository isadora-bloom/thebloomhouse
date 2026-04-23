'use client'

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useScope } from '@/lib/hooks/use-scope'
import {
  MapPin,
  Plus,
  X,
  CalendarCheck,
  Clock,
  Target,
  Video,
  Phone,
  Users,
  ChevronDown,
  ChevronRight,
  Sparkles,
  MessageSquare,
  Heart,
  Calendar,
  FileText,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptExtractedShape {
  attendee_types?: string[]
  key_questions?: Array<{ question: string; category: string }>
  emotional_signals?: Array<{ signal: string; evidence: string }>
  specific_interests?: string[]
  booked_date_mentions?: string[]
  summary?: string
}

interface TourRow {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string
  tour_type: string
  conducted_by: string | null
  // couple_name is derived from notes (legacy rows) or omitted. Not a DB column.
  couple_name?: string | null
  source: string | null
  outcome: string
  competing_venues: string | null
  notes: string | null
  created_at: string
  transcript: string | null
  transcript_extracted: TranscriptExtractedShape | null
  tour_brief_generated_at: string | null
  venue?: { name: string | null } | null
  conductor?: { first_name: string | null; last_name: string | null } | null
}

type TourFilter = 'all' | 'upcoming' | 'completed' | 'cancelled'

const TOUR_TYPES = ['in_person', 'virtual', 'phone']
const OUTCOMES = ['pending', 'completed', 'booked', 'lost', 'cancelled']
const SOURCES = ['website', 'the_knot', 'wedding_wire', 'instagram', 'referral', 'phone', 'other']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLabel(s: string): string {
  if (!s) return ''
  return s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

function outcomeBadge(outcome: string): string {
  const m: Record<string, string> = {
    pending: 'bg-blue-50 text-blue-700 border-blue-200',
    completed: 'bg-sage-50 text-sage-700 border-sage-200',
    booked: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    lost: 'bg-red-50 text-red-700 border-red-200',
    cancelled: 'bg-slate-50 text-slate-700 border-slate-200',
  }
  return m[outcome] ?? 'bg-sage-50 text-sage-700 border-sage-200'
}

function tourTypeIcon(type: string) {
  switch (type) {
    case 'virtual':
      return Video
    case 'phone':
      return Phone
    default:
      return MapPin
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-20 bg-sage-100 rounded" />
        <div className="h-7 w-12 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function ToursPage() {
  const scope = useScope()
  const [tours, setTours] = useState<TourRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TourFilter>('all')
  const [showModal, setShowModal] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [briefingId, setBriefingId] = useState<string | null>(null)
  const [briefError, setBriefError] = useState<string | null>(null)
  const [briefs, setBriefs] = useState<
    Record<
      string,
      {
        aiName: string
        venueName: string
        brief: string
        suggestedFollowUpDraft: string | null
        confidence: 'high' | 'medium' | 'low'
      }
    >
  >({})

  // Form state
  const [formDate, setFormDate] = useState('')
  const [formType, setFormType] = useState('in_person')
  const [formCouple, setFormCouple] = useState('')
  const [formConductor, setFormConductor] = useState('')
  const [formSource, setFormSource] = useState('website')
  const [formCompeting, setFormCompeting] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formAttendees, setFormAttendees] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    if (scope.loading) return
    const supabase = getSupabase()
    try {
      // Resolve scope → list of venue IDs (null = all venues / company)
      let venueIds: string[] | null = null
      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data: members } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (members ?? []).map((m) => m.venue_id as string)
      } else if (scope.orgId) {
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      let query = supabase
        .from('tours')
        .select(`
          *,
          venue:venues(name),
          conductor:user_profiles!conducted_by(first_name, last_name)
        `)
        .order('scheduled_at', { ascending: false })

      if (venueIds && venueIds.length > 0) {
        query = query.in('venue_id', venueIds)
      }

      const { data, error: err } = await query
      if (err) throw err
      setTours((data ?? []) as TourRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch tours:', err)
      setError('Failed to load tours')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.venueId, scope.groupId])

  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // Format helper for conductor full name
  function conductorName(t: TourRow): string {
    if (!t.conductor) return '—'
    const full = [t.conductor.first_name, t.conductor.last_name].filter(Boolean).join(' ')
    return full || '—'
  }

  // Stats
  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString()
  const yearTours = tours.filter((t) => t.created_at >= yearStart)
  const completed = yearTours.filter((t) => ['completed', 'booked'].includes(t.outcome)).length
  const booked = yearTours.filter((t) => t.outcome === 'booked').length
  const conversionRate = completed > 0 ? booked / completed : 0

  // Avg days to booking (simplified: diff between tour date and created_at for booked)
  const bookedTours = yearTours.filter((t) => t.outcome === 'booked')
  const avgDaysToBooking =
    bookedTours.length > 0
      ? Math.round(
          bookedTours.reduce((s, t) => {
            const tourDate = new Date(t.scheduled_at).getTime()
            const created = new Date(t.created_at).getTime()
            return s + Math.abs(tourDate - created) / (1000 * 60 * 60 * 24)
          }, 0) / bookedTours.length
        )
      : 0

  // No-show count (cancelled tours)
  const noShows = yearTours.filter((t) => t.outcome === 'cancelled').length

  // Best converting day of week
  const dayConversions = useMemo(() => {
    const dayMap: Record<string, { total: number; booked: number }> = {}
    for (const t of yearTours) {
      if (!['completed', 'booked'].includes(t.outcome)) continue
      const day = new Date(t.scheduled_at).toLocaleDateString('en-US', { weekday: 'long' })
      if (!dayMap[day]) dayMap[day] = { total: 0, booked: 0 }
      dayMap[day].total++
      if (t.outcome === 'booked') dayMap[day].booked++
    }
    return dayMap
  }, [yearTours])

  // ---- Compute insights from tour data ----
  const tourInsights: InsightItem[] = (() => {
    if (yearTours.length === 0) return []
    const items: InsightItem[] = []

    // Conversion rate vs industry average
    const convPct = conversionRate * 100
    if (completed > 0) {
      const comparison = convPct >= 40 ? 'above' : 'below'
      items.push({
        icon: convPct >= 40 ? 'trend_up' : 'trend_down',
        text: `Your tour-to-booking rate is ${convPct.toFixed(1)}% — ${comparison} the industry average of 40%`,
        priority: convPct < 30 ? 'high' : convPct < 40 ? 'medium' : undefined,
      })
    }

    // No-shows
    if (noShows > 0) {
      items.push({
        icon: 'warning',
        text: `${noShows} no-show${noShows !== 1 ? 's' : ''} this year — consider sending confirmation texts 24hrs before each tour`,
        priority: noShows >= 5 ? 'high' : 'medium',
      })
    }

    // Best converting day
    const dayEntries = Object.entries(dayConversions).filter(([, v]) => v.total >= 2)
    if (dayEntries.length >= 2) {
      const sorted = dayEntries
        .map(([day, v]) => ({ day, rate: v.total > 0 ? v.booked / v.total : 0 }))
        .sort((a, b) => b.rate - a.rate)
      const best = sorted[0]
      const avg = dayEntries.reduce((s, [, v]) => s + (v.total > 0 ? v.booked / v.total : 0), 0) / dayEntries.length
      if (best.rate > avg && best.rate > 0) {
        const pctBetter = Math.round(((best.rate - avg) / avg) * 100)
        items.push({
          icon: 'tip',
          text: `Tours on ${best.day}s convert ${pctBetter}% better than average — prioritize this day for showings`,
        })
      }
    }

    return items
  })()

  // Filtered
  const now = new Date().toISOString().slice(0, 10)
  const filtered = useMemo(() => {
    return tours.filter((t) => {
      switch (filter) {
        case 'upcoming':
          return t.scheduled_at >= now && t.outcome === 'pending'
        case 'completed':
          return ['completed', 'booked'].includes(t.outcome)
        case 'cancelled':
          return t.outcome === 'cancelled'
        default:
          return true
      }
    })
  }, [tours, filter, now])

  const handleSave = async () => {
    setSaving(true)
    const supabase = getSupabase()
    try {
      // Note: `couple_name` isn't a column on tours (couple identity lives
      // on people via wedding_id). `competing_venues` is text[], so a
      // comma-separated free-text input must be split before insert.
      // `outcome='pending'` is admitted by migration 077.
      const competingArr = formCompeting
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const noteWithCouple = [formCouple && `Couple: ${formCouple}`, formNotes]
        .filter(Boolean)
        .join('\n\n')
      const { error: err } = await supabase.from('tours').insert({
        scheduled_at: formDate || new Date().toISOString().slice(0, 10),
        tour_type: formType,
        conducted_by: formConductor || null,
        source: formSource,
        competing_venues: competingArr.length > 0 ? competingArr : null,
        notes: noteWithCouple || null,
        attendees: formAttendees,
        outcome: 'pending',
      })
      if (err) throw err

      // Track tour_booked in consultant_metrics
      fetch('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tour_booked' }),
      }).catch((trackErr) => console.warn('Tour tracking failed:', trackErr))

      setShowModal(false)
      setFormDate('')
      setFormType('in_person')
      setFormCouple('')
      setFormConductor('')
      setFormSource('website')
      setFormCompeting('')
      setFormNotes('')
      setFormAttendees([])
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save tour:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleExtractTranscript(tourId: string) {
    setExtractingId(tourId)
    setExtractError(null)
    try {
      const res = await fetch('/api/agent/tour-transcript-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        extraction?: TranscriptExtractedShape | null
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error || `Extraction failed (${res.status})`)
      }
      if (!json.extraction) {
        setExtractError('No transcript content to extract.')
        return
      }
      // Patch the local row so the panel renders the new extraction
      // without a full refetch.
      setTours((prev) =>
        prev.map((t) =>
          t.id === tourId
            ? { ...t, transcript_extracted: json.extraction ?? null }
            : t
        )
      )
    } catch (err) {
      console.error('[tours] extract failed:', err)
      setExtractError(
        err instanceof Error ? err.message : 'Extraction failed'
      )
    } finally {
      setExtractingId(null)
    }
  }

  async function handleGenerateBrief(tourId: string) {
    setBriefingId(tourId)
    setBriefError(null)
    try {
      const res = await fetch('/api/agent/post-tour-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        brief?: {
          aiName: string
          venueName: string
          brief: string
          suggestedFollowUpDraft: string | null
          confidence: 'high' | 'medium' | 'low'
        } | null
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error || `Brief failed (${res.status})`)
      }
      if (!json.brief) {
        setBriefError('Brief could not be generated. Run the transcript extraction first.')
        return
      }
      setBriefs((prev) => ({ ...prev, [tourId]: json.brief! }))
      // Stamp the local row so the "Generate" button disappears until refetch.
      setTours((prev) =>
        prev.map((t) =>
          t.id === tourId
            ? { ...t, tour_brief_generated_at: new Date().toISOString() }
            : t
        )
      )
    } catch (err) {
      console.error('[tours] brief failed:', err)
      setBriefError(
        err instanceof Error ? err.message : 'Brief generation failed'
      )
    } finally {
      setBriefingId(null)
    }
  }

  const filters: { key: TourFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Tour Tracking
          </h1>
          <p className="text-sage-600">
            Track every tour — scheduled, completed, cancelled, and no-shows. See conversion rates from tour to booking and identify which tour types and times work best.
          </p>
          {scope.level === 'company' && (
            <p className="text-xs text-sage-500 mt-2">
              Showing across all venues — {scope.companyName}
            </p>
          )}
          {scope.level === 'group' && (
            <p className="text-xs text-sage-500 mt-2">
              Showing across {scope.groupName}
            </p>
          )}
          {scope.level === 'venue' && (
            <p className="text-xs text-sage-500 mt-2">
              Showing for {scope.venueName}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Tour
        </button>
      </div>

      {/* ---- Inline insight banner ---- */}
      <InlineInsightBanner category="lead_conversion" />

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <MapPin className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <CalendarCheck className="w-4 h-4 text-teal-500" />
                <span className="text-sm font-medium text-sage-600">Tours This Year</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{yearTours.length}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-sage-500" />
                <span className="text-sm font-medium text-sage-600">Completed</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{completed}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-medium text-sage-600">Conversion Rate</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{(conversionRate * 100).toFixed(1)}%</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-indigo-500" />
                <span className="text-sm font-medium text-sage-600">Avg Days to Booking</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{avgDaysToBooking || '--'}</p>
            </div>
          </>
        )}
      </div>

      {/* AI Insights */}
      {!loading && tourInsights.length > 0 && (
        <InsightPanel insights={tourInsights} />
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              filter === f.key
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tour list */}
      {!loading && (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-12 text-center">
              <MapPin className="w-10 h-10 text-sage-300 mx-auto mb-3" />
              <p className="text-sm text-sage-500">No tours match the current filter.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-warm-white">
                    <th className="px-3 py-3 w-8"></th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Couple</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Date</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Venue</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Type</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Conducted By</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Outcome</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Intel</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((t) => {
                    const TypeIcon = tourTypeIcon(t.tour_type)
                    const hasTranscript = !!(t.transcript && t.transcript.trim().length > 0)
                    const hasExtraction = !!t.transcript_extracted
                    const isExpanded = expandedId === t.id
                    return (
                      <Fragment key={t.id}>
                        <tr
                          className="hover:bg-sage-50/50 transition-colors cursor-pointer"
                          onClick={() =>
                            setExpandedId((prev) => (prev === t.id ? null : t.id))
                          }
                        >
                          <td className="px-3 py-4 text-sage-400">
                            {hasTranscript ? (
                              isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )
                            ) : null}
                          </td>
                          <td className="px-5 py-4 font-medium text-sage-900">{t.couple_name || '—'}</td>
                          <td className="px-5 py-4 text-sage-700">{new Date(t.scheduled_at).toLocaleDateString()}</td>
                          <td className="px-5 py-4 text-sage-600">{t.venue?.name || '—'}</td>
                          <td className="px-5 py-4 text-sage-700">
                            <span className="inline-flex items-center gap-1">
                              <TypeIcon className="w-3 h-3" />
                              {formatLabel(t.tour_type)}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-sage-600">{conductorName(t)}</td>
                          <td className="px-5 py-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${outcomeBadge(t.outcome)}`}>
                              {formatLabel(t.outcome)}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-xs">
                            {hasExtraction ? (
                              <span className="inline-flex items-center gap-1 text-sage-600">
                                <Sparkles className="w-3 h-3" />
                                Extracted
                              </span>
                            ) : hasTranscript ? (
                              <span className="inline-flex items-center gap-1 text-sage-500">
                                <FileText className="w-3 h-3" />
                                Transcript
                              </span>
                            ) : (
                              <span className="text-sage-400">—</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && hasTranscript && (
                          <tr className="bg-sage-50/30">
                            <td colSpan={8} className="px-6 py-5">
                              <TourIntelligencePanel
                                tour={t}
                                onExtract={() => handleExtractTranscript(t.id)}
                                extracting={extractingId === t.id}
                                error={
                                  extractingId === null && extractError && expandedId === t.id
                                    ? extractError
                                    : null
                                }
                                onGenerateBrief={() => handleGenerateBrief(t.id)}
                                briefing={briefingId === t.id}
                                brief={briefs[t.id] ?? null}
                                briefError={
                                  briefingId === null && briefError && expandedId === t.id
                                    ? briefError
                                    : null
                                }
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add Tour Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-md p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">Add Tour</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-sage-50"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Date</label>
                  <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Type</label>
                  <select value={formType} onChange={(e) => setFormType(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                    {TOUR_TYPES.map((t) => <option key={t} value={t}>{formatLabel(t)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Couple Name</label>
                <input type="text" value={formCouple} onChange={(e) => setFormCouple(e.target.value)} placeholder="e.g. Sarah & James" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Conducted By</label>
                  <input type="text" value={formConductor} onChange={(e) => setFormConductor(e.target.value)} placeholder="Name" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Source</label>
                  <select value={formSource} onChange={(e) => setFormSource(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                    {SOURCES.map((s) => <option key={s} value={s}>{formatLabel(s)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Competing Venues (optional)</label>
                <input type="text" value={formCompeting} onChange={(e) => setFormCompeting(e.target.value)} placeholder="e.g. Mount Ida, Keswick" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Who attended</label>
                <div className="flex flex-wrap gap-2">
                  {['couple', 'partner1', 'partner2', 'parents', 'friends', 'planner', 'wedding_party', 'other'].map((role) => {
                    const active = formAttendees.includes(role)
                    return (
                      <button
                        key={role}
                        type="button"
                        onClick={() =>
                          setFormAttendees((prev) =>
                            prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
                          )
                        }
                        className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                          active
                            ? 'bg-sage-600 text-white border-sage-600'
                            : 'bg-warm-white text-sage-700 border-sage-200 hover:bg-sage-50'
                        }`}
                      >
                        {formatLabel(role)}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-sage-500 mt-1">
                  Phase 4 attendee-signal feeds off this. Capture who actually
                  showed up, not who was invited.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Notes (optional)</label>
                <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 resize-none" />
              </div>
              {/* Omi transcript placeholder — Phase 7. The field exists on
                  tours.transcript (migration 075) and uploads will arrive via
                  the Omi webhook when wearable integration ships. Disabled
                  today so coordinators know it's coming without being able
                  to submit broken data. */}
              <div className="opacity-60 pointer-events-none bg-sage-50/50 border border-dashed border-sage-200 rounded-lg p-3">
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Tour transcript
                  <span className="ml-2 text-xs font-normal text-sage-500">Coming with Omi integration</span>
                </label>
                <p className="text-xs text-sage-500">
                  Tour conversations will auto-transcribe and attach here once Omi Dev Kit 2 is wired.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tour Intelligence Panel. Phase 7 Task 62.
//
// Surfaces the AI-extracted intelligence from a tour's Omi transcript.
// When the tour has a transcript but no extracted JSON yet, shows a single
// "Extract intelligence" button. When extraction exists, renders the full
// structured breakdown as sections.
// ---------------------------------------------------------------------------

interface TourIntelligencePanelProps {
  tour: TourRow
  onExtract: () => void
  extracting: boolean
  error: string | null
  onGenerateBrief: () => void
  briefing: boolean
  brief: {
    aiName: string
    venueName: string
    brief: string
    suggestedFollowUpDraft: string | null
    confidence: 'high' | 'medium' | 'low'
  } | null
  briefError: string | null
}

function TourIntelligencePanel({
  tour,
  onExtract,
  extracting,
  error,
  onGenerateBrief,
  briefing,
  brief,
  briefError,
}: TourIntelligencePanelProps) {
  const extracted = tour.transcript_extracted

  if (!extracted) {
    return (
      <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sage-900 font-medium">
              <FileText className="w-4 h-4 text-sage-500" />
              Tour transcript available
            </div>
            <p className="text-xs text-sage-600 mt-1">
              Run the AI extractor to pull out attendees, questions, emotional
              signals, interests, and mentioned dates.
            </p>
            {tour.transcript && (
              <p className="text-xs text-sage-500 mt-2">
                Transcript length: {tour.transcript.length.toLocaleString()} chars
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onExtract()
            }}
            disabled={extracting}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-sage-600 hover:bg-sage-700 text-white transition-colors disabled:opacity-50"
          >
            <Sparkles className="w-3 h-3" />
            {extracting ? 'Extracting...' : 'Extract intelligence'}
          </button>
        </div>
        {error && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}
      </div>
    )
  }

  const attendees = extracted.attendee_types ?? []
  const questions = extracted.key_questions ?? []
  const signals = extracted.emotional_signals ?? []
  const interests = extracted.specific_interests ?? []
  const dates = extracted.booked_date_mentions ?? []
  const summary = extracted.summary ?? ''

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h3 className="font-heading text-sm font-semibold text-sage-900">
          AI-extracted tour intelligence
        </h3>
      </div>

      {summary && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-sage-500 mb-1">
            Summary
          </div>
          <p className="text-sm text-sage-800 leading-relaxed">{summary}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {attendees.length > 0 && (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-sage-500 mb-2">
              <Users className="w-3 h-3" /> Attendees present
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attendees.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-sage-50 text-sage-700 border-sage-200"
                >
                  {formatLabel(a)}
                </span>
              ))}
            </div>
          </div>
        )}

        {dates.length > 0 && (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-sage-500 mb-2">
              <Calendar className="w-3 h-3" /> Dates mentioned
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dates.map((d, i) => (
                <span
                  key={`${d}-${i}`}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-teal-50 text-teal-700 border-teal-200"
                >
                  {d}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {questions.length > 0 && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-sage-500 mb-2">
            <MessageSquare className="w-3 h-3" /> Key questions
          </div>
          <ul className="space-y-2">
            {questions.map((q, i) => (
              <li
                key={`${q.question}-${i}`}
                className="flex items-start gap-2 text-sm text-sage-800"
              >
                <span className="inline-flex items-center shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-gold-50 text-gold-700 border border-gold-200">
                  {q.category}
                </span>
                <span className="flex-1">{q.question}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {signals.length > 0 && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-sage-500 mb-2">
            <Heart className="w-3 h-3" /> Emotional signals
          </div>
          <ul className="space-y-2">
            {signals.map((s, i) => (
              <li key={`${s.signal}-${i}`} className="text-sm">
                <div className="font-medium text-sage-900">
                  {formatLabel(s.signal)}
                </div>
                {s.evidence && (
                  <div className="text-xs text-sage-600 italic mt-0.5">
                    &ldquo;{s.evidence}&rdquo;
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {interests.length > 0 && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-sage-500 mb-2">
            <Target className="w-3 h-3" /> Specific interests
          </div>
          <div className="flex flex-wrap gap-1.5">
            {interests.map((i, idx) => (
              <span
                key={`${i}-${idx}`}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200"
              >
                {i}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Post-tour Sage brief section (Phase 7 Task 63) */}
      <PostTourBriefSection
        tour={tour}
        onGenerateBrief={onGenerateBrief}
        briefing={briefing}
        brief={brief}
        briefError={briefError}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// PostTourBriefSection (Phase 7 Task 63)
// Below the extracted-intelligence section. Shows a "Generate post-tour
// brief" CTA when the transcript has been extracted but no brief exists,
// and renders the venue-voice markdown brief + suggested draft card once
// generated.
// ---------------------------------------------------------------------------

interface PostTourBriefSectionProps {
  tour: TourRow
  onGenerateBrief: () => void
  briefing: boolean
  brief: {
    aiName: string
    venueName: string
    brief: string
    suggestedFollowUpDraft: string | null
    confidence: 'high' | 'medium' | 'low'
  } | null
  briefError: string | null
}

function PostTourBriefSection({
  tour,
  onGenerateBrief,
  briefing,
  brief,
  briefError,
}: PostTourBriefSectionProps) {
  const hasExtraction = !!tour.transcript_extracted
  const hasBriefStamp = !!tour.tour_brief_generated_at

  // If there's no extraction yet, nothing to brief on.
  if (!hasExtraction) return null

  // Already generated and we have the content locally: render it.
  if (brief) {
    return (
      <div className="rounded-lg border border-sage-300 bg-white p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-gold-500" />
            <h3 className="font-heading text-sm font-semibold text-sage-900">
              Post-tour brief from {brief.aiName}
            </h3>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-semibold bg-sage-50 text-sage-700 border border-sage-200">
              {brief.confidence} confidence
            </span>
          </div>
        </div>
        <BriefMarkdown text={brief.brief} />

        {brief.suggestedFollowUpDraft ? (
          <div className="rounded-md border border-gold-200 bg-gold-50/40 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-wider text-sage-500">
                Suggested follow-up draft
              </div>
              <a
                href="/agent/drafts"
                onClick={(e) => e.stopPropagation()}
                className="text-xs font-medium text-sage-700 hover:text-sage-900 underline"
              >
                Review in Drafts
              </a>
            </div>
            <p className="text-sm text-sage-800 whitespace-pre-wrap leading-relaxed">
              {brief.suggestedFollowUpDraft}
            </p>
            <p className="text-[11px] text-sage-500 italic">
              Saved to Drafts as pending. Approve, edit, or reject from there.
            </p>
          </div>
        ) : (
          <p className="text-xs text-sage-500 italic">
            {brief.aiName} didn&rsquo;t have enough signal to compose a follow-up
            draft. Try adding more detail to the transcript.
          </p>
        )}
      </div>
    )
  }

  // Brief already generated in a past session but not re-fetched:
  // show a hint + let the coordinator re-run if they want a fresh one.
  if (hasBriefStamp) {
    return (
      <div className="rounded-lg border border-sage-200 bg-warm-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sage-900 font-medium">
              <Sparkles className="w-4 h-4 text-gold-500" />
              Post-tour brief already generated
            </div>
            <p className="text-xs text-sage-600 mt-1">
              A brief was composed on{' '}
              {new Date(tour.tour_brief_generated_at!).toLocaleString()}. Check
              the drafts queue for the follow-up email, or regenerate below.
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onGenerateBrief()
            }}
            disabled={briefing}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-sage-300 bg-warm-white hover:bg-sage-50 text-sage-700 transition-colors disabled:opacity-50"
          >
            <Sparkles className="w-3 h-3" />
            {briefing ? 'Regenerating...' : 'Regenerate brief'}
          </button>
        </div>
        {briefError && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
            {briefError}
          </p>
        )}
      </div>
    )
  }

  // Never generated: show the primary CTA.
  return (
    <div className="rounded-lg border border-gold-200 bg-gold-50/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sage-900 font-medium">
            <Sparkles className="w-4 h-4 text-gold-500" />
            Generate post-tour brief
          </div>
          <p className="text-xs text-sage-600 mt-1">
            Compose a coordinator brief in your venue&rsquo;s voice and draft a
            personalised follow-up email anchored on what the couple actually
            cared about.
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onGenerateBrief()
          }}
          disabled={briefing}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-gold-500 hover:bg-gold-600 text-white transition-colors disabled:opacity-50"
        >
          <Sparkles className="w-3 h-3" />
          {briefing ? 'Generating...' : 'Generate post-tour brief'}
        </button>
      </div>
      {briefError && (
        <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
          {briefError}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BriefMarkdown: lightweight markdown renderer for H3/paragraph/bullets.
// The brief prompt constrains output to these primitives so we can avoid
// shipping a full markdown library just for this surface.
// ---------------------------------------------------------------------------

function BriefMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  type Block =
    | { type: 'h3'; text: string }
    | { type: 'p'; text: string }
    | { type: 'ul'; items: string[] }
  const blocks: Block[] = []
  let paragraph: string[] = []
  let bullets: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'p', text: paragraph.join(' ').trim() })
      paragraph = []
    }
  }
  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ type: 'ul', items: bullets })
      bullets = []
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('### ')) {
      flushParagraph()
      flushBullets()
      blocks.push({ type: 'h3', text: line.slice(4).trim() })
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph()
      bullets.push(line.replace(/^[-*]\s+/, '').trim())
    } else if (line.length === 0) {
      flushParagraph()
      flushBullets()
    } else {
      flushBullets()
      paragraph.push(line)
    }
  }
  flushParagraph()
  flushBullets()

  return (
    <div className="space-y-3 text-sm text-sage-800 leading-relaxed">
      {blocks.map((block, i) => {
        if (block.type === 'h3') {
          return (
            <h4
              key={i}
              className="font-heading text-sm font-semibold text-sage-900 mt-2"
            >
              {block.text}
            </h4>
          )
        }
        if (block.type === 'ul') {
          return (
            <ul key={i} className="list-disc pl-5 space-y-1">
              {block.items.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} className="text-sage-800">
            {block.text}
          </p>
        )
      })}
    </div>
  )
}
