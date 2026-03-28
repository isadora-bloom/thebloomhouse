'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Kanban,
  Users,
  Calendar,
  Flame,
  Clock,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineWedding {
  id: string
  venue_id: string
  status: string
  source: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  heat_score: number
  temperature_tier: string
  inquiry_date: string
  updated_at: string
  // Joined
  partner1_name: string | null
  partner2_name: string | null
}

interface PipelineColumn {
  key: string
  label: string
  weddings: PipelineWedding[]
}

// TODO: Replace with venue from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: 'inquiry', label: 'Inquiry' },
  { key: 'tour_scheduled', label: 'Tour Scheduled' },
  { key: 'tour_completed', label: 'Tour Completed' },
  { key: 'proposal_sent', label: 'Proposal Sent' },
  { key: 'booked', label: 'Booked' },
  { key: 'lost', label: 'Lost' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceBadge(source: string | null): { bg: string; text: string; label: string } {
  switch (source) {
    case 'the_knot':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'The Knot' }
    case 'weddingwire':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'WeddingWire' }
    case 'google':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Google' }
    case 'instagram':
      return { bg: 'bg-pink-50', text: 'text-pink-700', label: 'Instagram' }
    case 'referral':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Referral' }
    case 'website':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Website' }
    case 'walk_in':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Walk-in' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: source || 'Unknown' }
  }
}

function heatDotColor(tier: string): string {
  switch (tier) {
    case 'hot':
      return 'bg-red-500'
    case 'warm':
      return 'bg-amber-500'
    case 'cool':
      return 'bg-blue-500'
    case 'cold':
      return 'bg-blue-800'
    case 'frozen':
      return 'bg-gray-400'
    default:
      return 'bg-sage-300'
  }
}

function daysInStage(updatedAt: string): number {
  const diff = Date.now() - new Date(updatedAt).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function coupleName(p1: string | null, p2: string | null): string {
  if (p1 && p2) return `${p1} & ${p2}`
  return p1 || p2 || 'Unknown'
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ColumnSkeleton() {
  return (
    <div className="min-w-[280px] flex-shrink-0">
      <div className="bg-sage-50 rounded-xl p-3">
        <div className="animate-pulse mb-3">
          <div className="h-5 w-28 bg-sage-100 rounded" />
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="bg-surface border border-border rounded-lg p-3 shadow-sm"
            >
              <div className="animate-pulse space-y-2">
                <div className="h-4 w-32 bg-sage-100 rounded" />
                <div className="h-3 w-20 bg-sage-100 rounded-full" />
                <div className="flex gap-3">
                  <div className="h-3 w-16 bg-sage-50 rounded" />
                  <div className="h-3 w-12 bg-sage-50 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Card
// ---------------------------------------------------------------------------

function PipelineCard({ wedding }: { wedding: PipelineWedding }) {
  const source = sourceBadge(wedding.source)
  const days = daysInStage(wedding.updated_at)

  return (
    <div className="bg-surface border border-border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow cursor-default">
      {/* Couple name + heat dot */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-sage-900 truncate">
          {coupleName(wedding.partner1_name, wedding.partner2_name)}
        </h4>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`w-2.5 h-2.5 rounded-full ${heatDotColor(wedding.temperature_tier)}`}
            title={`${wedding.temperature_tier} (${wedding.heat_score})`}
          />
        </div>
      </div>

      {/* Source badge */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${source.bg} ${source.text}`}
        >
          {source.label}
        </span>
        {wedding.guest_count_estimate && (
          <span className="inline-flex items-center gap-1 text-[10px] text-sage-500">
            <Users className="w-3 h-3" />
            {wedding.guest_count_estimate}
          </span>
        )}
      </div>

      {/* Date + days in stage */}
      <div className="flex items-center justify-between text-[11px] text-sage-400">
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(wedding.wedding_date)}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {days}d in stage
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Column
// ---------------------------------------------------------------------------

function PipelineColumnView({ column }: { column: PipelineColumn }) {
  const isLost = column.key === 'lost'

  return (
    <div className="min-w-[280px] flex-shrink-0">
      <div
        className={`rounded-xl p-3 h-full ${
          isLost ? 'bg-red-50/50' : 'bg-sage-50'
        }`}
      >
        {/* Column header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <h3
            className={`text-sm font-semibold ${
              isLost ? 'text-red-700' : 'text-sage-800'
            }`}
          >
            {column.label}
          </h3>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              isLost
                ? 'bg-red-100 text-red-600'
                : 'bg-sage-100 text-sage-600'
            }`}
          >
            {column.weddings.length}
          </span>
        </div>

        {/* Cards */}
        {/* TODO: Add drag-and-drop (DnD) for card reordering between columns */}
        <div className="space-y-2">
          {column.weddings.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-xs text-sage-400">No leads</p>
            </div>
          ) : (
            column.weddings.map((wedding) => (
              <PipelineCard key={wedding.id} wedding={wedding} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function PipelinePage() {
  const [columns, setColumns] = useState<PipelineColumn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [totalLeads, setTotalLeads] = useState(0)

  const supabase = createClient()

  // ---- Fetch pipeline data ----
  const fetchPipeline = useCallback(async () => {
    try {
      // Fetch all non-completed/cancelled weddings with people
      const { data: weddingsData, error: fetchError } = await supabase
        .from('weddings')
        .select(`
          id,
          venue_id,
          status,
          source,
          wedding_date,
          guest_count_estimate,
          heat_score,
          temperature_tier,
          inquiry_date,
          updated_at,
          people!people_wedding_id_fkey ( role, first_name, last_name )
        `)
        .eq('venue_id', VENUE_ID)
        .in('status', [
          'inquiry',
          'tour_scheduled',
          'tour_completed',
          'proposal_sent',
          'booked',
          'lost',
        ])
        .order('heat_score', { ascending: false })

      if (fetchError) throw fetchError

      // Map weddings with partner names
      const weddings: PipelineWedding[] = (weddingsData ?? []).map(
        (row: any) => {
          const people = row.people ?? []
          const p1 = people.find(
            (p: any) => p.role === 'partner1'
          )
          const p2 = people.find(
            (p: any) => p.role === 'partner2'
          )

          return {
            id: row.id,
            venue_id: row.venue_id,
            status: row.status,
            source: row.source,
            wedding_date: row.wedding_date,
            guest_count_estimate: row.guest_count_estimate,
            heat_score: row.heat_score ?? 0,
            temperature_tier: row.temperature_tier ?? 'cool',
            inquiry_date: row.inquiry_date,
            updated_at: row.updated_at,
            partner1_name: p1
              ? [p1.first_name, p1.last_name].filter(Boolean).join(' ')
              : null,
            partner2_name: p2
              ? [p2.first_name, p2.last_name].filter(Boolean).join(' ')
              : null,
          }
        }
      )

      // Group by status into columns
      const grouped = PIPELINE_STAGES.map((stage) => ({
        key: stage.key,
        label: stage.label,
        weddings: weddings.filter((w) => w.status === stage.key),
      }))

      setColumns(grouped)
      setTotalLeads(weddings.length)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch pipeline:', err)
      setError('Failed to load pipeline')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPipeline()
  }, [fetchPipeline])

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Pipeline
          </h1>
          <p className="text-sage-600">
            {totalLeads} active lead{totalLeads !== 1 ? 's' : ''} across all
            stages
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true)
            fetchPipeline()
          }}
          className="flex items-center gap-2 px-4 py-2.5 text-sage-700 border border-sage-300 text-sm font-medium rounded-lg hover:bg-sage-50 transition-colors shrink-0"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
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
              setLoading(true)
              fetchPipeline()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Kanban Board ---- */}
      {loading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {PIPELINE_STAGES.map((stage) => (
            <ColumnSkeleton key={stage.key} />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 -mx-6 lg:-mx-8 px-6 lg:px-8">
          {columns.map((column) => (
            <PipelineColumnView key={column.key} column={column} />
          ))}
        </div>
      )}

      {/* ---- Summary row ---- */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {columns.map((col) => (
            <div
              key={col.key}
              className="bg-surface border border-border rounded-xl p-4 shadow-sm text-center"
            >
              <p className="text-2xl font-bold text-sage-900">
                {col.weddings.length}
              </p>
              <p className="text-xs text-sage-500 mt-0.5">{col.label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
