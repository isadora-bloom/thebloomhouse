'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Network,
  Plus,
  Search,
  Users,
  Heart,
  Briefcase,
  UserPlus,
  AlertTriangle,
  X,
  Filter,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Relationship {
  id: string
  venue_id: string
  person_a_id: string
  person_b_id: string
  type: 'partner' | 'parent' | 'sibling' | 'friend' | 'vendor' | 'planner'
  notes: string | null
  created_at: string
  // Joined
  person_a_name?: string
  person_a_email?: string
  person_b_name?: string
  person_b_email?: string
}

interface Person {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

type TypeFilter = 'all' | 'partner' | 'parent' | 'sibling' | 'friend' | 'vendor' | 'planner'

const RELATIONSHIP_TYPES: { value: TypeFilter; label: string; icon: string }[] = [
  { value: 'all', label: 'All', icon: '' },
  { value: 'partner', label: 'Partner', icon: '' },
  { value: 'parent', label: 'Parent', icon: '' },
  { value: 'sibling', label: 'Sibling', icon: '' },
  { value: 'friend', label: 'Friend', icon: '' },
  { value: 'vendor', label: 'Vendor', icon: '' },
  { value: 'planner', label: 'Planner', icon: '' },
]

function typeBadge(type: string): { bg: string; text: string; label: string } {
  switch (type) {
    case 'partner':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'Partner' }
    case 'parent':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Parent' }
    case 'sibling':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Sibling' }
    case 'friend':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Friend' }
    case 'vendor':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Vendor' }
    case 'planner':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Planner' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: type }
  }
}

function personName(p: Person): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unknown'
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

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
              <div className="h-4 w-32 bg-sage-100 rounded" />
              <div className="h-4 w-8 bg-sage-50 rounded" />
              <div className="h-4 w-32 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
              <div className="h-4 w-48 bg-sage-50 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Relationship Modal
// ---------------------------------------------------------------------------

function AddRelationshipModal({
  people,
  onClose,
  onSave,
}: {
  people: Person[]
  onClose: () => void
  onSave: (personAId: string, personBId: string, type: string, notes: string) => Promise<void>
}) {
  const [searchA, setSearchA] = useState('')
  const [searchB, setSearchB] = useState('')
  const [personAId, setPersonAId] = useState('')
  const [personBId, setPersonBId] = useState('')
  const [relType, setRelType] = useState('friend')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [showDropdownA, setShowDropdownA] = useState(false)
  const [showDropdownB, setShowDropdownB] = useState(false)

  const filteredPeopleA = searchA.trim()
    ? people.filter(
        (p) =>
          personName(p).toLowerCase().includes(searchA.toLowerCase()) ||
          (p.email?.toLowerCase().includes(searchA.toLowerCase()) ?? false)
      ).slice(0, 8)
    : []

  const filteredPeopleB = searchB.trim()
    ? people.filter(
        (p) =>
          p.id !== personAId &&
          (personName(p).toLowerCase().includes(searchB.toLowerCase()) ||
            (p.email?.toLowerCase().includes(searchB.toLowerCase()) ?? false))
      ).slice(0, 8)
    : []

  const selectPersonA = (p: Person) => {
    setPersonAId(p.id)
    setSearchA(personName(p))
    setShowDropdownA(false)
  }

  const selectPersonB = (p: Person) => {
    setPersonBId(p.id)
    setSearchB(personName(p))
    setShowDropdownB(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!personAId || !personBId) return
    setSaving(true)
    await onSave(personAId, personBId, relType, notes)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Add Relationship
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Person A */}
          <div className="relative">
            <label className="block text-sm font-medium text-sage-700 mb-1">Person A</label>
            <input
              type="text"
              value={searchA}
              onChange={(e) => {
                setSearchA(e.target.value)
                setPersonAId('')
                setShowDropdownA(true)
              }}
              onFocus={() => setShowDropdownA(true)}
              className={inputClasses}
              placeholder="Search by name or email..."
            />
            {showDropdownA && filteredPeopleA.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredPeopleA.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectPersonA(p)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-sage-50 transition-colors"
                  >
                    <span className="font-medium text-sage-900">{personName(p)}</span>
                    {p.email && (
                      <span className="text-sage-500 ml-2">{p.email}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Person B */}
          <div className="relative">
            <label className="block text-sm font-medium text-sage-700 mb-1">Person B</label>
            <input
              type="text"
              value={searchB}
              onChange={(e) => {
                setSearchB(e.target.value)
                setPersonBId('')
                setShowDropdownB(true)
              }}
              onFocus={() => setShowDropdownB(true)}
              className={inputClasses}
              placeholder="Search by name or email..."
            />
            {showDropdownB && filteredPeopleB.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredPeopleB.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectPersonB(p)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-sage-50 transition-colors"
                  >
                    <span className="font-medium text-sage-900">{personName(p)}</span>
                    {p.email && (
                      <span className="text-sage-500 ml-2">{p.email}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Relationship Type */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Relationship Type
            </label>
            <select
              value={relType}
              onChange={(e) => setRelType(e.target.value)}
              className={inputClasses}
            >
              {RELATIONSHIP_TYPES.filter((t) => t.value !== 'all').map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={inputClasses}
              placeholder="Optional notes about this relationship..."
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !personAId || !personBId}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <UserPlus className="w-4 h-4" />
              {saving ? 'Saving...' : 'Add Relationship'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function RelationshipsPage() {
  const VENUE_ID = useVenueId()
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)

  const supabase = createClient()

  // ---- Fetch relationships ----
  const fetchRelationships = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('relationships')
        .select(`
          id,
          venue_id,
          person_a_id,
          person_b_id,
          type,
          notes,
          created_at,
          person_a:people!relationships_person_a_id_fkey ( first_name, last_name, email ),
          person_b:people!relationships_person_b_id_fkey ( first_name, last_name, email )
        `)
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (fetchError) throw fetchError

      const mapped: Relationship[] = (data ?? []).map((row: any) => {
        const a = row.person_a
        const b = row.person_b
        return {
          id: row.id,
          venue_id: row.venue_id,
          person_a_id: row.person_a_id,
          person_b_id: row.person_b_id,
          type: row.type,
          notes: row.notes,
          created_at: row.created_at,
          person_a_name: a
            ? [a.first_name, a.last_name].filter(Boolean).join(' ') || undefined
            : undefined,
          person_a_email: a?.email || undefined,
          person_b_name: b
            ? [b.first_name, b.last_name].filter(Boolean).join(' ') || undefined
            : undefined,
          person_b_email: b?.email || undefined,
        }
      })

      setRelationships(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch relationships:', err)
      setError('Failed to load relationships')
    }
  }, [])

  // ---- Fetch people for modal ----
  const fetchPeople = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('people')
        .select('id, first_name, last_name, email')
        .eq('venue_id', VENUE_ID)
        .order('first_name', { ascending: true })
        .limit(500)

      setPeople(data ?? [])
    } catch (err) {
      console.error('Failed to fetch people:', err)
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchRelationships(), fetchPeople()]).then(() => setLoading(false))
  }, [fetchRelationships, fetchPeople])

  // ---- Add relationship ----
  const handleAddRelationship = async (
    personAId: string,
    personBId: string,
    type: string,
    notes: string
  ) => {
    try {
      const { error: insertError } = await supabase.from('relationships').insert({
        venue_id: VENUE_ID,
        person_a_id: personAId,
        person_b_id: personBId,
        type,
        notes: notes || null,
      })

      if (insertError) throw insertError
      setShowAddModal(false)
      await fetchRelationships()
    } catch (err) {
      console.error('Failed to add relationship:', err)
    }
  }

  // ---- Filtering ----
  const filteredRelationships = useMemo(() => {
    let result = [...relationships]

    if (typeFilter !== 'all') {
      result = result.filter((r) => r.type === typeFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (r) =>
          (r.person_a_name?.toLowerCase().includes(q) ?? false) ||
          (r.person_a_email?.toLowerCase().includes(q) ?? false) ||
          (r.person_b_name?.toLowerCase().includes(q) ?? false) ||
          (r.person_b_email?.toLowerCase().includes(q) ?? false) ||
          (r.notes?.toLowerCase().includes(q) ?? false)
      )
    }

    return result
  }, [relationships, typeFilter, searchQuery])

  // ---- Stats ----
  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of relationships) {
      c[r.type] = (c[r.type] || 0) + 1
    }
    return c
  }, [relationships])

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Relationships
          </h1>
          <p className="text-sage-600">
            Map the connections between your couples, their families, vendors, and referral sources. Spot referral patterns and understand how your clients are connected to each other.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Relationship
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
              Promise.all([fetchRelationships(), fetchPeople()]).then(() => setLoading(false))
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Stats ---- */}
      {!loading && relationships.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <Network className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{relationships.length}</p>
                <p className="text-xs text-sage-500">Total</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-rose-50 flex items-center justify-center">
                <Heart className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{typeCounts.partner ?? 0}</p>
                <p className="text-xs text-sage-500">Partners</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center">
                <Briefcase className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{typeCounts.vendor ?? 0}</p>
                <p className="text-xs text-sage-500">Vendors</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center">
                <Users className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{typeCounts.parent ?? 0}</p>
                <p className="text-xs text-sage-500">Parents</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 flex-wrap">
          {RELATIONSHIP_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setTypeFilter(t.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                typeFilter === t.value
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {t.label}
              {t.value !== 'all' && typeCounts[t.value] !== undefined && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    typeFilter === t.value
                      ? 'bg-sage-100 text-sage-700'
                      : 'bg-sage-100/50 text-sage-500'
                  }`}
                >
                  {typeCounts[t.value]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search people..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : filteredRelationships.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Network className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery
              ? 'No matching relationships'
              : typeFilter !== 'all'
                ? `No ${typeFilter} relationships`
                : 'No relationships tracked yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No relationships match "${searchQuery}".`
              : 'Track connections between people to identify referral networks and family ties across weddings.'}
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
                      Person A
                    </span>
                  </th>
                  <th className="text-center px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Relationship
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Person B
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Notes
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Added
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredRelationships.map((rel) => {
                  const badge = typeBadge(rel.type)
                  return (
                    <tr
                      key={rel.id}
                      className="hover:bg-sage-50/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-sage-900">
                            {rel.person_a_name || 'Unknown'}
                          </p>
                          {rel.person_a_email && (
                            <p className="text-xs text-sage-500">{rel.person_a_email}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-sage-900">
                            {rel.person_b_name || 'Unknown'}
                          </p>
                          {rel.person_b_email && (
                            <p className="text-xs text-sage-500">{rel.person_b_email}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="text-sm text-sage-600 truncate">
                          {rel.notes || '---'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {new Date(rel.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Add Modal ---- */}
      {showAddModal && (
        <AddRelationshipModal
          people={people}
          onClose={() => setShowAddModal(false)}
          onSave={handleAddRelationship}
        />
      )}
    </div>
  )
}
