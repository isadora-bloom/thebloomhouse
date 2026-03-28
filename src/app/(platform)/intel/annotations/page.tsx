'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  StickyNote,
  Plus,
  X,
  Calendar,
  Tag,
  AlertTriangle,
  Zap,
  Eye,
} from 'lucide-react'

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

interface Annotation {
  id: string
  venue_id: string
  start_date: string
  end_date: string | null
  title: string
  description: string | null
  type: string
  affects_metrics: string[] | null
  anomaly_alert_id: string | null
  created_at: string
}

const TYPES = ['system', 'proactive', 'reactive']
const METRIC_OPTIONS = ['inquiry_volume', 'response_time', 'tour_conversion', 'booking_rate', 'revenue', 'lost_deal_rate']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeBadge(type: string): { bg: string; icon: React.ComponentType<{ className?: string }> } {
  switch (type) {
    case 'system':
      return { bg: 'bg-blue-50 text-blue-700 border-blue-200', icon: Zap }
    case 'proactive':
      return { bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: Eye }
    case 'reactive':
      return { bg: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertTriangle }
    default:
      return { bg: 'bg-sage-50 text-sage-700 border-sage-200', icon: Tag }
  }
}

function formatLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function AnnotationSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="flex gap-2">
          <div className="h-5 w-16 bg-sage-100 rounded-full" />
          <div className="h-5 w-32 bg-sage-100 rounded" />
        </div>
        <div className="h-4 w-full bg-sage-50 rounded" />
        <div className="h-4 w-1/2 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function AnnotationsPage() {
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)

  // Form state
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formType, setFormType] = useState('proactive')
  const [formStartDate, setFormStartDate] = useState('')
  const [formEndDate, setFormEndDate] = useState('')
  const [formMetrics, setFormMetrics] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('annotations')
        .select('*')
        .order('start_date', { ascending: false })
      if (err) throw err
      setAnnotations((data ?? []) as Annotation[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch annotations:', err)
      setError('Failed to load annotations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const toggleMetric = (metric: string) => {
    setFormMetrics((prev) =>
      prev.includes(metric) ? prev.filter((m) => m !== metric) : [...prev, metric]
    )
  }

  const handleSave = async () => {
    setSaving(true)
    const supabase = getSupabase()
    try {
      const { error: err } = await supabase.from('annotations').insert({
        title: formTitle,
        description: formDescription || null,
        type: formType,
        start_date: formStartDate || new Date().toISOString().slice(0, 10),
        end_date: formEndDate || null,
        affects_metrics: formMetrics.length > 0 ? formMetrics : null,
      })
      if (err) throw err
      setShowModal(false)
      setFormTitle('')
      setFormDescription('')
      setFormType('proactive')
      setFormStartDate('')
      setFormEndDate('')
      setFormMetrics([])
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save annotation:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Event Annotations
          </h1>
          <p className="text-sage-600">
            Mark known events that explain metric movements (holidays, closures, campaigns).
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Annotation
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <StickyNote className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Annotation list */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <AnnotationSkeleton key={i} />
          ))}
        </div>
      ) : annotations.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <StickyNote className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No annotations</h3>
          <p className="text-sm text-sage-600">Add annotations to provide context for metric anomalies.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {annotations.map((a) => {
            const { bg, icon: TypeIcon } = typeBadge(a.type)
            return (
              <div key={a.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {/* Type + title */}
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${bg}`}>
                        <TypeIcon className="w-2.5 h-2.5" />
                        {formatLabel(a.type)}
                      </span>
                      <h3 className="font-heading text-base font-semibold text-sage-900">{a.title}</h3>
                    </div>

                    {/* Date range */}
                    <div className="flex items-center gap-1 text-xs text-sage-500 mb-2">
                      <Calendar className="w-3 h-3" />
                      {new Date(a.start_date).toLocaleDateString()}
                      {a.end_date && ` - ${new Date(a.end_date).toLocaleDateString()}`}
                    </div>

                    {/* Description */}
                    {a.description && (
                      <p className="text-sm text-sage-600 leading-relaxed mb-3">{a.description}</p>
                    )}

                    {/* Affected metrics */}
                    {a.affects_metrics && a.affects_metrics.length > 0 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-sage-500">Affects:</span>
                        {a.affects_metrics.map((m) => (
                          <span key={m} className="px-2 py-0.5 bg-sage-50 text-sage-600 text-[10px] font-medium rounded-full border border-sage-200">
                            {formatLabel(m)}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Linked anomaly */}
                    {a.anomaly_alert_id && (
                      <p className="mt-2 text-xs text-teal-600 font-medium">
                        Linked to anomaly alert
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add Annotation Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-md p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">Add Annotation</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-sage-50"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Title</label>
                <input type="text" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="e.g. Holiday weekend, Venue closure" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Type</label>
                <select value={formType} onChange={(e) => setFormType(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                  {TYPES.map((t) => <option key={t} value={t}>{formatLabel(t)}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Start Date</label>
                  <input type="date" value={formStartDate} onChange={(e) => setFormStartDate(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">End Date (optional)</label>
                  <input type="date" value={formEndDate} onChange={(e) => setFormEndDate(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Description (optional)</label>
                <textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} rows={3} placeholder="Context for this event..." className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400 resize-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-2">Affects Metrics</label>
                <div className="flex flex-wrap gap-2">
                  {METRIC_OPTIONS.map((m) => (
                    <button
                      key={m}
                      onClick={() => toggleMetric(m)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                        formMetrics.includes(m)
                          ? 'bg-sage-500 text-white border-sage-500'
                          : 'bg-warm-white text-sage-600 border-sage-200 hover:bg-sage-50'
                      }`}
                    >
                      {formatLabel(m)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving || !formTitle} className="px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
