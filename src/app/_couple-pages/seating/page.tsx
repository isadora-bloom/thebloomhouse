'use client'

// Feature: configurable via venue_config.feature_flags
// Tables: seating_tables, guest_list, table_map_layouts
//
// Wave 6 W44: the floor plan and the assignment list are one surface now.
// Both halves render from `buildSeatingView` and save through
// `saveTableAssignment`, so they cannot disagree. The authoritative column
// for "who sits where" is `guest_list.table_assignment` (the table's NAME) —
// the reasoning is written out at the top of
// src/lib/services/couple-portal/seating-view.ts.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  Plus,
  X,
  Circle,
  RectangleHorizontal,
  Crown,
  Heart,
  Image,
  ChevronDown,
  ChevronUp,
  Edit2,
  Trash2,
  Check,
  AlertTriangle,
  Table2,
  Tag,
  Info,
} from 'lucide-react'
import { TagChip, type TagChipData } from '@/components/couple/tag-chip'
import { TagPicker } from '@/components/couple/tag-picker'
import {
  loadSeatingConfig,
  loadFloorPlan,
  EMPTY_SEATING_CONFIG,
  type VenueSeatingConfig,
} from '@/lib/services/couple-portal-config'
import { SeatingImportDialog } from '@/components/couple/seating-import-dialog'
import { SeatingBoard } from '@/components/couple/seating-board'
import {
  buildSeatingView,
  type SeatedParty,
  type SeatingGuestRow,
  type SeatingMapElement,
  type SeatingTableRow,
} from '@/lib/services/couple-portal/seating-view'
import { saveTableAssignment } from '@/lib/services/couple-portal/seating-assignment'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TableType = 'round' | 'rectangular' | 'head' | 'sweetheart' | 'farm' | 'cocktail'

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
// Seating Chart Page
// ---------------------------------------------------------------------------

export default function SeatingChartPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  // Data
  const [tables, setTables] = useState<SeatingTableRow[]>([])
  const [guests, setGuests] = useState<SeatingGuestRow[]>([])
  const [mapElements, setMapElements] = useState<SeatingMapElement[]>([])
  const [floorPlanUrl, setFloorPlanUrl] = useState<string | null>(null)
  const [venueWidthFt, setVenueWidthFt] = useState<number>(80)
  const [venueSeatingConfig, setVenueSeatingConfig] = useState<VenueSeatingConfig>(EMPTY_SEATING_CONFIG)
  const [loading, setLoading] = useState(true)

  // Tag data
  const [allTags, setAllTags] = useState<TagChipData[]>([])
  // guest_id -> tag_id[]
  const [guestTagMap, setGuestTagMap] = useState<Record<string, string[]>>({})
  // Multi-select tag filter applied to the not-seated list and the pickers
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [showTagFilterMenu, setShowTagFilterMenu] = useState(false)

  // Table CRUD modal
  const [showTableModal, setShowTableModal] = useState(false)
  const [editingTableId, setEditingTableId] = useState<string | null>(null)
  const [tableForm, setTableForm] = useState<TableFormData>(EMPTY_FORM)

  // The guest currently being saved, so its row can show as busy
  const [pendingGuestId, setPendingGuestId] = useState<string | null>(null)

  // Floor plan expanded (only used for the plain image fallback)
  const [floorPlanExpanded, setFloorPlanExpanded] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    if (!weddingId || !venueId) return
    const [tablesRes, guestsRes, layoutRes, floorPlan, tagsRes, seatingConfig] = await Promise.all([
      supabase
        .from('seating_tables')
        .select('*')
        .eq('wedding_id', weddingId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('guest_list')
        // `table_assignment` is the authoritative column. `plus_one` and
        // `has_plus_one` decide whether the row is a party of two.
        .select(
          'id, table_assignment, rsvp_status, plus_one, has_plus_one, plus_one_name, group_name, first_name, last_name',
        )
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: true }),
      supabase
        .from('table_map_layouts')
        .select('elements')
        .eq('wedding_id', weddingId)
        .maybeSingle(),
      loadFloorPlan(supabase, venueId),
      supabase
        .from('guest_tags')
        .select('id, tag_name, color')
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: true }),
      loadSeatingConfig(supabase, venueId),
    ])
    setVenueSeatingConfig(seatingConfig)

    if (tablesRes.data) setTables(tablesRes.data as unknown as SeatingTableRow[])
    if (guestsRes.data) setGuests(guestsRes.data as unknown as SeatingGuestRow[])
    setMapElements(((layoutRes.data?.elements ?? []) as SeatingMapElement[]) || [])
    setFloorPlanUrl(floorPlan.url)
    setVenueWidthFt(floorPlan.venue_width_ft || 80)

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
  }, [supabase, weddingId, venueId])

  // BUG-04A: wait for context ids before firing fetch.
  useEffect(() => {
    if (!weddingId || !venueId) return
    fetchData()
  }, [weddingId, venueId, fetchData])

  // ---- The view both halves read ----
  const view = useMemo(
    () => buildSeatingView({ tables, guests, mapElements }),
    [tables, guests, mapElements],
  )

  // Tag filter narrows the not-seated list and every table's picker, so the
  // two stay in step (it did the same for the old assign modal).
  const boardView = useMemo(() => {
    if (filterTagIds.size === 0) return view
    return {
      ...view,
      unseated: view.unseated.filter((p) =>
        (guestTagMap[p.guestId] || []).some((tid) => filterTagIds.has(tid)),
      ),
    }
  }, [view, filterTagIds, guestTagMap])

  const tablesFullCount = view.tables.filter((t) => t.isFull || t.isOver).length

  // ---- Table CRUD ----
  function openAddTable() {
    setTableForm(EMPTY_FORM)
    setEditingTableId(null)
    setShowTableModal(true)
  }

  function openEditTable(tableId: string) {
    const row = tables.find((t) => t.id === tableId)
    if (!row) return
    setTableForm({
      table_name: row.table_name ?? '',
      table_type: (row.table_type as TableType) || 'round',
      capacity: row.capacity ?? 0,
    })
    setEditingTableId(tableId)
    setShowTableModal(true)
  }

  async function handleSaveTable() {
    if (!tableForm.table_name.trim()) return

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      table_name: tableForm.table_name.trim(),
      table_type: tableForm.table_type,
      capacity: tableForm.capacity,
    }

    if (editingTableId) {
      const previous = tables.find((t) => t.id === editingTableId)
      const { error } = await supabase.from('seating_tables').update(payload).eq('id', editingTableId)
      if (error) {
        alert(`Failed to update table: ${error.message}`)
        return
      }
      // Guests point at the NAME, so a rename has to carry them with it or
      // they are stranded at a table that no longer exists.
      const oldName = (previous?.table_name ?? '').trim()
      if (oldName && oldName !== payload.table_name) {
        await supabase
          .from('guest_list')
          .update({ table_assignment: payload.table_name })
          .eq('wedding_id', weddingId)
          .eq('table_assignment', oldName)
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

  async function handleDeleteTable(tableId: string, tableName: string) {
    if (!confirm(`Remove "${tableName}"? Guests at this table will go back to the not-seated list.`)) return

    const seated = view.tables.find((t) => t.tableId === tableId)?.parties ?? []
    if (seated.length > 0) {
      await supabase
        .from('guest_list')
        .update({ table_assignment: null })
        .in('id', seated.map((p) => p.guestId))
    }

    await supabase.from('seating_tables').delete().eq('id', tableId)
    fetchData()
  }

  // ---- The one save route both halves use ----
  const assignGuest = useCallback(
    async (guestId: string, tableName: string) => {
      setPendingGuestId(guestId)
      // Optimistic: the board should move the chip before the round trip.
      setGuests((prev) =>
        prev.map((g) => (g.id === guestId ? { ...g, table_assignment: tableName } : g)),
      )
      const { error } = await saveTableAssignment(supabase, { guestId, tableName, venueId })
      setPendingGuestId(null)
      if (error) {
        alert(`Could not seat that guest: ${error.message}`)
      }
      fetchData()
    },
    [supabase, venueId, fetchData],
  )

  const unassignGuest = useCallback(
    async (guestId: string) => {
      setPendingGuestId(guestId)
      setGuests((prev) =>
        prev.map((g) => (g.id === guestId ? { ...g, table_assignment: null } : g)),
      )
      const { error } = await saveTableAssignment(supabase, { guestId, tableName: null, venueId })
      setPendingGuestId(null)
      if (error) {
        alert(`Could not take that guest off the table: ${error.message}`)
      }
      fetchData()
    },
    [supabase, venueId, fetchData],
  )

  const renderPartyExtra = useCallback(
    (party: SeatedParty) => {
      const tagIds = guestTagMap[party.guestId] || []
      if (tagIds.length === 0) return null
      return (
        <span className="inline-flex flex-wrap gap-0.5 ml-1.5 align-middle">
          {tagIds.map((tid) => {
            const tag = allTags.find((t) => t.id === tid)
            if (!tag) return null
            return <TagChip key={tid} tag={tag} />
          })}
        </span>
      )
    },
    [guestTagMap, allTags],
  )

  // ---- Loading ----
  if (contextLoading || !weddingId || !venueId || loading) {
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
            Your floor plan and your guest list, together. Drag a name onto a table, or search for
            one from the table itself.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SeatingImportDialog weddingId={weddingId} onComplete={fetchData} />
          <button
            onClick={openAddTable}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Table
          </button>
        </div>
      </div>

      {/* Venue admin notes */}
      {venueSeatingConfig.notes_to_couples && (
        <div
          className="rounded-xl border p-4 flex items-start gap-3"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--couple-primary) 6%, white)',
            borderColor: 'color-mix(in srgb, var(--couple-primary) 18%, transparent)',
          }}
        >
          <Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--couple-primary)' }} />
          <p className="text-sm text-gray-700 whitespace-pre-line">
            {venueSeatingConfig.notes_to_couples}
          </p>
        </div>
      )}

      {/* Stats Bar. Counts are people, so a plus one counts as a seat. */}
      {(view.tables.length > 0 || view.totals.parties > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <StatCard label="Guests" value={view.totals.people} tone="primary" />
          <StatCard label="Seated" value={view.totals.seatedPeople} tone="good" />
          <StatCard
            label="Not seated"
            value={view.totals.unseatedPeople}
            tone={view.totals.unseatedPeople > 0 ? 'warn' : 'good'}
          />
          <StatCard label="Tables" value={view.tables.length} tone="primary" />
          <StatCard label="Tables full" value={tablesFullCount} tone="good" />
          <StatCard label="Total seats" value={view.totals.capacity} tone="primary" />
        </div>
      )}

      {/* Floor plan image on its own, for weddings with no layout drawn yet */}
      {mapElements.length === 0 && (
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
                <>
                  <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={floorPlanUrl}
                      alt="Floor plan"
                      className="w-full h-auto max-h-[500px] object-contain"
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Your coordinator has not placed your tables on this plan yet. Once they do, you
                    can drag guests straight onto them.
                  </p>
                </>
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
      )}

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
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
              <div className="absolute left-0 top-full mt-1 z-40">
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
          {filterTagIds.size > 0 && (
            <button
              onClick={() => setFilterTagIds(new Set())}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* The board: plan, tables and the not-seated list, all on one view */}
      {view.tables.length === 0 && view.totals.parties === 0 ? (
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
        <SeatingBoard
          view={boardView}
          floorPlanUrl={floorPlanUrl}
          mapElements={mapElements}
          venueWidthFt={venueWidthFt}
          onAssign={assignGuest}
          onUnassign={unassignGuest}
          pendingGuestId={pendingGuestId}
          renderPartyExtra={renderPartyExtra}
          renderTableActions={(table) =>
            table.existsInTables ? (
              <>
                <button
                  onClick={() => openEditTable(table.tableId)}
                  aria-label={`Edit ${table.name}`}
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDeleteTable(table.tableId, table.name)}
                  aria-label={`Delete ${table.name}`}
                  className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            ) : null
          }
        />
      )}

      {/* Tables drawn on the plan that nobody can sit at */}
      {view.unmatchedMapLabels.length > 0 && (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-100 rounded-xl text-amber-800">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs">
            <span className="font-medium">On the plan but not in your table list:</span>{' '}
            {view.unmatchedMapLabels.join(', ')}. Add a table with the same name to seat people
            there.
          </p>
        </div>
      )}

      {/* All guests assigned message */}
      {view.totals.parties > 0 && view.totals.unseatedParties === 0 && view.tables.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-100 rounded-xl text-sm text-emerald-800">
          <Check className="w-5 h-5 shrink-0 text-emerald-500" />
          <p className="text-xs font-medium">
            All {view.totals.people} guests have a table.
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
                <p className="text-[11px] text-gray-400 mt-1">
                  Use the same name your coordinator used on the floor plan and the two will line
                  up.
                </p>
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'primary' | 'good' | 'warn'
}) {
  return (
    <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
      <p
        className={cn(
          'text-xl font-bold tabular-nums',
          tone === 'good' && 'text-emerald-600',
          tone === 'warn' && 'text-amber-600',
        )}
        style={tone === 'primary' ? { color: 'var(--couple-primary)' } : undefined}
      >
        {value}
      </p>
      <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{label}</p>
    </div>
  )
}
