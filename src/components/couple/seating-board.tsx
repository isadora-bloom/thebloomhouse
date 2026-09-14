'use client'

/**
 * Seating board — the floor plan and the assignment list, joined.
 *
 * The two used to be separate features: a drag-and-drop map of table shapes
 * that knew nothing about guests, and a list that assigned a guest to a table
 * by typing a name. They could disagree, and nobody could put a named guest
 * on the map. Both halves now render from one `SeatingView` and save through
 * one callback, so they cannot drift.
 *
 * Shared on purpose. The couple seating page owns the data loading; the
 * coordinator wedding page (W43) can render the same board read-only, or with
 * the same two callbacks, from the same view model.
 *
 * Capacity is reported, never enforced. A couple may squeeze an extra chair
 * in; the board says so in plain words on the tile, on the card, and in the
 * picker, and saves anyway.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Crown,
  Circle,
  Heart,
  MapPin,
  Plus,
  RectangleHorizontal,
  Search,
  Table2,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  SeatedParty,
  SeatingMapElement,
  SeatingTableView,
  SeatingView,
} from '@/lib/services/couple-portal/seating-view'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SeatingBoardProps {
  view: SeatingView
  /** Venue floor plan image. Without one the board renders cards only. */
  floorPlanUrl?: string | null
  /** `table_map_layouts.elements` for this wedding. */
  mapElements?: SeatingMapElement[]
  /** Width of the room in feet, as the layout was drawn. */
  venueWidthFt?: number
  /** Seat a party. Called with the table NAME, the authoritative value. */
  onAssign: (guestId: string, tableName: string) => void | Promise<void>
  /** Take a party off its table. */
  onUnassign: (guestId: string) => void | Promise<void>
  /** Guest currently being saved, so its row can show as busy. */
  pendingGuestId?: string | null
  /** Coordinator view: show everything, change nothing. */
  readOnly?: boolean
  /** Extra controls rendered in a table card's header, e.g. edit and delete. */
  renderTableActions?: (table: SeatingTableView) => React.ReactNode
  /** Extra detail under a party's name, e.g. its guest tags. */
  renderPartyExtra?: (party: SeatedParty) => React.ReactNode
  className?: string
}

const DRAG_TYPE = 'application/x-bloom-guest-id'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Rendered rather than returned as a type, so nothing builds a component
 *  during render. */
function TableTypeIcon({ tableType }: { tableType: string | null }) {
  const props = { className: 'w-4 h-4', style: { color: 'var(--couple-primary)' } }
  switch (tableType) {
    case 'head':
      return <Crown {...props} />
    case 'sweetheart':
      return <Heart {...props} />
    case 'rectangular':
    case 'farm':
      return <RectangleHorizontal {...props} />
    case 'cocktail':
      return <Table2 {...props} />
    default:
      return <Circle {...props} />
  }
}

function matchesSearch(party: SeatedParty, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    party.hostName.toLowerCase().includes(q) ||
    (party.plusOneName ?? '').toLowerCase().includes(q) ||
    (party.groupName ?? '').toLowerCase().includes(q)
  )
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function SeatingBoard({
  view,
  floorPlanUrl = null,
  mapElements = [],
  venueWidthFt = 80,
  onAssign,
  onUnassign,
  pendingGuestId = null,
  readOnly = false,
  renderTableActions,
  renderPartyExtra,
  className,
}: SeatingBoardProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [pickerTable, setPickerTable] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draggingGuestId, setDraggingGuestId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [planSize, setPlanSize] = useState<{ w: number; h: number } | null>(null)
  const planRef = useRef<HTMLDivElement | null>(null)

  const elementById = useMemo(() => {
    const map = new Map<string, SeatingMapElement>()
    for (const el of mapElements) map.set(el.id, el)
    return map
  }, [mapElements])

  const hasPlan = Boolean(floorPlanUrl) && mapElements.length > 0

  // Clear the highlight after a few seconds so the board does not stay lit.
  useEffect(() => {
    if (!highlighted) return
    const t = setTimeout(() => setHighlighted(null), 4000)
    return () => clearTimeout(t)
  }, [highlighted])

  const showOnMap = useCallback((table: SeatingTableView) => {
    setHighlighted(table.name)
    const node = planRef.current
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [])

  const assign = useCallback(
    async (guestId: string, tableName: string) => {
      if (readOnly) return
      await onAssign(guestId, tableName)
      setPickerTable(null)
      setSearch('')
    },
    [onAssign, readOnly],
  )

  const handleDrop = useCallback(
    (event: React.DragEvent, tableName: string) => {
      event.preventDefault()
      setDropTarget(null)
      const guestId =
        event.dataTransfer.getData(DRAG_TYPE) || event.dataTransfer.getData('text/plain')
      setDraggingGuestId(null)
      if (!guestId) return
      void assign(guestId, tableName)
    },
    [assign],
  )

  const dropProps = (tableName: string) =>
    readOnly
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault()
            setDropTarget(tableName)
          },
          onDragLeave: () => setDropTarget((t) => (t === tableName ? null : t)),
          onDrop: (e: React.DragEvent) => handleDrop(e, tableName),
        }

  return (
    <div className={cn('space-y-5', className)}>
      {view.overallNote && (
        <div
          className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-900"
          role="status"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed">{view.overallNote}</p>
        </div>
      )}

      {hasPlan && (
        <FloorPlan
          ref={planRef}
          view={view}
          floorPlanUrl={floorPlanUrl!}
          mapElements={mapElements}
          elementById={elementById}
          venueWidthFt={venueWidthFt}
          planSize={planSize}
          onPlanSize={setPlanSize}
          highlighted={highlighted}
          dropTarget={dropTarget}
          dropProps={dropProps}
          onPick={(name) => {
            setPickerTable(name)
            setSearch('')
          }}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_18rem] items-start">
        {/* ---- Table cards ---- */}
        <div className="space-y-3" data-testid="seating-tables">
          {view.tables.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center border border-dashed border-gray-200 rounded-xl">
              No tables yet. Add one to start seating people.
            </p>
          ) : (
            view.tables.map((table) => (
              <TableCard
                key={table.tableId || `name:${table.name}`}
                table={table}
                unseated={view.unseated}
                highlighted={highlighted === table.name}
                isDropTarget={dropTarget === table.name}
                dropProps={dropProps(table.name)}
                pickerOpen={pickerTable === table.name}
                search={search}
                onSearch={setSearch}
                onOpenPicker={() => {
                  setPickerTable(table.name)
                  setSearch('')
                }}
                onClosePicker={() => setPickerTable(null)}
                onAssign={(guestId) => void assign(guestId, table.name)}
                onUnassign={(guestId) => void onUnassign(guestId)}
                onShowOnMap={hasPlan && table.mapElementId ? () => showOnMap(table) : undefined}
                pendingGuestId={pendingGuestId}
                readOnly={readOnly}
                actions={renderTableActions?.(table)}
                renderPartyExtra={renderPartyExtra}
              />
            ))
          )}
        </div>

        {/* ---- Not seated yet ---- */}
        <UnseatedColumn
          parties={view.unseated}
          readOnly={readOnly}
          renderPartyExtra={renderPartyExtra}
          draggingGuestId={draggingGuestId}
          onDragStart={setDraggingGuestId}
          onDragEnd={() => {
            setDraggingGuestId(null)
            setDropTarget(null)
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Floor plan — tables drawn where the layout put them, as real drop targets
// ---------------------------------------------------------------------------

interface FloorPlanProps {
  ref: React.Ref<HTMLDivElement>
  view: SeatingView
  floorPlanUrl: string
  mapElements: SeatingMapElement[]
  elementById: Map<string, SeatingMapElement>
  venueWidthFt: number
  planSize: { w: number; h: number } | null
  onPlanSize: (size: { w: number; h: number }) => void
  highlighted: string | null
  dropTarget: string | null
  dropProps: (tableName: string) => Record<string, unknown>
  onPick: (tableName: string) => void
}

function FloorPlan({
  ref,
  view,
  floorPlanUrl,
  mapElements,
  elementById,
  venueWidthFt,
  planSize,
  onPlanSize,
  highlighted,
  dropTarget,
  dropProps,
  onPick,
}: FloorPlanProps) {
  const placed = view.tables.filter((t) => t.mapElementId && elementById.has(t.mapElementId))
  const blocks = mapElements.filter((el) => el.type === 'block')

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <MapPin className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
        <h2
          className="text-sm font-semibold"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Floor Plan
        </h2>
        <span className="text-xs text-gray-400 ml-auto">
          Drag a guest onto a table, or tap a table to search for one.
        </span>
      </div>
      <div ref={ref} className="relative bg-gray-50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={floorPlanUrl}
          alt="Venue floor plan"
          className="w-full h-auto block"
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth > 0) onPlanSize({ w: img.naturalWidth, h: img.naturalHeight })
          }}
        />
        {planSize && (
          <>
            {blocks.map((el) => (
              <div
                key={el.id}
                className="absolute rounded-md border border-gray-300/70 bg-white/40 flex items-center justify-center pointer-events-none"
                style={boxStyle(el, planSize, venueWidthFt)}
              >
                <span className="text-[9px] font-medium text-gray-500 truncate px-1">
                  {el.label}
                </span>
              </div>
            ))}
            {placed.map((table) => {
              const el = elementById.get(table.mapElementId!)!
              return (
                <button
                  key={table.tableId || table.name}
                  type="button"
                  data-table-name={table.name}
                  aria-label={`${table.name}: ${table.capacityNote}`}
                  onClick={() => onPick(table.name)}
                  {...dropProps(table.name)}
                  className={cn(
                    'absolute flex flex-col items-center justify-center overflow-hidden text-center transition-all',
                    el.type === 'round' ? 'rounded-full' : 'rounded-md',
                    table.isOver
                      ? 'border-2 border-amber-500 bg-amber-100/90'
                      : 'border border-gray-400/60 bg-white/90',
                    highlighted === table.name && 'ring-4 ring-offset-1 ring-rose-400 z-20',
                    dropTarget === table.name && 'ring-4 ring-emerald-400 z-20',
                  )}
                  style={boxStyle(el, planSize, venueWidthFt)}
                >
                  <span className="text-[10px] font-semibold leading-tight truncate w-full px-0.5">
                    {table.name}
                  </span>
                  <span className="text-[9px] leading-tight text-gray-600 tabular-nums">
                    {table.seated}/{table.capacity || '?'}
                  </span>
                  {table.parties.length > 0 && (
                    <span className="text-[8px] leading-tight text-gray-500 truncate w-full px-0.5">
                      {table.parties.map((p) => p.hostName.split(' ')[0]).join(', ')}
                    </span>
                  )}
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Position an element the way the Konva editor drew it: x and y are image
 * pixels, width and depth are feet against the room's width. Percentages keep
 * that true at any rendered size.
 */
function boxStyle(
  el: SeatingMapElement,
  plan: { w: number; h: number },
  venueWidthFt: number,
): React.CSSProperties {
  const pxPerFt = plan.w / (venueWidthFt || 80)
  const widthPx = (el.feetW ?? 5) * pxPerFt
  const heightPx = (el.feetH ?? el.feetW ?? 5) * pxPerFt
  return {
    left: `${((el.x ?? 0) / plan.w) * 100}%`,
    top: `${((el.y ?? 0) / plan.h) * 100}%`,
    width: `${(widthPx / plan.w) * 100}%`,
    height: `${(heightPx / plan.h) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${el.rotation ?? 0}deg)`,
    minWidth: '2.5rem',
    minHeight: '2.5rem',
  }
}

// ---------------------------------------------------------------------------
// Table card
// ---------------------------------------------------------------------------

interface TableCardProps {
  table: SeatingTableView
  unseated: SeatedParty[]
  highlighted: boolean
  isDropTarget: boolean
  dropProps: Record<string, unknown>
  pickerOpen: boolean
  search: string
  onSearch: (value: string) => void
  onOpenPicker: () => void
  onClosePicker: () => void
  onAssign: (guestId: string) => void
  onUnassign: (guestId: string) => void
  onShowOnMap?: () => void
  pendingGuestId: string | null
  readOnly: boolean
  actions?: React.ReactNode
  renderPartyExtra?: (party: SeatedParty) => React.ReactNode
}

function TableCard({
  table,
  unseated,
  highlighted,
  isDropTarget,
  dropProps,
  pickerOpen,
  search,
  onSearch,
  onOpenPicker,
  onClosePicker,
  onAssign,
  onUnassign,
  onShowOnMap,
  pendingGuestId,
  readOnly,
  actions,
  renderPartyExtra,
}: TableCardProps) {
  const matches = unseated.filter((p) => matchesSearch(p, search))

  return (
    <div
      data-table-card={table.name}
      {...dropProps}
      className={cn(
        'bg-white rounded-xl border shadow-sm overflow-hidden transition-all',
        table.isOver ? 'border-amber-300' : 'border-gray-100',
        highlighted && 'ring-2 ring-rose-400',
        isDropTarget && 'ring-2 ring-emerald-400',
      )}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)' }}
            >
              <TableTypeIcon tableType={table.tableType} />
            </div>
            <div className="min-w-0">
              <h3
                className="font-semibold text-sm truncate"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {table.name}
              </h3>
              <p className="text-xs text-gray-400 tabular-nums">
                {table.seated} seated
                {table.capacity > 0 ? ` of ${table.capacity}` : ''}
                {' · '}
                <span className={cn(table.isOver && 'text-amber-700 font-medium')}>
                  {table.capacityNote}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {onShowOnMap && (
              <button
                type="button"
                onClick={onShowOnMap}
                aria-label={`Show ${table.name} on the map`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50"
              >
                <MapPin className="w-3 h-3" />
                Show on map
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={pickerOpen ? onClosePicker : onOpenPicker}
                aria-label={`Add a guest to ${table.name}`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                <Plus className="w-3 h-3" />
                Add guest
              </button>
            )}
            {actions}
          </div>
        </div>

        {!table.existsInTables && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
            Guests are sitting at &quot;{table.name}&quot; but there is no table by that name in
            your list. Add it, or move these guests.
          </p>
        )}

        {table.isOver && (
          <p
            role="status"
            className="flex items-center gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
            {table.capacityNote}. That is allowed, you may be squeezing people in on purpose.
          </p>
        )}

        {/* Seated parties */}
        {table.parties.length === 0 ? (
          <p className="text-xs text-gray-400">Nobody here yet.</p>
        ) : (
          <ul className="space-y-1">
            {table.parties.map((party) => (
              <li
                key={party.guestId}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50"
              >
                <span className="text-sm text-gray-700 min-w-0 truncate">
                  {party.label}
                  {party.groupName && (
                    <span className="text-[10px] text-gray-400 ml-2">({party.groupName})</span>
                  )}
                  {renderPartyExtra?.(party)}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onUnassign(party.guestId)}
                    disabled={pendingGuestId === party.guestId}
                    aria-label={`Remove ${party.hostName} from ${table.name}`}
                    className="text-gray-300 hover:text-red-500 transition-colors p-1 disabled:opacity-40"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Picker */}
        {pickerOpen && !readOnly && (
          <div className="border-t border-gray-100 pt-3 space-y-2">
            {(table.isFull || table.isOver) && (
              <p className="text-[11px] text-amber-800">
                {table.isOver ? table.capacityNote : 'This table is full'}. You can still seat
                someone here.
              </p>
            )}
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
              <input
                type="text"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                aria-label={`Search guests to seat at ${table.name}`}
                placeholder="Search by name..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
            {matches.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">
                {unseated.length === 0 ? 'Everyone has a table.' : 'No guest matches that.'}
              </p>
            ) : (
              <ul className="max-h-56 overflow-y-auto space-y-0.5">
                {matches.map((party) => (
                  <li key={party.guestId}>
                    <button
                      type="button"
                      onClick={() => onAssign(party.guestId)}
                      disabled={pendingGuestId === party.guestId}
                      aria-label={`Seat ${party.hostName} at ${table.name}`}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      <span className="truncate text-left">
                        {party.label}
                        {renderPartyExtra?.(party)}
                      </span>
                      <Plus className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unseated column
// ---------------------------------------------------------------------------

function UnseatedColumn({
  parties,
  readOnly,
  renderPartyExtra,
  draggingGuestId,
  onDragStart,
  onDragEnd,
}: {
  parties: SeatedParty[]
  readOnly: boolean
  renderPartyExtra?: (party: SeatedParty) => React.ReactNode
  draggingGuestId: string | null
  onDragStart: (guestId: string) => void
  onDragEnd: () => void
}) {
  const people = parties.reduce((sum, p) => sum + p.size, 0)

  return (
    <aside
      data-testid="seating-unseated"
      className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden lg:sticky lg:top-4"
    >
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <Users className="w-4 h-4 text-amber-600" />
        <h2
          className="text-sm font-semibold"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Not seated yet
        </h2>
        <span className="ml-auto text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full tabular-nums">
          {parties.length}
        </span>
      </div>
      <div className="p-3">
        {parties.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-emerald-700 py-2">
            <Check className="w-4 h-4 shrink-0 text-emerald-500" />
            Everyone has a table.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-400 mb-2">
              {people === parties.length
                ? `${people} to seat`
                : `${parties.length} invitations, ${people} seats to fill`}
              {!readOnly && '. Drag one onto a table.'}
            </p>
            <ul className="space-y-1 max-h-96 overflow-y-auto">
              {parties.map((party) => (
                <li
                  key={party.guestId}
                  draggable={!readOnly}
                  data-guest-id={party.guestId}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, party.guestId)
                    e.dataTransfer.setData('text/plain', party.guestId)
                    e.dataTransfer.effectAllowed = 'move'
                    onDragStart(party.guestId)
                  }}
                  onDragEnd={onDragEnd}
                  className={cn(
                    'px-2.5 py-1.5 rounded-lg bg-gray-50 text-sm text-gray-600 truncate',
                    !readOnly && 'cursor-grab active:cursor-grabbing',
                    draggingGuestId === party.guestId && 'opacity-50',
                  )}
                  title={party.label}
                >
                  {party.label}
                  {renderPartyExtra?.(party)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  )
}
