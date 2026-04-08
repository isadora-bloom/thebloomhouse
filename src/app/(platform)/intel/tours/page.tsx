'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
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
  Filter,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'

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

interface TourRow {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string
  tour_type: string
  conducted_by: string | null
  couple_name: string | null
  source: string | null
  outcome: string
  competing_venues: string | null
  notes: string | null
  created_at: string
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
  const [tours, setTours] = useState<TourRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TourFilter>('all')
  const [showModal, setShowModal] = useState(false)

  // Form state
  const [formDate, setFormDate] = useState('')
  const [formType, setFormType] = useState('in_person')
  const [formCouple, setFormCouple] = useState('')
  const [formConductor, setFormConductor] = useState('')
  const [formSource, setFormSource] = useState('website')
  const [formCompeting, setFormCompeting] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('tours')
        .select('*')
        .order('scheduled_at', { ascending: false })
      if (err) throw err
      setTours((data ?? []) as TourRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch tours:', err)
      setError('Failed to load tours')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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
      const { error: err } = await supabase.from('tours').insert({
        scheduled_at: formDate || new Date().toISOString().slice(0, 10),
        tour_type: formType,
        couple_name: formCouple || null,
        conducted_by: formConductor || null,
        source: formSource,
        competing_venues: formCompeting || null,
        notes: formNotes || null,
        outcome: 'pending',
      })
      if (err) throw err
      setShowModal(false)
      setFormDate('')
      setFormType('in_person')
      setFormCouple('')
      setFormConductor('')
      setFormSource('website')
      setFormCompeting('')
      setFormNotes('')
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save tour:', err)
    } finally {
      setSaving(false)
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
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Tour
        </button>
      </div>

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
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Date</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Couple</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Type</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Conducted By</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Source</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((t) => {
                    const TypeIcon = tourTypeIcon(t.tour_type)
                    return (
                      <tr key={t.id} className="hover:bg-sage-50/50 transition-colors">
                        <td className="px-5 py-4 text-sage-700">{new Date(t.scheduled_at).toLocaleDateString()}</td>
                        <td className="px-5 py-4 font-medium text-sage-900">{t.couple_name || '--'}</td>
                        <td className="px-5 py-4 text-sage-700">
                          <span className="inline-flex items-center gap-1">
                            <TypeIcon className="w-3 h-3" />
                            {formatLabel(t.tour_type)}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-sage-600">{t.conducted_by || '--'}</td>
                        <td className="px-5 py-4 text-sage-600">{t.source ? formatLabel(t.source) : '--'}</td>
                        <td className="px-5 py-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${outcomeBadge(t.outcome)}`}>
                            {formatLabel(t.outcome)}
                          </span>
                        </td>
                      </tr>
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
                <label className="block text-sm font-medium text-sage-700 mb-1">Notes (optional)</label>
                <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 resize-none" />
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
