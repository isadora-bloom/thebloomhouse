'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Hash,
  Search,
  Copy,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  ArrowRight,
  Users,
  Calendar,
  Flame,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClientCode {
  id: string
  venue_id: string
  wedding_id: string
  code: string
  format: string | null
  created_at: string
  // Joined
  partner1_name?: string
  partner2_name?: string
  wedding_date?: string | null
  wedding_status?: string
  heat_score?: number
}

interface WeddingLookup {
  id: string
  partner1_name: string | null
  partner2_name: string | null
  wedding_date: string | null
  status: string
  heat_score: number
  guest_count_estimate: number | null
  source: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coupleName(p1: string | null | undefined, p2: string | null | undefined): string {
  if (p1 && p2) return `${p1} & ${p2}`
  return p1 || p2 || 'Unknown'
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '---'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function statusBadge(status: string) {
  switch (status) {
    case 'inquiry':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Inquiry' }
    case 'tour_scheduled':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Tour Scheduled' }
    case 'tour_completed':
      return { bg: 'bg-indigo-50', text: 'text-indigo-700', label: 'Tour Completed' }
    case 'proposal_sent':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Proposal Sent' }
    case 'booked':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Booked' }
    case 'completed':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Completed' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: status }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="divide-y divide-border">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="p-4">
            <div className="animate-pulse flex items-center gap-4">
              <div className="h-4 w-28 bg-sage-100 rounded" />
              <div className="h-4 w-40 bg-sage-100 rounded" />
              <div className="h-4 w-24 bg-sage-50 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Code Lookup Result
// ---------------------------------------------------------------------------

function LookupResult({ wedding, onClear }: { wedding: WeddingLookup; onClear: () => void }) {
  const status = statusBadge(wedding.status)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-heading text-base font-semibold text-sage-900">
          Wedding Details
        </h3>
        <button
          onClick={onClear}
          className="text-sm text-sage-500 hover:text-sage-700 transition-colors"
        >
          Clear
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-sage-500 mb-1">Couple</p>
          <p className="text-sm font-medium text-sage-900 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-sage-400" />
            {coupleName(wedding.partner1_name, wedding.partner2_name)}
          </p>
        </div>
        <div>
          <p className="text-xs text-sage-500 mb-1">Wedding Date</p>
          <p className="text-sm font-medium text-sage-900 flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-sage-400" />
            {formatDate(wedding.wedding_date)}
          </p>
        </div>
        <div>
          <p className="text-xs text-sage-500 mb-1">Status</p>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${status.bg} ${status.text}`}
          >
            {status.label}
          </span>
        </div>
        <div>
          <p className="text-xs text-sage-500 mb-1">Heat Score</p>
          <p className="text-sm font-medium text-sage-900 flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-amber-500" />
            {wedding.heat_score}
          </p>
        </div>
        {wedding.guest_count_estimate && (
          <div>
            <p className="text-xs text-sage-500 mb-1">Guest Count</p>
            <p className="text-sm font-medium text-sage-900">
              ~{wedding.guest_count_estimate}
            </p>
          </div>
        )}
        {wedding.source && (
          <div>
            <p className="text-xs text-sage-500 mb-1">Source</p>
            <p className="text-sm font-medium text-sage-900 capitalize">
              {wedding.source.replace(/_/g, ' ')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ClientCodesPage() {
  const VENUE_ID = useVenueId()
  const [codes, setCodes] = useState<ClientCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [lookupCode, setLookupCode] = useState('')
  const [lookupResult, setLookupResult] = useState<WeddingLookup | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const supabase = createClient()

  // ---- Fetch codes ----
  const fetchCodes = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('client_codes')
        .select(`
          id,
          venue_id,
          wedding_id,
          code,
          format,
          created_at,
          weddings!client_codes_wedding_id_fkey (
            wedding_date,
            status,
            heat_score,
            people!people_wedding_id_fkey ( role, first_name, last_name )
          )
        `)
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (fetchError) throw fetchError

      const mapped: ClientCode[] = (data ?? []).map((row: any) => {
        const wedding = row.weddings
        const people = wedding?.people ?? []
        const p1 = people.find((p: any) => p.role === 'partner1')
        const p2 = people.find((p: any) => p.role === 'partner2')

        return {
          id: row.id,
          venue_id: row.venue_id,
          wedding_id: row.wedding_id,
          code: row.code,
          format: row.format,
          created_at: row.created_at,
          partner1_name: p1
            ? [p1.first_name, p1.last_name].filter(Boolean).join(' ')
            : undefined,
          partner2_name: p2
            ? [p2.first_name, p2.last_name].filter(Boolean).join(' ')
            : undefined,
          wedding_date: wedding?.wedding_date,
          wedding_status: wedding?.status,
          heat_score: wedding?.heat_score,
        }
      })

      setCodes(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch client codes:', err)
      setError('Failed to load client codes')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCodes()
  }, [fetchCodes])

  // ---- Copy to clipboard ----
  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // ---- Code lookup ----
  const handleLookup = async () => {
    if (!lookupCode.trim()) return
    setLookupLoading(true)
    setLookupResult(null)

    try {
      const { data: codeData } = await supabase
        .from('client_codes')
        .select('wedding_id')
        .eq('venue_id', VENUE_ID)
        .eq('code', lookupCode.trim().toUpperCase())
        .maybeSingle()

      if (!codeData) {
        setError('Code not found')
        setLookupLoading(false)
        return
      }

      const { data: weddingData } = await supabase
        .from('weddings')
        .select(`
          id,
          wedding_date,
          status,
          heat_score,
          guest_count_estimate,
          source,
          people!people_wedding_id_fkey ( role, first_name, last_name )
        `)
        .eq('id', codeData.wedding_id)
        .single()

      if (weddingData) {
        const people = (weddingData as any).people ?? []
        const p1 = people.find((p: any) => p.role === 'partner1')
        const p2 = people.find((p: any) => p.role === 'partner2')

        setLookupResult({
          id: weddingData.id,
          partner1_name: p1
            ? [p1.first_name, p1.last_name].filter(Boolean).join(' ')
            : null,
          partner2_name: p2
            ? [p2.first_name, p2.last_name].filter(Boolean).join(' ')
            : null,
          wedding_date: weddingData.wedding_date,
          status: weddingData.status,
          heat_score: weddingData.heat_score ?? 0,
          guest_count_estimate: weddingData.guest_count_estimate,
          source: weddingData.source,
        })
        setError(null)
      }
    } catch (err) {
      console.error('Lookup failed:', err)
      setError('Lookup failed')
    } finally {
      setLookupLoading(false)
    }
  }

  // ---- Auto-generate codes for weddings without one ----
  const handleGenerate = async () => {
    setGenerating(true)
    try {
      // Get all weddings for this venue
      const { data: weddings } = await supabase
        .from('weddings')
        .select(`
          id,
          wedding_date,
          people!people_wedding_id_fkey ( role, last_name )
        `)
        .eq('venue_id', VENUE_ID)

      if (!weddings) {
        setGenerating(false)
        return
      }

      // Get existing codes
      const existingWeddingIds = new Set(codes.map((c) => c.wedding_id))

      // Generate codes for weddings without one
      const newCodes: { venue_id: string; wedding_id: string; code: string; format: string }[] = []

      for (const w of weddings) {
        if (existingWeddingIds.has(w.id)) continue
        const people = (w as any).people ?? []
        const p1 = people.find((p: any) => p.role === 'partner1')
        const lastName = (p1?.last_name || 'UNK').toUpperCase().slice(0, 4)
        const year = w.wedding_date
          ? new Date(w.wedding_date).getFullYear()
          : new Date().getFullYear()
        const code = `RM-${year}-${lastName}`

        newCodes.push({
          venue_id: VENUE_ID,
          wedding_id: w.id,
          code,
          format: 'RM-YYYY-NAME',
        })
      }

      if (newCodes.length > 0) {
        await supabase.from('client_codes').insert(newCodes)
        await fetchCodes()
      }
    } catch (err) {
      console.error('Failed to generate codes:', err)
      setError('Failed to generate codes')
    } finally {
      setGenerating(false)
    }
  }

  // ---- Filtering ----
  const filteredCodes = useMemo(() => {
    if (!searchQuery.trim()) return codes
    const q = searchQuery.toLowerCase()
    return codes.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        coupleName(c.partner1_name, c.partner2_name).toLowerCase().includes(q)
    )
  }, [codes, searchQuery])

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Client Codes
          </h1>
          <p className="text-sage-600">
            Every wedding gets a short reference code for quick lookups during calls or in-person conversations. Click any code to copy it, or use the search to find a specific couple.
          </p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} />
          {generating ? 'Generating...' : 'Auto-Generate'}
        </button>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---- Code Lookup ---- */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
        <h2 className="font-heading text-base font-semibold text-sage-900 mb-3">
          Quick Lookup
        </h2>
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
            <input
              type="text"
              placeholder="Enter code (e.g., RM-2026-CHEN)"
              value={lookupCode}
              onChange={(e) => setLookupCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
              className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full bg-warm-white uppercase"
            />
          </div>
          <button
            onClick={handleLookup}
            disabled={lookupLoading || !lookupCode.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-sage-100 hover:bg-sage-200 text-sage-700 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowRight className="w-4 h-4" />
            {lookupLoading ? 'Looking up...' : 'Lookup'}
          </button>
        </div>
      </div>

      {/* ---- Lookup Result ---- */}
      {lookupResult && (
        <LookupResult wedding={lookupResult} onClear={() => setLookupResult(null)} />
      )}

      {/* ---- Search ---- */}
      <div className="flex items-center">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search codes or couples..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-72 bg-warm-white"
          />
        </div>
        <span className="ml-4 text-sm text-sage-500">
          {filteredCodes.length} code{filteredCodes.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ---- Codes Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : filteredCodes.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Hash className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery ? 'No matching codes' : 'No client codes yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No codes match "${searchQuery}".`
              : 'Click "Auto-Generate" to create codes for all existing weddings.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Code
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Couple
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Wedding Date
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Status
                    </span>
                  </th>
                  <th className="text-right px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Copy
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCodes.map((cc) => {
                  const status = cc.wedding_status ? statusBadge(cc.wedding_status) : null
                  return (
                    <tr
                      key={cc.id}
                      className="hover:bg-sage-50/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="text-sm font-mono font-bold text-sage-900">
                          {cc.code}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-sage-900">
                          {coupleName(cc.partner1_name, cc.partner2_name)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {formatDate(cc.wedding_date)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {status && (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${status.bg} ${status.text}`}
                          >
                            {status.label}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleCopy(cc.code, cc.id)}
                          className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                          title="Copy code"
                        >
                          {copiedId === cc.id ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
