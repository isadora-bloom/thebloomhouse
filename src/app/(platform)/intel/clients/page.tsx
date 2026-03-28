'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Users,
  Search,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Calendar,
  Mail,
  Phone,
  ArrowRight,
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

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  event_date: string | null
  source: string | null
  created_at: string
}

interface PersonRow {
  id: string
  wedding_id: string
  first_name: string
  last_name: string
  role: string
}

interface ContactRow {
  id: string
  person_id: string
  type: string
  value: string
}

interface ClientData {
  weddingId: string
  name: string
  email: string
  phone: string
  status: string
  source: string
  eventDate: string | null
  revenue: number
  coordinator: string
  created_at: string
  notes: string[]
}

type StatusTab = 'all' | 'inquiry' | 'toured' | 'held' | 'contracted' | 'completed' | 'lost'

const STATUS_FLOW: StatusTab[] = ['all', 'inquiry', 'toured', 'held', 'contracted', 'completed', 'lost']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function statusBadge(status: string): string {
  const m: Record<string, string> = {
    inquiry: 'bg-blue-50 text-blue-700 border-blue-200',
    toured: 'bg-teal-50 text-teal-700 border-teal-200',
    held: 'bg-amber-50 text-amber-700 border-amber-200',
    contracted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    completed: 'bg-sage-100 text-sage-700 border-sage-200',
    lost: 'bg-red-50 text-red-700 border-red-200',
  }
  return m[status] ?? 'bg-sage-50 text-sage-700 border-sage-200'
}

function formatLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ClientRowSkeleton() {
  return (
    <div className="px-6 py-4 animate-pulse flex items-center gap-4">
      <div className="h-5 w-32 bg-sage-100 rounded" />
      <div className="h-5 w-40 bg-sage-50 rounded" />
      <div className="h-5 w-20 bg-sage-50 rounded" />
      <div className="h-5 w-16 bg-sage-50 rounded" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function ClientsPage() {
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [people, setPeople] = useState<PersonRow[]>([])
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusTab, setStatusTab] = useState<StatusTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [weddingRes, personRes, contactRes] = await Promise.all([
        supabase.from('weddings').select('id, venue_id, status, booking_value, event_date, source, created_at').order('created_at', { ascending: false }),
        supabase.from('people').select('id, wedding_id, first_name, last_name, role'),
        supabase.from('contacts').select('id, person_id, type, value'),
      ])
      if (weddingRes.error) throw weddingRes.error
      if (personRes.error) throw personRes.error
      if (contactRes.error) throw contactRes.error
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setPeople((personRes.data ?? []) as PersonRow[])
      setContacts((contactRes.data ?? []) as ContactRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch client data:', err)
      setError('Failed to load client data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Build client list from weddings + people + contacts
  const clients: ClientData[] = useMemo(() => {
    return weddings.map((w) => {
      const wPeople = people.filter((p) => p.wedding_id === w.id)
      const primaryPerson = wPeople.find((p) => p.role === 'primary') ?? wPeople[0]
      const name = primaryPerson
        ? `${primaryPerson.first_name} ${primaryPerson.last_name}`
        : 'Unknown'

      let email = ''
      let phone = ''
      if (primaryPerson) {
        const pContacts = contacts.filter((c) => c.person_id === primaryPerson.id)
        email = pContacts.find((c) => c.type === 'email')?.value ?? ''
        phone = pContacts.find((c) => c.type === 'phone')?.value ?? ''
      }

      return {
        weddingId: w.id,
        name,
        email,
        phone,
        status: w.status,
        source: w.source ?? 'Unknown',
        eventDate: w.event_date,
        revenue: w.booking_value ?? 0,
        coordinator: '--',
        created_at: w.created_at,
        notes: [],
      }
    })
  }, [weddings, people, contacts])

  // Filter
  const filtered = useMemo(() => {
    let list = clients
    if (statusTab !== 'all') {
      list = list.filter((c) => c.status === statusTab)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.includes(q)
      )
    }
    return list
  }, [clients, statusTab, searchQuery])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Client Lifecycle
        </h1>
        <p className="text-sage-600">
          Manage clients from inquiry through completion.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Users className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Status tabs + search */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 overflow-x-auto">
          {STATUS_FLOW.map((s) => (
            <button
              key={s}
              onClick={() => setStatusTab(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                statusTab === s
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {s === 'all' ? 'All' : formatLabel(s)}
              {s !== 'all' && (
                <span className="ml-1 text-sage-400">
                  ({clients.filter((c) => c.status === s).length})
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, email, phone..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-sage-900 placeholder:text-sage-400"
          />
        </div>
      </div>

      {/* Client list */}
      {loading ? (
        <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <ClientRowSkeleton key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Users className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No clients found
          </h3>
          <p className="text-sm text-sage-600">
            {searchQuery
              ? 'Try adjusting your search query.'
              : 'Clients will appear here once inquiries are tracked.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Client</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Status</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Source</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Event Date</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-sage-600">Revenue</th>
                  <th className="px-5 py-3 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => {
                  const isExpanded = expandedId === c.weddingId
                  return (
                    <tr key={c.weddingId} className="group">
                      <td colSpan={6} className="p-0">
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : c.weddingId)}
                          className="w-full text-left hover:bg-sage-50/50 transition-colors"
                        >
                          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center px-5 py-4 gap-4">
                            <div>
                              <p className="font-medium text-sage-900">{c.name}</p>
                              {c.email && <p className="text-xs text-sage-500">{c.email}</p>}
                            </div>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge(c.status)}`}>
                              {formatLabel(c.status)}
                            </span>
                            <span className="text-sage-600 text-xs">{formatLabel(c.source)}</span>
                            <span className="text-sage-600 text-xs">
                              {c.eventDate ? new Date(c.eventDate).toLocaleDateString() : '--'}
                            </span>
                            <span className="text-sage-700 font-medium tabular-nums text-right">
                              {c.revenue > 0 ? fmt$(c.revenue) : '--'}
                            </span>
                            <span>
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4 text-sage-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-sage-400" />
                              )}
                            </span>
                          </div>
                        </button>

                        {/* Expanded detail */}
                        {isExpanded && (
                          <div className="px-5 pb-5 border-t border-sage-100 bg-warm-white">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Contact</p>
                                <div className="space-y-1 text-sm text-sage-700">
                                  {c.email && (
                                    <p className="flex items-center gap-2"><Mail className="w-3 h-3 text-sage-400" /> {c.email}</p>
                                  )}
                                  {c.phone && (
                                    <p className="flex items-center gap-2"><Phone className="w-3 h-3 text-sage-400" /> {c.phone}</p>
                                  )}
                                </div>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Details</p>
                                <div className="space-y-1 text-sm text-sage-700">
                                  <p className="flex items-center gap-2"><Calendar className="w-3 h-3 text-sage-400" /> Event: {c.eventDate ? new Date(c.eventDate).toLocaleDateString() : 'TBD'}</p>
                                  <p className="flex items-center gap-2"><DollarSign className="w-3 h-3 text-sage-400" /> Value: {c.revenue > 0 ? fmt$(c.revenue) : 'TBD'}</p>
                                  <p>Coordinator: {c.coordinator}</p>
                                </div>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Timeline</p>
                                <div className="space-y-1 text-sm text-sage-700">
                                  <p>Created: {new Date(c.created_at).toLocaleDateString()}</p>
                                  <p>Status: {formatLabel(c.status)}</p>
                                </div>
                                {c.status === 'inquiry' && (
                                  <button className="mt-3 flex items-center gap-1 text-xs font-medium text-sage-600 hover:text-sage-800 transition-colors">
                                    <ArrowRight className="w-3 h-3" /> Convert to Client
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
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
