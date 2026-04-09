'use client'

// Feature: configurable via venue_config.feature_flags
// Tables: seating_tables, guest_list

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Plus,
  X,
  Users,
  Search,
  Circle,
  RectangleHorizontal,
  Crown,
  Heart,
  Image,
  UserPlus,
  UserMinus,
  ChevronDown,
  ChevronUp,
  Edit2,
  Trash2,
  Check,
  AlertTriangle,
  BarChart3,
  Table2,
  Tag,
} from 'lucide-react'
import { TagChip, type TagChipData } from '@/components/couple/tag-chip'
import { TagPicker } from '@/components/couple/tag-picker'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TableType = 'round' | 'rectangular' | 'head' | 'sweetheart' | 'farm' | 'cocktail'

interface SeatingTable {
  id: string
  table_name: string
  table_type: TableType
  capacity: number
  sort_order: number
}

interface Guest {
  id: string
  table_assignment: string | null
  rsvp_status: string | null
  plus_one_name: string | null
  group_name: string | null
  first_name: string | null
  last_name: string | null
}

interface GuestTagRow {
  id: string
  tag_name: string
  color: string
}

interface TableFormData {
  table_name: string
  table_type: TableType
  capacity: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE_TYPE_OPTIONS: { value: TableType; label: string; icon: React.ElementType; defaultCapacity: number }[] = [
  { value: 'round', label: 'Round', icon: Circle, defaultCapacity: 8 },
  { value: 'rectangular', label: 'Rectangular', icon: RectangleHorizontal, defaultCapacity: 8 },
  { value: 'head', label: 'Head Table', icon: Crown, defaultCapacity: 10 },
  { value: 'sweetheart', label: 'Sweetheart', icon: Heart, defaultCapacity: 2 },
  { value: 'farm', label: 'Farm Table', icon: RectangleHorizontal, defaultCapacity: 10 },
  { value: 'cocktail', label: 'Cocktail', icon: Table2, defaultCapacity: 4 },
]

const EMPTY_FORM: TableFormData = {
  table_name: '',
  table_type: 'round',
  capacity: 8,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guestName(guest: Guest): string {
  const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ')
  return name || 'Unnamed'
}

function typeLabel(t: TableType): string {
  return TABLE_TYPE_OPTIONS.find((o) => o.value === t)?.label || t
}

function typeIcon(t: TableType): React.ElementType {
  return TABLE_TYPE_OPTIONS.find((o) => o.value === t)?.icon || Circle
}

// ---------------------------------------------------------------------------
// Seating Chart Page
// ---------------------------------------------------------------------------

export default function SeatingChartPage() {
  // Data
  const [tables, setTables] = useState<SeatingTable[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [floorPlanUrl, setFloorPlanUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Tag data
  const [allTags, setAllTags] = useState<TagChipData[]>([])
  // guest_id -> tag_id[]
  const [guestTagMap, setGuestTagMap] = useState<Record<string, string[]>>({})
  // Multi-select tag filter applied to the unassigned list
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [showTagFilterMenu, setShowTagFilterMenu] = useState(false)

  // Table CRUD modal
  const [showTableModal, setShowTableModal] = useState(false)
  const [editingTableId, setEditingTableId] = useState<string | null>(null)
  const [tableForm, setTableForm] = useState<TableFormData>(EMPTY_FORM)

  // Guest assignment modal
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [assigningTable, setAssigningTable] = useState<SeatingTable | null>(null)
  const [assignSearch, setAssignSearch] = useState('')

  // Expanded tables
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())

  // Floor plan expanded
  const [floorPlanExpanded, setFloorPlanExpanded] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [tablesRes, guestsRes, configRes, tagsRes] = await Promise.all([
      supabase
        .from('seating_tables')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .order('sort_order', { ascending: true }),
      supabase
        .from('guest_list')
        .select('id, table_assignment, rsvp_status, plus_one_name, group_name, first_name, last_name')
        .eq('wedding_id', WEDDING_ID)
        .order('created_at', { ascending: true }),
      supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
      supabase
        .from('guest_tags')
        .select('id, tag_name, color')
        .eq('wedding_id', WEDDING_ID)
        .order('created_at', { ascending: true }),
    ])

    if (tablesRes.data) setTables(tablesRes.data as unknown as SeatingTable[])
    if (guestsRes.data) setGuests(guestsRes.data as unknown as Guest[])
    if (configRes.data) {
      const flags = (configRes.data.feature_flags ?? {}) as Record<string, unknown>
      if (flags.floor_plan_url) {
        setFloorPlanUrl(flags.floor_plan_url as string)
      }
    }

    // Tags
    if (tagsRes.data) {
      setAllTags(
        (tagsRes.data as GuestTagRow[]).map((t) => ({
          id: t.id,
          name: t.tag_name,
          color: t.color || '#7D8471',
        })),
      )
    }

    // Tag assignments — limited to this wedding's guests
    const guestIds = ((guestsRes.data as { id: string }[] | null) || []).map((g) => g.id)
    if (guestIds.length > 0) {
      const { data: assignmentData } = await supabase
        .from('guest_tag_assignments')
        .select('guest_id, tag_id')
        .in('guest_id', guestIds)
      const map: Record<string, string[]> = {}
      if (assignmentData) {
        for (const row of assignmentData as { guest_id: string; tag_id: string }[]) {
          if (!map[row.guest_id]) map[row.guest_id] = []
          map[row.guest_id].push(row.tag_id)
        }
      }
      setGuestTagMap(map)
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Derived data ----
  const guestsByTable = useMemo(() => {
    const map: Record<string, Guest[]> = {}
    for (const g of guests) {
      if (g.table_assignment) {
        if (!map[g.table_assignment]) map[g.table_assignment] = []
        map[g.table_assignment].push(g)
      }
    }
    return map
  }, [guests])

  const unassignedGuests = useMemo(() => {
    return guests.filter((g) => !g.table_assignment)
  }, [guests])

  // Tag-filtered version of unassigned list (applied in both the side panel
  // and the assignment modal so the filters stay in sync).
  const tagFilteredUnassigned = useMemo(() => {
    if (filterTagIds.size === 0) return unassignedGuests
    return unassignedGuests.filter((g) => {
      const guestTags = guestTagMap[g.id] || []
      return guestTags.some((tid) => filterTagIds.has(tid))
    })
  }, [unassignedGuests, filterTagIds, guestTagMap])

  const totalGuests = guests.length
  const assignedCount = totalGuests - unassignedGuests.length
  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0)
  const tablesFullCount = tables.filter((t) => {
    const assigned = (guestsByTable[t.table_name] || []).length
    return assigned >= t.capacity
  }).length
  const tablesWithSpaceCount = tables.length - tablesFullCount

  // Filtered unassigned guests for assignment modal — applies both the
  // tag filter (from the side panel) and the modal's own search.
  const filteredUnassigned = useMemo(() => {
    const base = tagFilteredUnassigned
    if (!assignSearch.trim()) return base
    const q = assignSearch.toLowerCase()
    return base.filter((g) => guestName(g).toLowerCase().includes(q))
  }, [tagFilteredUnassigned, assignSearch])

  // ---- Table CRUD ----
  function openAddTable() {
    setTableForm(EMPTY_FORM)
    setEditingTableId(null)
    setShowTableModal(true)
  }

  function openEditTable(table: SeatingTable) {
    setTableForm({
      table_name: table.table_name,
      table_type: table.table_type,
      capacity: table.capacity,
    })
    setEditingTableId(table.id)
    setShowTableModal(true)
  }

  async function handleSaveTable() {
    if (!tableForm.table_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      table_name: tableForm.table_name.trim(),
      table_type: tableForm.table_type,
      capacity: tableForm.capacity,
    }

    if (editingTableId) {
      const { error } = await supabase.from('seating_tables').update(payload).eq('id', editingTableId)
      if (error) {
        alert(`Failed to update table: ${error.message}`)
        return
      }
    } else {
      const { error } = await supabase.from('seating_tables').insert({
        ...payload,
        sort_order: tables.length,
        x_position: 0,
        y_position: 0,
        rotation: 0,
      })
      if (error) {
        alert(`Failed to add table: ${error.message}`)
        return
      }
    }

    setShowTableModal(false)
    setEditingTableId(null)
    fetchData()
  }

  async function handleDeleteTable(table: SeatingTable) {
    if (!confirm(`Remove "${table.table_name}"? Guests assigned to this table will become unassigned.`)) return

    // Unassign guests from this table
    const assignedGuests = guestsByTable[table.table_name] || []
    if (assignedGuests.length > 0) {
      const guestIds = assignedGuests.map((g) => g.id)
      await supabase
        .from('guest_list')
        .update({ table_assignment: null })
        .in('id', guestIds)
    }

    await supabase.from('seating_tables').delete().eq('id', table.id)
    fetchData()
  }

  // ---- Guest assignment ----
  function openAssign(table: SeatingTable) {
    setAssigningTable(table)
    setAssignSearch('')
    setShowAssignModal(true)
  }

  async function assignGuestToTable(guestId: string, tableName: string) {
    await supabase
      .from('guest_list')
      .update({ table_assignment: tableName })
      .eq('id', guestId)
    fetchData()
  }

  async function unassignGuest(guestId: string) {
    await supabase
      .from('guest_list')
      .update({ table_assignment: null })
      .eq('id', guestId)
    fetchData()
  }

  // ---- Toggle expand ----
  function toggleExpand(tableId: string) {
    setExpandedTables((prev) => {
      const next = new Set(prev)
      if (next.has(tableId)) next.delete(tableId)
      else next.add(tableId)
      return next
    })
  }

  // ---- Loading ----
  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-48 bg-gray-100 rounded-xl" />
        <div className="h-32 bg-gray-100 rounded-xl" />
        <div className="h-32 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Seating Chart
          </h1>
          <p className="text-gray-500 text-sm">
            View your floor plan, manage tables, and assign guests to their seats.
          </p>
        </div>
        <button
          onClick={openAddTable}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Table
        </button>
      </div>

      {/* Stats Bar */}
      {(tables.length > 0 || guests.length > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {totalGuests}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Total Guests</p>
          </div>
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums text-emerald-600">
              {assignedCount}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Assigned</p>
          </div>
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className={cn('text-xl font-bold tabular-nums', unassignedGuests.length > 0 ? 'text-amber-600' : 'text-emerald-600')}>
              {unassignedGuests.length}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Unassigned</p>
          </div>
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {tables.length}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Tables</p>
          </div>
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums text-emerald-600">
              {tablesFullCount}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Tables Full</p>
          </div>
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {totalCapacity}
            </p>
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Total Capacity</p>
          </div>
        </div>
      )}

      {/* Floor Plan Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setFloorPlanExpanded(!floorPlanExpanded)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Image className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Floor Plan
            </h2>
          </div>
          {floorPlanExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </button>

        {floorPlanExpanded && (
          <div className="px-5 pb-5">
            {floorPlanUrl ? (
              <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                <img
                  src={floorPlanUrl}
                  alt="Floor plan"
                  className="w-full h-auto max-h-[500px] object-contain"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <Image className="w-10 h-10 mb-3 text-gray-300" />
                <p className="text-sm text-gray-500 font-medium mb-1">No floor plan uploaded yet</p>
                <p className="text-xs text-gray-400">
                  Your venue will upload a floor plan for you to view here.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Capacity Warning */}
      {tables.length > 0 && totalGuests > totalCapacity && (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-100 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs">
            <span className="font-medium">Capacity warning:</span> You have {totalGuests} guests but only{' '}
            {totalCapacity} total seats across {tables.length} tables. You may need to add more tables.
          </p>
        </div>
      )}

      {/* Tables List */}
      {tables.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Table2 className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No tables yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Add tables to start building your seating chart.
          </p>
          <button
            onClick={openAddTable}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Table
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <h2
            className="text-sm font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-2"
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Tables ({tables.length})
          </h2>

          {tables.map((table) => {
            const assignedGuests = guestsByTable[table.table_name] || []
            const remaining = table.capacity - assignedGuests.length
            const isFull = remaining <= 0
            const isExpanded = expandedTables.has(table.id)
            const progressPct = table.capacity > 0 ? Math.min((assignedGuests.length / table.capacity) * 100, 100) : 0
            const TypeIcon = typeIcon(table.table_type)

            return (
              <div
                key={table.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden group hover:shadow-md transition-shadow"
              >
                {/* Table header */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)' }}
                      >
                        <TypeIcon className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                      </div>
                      <div className="min-w-0">
                        <h3
                          className="font-semibold text-sm truncate"
                          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                        >
                          {table.table_name}
                        </h3>
                        <p className="text-xs text-gray-400">
                          {typeLabel(table.table_type)} &middot; {table.capacity} seats
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openAssign(table)}
                        disabled={isFull}
                        className={cn(
                          'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                          isFull
                            ? 'text-gray-400 border-gray-200 cursor-not-allowed'
                            : 'text-white border-transparent hover:opacity-90',
                        )}
                        style={!isFull ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                      >
                        <UserPlus className="w-3 h-3" />
                        Assign
                      </button>
                      <button
                        onClick={() => openEditTable(table)}
                        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteTable(table)}
                        className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1 font-medium uppercase tracking-wide">
                      <span>{assignedGuests.length} / {table.capacity} assigned</span>
                      <span className={cn(isFull ? 'text-emerald-600 font-semibold' : remaining <= 2 && remaining > 0 ? 'text-amber-600' : '')}>
                        {isFull ? 'Full' : `${remaining} remaining`}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${progressPct}%`,
                          backgroundColor: isFull ? '#10b981' : 'var(--couple-primary)',
                        }}
                      />
                    </div>
                  </div>

                  {/* Expand toggle */}
                  {assignedGuests.length > 0 && (
                    <button
                      onClick={() => toggleExpand(table.id)}
                      className="flex items-center gap-1 mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="w-3 h-3" />
                          Hide guests
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3 h-3" />
                          Show {assignedGuests.length} guest{assignedGuests.length !== 1 ? 's' : ''}
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Expanded guest list */}
                {isExpanded && assignedGuests.length > 0 && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    <div className="space-y-1">
                      {assignedGuests.map((guest) => (
                        <div
                          key={guest.id}
                          className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-gray-700">{guestName(guest)}</span>
                            {guest.plus_one_name && (
                              <span className="text-xs text-gray-400 ml-2">+ {guest.plus_one_name}</span>
                            )}
                            {guest.group_name && (
                              <span className="text-[10px] text-gray-300 ml-2">({guest.group_name})</span>
                            )}
                          </div>
                          <button
                            onClick={() => unassignGuest(guest.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors p-1"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Unassigned Guests Section */}
      {unassignedGuests.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-accent) 5%, white)' }}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-amber-600" />
                <h2
                  className="text-sm font-semibold"
                  style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                >
                  Unassigned Guests
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {/* Tag filter */}
                {allTags.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setShowTagFilterMenu((v) => !v)}
                      className="flex items-center gap-1.5 px-2.5 py-1 border border-gray-200 rounded-lg text-xs bg-white hover:border-gray-300"
                    >
                      <Tag className="w-3 h-3 text-gray-400" />
                      {filterTagIds.size === 0
                        ? 'Filter by tag'
                        : `${filterTagIds.size} tag${filterTagIds.size === 1 ? '' : 's'}`}
                      <ChevronDown className="w-3 h-3 text-gray-400" />
                    </button>
                    {showTagFilterMenu && (
                      <div className="absolute right-0 top-full mt-1 z-40">
                        <TagPicker
                          tags={allTags}
                          selectedIds={[...filterTagIds]}
                          onToggle={(tid) => {
                            setFilterTagIds((prev) => {
                              const next = new Set(prev)
                              if (next.has(tid)) next.delete(tid)
                              else next.add(tid)
                              return next
                            })
                          }}
                          onClose={() => setShowTagFilterMenu(false)}
                          title="Filter by tag"
                        />
                      </div>
                    )}
                  </div>
                )}
                {filterTagIds.size > 0 && (
                  <button
                    onClick={() => setFilterTagIds(new Set())}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Clear
                  </button>
                )}
                <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full">
                  {tagFilteredUnassigned.length} guest{tagFilteredUnassigned.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>

          <div className="p-5">
            {tagFilteredUnassigned.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                No unassigned guests match the selected tag filter.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {tagFilteredUnassigned.map((guest) => {
                  const tagIds = guestTagMap[guest.id] || []
                  return (
                    <div
                      key={guest.id}
                      className="flex items-start gap-2 px-3 py-2 rounded-lg bg-gray-50 text-sm text-gray-600"
                    >
                      <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-medium text-gray-500 shrink-0 mt-0.5">
                        {guestName(guest).charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="truncate block">{guestName(guest)}</span>
                        {guest.plus_one_name && (
                          <span className="text-[10px] text-gray-400">+ {guest.plus_one_name}</span>
                        )}
                        {tagIds.length > 0 && (
                          <div className="flex flex-wrap gap-0.5 mt-1">
                            {tagIds.map((tid) => {
                              const tag = allTags.find((t) => t.id === tid)
                              if (!tag) return null
                              return <TagChip key={tid} tag={tag} />
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* All guests assigned message */}
      {guests.length > 0 && unassignedGuests.length === 0 && tables.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-100 rounded-xl text-sm text-emerald-800">
          <Check className="w-5 h-5 shrink-0 text-emerald-500" />
          <p className="text-xs font-medium">
            All {totalGuests} guests have been assigned to tables.
          </p>
        </div>
      )}

      {/* ================================================================ */}
      {/* Add/Edit Table Modal */}
      {/* ================================================================ */}
      {showTableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowTableModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingTableId ? 'Edit Table' : 'Add Table'}
              </h2>
              <button onClick={() => setShowTableModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Table name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Table Name</label>
                <input
                  type="text"
                  value={tableForm.table_name}
                  onChange={(e) => setTableForm({ ...tableForm, table_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Table 1, Head Table, Sweetheart"
                />
              </div>

              {/* Table type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Table Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {TABLE_TYPE_OPTIONS.map((opt) => {
                    const OptIcon = opt.icon
                    const isSelected = tableForm.table_type === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() =>
                          setTableForm({
                            ...tableForm,
                            table_type: opt.value,
                            capacity: editingTableId ? tableForm.capacity : opt.defaultCapacity,
                          })
                        }
                        className={cn(
                          'flex items-center gap-2 p-2.5 rounded-lg border text-sm transition-colors text-left',
                          isSelected
                            ? 'text-white border-transparent'
                            : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
                        )}
                        style={isSelected ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                      >
                        <OptIcon className="w-4 h-4 shrink-0" />
                        <span className="font-medium">{opt.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Capacity */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Capacity (seats)</label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={tableForm.capacity}
                  onChange={(e) => setTableForm({ ...tableForm, capacity: parseInt(e.target.value) || 0 })}
                  className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowTableModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTable}
                disabled={!tableForm.table_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingTableId ? 'Save Changes' : 'Add Table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* Guest Assignment Modal */}
      {/* ================================================================ */}
      {showAssignModal && assigningTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAssignModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col">
            {/* Modal header */}
            <div className="px-6 pt-6 pb-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center justify-between mb-1">
                <h2
                  className="text-lg font-semibold"
                  style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                >
                  Assign to {assigningTable.table_name}
                </h2>
                <button onClick={() => setShowAssignModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-xs text-gray-400">
                {(guestsByTable[assigningTable.table_name] || []).length} / {assigningTable.capacity} seats filled
              </p>

              {/* Currently assigned */}
              {(guestsByTable[assigningTable.table_name] || []).length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Currently assigned</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(guestsByTable[assigningTable.table_name] || []).map((g) => (
                      <span
                        key={g.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium"
                        style={{
                          backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)',
                          color: 'var(--couple-primary)',
                        }}
                      >
                        {guestName(g)}
                        <button
                          onClick={() => unassignGuest(g.id)}
                          className="hover:opacity-70 transition-opacity"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Search */}
              <div className="mt-3 relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
                <input
                  type="text"
                  value={assignSearch}
                  onChange={(e) => setAssignSearch(e.target.value)}
                  placeholder="Search unassigned guests..."
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
            </div>

            {/* Guest list */}
            <div className="flex-1 overflow-y-auto px-6 py-3">
              {filteredUnassigned.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">
                  {unassignedGuests.length === 0
                    ? 'All guests have been assigned to tables.'
                    : 'No matching guests found.'}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {filteredUnassigned.map((guest) => {
                    const currentAssigned = (guestsByTable[assigningTable.table_name] || []).length
                    const isFull = currentAssigned >= assigningTable.capacity

                    return (
                      <button
                        key={guest.id}
                        onClick={() => {
                          if (!isFull) {
                            assignGuestToTable(guest.id, assigningTable.table_name)
                          }
                        }}
                        disabled={isFull}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors',
                          isFull
                            ? 'text-gray-300 cursor-not-allowed'
                            : 'text-gray-700 hover:bg-gray-50',
                        )}
                      >
                        <div className="flex items-center gap-2 text-left flex-1 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-medium text-gray-500 shrink-0">
                            {guestName(guest).charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="block truncate">{guestName(guest)}</span>
                            {guest.plus_one_name && (
                              <span className="text-[10px] text-gray-400">+ {guest.plus_one_name}</span>
                            )}
                            {(guestTagMap[guest.id] || []).length > 0 && (
                              <div className="flex flex-wrap gap-0.5 mt-0.5">
                                {(guestTagMap[guest.id] || []).map((tid) => {
                                  const tag = allTags.find((t) => t.id === tid)
                                  if (!tag) return null
                                  return <TagChip key={tid} tag={tag} />
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                        {!isFull && <Plus className="w-3.5 h-3.5 text-gray-300 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="px-6 py-4 border-t border-gray-100 shrink-0">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {unassignedGuests.length} guest{unassignedGuests.length !== 1 ? 's' : ''} remaining
                </p>
                <button
                  onClick={() => setShowAssignModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
