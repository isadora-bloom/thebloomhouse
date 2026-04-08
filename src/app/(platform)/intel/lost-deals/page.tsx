'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  XCircle,
  Plus,
  Filter,
  RotateCcw,
  AlertTriangle,
  X,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

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

interface LostDeal {
  id: string
  venue_id: string
  wedding_id: string | null
  stage: string
  reason: string
  competitor: string | null
  notes: string | null
  recovery_attempted: boolean
  recovery_outcome: string | null
  created_at: string
}

type StageFilter = 'all' | string
type ReasonFilter = 'all' | string

const PIE_COLORS = ['#7D8471', '#5D7A7A', '#A6894A', '#B8908A', '#6A7060', '#8FA88A']

const STAGES = ['inquiry', 'toured', 'held', 'proposal_sent', 'negotiation']
const REASONS = ['price', 'date_unavailable', 'competitor', 'cold_feet', 'venue_fit', 'unresponsive', 'other']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageBadge(stage: string): string {
  const m: Record<string, string> = {
    inquiry: 'bg-blue-50 text-blue-700 border-blue-200',
    toured: 'bg-teal-50 text-teal-700 border-teal-200',
    held: 'bg-amber-50 text-amber-700 border-amber-200',
    proposal_sent: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    negotiation: 'bg-purple-50 text-purple-700 border-purple-200',
  }
  return m[stage] ?? 'bg-sage-50 text-sage-700 border-sage-200'
}

function formatLabel(s: string): string {
  if (!s) return 'Unknown'
  return s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

// ---------------------------------------------------------------------------
// Skeletons
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

export default function LostDealsPage() {
  const [deals, setDeals] = useState<LostDeal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all')
  const [showModal, setShowModal] = useState(false)

  // Form state
  const [formStage, setFormStage] = useState('inquiry')
  const [formReason, setFormReason] = useState('price')
  const [formCompetitor, setFormCompetitor] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('lost_deals')
        .select('*')
        .order('created_at', { ascending: false })
      if (err) throw err
      setDeals((data ?? []) as LostDeal[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch lost deals:', err)
      setError('Failed to load lost deals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Stats
  const totalLost = deals.length
  const recoveryAttempted = deals.filter((d) => d.recovery_attempted).length
  const recovered = deals.filter((d) => d.recovery_outcome === 'recovered').length
  const recoveryRate = recoveryAttempted > 0 ? recovered / recoveryAttempted : 0

  // Lost by stage (pie)
  const stageData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of deals) {
      const key = d.stage || 'unknown'
      map[key] = (map[key] || 0) + 1
    }
    return Object.entries(map).map(([name, value]) => ({ name: formatLabel(name), value }))
  }, [deals])

  // Top reasons (bar)
  const reasonData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of deals) {
      const key = d.reason || 'unknown'
      map[key] = (map[key] || 0) + 1
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name: formatLabel(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
  }, [deals])

  // Top competitors
  const topCompetitors = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of deals) {
      if (d.competitor) map[d.competitor] = (map[d.competitor] || 0) + 1
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  }, [deals])

  // ---- Compute insights from lost deal data ----
  const lostDealInsights: InsightItem[] = useMemo(() => {
    if (deals.length === 0) return []
    const items: InsightItem[] = []

    // Top reason
    const reasonCounts: Record<string, number> = {}
    for (const d of deals) {
      const key = d.reason || 'unknown'
      reasonCounts[key] = (reasonCounts[key] || 0) + 1
    }
    const topReasonEntry = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]
    if (topReasonEntry) {
      const [reason, count] = topReasonEntry
      const pct = Math.round((count / deals.length) * 100)
      const formatted = reason ? reason.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()) : ''
      const label = (formatted && formatted.toLowerCase() !== 'undefined') ? formatted : 'Unknown'
      items.push({
        icon: 'warning',
        text: `${label} is your #1 reason for lost deals (${pct}%) — review your value proposition and messaging around this`,
        priority: 'high',
      })
    }

    // Top competitor
    if (topCompetitors.length > 0) {
      items.push({
        icon: 'trend_down',
        text: `${topCompetitors[0][0]} is winning the most deals against you (${topCompetitors[0][1]} lost) — study their positioning`,
        priority: 'medium',
      })
    }

    // Recovery rate insight
    if (recoveryAttempted > 0) {
      const ratePct = (recoveryRate * 100).toFixed(0)
      items.push({
        icon: recovered > 0 ? 'tip' : 'action',
        text: `${ratePct}% of recovery attempts succeeded (${recovered} of ${recoveryAttempted}) — ${recovered > 0 ? 'worth continuing to pursue lost leads' : 'refine your recovery approach'}`,
      })
    } else if (deals.length > 3) {
      items.push({
        icon: 'action',
        text: `No recovery attempts logged yet — even a 10% win-back rate adds meaningful revenue`,
        priority: 'medium',
      })
    }

    return items
  }, [deals, topCompetitors, recoveryAttempted, recovered, recoveryRate])

  // Filtered list
  const filtered = useMemo(() => {
    return deals.filter((d) => {
      if (stageFilter !== 'all' && d.stage !== stageFilter) return false
      if (reasonFilter !== 'all' && d.reason !== reasonFilter) return false
      return true
    })
  }, [deals, stageFilter, reasonFilter])

  // Save new lost deal
  const handleSave = async () => {
    setSaving(true)
    const supabase = getSupabase()
    try {
      const { error: err } = await supabase.from('lost_deals').insert({
        stage: formStage,
        reason: formReason,
        competitor: formCompetitor || null,
        notes: formNotes || null,
      })
      if (err) throw err
      setShowModal(false)
      setFormStage('inquiry')
      setFormReason('price')
      setFormCompetitor('')
      setFormNotes('')
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save lost deal:', err)
    } finally {
      setSaving(false)
    }
  }

  // Toggle recovery attempt
  const handleRecoveryAttempt = async (id: string) => {
    const supabase = getSupabase()
    await supabase.from('lost_deals').update({ recovery_attempted: true }).eq('id', id)
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, recovery_attempted: true } : d)))
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Lost Deals
          </h1>
          <p className="text-sage-600">
            Analyze every couple who didn't book — what stage they dropped off, why, and what you could do differently. Patterns here reveal your biggest conversion opportunities.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Record Lost Deal
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <p className="text-sm font-medium text-sage-600 mb-1">Total Lost</p>
              <p className="text-2xl font-bold text-sage-900">{totalLost}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <p className="text-sm font-medium text-sage-600 mb-1">Recovery Attempts</p>
              <p className="text-2xl font-bold text-sage-900">{recoveryAttempted}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <p className="text-sm font-medium text-sage-600 mb-1">Recovery Rate</p>
              <p className="text-2xl font-bold text-sage-900">{(recoveryRate * 100).toFixed(1)}%</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <p className="text-sm font-medium text-sage-600 mb-1">Top Competitor</p>
              <p className="text-2xl font-bold text-sage-900">
                {topCompetitors.length > 0 ? topCompetitors[0][0] : '--'}
              </p>
            </div>
          </>
        )}
      </div>

      {/* AI Insights */}
      {!loading && lostDealInsights.length > 0 && (
        <InsightPanel insights={lostDealInsights} />
      )}

      {/* Charts */}
      {!loading && deals.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Lost by stage */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">Lost by Stage</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stageData} cx="50%" cy="50%" innerRadius={45} outerRadius={85} dataKey="value" nameKey="name" paddingAngle={2} label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                    {stageData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Top reasons */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">Top Reasons</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={reasonData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} width={80} />
                  <Tooltip contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }} />
                  <Bar dataKey="value" fill="#7D8471" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      {!loading && (
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-sage-500" />
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-1.5 bg-surface text-sage-700"
          >
            <option value="all">All Stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>{formatLabel(s)}</option>
            ))}
          </select>
          <select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-1.5 bg-surface text-sage-700"
          >
            <option value="all">All Reasons</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>{formatLabel(r)}</option>
            ))}
          </select>
          {(stageFilter !== 'all' || reasonFilter !== 'all') && (
            <button
              onClick={() => { setStageFilter('all'); setReasonFilter('all') }}
              className="text-xs text-sage-500 hover:text-sage-700 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Deal list */}
      {!loading && (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-12 text-center">
              <XCircle className="w-10 h-10 text-sage-300 mx-auto mb-3" />
              <p className="text-sm text-sage-500">No lost deals match the current filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-warm-white">
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Stage</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Reason</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Competitor</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Notes</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Recovery</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((d) => (
                    <tr key={d.id} className="hover:bg-sage-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${stageBadge(d.stage)}`}>
                          {formatLabel(d.stage)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sage-700">{formatLabel(d.reason)}</td>
                      <td className="px-6 py-4 text-sage-700">{d.competitor ?? '--'}</td>
                      <td className="px-6 py-4 text-sage-600 max-w-xs truncate">{d.notes ?? '--'}</td>
                      <td className="px-6 py-4">
                        {d.recovery_attempted ? (
                          <span className="text-xs font-medium text-emerald-600">Attempted</span>
                        ) : (
                          <button
                            onClick={() => handleRecoveryAttempt(d.id)}
                            className="flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700 transition-colors"
                          >
                            <RotateCcw className="w-3 h-3" /> Mark attempt
                          </button>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sage-500 text-xs">
                        {new Date(d.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add Lost Deal Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-md p-6 mx-4">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">Record Lost Deal</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-sage-50"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Stage Lost</label>
                <select value={formStage} onChange={(e) => setFormStage(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                  {STAGES.map((s) => <option key={s} value={s}>{formatLabel(s)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Reason</label>
                <select value={formReason} onChange={(e) => setFormReason(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                  {REASONS.map((r) => <option key={r} value={r}>{formatLabel(r)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Competitor (optional)</label>
                <input type="text" value={formCompetitor} onChange={(e) => setFormCompetitor(e.target.value)} placeholder="e.g. Mount Ida Farm" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Notes (optional)</label>
                <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} rows={3} placeholder="Additional context..." className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400 resize-none" />
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
