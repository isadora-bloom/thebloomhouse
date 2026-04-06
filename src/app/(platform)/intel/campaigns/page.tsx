'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Megaphone,
  Plus,
  X,
  DollarSign,
  TrendingUp,
  Award,
} from 'lucide-react'
import {
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

interface Campaign {
  id: string
  venue_id: string
  name: string
  channel: string
  spend: number
  inquiries: number
  tours: number
  bookings: number
  revenue: number
  start_date: string
  end_date: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function fmtRoi(revenue: number, spend: number): string {
  if (spend === 0) return '--'
  const roi = ((revenue - spend) / spend) * 100
  return `${roi.toFixed(0)}%`
}

function costPer(total: number, count: number): string {
  if (count === 0) return '--'
  return fmt$(total / count)
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
      <div className="animate-pulse space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-4">
            <div className="h-5 w-32 bg-sage-100 rounded" />
            <div className="h-5 w-20 bg-sage-50 rounded" />
            <div className="h-5 w-16 bg-sage-50 rounded" />
            <div className="h-5 w-16 bg-sage-50 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formChannel, setFormChannel] = useState('instagram')
  const [formSpend, setFormSpend] = useState('')
  const [formInquiries, setFormInquiries] = useState('')
  const [formTours, setFormTours] = useState('')
  const [formBookings, setFormBookings] = useState('')
  const [formRevenue, setFormRevenue] = useState('')
  const [formStartDate, setFormStartDate] = useState('')
  const [saving, setSaving] = useState(false)

  const CHANNELS = ['instagram', 'facebook', 'google_ads', 'the_knot', 'wedding_wire', 'tiktok', 'email', 'referral', 'other']

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false })
      if (err) throw err
      setCampaigns((data ?? []) as Campaign[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch campaigns:', err)
      setError('Failed to load campaigns')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Best performing channel
  const bestChannel = useMemo(() => {
    const channelMap: Record<string, { revenue: number; spend: number }> = {}
    for (const c of campaigns) {
      const ch = channelMap[c.channel] ?? { revenue: 0, spend: 0 }
      ch.revenue += c.revenue
      ch.spend += c.spend
      channelMap[c.channel] = ch
    }
    let best = ''
    let bestRoi = -Infinity
    for (const [ch, stats] of Object.entries(channelMap)) {
      const roi = stats.spend > 0 ? (stats.revenue - stats.spend) / stats.spend : 0
      if (roi > bestRoi) {
        bestRoi = roi
        best = ch
      }
    }
    return best ? best.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()) : '--'
  }, [campaigns])

  // ROI comparison chart data
  const chartData = useMemo(() => {
    return campaigns.map((c) => ({
      name: c.name.length > 15 ? c.name.slice(0, 15) + '...' : c.name,
      roi: c.spend > 0 ? Math.round(((c.revenue - c.spend) / c.spend) * 100) : 0,
    })).sort((a, b) => b.roi - a.roi).slice(0, 10)
  }, [campaigns])

  // Open modal for edit
  const openEdit = (c: Campaign) => {
    setEditingId(c.id)
    setFormName(c.name)
    setFormChannel(c.channel)
    setFormSpend(String(c.spend))
    setFormInquiries(String(c.inquiries))
    setFormTours(String(c.tours))
    setFormBookings(String(c.bookings))
    setFormRevenue(String(c.revenue))
    setFormStartDate(c.start_date)
    setShowModal(true)
  }

  const resetForm = () => {
    setEditingId(null)
    setFormName('')
    setFormChannel('instagram')
    setFormSpend('')
    setFormInquiries('')
    setFormTours('')
    setFormBookings('')
    setFormRevenue('')
    setFormStartDate('')
  }

  const handleSave = async () => {
    setSaving(true)
    const supabase = getSupabase()
    const payload = {
      name: formName,
      channel: formChannel,
      spend: Number(formSpend) || 0,
      inquiries: Number(formInquiries) || 0,
      tours: Number(formTours) || 0,
      bookings: Number(formBookings) || 0,
      revenue: Number(formRevenue) || 0,
      start_date: formStartDate || new Date().toISOString().slice(0, 10),
    }
    try {
      if (editingId) {
        const { error: err } = await supabase.from('campaigns').update(payload).eq('id', editingId)
        if (err) throw err
      } else {
        const { error: err } = await supabase.from('campaigns').insert(payload)
        if (err) throw err
      }
      setShowModal(false)
      resetForm()
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save campaign:', err)
    } finally {
      setSaving(false)
    }
  }

  const formatLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Campaign ROI
          </h1>
          <p className="text-sage-600">
            Track marketing spend against results across every channel — The Knot, Instagram ads, Google, and more. See which campaigns actually drive bookings, not just clicks.
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowModal(true) }}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Campaign
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Megaphone className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Best channel highlight */}
      {!loading && campaigns.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex items-center gap-4">
          <Award className="w-6 h-6 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-emerald-800">Best Performing Channel</p>
            <p className="text-lg font-bold text-emerald-900">{bestChannel}</p>
          </div>
        </div>
      )}

      {/* Campaign table */}
      {loading ? (
        <TableSkeleton />
      ) : campaigns.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Megaphone className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No campaigns yet</h3>
          <p className="text-sm text-sage-600">Add your first campaign to start tracking ROI.</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Campaign</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Channel</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Spend</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Inquiries</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Tours</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Bookings</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Revenue</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Cost/Inquiry</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Cost/Booking</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">ROI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => openEdit(c)}
                    className="hover:bg-sage-50/50 transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-4 font-medium text-sage-900">{c.name}</td>
                    <td className="px-5 py-4 text-sage-600">{formatLabel(c.channel)}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{fmt$(c.spend)}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{c.inquiries}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{c.tours}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{c.bookings}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{fmt$(c.revenue)}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{costPer(c.spend, c.inquiries)}</td>
                    <td className="px-5 py-4 text-right text-sage-700 tabular-nums">{costPer(c.spend, c.bookings)}</td>
                    <td className="px-5 py-4 text-right">
                      <span className={`font-semibold tabular-nums ${
                        c.spend > 0 && c.revenue > c.spend ? 'text-emerald-700' : 'text-red-600'
                      }`}>
                        {fmtRoi(c.revenue, c.spend)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ROI comparison chart */}
      {!loading && chartData.length > 1 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">ROI Comparison</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} width={100} />
                <Tooltip formatter={(v) => { const n = Number(v) || 0; return [`${n}%`, 'ROI']; }} contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }} />
                <Bar dataKey="roi" fill="#7D8471" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setShowModal(false); resetForm() }} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-lg p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">
                {editingId ? 'Edit Campaign' : 'Add Campaign'}
              </h3>
              <button onClick={() => { setShowModal(false); resetForm() }} className="p-1.5 rounded-lg hover:bg-sage-50">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Campaign Name</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Spring Instagram Push" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Channel</label>
                  <select value={formChannel} onChange={(e) => setFormChannel(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                    {CHANNELS.map((ch) => <option key={ch} value={ch}>{formatLabel(ch)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Start Date</label>
                  <input type="date" value={formStartDate} onChange={(e) => setFormStartDate(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Spend ($)</label>
                  <input type="number" value={formSpend} onChange={(e) => setFormSpend(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Revenue ($)</label>
                  <input type="number" value={formRevenue} onChange={(e) => setFormRevenue(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Inquiries</label>
                  <input type="number" value={formInquiries} onChange={(e) => setFormInquiries(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Tours</label>
                  <input type="number" value={formTours} onChange={(e) => setFormTours(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Bookings</label>
                  <input type="number" value={formBookings} onChange={(e) => setFormBookings(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => { setShowModal(false); resetForm() }} className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving || !formName} className="px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? 'Saving...' : editingId ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
